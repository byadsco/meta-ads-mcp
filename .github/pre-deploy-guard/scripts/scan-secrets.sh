#!/usr/bin/env bash
# scan-secrets.sh — Custom regex scanner for project-specific secrets.
# Reads input from stdin (a unified diff or file content). Falls back to
# `git diff --cached -U0` whenever stdin yields no bytes.
#
# Exits 0 if nothing was found, 1 if at least one pattern matched.
# Prints matches in a `<file>:<line>: <pattern-name>` style for easy parsing.

set -uo pipefail

# Patterns: name|regex
# Order matters only for reporting — every pattern is checked.
PATTERNS=(
  'meta-app-secret|(^|[^A-Za-z0-9_])META_APP_SECRET[[:space:]]*=[[:space:]]*["'\''"]?[A-Za-z0-9]{16,}'
  'meta-access-token|EAA[A-Za-z0-9]{20,}'
  'oauth-secret|(^|[^A-Za-z0-9_])OAUTH_SECRET[[:space:]]*=[[:space:]]*["'\''"]?[A-Za-z0-9+/=]{32,}'
  'oauth-approval-pin|(^|[^A-Za-z0-9_])OAUTH_APPROVAL_PIN[[:space:]]*=[[:space:]]*["'\''"]?[A-Za-z0-9]{6,}'
  'token-encryption-key|(^|[^A-Za-z0-9_])TOKEN_ENCRYPTION_KEY[[:space:]]*=[[:space:]]*["'\''"]?[A-Fa-f0-9]{64}'
  'session-cookie-secret|(^|[^A-Za-z0-9_])SESSION_COOKIE_SECRET[[:space:]]*=[[:space:]]*["'\''"]?[A-Za-z0-9+/=]{32,}'
  'mcp-api-key|(^|[^A-Za-z0-9_])MCP_API_KEY[[:space:]]*=[[:space:]]*["'\''"]?[A-Za-z0-9]{20,}'
  'meta-tokens-json|(^|[^A-Za-z0-9_])META_TOKENS[[:space:]]*=[[:space:]]*["'\''"]?\{[^}]*EAA'
  'google-oauth-token|ya29\.[0-9A-Za-z_-]{30,}'
  'google-api-key|AIza[0-9A-Za-z_-]{35}'
  'gcp-service-account-key|"private_key":[[:space:]]*"-----BEGIN'
  'private-key-block|-----BEGIN[[:space:]]*(RSA|EC|DSA|OPENSSH|PGP)?[[:space:]]*PRIVATE[[:space:]]*KEY-----'
  'github-token|gh[pousr]_[A-Za-z0-9]{36,}'
  'aws-access-key|AKIA[0-9A-Z]{16}'
)

# Allowlist: skip findings that match these substrings (case-sensitive).
# Mainly to suppress obvious examples / placeholders / stripped redactions.
ALLOWLIST=(
  'EAAabcdefghij'                 # canonical example placeholder
  'EAA[A-Za-z0-9]{20'              # the regex itself if dumped to a file
  'YOUR_'
  'EXAMPLE'
  'placeholder'
  'PLACEHOLDER'
  '<your-'
  'fixture'
  'gitleaks:allow'
)

# Source the diff: piped stdin when there is one, else the staged diff.
WORKDIR="$(mktemp -d -t scan-secrets.XXXXXX)" || {
  echo "scan-secrets: cannot create a working directory; refusing to report clean" >&2
  exit 1
}
trap 'rm -rf "$WORKDIR"' EXIT
INPUT="$WORKDIR/input"
: > "$INPUT"

if [ -p /dev/stdin ] || { [ ! -t 0 ] && [ -f /dev/stdin ]; }; then
  cat > "$INPUT"
fi

# Testing `-t 0` alone was not enough: under an agent, a PreToolUse hook or a CI
# runner, stdin is a closed pipe rather than a TTY, so the read returned nothing
# and an unscanned diff reported clean. Fall back to the index whenever stdin
# produced no bytes, regardless of what kind of handle it was.
if [ ! -s "$INPUT" ] && git rev-parse --git-dir >/dev/null 2>&1; then
  git diff --cached -U0 > "$INPUT" 2>/dev/null || true
fi

if [ ! -s "$INPUT" ]; then
  # Reporting clean while the index holds staged changes is the exact false
  # negative this scanner exists to prevent, so fail closed instead.
  if git rev-parse --git-dir >/dev/null 2>&1 && ! git diff --cached --quiet 2>/dev/null; then
    echo "scan-secrets: no scannable input though the index has staged changes; refusing to report clean" >&2
    exit 1
  fi
  exit 0
fi

# Parse unified diff to track current file and line number per hunk.
# We only check lines that start with '+' (additions) but not the '+++' header.
HITS=0
MAP="$WORKDIR/map"

awk '
  /^diff --git / {
    # Extract b/<path> as the current file.
    n = split($0, parts, " ")
    file = parts[n]
    sub(/^b\//, "", file)
    next
  }
  /^\+\+\+ / {
    # Fallback: +++ b/<file>
    f = $2
    sub(/^b\//, "", f)
    if (f != "/dev/null") file = f
    next
  }
  /^@@ / {
    # @@ -a,b +c,d @@
    match($0, /\+[0-9]+/)
    line = substr($0, RSTART+1, RLENGTH-1) + 0
    in_hunk = 1
    next
  }
  /^---/ { next }
  /^\+\+\+/ { next }
  in_hunk && /^\+/ {
    body = substr($0, 2)
    print file "\t" line "\t" body
    line++
    next
  }
  in_hunk && /^-/ { next }
  in_hunk && /^ / { line++; next }
  { in_hunk = 0 }
' "$INPUT" > "$MAP"

# Absence of diff structure means plain file content, which the docstring
# accepts; scanning nothing and reporting clean is the failure this guard
# exists to prevent. Both a header and a hunk marker are required, so a plain
# file that merely contains a diff-looking line still gets scanned in full.
# Judging by the parse being empty instead would misread a deletion-only diff
# as plain text and flag the very removal of a secret.
if ! { grep -qE '^(diff --git |--- )' "$INPUT" && grep -qE '^@@ ' "$INPUT"; }; then
  awk '{ print "(stdin)\t" NR "\t" $0 }' "$INPUT" > "$MAP"
fi

while IFS=$'\t' read -r FILE HIT_LINE BODY; do
  # Skip allowlisted contents.
  skip=0
  for needle in "${ALLOWLIST[@]}"; do
    if printf '%s' "$BODY" | grep -qF -- "$needle"; then
      skip=1
      break
    fi
  done
  [ "$skip" = "1" ] && continue

  # Skip if path is .env.example, tests fixtures, or vendored.
  case "$FILE" in
    .env.example|*/.env.example) continue ;;
    package-lock.json|*/package-lock.json) continue ;;
    *.lock|yarn.lock|pnpm-lock.yaml) continue ;;
    # Self-references: the gitleaks config and this script declare the
    # very regex shapes we look for as PATTERNS. Skip them so a doc-only
    # change to either doesn't trigger a guard against itself.
    .gitleaks.toml|*/.gitleaks.toml) continue ;;
    scan-secrets.sh|*/scan-secrets.sh) continue ;;
  esac

  for entry in "${PATTERNS[@]}"; do
    NAME="${entry%%|*}"
    RE="${entry#*|}"
    if printf '%s' "$BODY" | grep -E -q -- "$RE"; then
      printf '%s:%s: %s\n' "$FILE" "$HIT_LINE" "$NAME"
      HITS=$((HITS+1))
    fi
  done
done < "$MAP"

if [ "$HITS" -gt 0 ]; then
  echo ""
  echo "scan-secrets: $HITS finding(s) in staged diff"
  exit 1
fi
exit 0
