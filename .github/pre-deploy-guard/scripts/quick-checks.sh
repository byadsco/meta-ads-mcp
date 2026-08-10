#!/usr/bin/env bash
# quick-checks.sh — Fast pre-commit validation (<10s target).
# Skips full test suite and full build. Runs:
#   1. File guard (staged paths blacklist)
#   2. Custom regex secret scan on staged diff
#   3. gitleaks --staged (fast)
#   4. typecheck (TypeScript projects only)
#
# Exits 0 on success, 1 on any blocking failure.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCAN_SECRETS="$SCRIPT_DIR/scan-secrets.sh"

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$ROOT" ]; then
  echo "[SKIP] Not in a git repository — pre-deploy-guard quick mode does nothing here."
  exit 0
fi
cd "$ROOT"

PASS=0
FAIL=0
SKIP=0
FAILURES=()
LOG="$(mktemp -t pre-deploy-guard-quick.XXXXXX)"
trap 'rm -f "$LOG"' EXIT

mark_ok()    { echo "[OK]   $1"; PASS=$((PASS+1)); }
mark_fail()  { echo "[FAIL] $1"; FAIL=$((FAIL+1)); FAILURES+=("$1"); }
mark_skip()  { echo "[SKIP] $1"; SKIP=$((SKIP+1)); }

# 1. File guard
echo "── File guard ────────────────────────────────────────────────"
STAGED="$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)"
PROHIBITED_HITS=()
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    .env.example|*/.env.example) continue ;;
    .env|.env.*|*/.env|*/.env.*) PROHIBITED_HITS+=("$f") ;;
    *.key|*.pem|*.p12|*.pfx)     PROHIBITED_HITS+=("$f") ;;
    credentials.json|*/credentials.json) PROHIBITED_HITS+=("$f") ;;
    service-account*.json|*/service-account*.json) PROHIBITED_HITS+=("$f") ;;
    id_rsa|*/id_rsa|id_dsa|*/id_dsa|id_ed25519|*/id_ed25519) PROHIBITED_HITS+=("$f") ;;
  esac
done <<EOF
$STAGED
EOF

if [ "${#PROHIBITED_HITS[@]}" -eq 0 ]; then
  mark_ok "no prohibited files staged"
else
  mark_fail "prohibited files staged: ${PROHIBITED_HITS[*]}"
fi

# 2. Custom regex secret scan
echo "── Custom secret scan ───────────────────────────────────────"
if [ -x "$SCAN_SECRETS" ]; then
  if git diff --cached --quiet 2>/dev/null; then
    mark_ok "custom regex (nothing staged to scan)"
  elif git diff --cached -U0 | "$SCAN_SECRETS" >"$LOG" 2>&1; then
    mark_ok "custom regex (no findings)"
  else
    mark_fail "custom regex scanner found secrets"
    sed 's/^/        /' "$LOG" | head -n 30
  fi
else
  mark_skip "scan-secrets.sh not executable at $SCAN_SECRETS"
fi

# 3. gitleaks (staged-only). Pure Go binary — no npm fallback.
echo "── gitleaks ─────────────────────────────────────────────────"
if command -v gitleaks >/dev/null 2>&1; then
  # See run-checks.sh: gitleaks releases disagree about allowlist semantics,
  # so a version mismatch means a clean scan here does not predict CI.
  if [ -f .gitleaks-version ]; then
    want="$(tr -d '[:space:]' < .gitleaks-version)"
    have="$(gitleaks version 2>/dev/null | tr -d '[:space:]')"
    if [ -n "$want" ] && [ "$have" != "$want" ]; then
      mark_fail "gitleaks version mismatch — CI pins $want, this machine has ${have:-unknown}"
      echo "        Install the pinned version, or bump .gitleaks-version if the pin is stale."
    fi
  fi

  GITLEAKS_ARGS=(git --staged --redact --no-banner)
  [ -f .gitleaks.toml ] && GITLEAKS_ARGS+=(--config .gitleaks.toml)
  gitleaks "${GITLEAKS_ARGS[@]}" >"$LOG" 2>&1
  rc=$?
  case "$rc" in
    0)  mark_ok "gitleaks (no findings)" ;;
    1)  mark_fail "gitleaks reported findings"
        sed 's/^/        /' "$LOG" | tail -n 30 ;;
    *)  mark_fail "gitleaks errored (rc=$rc) — treating an unusable scanner as a failure, not a pass"
        sed 's/^/        /' "$LOG" | tail -n 10 ;;
  esac
else
  mark_skip "gitleaks not installed (install with: brew install gitleaks)"
fi

# 4. Typecheck (only if there's a tsconfig.json and a script for it)
echo "── typecheck ────────────────────────────────────────────────"
if [ -f tsconfig.json ] && [ -f package.json ]; then
  if node -e "process.exit(require('./package.json').scripts?.typecheck?0:1)" 2>/dev/null; then
    if npm run typecheck --silent >"$LOG" 2>&1; then
      mark_ok "npm run typecheck"
    else
      mark_fail "npm run typecheck"
      sed 's/^/        /' "$LOG" | tail -n 30
    fi
  else
    mark_skip "no 'typecheck' script in package.json"
  fi
else
  mark_skip "no tsconfig.json (or no package.json)"
fi

echo
echo "── Summary ──────────────────────────────────────────────────"
echo "PASS: $PASS    FAIL: $FAIL    SKIP: $SKIP"
if [ "$FAIL" -gt 0 ]; then
  echo
  echo "Blocking failures:"
  for f in "${FAILURES[@]}"; do
    echo "  - $f"
  done
  exit 1
fi
exit 0
