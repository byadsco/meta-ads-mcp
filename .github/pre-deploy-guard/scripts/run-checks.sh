#!/usr/bin/env bash
# run-checks.sh — Full pre-deploy / pre-push validation.
# Exits 0 on success, 1 if any blocking check failed.
#
# Steps (each can be skipped if not applicable to the repo):
#   1. File guard         — staged paths blacklist
#   2. .gitignore guard   — required ignore entries are present
#   3. npm run lint
#   4. npm run typecheck
#   5. npm test
#   6. npm run build
#   7. Custom regex secret scan on staged diff
#   8. gitleaks (via npx) on staged diff
#
# Output uses [OK] / [FAIL] / [SKIP] markers and a final summary block.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCAN_SECRETS="$SCRIPT_DIR/scan-secrets.sh"

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$ROOT" ]; then
  echo "[SKIP] Not in a git repository — pre-deploy-guard does nothing here."
  exit 0
fi
cd "$ROOT"

PASS=0
FAIL=0
SKIP=0
FAILURES=()
LOG="$(mktemp -t pre-deploy-guard.XXXXXX)"
WORK_NAMES="$(mktemp -t pre-deploy-names.XXXXXX)"
trap 'rm -f "$LOG" "$WORK_NAMES"' EXIT

mark_ok()    { echo "[OK]   $1"; PASS=$((PASS+1)); }
mark_fail()  { echo "[FAIL] $1"; FAIL=$((FAIL+1)); FAILURES+=("$1"); }
mark_skip()  { echo "[SKIP] $1"; SKIP=$((SKIP+1)); }

run_step() {
  local label="$1"; shift
  if "$@" >"$LOG" 2>&1; then
    mark_ok "$label"
  else
    mark_fail "$label"
    sed 's/^/        /' "$LOG" | tail -n 40
  fi
}

# ─────────────────────────────────────────────────────────────────
# 1. File guard
# ─────────────────────────────────────────────────────────────────
# The full mode runs before a push, when the index is normally empty because
# everything is already committed. Scanning only the index there examined zero
# bytes and passed, so the outgoing commits are scanned too. Resolution order
# widens deliberately: failing to find a base must not silently skip the scan.
OUTGOING_RANGE=""
RANGE_UNRESOLVED=0
BASE_FOUND=0
if UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null)" \
   && git rev-parse --verify --quiet "$UPSTREAM" >/dev/null 2>&1; then
  BASE_FOUND=1
  [ "$(git rev-parse HEAD 2>/dev/null)" != "$(git rev-parse "$UPSTREAM" 2>/dev/null)" ] \
    && OUTGOING_RANGE="$UPSTREAM..HEAD"
else
  for base in "$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null)" origin/main origin/master main master develop trunk; do
    [ -z "$base" ] && continue
    git rev-parse --verify --quiet "$base" >/dev/null 2>&1 || continue
    BASE_FOUND=1
    # A base that equals HEAD means nothing is outgoing — that is a clean state,
    # not an unknown one, and must not block the push.
    [ "$(git rev-parse HEAD 2>/dev/null)" != "$(git rev-parse "$base" 2>/dev/null)" ] \
      && OUTGOING_RANGE="$base..HEAD"
    break
  done
  if [ "$BASE_FOUND" = "0" ] \
     && git rev-parse --verify --quiet HEAD >/dev/null 2>&1 \
     && [ -n "$(git remote 2>/dev/null)" ]; then
    RANGE_UNRESOLVED=1
  fi
fi
if [ -n "$OUTGOING_RANGE" ] && ! git rev-list --count "$OUTGOING_RANGE" >/dev/null 2>&1; then
  OUTGOING_RANGE=""
  RANGE_UNRESOLVED=1
fi

echo "── File guard ────────────────────────────────────────────────"
NAMES="$WORK_NAMES"
: > "$NAMES"
git diff --cached --name-only --diff-filter=ACMR -z 2>/dev/null >> "$NAMES" || true
if [ ! -s "$NAMES" ]; then
  git ls-files --modified --others --exclude-standard -z 2>/dev/null >> "$NAMES" || true
fi
# A .env or key sitting in an unpushed commit is exactly what must not be
# published. Walk the commits rather than diff the endpoints, so a file added
# and later deleted inside the range is still caught.
if [ -n "$OUTGOING_RANGE" ]; then
  git log --diff-merges=first-parent --name-only --diff-filter=ACMR \
    --pretty=format: -z "$OUTGOING_RANGE" 2>/dev/null >> "$NAMES" || true
fi

PROHIBITED_HITS=()
while IFS= read -r -d '' f; do
  [ -z "$f" ] && continue
  case "$f" in
    .env.example|*/.env.example) continue ;;  # allowed
    .env|.env.*|*/.env|*/.env.*) PROHIBITED_HITS+=("$f") ;;
    *.key|*.pem|*.p12|*.pfx)     PROHIBITED_HITS+=("$f") ;;
    credentials.json|*/credentials.json) PROHIBITED_HITS+=("$f") ;;
    service-account*.json|*/service-account*.json) PROHIBITED_HITS+=("$f") ;;
    id_rsa|*/id_rsa|id_dsa|*/id_dsa|id_ed25519|*/id_ed25519) PROHIBITED_HITS+=("$f") ;;
  esac
done < "$NAMES"

if [ "${#PROHIBITED_HITS[@]}" -eq 0 ]; then
  mark_ok "no prohibited files staged"
else
  mark_fail "prohibited files staged: ${PROHIBITED_HITS[*]}"
fi

# ─────────────────────────────────────────────────────────────────
# 2. .gitignore guard
# ─────────────────────────────────────────────────────────────────
echo "── .gitignore guard ─────────────────────────────────────────"
if [ -f .gitignore ]; then
  REQUIRED=(".env" "node_modules" "dist" "*.key" "*.pem")
  MISSING=()
  for needle in "${REQUIRED[@]}"; do
    if ! grep -Fxq "$needle" .gitignore && ! grep -Eq "(^|/)${needle//./\\.}(/|$)" .gitignore; then
      MISSING+=("$needle")
    fi
  done
  if [ "${#MISSING[@]}" -eq 0 ]; then
    mark_ok ".gitignore covers required paths"
  else
    mark_fail ".gitignore missing entries: ${MISSING[*]}"
  fi
else
  mark_skip "no .gitignore in repo root"
fi

# ─────────────────────────────────────────────────────────────────
# 3-6. npm scripts (lint / typecheck / test / build)
# ─────────────────────────────────────────────────────────────────
has_npm_script() {
  [ -f package.json ] && node -e "
    const p = require('./package.json');
    process.exit(p.scripts && p.scripts['$1'] ? 0 : 1);
  " 2>/dev/null
}

if [ -f package.json ]; then
  echo "── npm scripts ──────────────────────────────────────────────"
  if has_npm_script lint; then
    run_step "npm run lint" npm run lint --silent
  else
    mark_skip "npm run lint (script not defined)"
  fi
  if has_npm_script typecheck; then
    run_step "npm run typecheck" npm run typecheck --silent
  else
    mark_skip "npm run typecheck (script not defined)"
  fi
  if has_npm_script test; then
    CI=1 run_step "npm test" npm test --silent
  else
    mark_skip "npm test (script not defined)"
  fi
  if has_npm_script build; then
    run_step "npm run build" npm run build --silent
  else
    mark_skip "npm run build (script not defined)"
  fi
else
  echo "── npm scripts ──────────────────────────────────────────────"
  mark_skip "no package.json"
fi

# ─────────────────────────────────────────────────────────────────
# 7. Custom regex secret scan
# ─────────────────────────────────────────────────────────────────
echo "── Custom secret scan ───────────────────────────────────────"
if [ -x "$SCAN_SECRETS" ]; then
  SCAN_TARGETS=0
  SCAN_FAILED=0
  # "Nothing staged" is a fact about the index, not about the log. A clean scan
  # also leaves the log empty, so the old test reported real scans as skipped
  # ones — a reassuring message for the case that most deserves attention.
  if ! git diff --cached --quiet 2>/dev/null; then
    SCAN_TARGETS=$((SCAN_TARGETS+1))
    git diff --cached -U0 | "$SCAN_SECRETS" >"$LOG" 2>&1 || SCAN_FAILED=1
  fi
  if [ -n "$OUTGOING_RANGE" ] && [ "$(git rev-list --count "$OUTGOING_RANGE")" -gt 0 ]; then
    SCAN_TARGETS=$((SCAN_TARGETS+1))
    git log -p -U0 --no-color --diff-merges=first-parent "$OUTGOING_RANGE" | "$SCAN_SECRETS" >>"$LOG" 2>&1 || SCAN_FAILED=1
  fi

  if [ "$SCAN_FAILED" = "1" ]; then
    mark_fail "custom regex scanner found secrets"
    sed 's/^/        /' "$LOG"
  elif [ "$RANGE_UNRESOLVED" = "1" ]; then
    mark_fail "cannot determine which commits would be pushed; scan them manually (e.g. git log -p <base>..HEAD | scan-secrets.sh)"
  elif [ "$SCAN_TARGETS" -eq 0 ]; then
    mark_ok "custom regex (nothing staged or unpushed to scan)"
  else
    mark_ok "custom regex (no findings)"
  fi
else
  mark_skip "scan-secrets.sh not executable"
fi

# ─────────────────────────────────────────────────────────────────
# 8. gitleaks
# gitleaks is a Go binary (https://github.com/gitleaks/gitleaks).
# Install: `brew install gitleaks` or download a release binary.
# We don't try npm/npx — there's no first-party npm package.
# ─────────────────────────────────────────────────────────────────
echo "── gitleaks ─────────────────────────────────────────────────"
if command -v gitleaks >/dev/null 2>&1; then
  GITLEAKS_ARGS=(git --staged --redact --no-banner)
  [ -f .gitleaks.toml ] && GITLEAKS_ARGS+=(--config .gitleaks.toml)
  gitleaks "${GITLEAKS_ARGS[@]}" >"$LOG" 2>&1
  rc=$?
  # Same blind spot as the custom scanner: cover the commits about to leave.
  # rc is reassigned inside the branch on purpose — capturing it after the `if`
  # would read the `if` itself, which is 0 even when the staged scan found a leak.
  if [ "$rc" -eq 0 ] && [ -n "$OUTGOING_RANGE" ]; then
    GITLEAKS_RANGE_ARGS=(git --redact --no-banner "--log-opts=$OUTGOING_RANGE")
    [ -f .gitleaks.toml ] && GITLEAKS_RANGE_ARGS+=(--config .gitleaks.toml)
    gitleaks "${GITLEAKS_RANGE_ARGS[@]}" >>"$LOG" 2>&1
    rc=$?
  fi

  case "$rc" in
    0)  mark_ok "gitleaks (no findings)" ;;
    1)  mark_fail "gitleaks reported findings"
        sed 's/^/        /' "$LOG" | tail -n 40 ;;
    *)  mark_fail "gitleaks errored (rc=$rc) — treating an unusable scanner as a failure, not a pass"
        sed 's/^/        /' "$LOG" | tail -n 10 ;;
  esac
else
  mark_skip "gitleaks not installed (install with: brew install gitleaks)"
fi

# ─────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────
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
