#!/usr/bin/env bash
# hook-gate.sh — PreToolUse hook entrypoint for Claude Code.
#
# Reads the tool-invocation JSON from stdin. If the call is a Bash command
# performing `git commit` (with -m/--message/-am), `git push`, or one of a
# few deploy commands *inside an opted-in repo*, this script runs the
# pre-deploy validation suite. If anything fails, it emits a JSON
# `permissionDecision: "deny"` so Claude cannot run the action.
#
# Opt-in mechanism (any of):
#   - the repo contains a marker file `.github/pre-deploy-guard.enabled`
#
# Anywhere else: silently allow (exit 0 with empty JSON).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_FULL="$SCRIPT_DIR/run-checks.sh"
RUN_QUICK="$SCRIPT_DIR/quick-checks.sh"

allow_silent() {
  printf '{}\n'
  exit 0
}

# Emits a deny-decision JSON. The reason text comes from $REASON_FILE so we
# don't have to escape it for the shell.
deny_with_reason_file() {
  local reason_file="$1"
  REASON_FILE="$reason_file" python3 - <<'PY'
import json, os, sys
path = os.environ.get("REASON_FILE", "")
try:
    with open(path, "r") as f:
        reason = f.read()[:3500]
except Exception:
    reason = "pre-deploy-guard blocked the command (reason file unavailable)."
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }
}))
PY
  exit 0
}

deny_with_text() {
  local text="$1"
  local f
  f="$(mktemp -t pdg-reason.XXXXXX)" || {
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"pre-deploy-guard blocked this command and could not write the reason file."}}\n'
    exit 0
  }
  printf '%s' "$text" > "$f"
  trap 'rm -f "$f"' EXIT
  deny_with_reason_file "$f"
}

# ── 1. Read tool input ──────────────────────────────────────────────
if [ -t 0 ]; then
  allow_silent
fi

INPUT="$(cat)"
[ -z "$INPUT" ] && allow_silent

# Parse tool_name and tool_input.command via python. We write the result to a
# temp file with a header line for the tool name and the rest of the file as
# the verbatim command (preserves any newlines).
PARSE_OUT="$(mktemp -t pdg-parse.XXXXXX)" || deny_with_text \
  "pre-deploy-guard: could not create a temp file to inspect this command. Refusing to allow it unvalidated; free some disk/TMPDIR space and retry."
printf '%s' "$INPUT" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
tool = (data.get("tool_name") or "").strip()
cmd  = ""
ti   = data.get("tool_input")
if isinstance(ti, dict):
    cmd = ti.get("command") or ""
with open(sys.argv[1], "w") as f:
    f.write(tool + "\n")
    f.write(cmd)
' "$PARSE_OUT" 2>/dev/null

if [ ! -s "$PARSE_OUT" ]; then
  rm -f "$PARSE_OUT"
  allow_silent
fi

TOOL_NAME="$(head -n 1 "$PARSE_OUT")"
COMMAND="$(tail -n +2 "$PARSE_OUT")"
rm -f "$PARSE_OUT"

[ "$TOOL_NAME" = "Bash" ] || allow_silent
[ -z "$COMMAND" ] && allow_silent

# ── 2. Decide which gate to run based on the command ────────────────
MODE=""
case "$COMMAND" in
  *"git commit"*"-m"*|*"git commit"*"--message"*|*"git commit"*"-am"*|*"git commit"*"-a -m"*)
    MODE="quick" ;;
  *"git push"*)
    MODE="full" ;;
  *"gcloud run deploy"*|*"gcloud run services replace"*|*"gcloud run services update"*"--image"*)
    MODE="full" ;;
  *"docker push"*)
    MODE="full" ;;
  *"npm publish"*|*"pnpm publish"*|*"yarn publish"*)
    MODE="full" ;;
  *)
    allow_silent ;;
esac

# ── 3. Determine if cwd opted in ────────────────────────────────────
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -z "$ROOT" ] && allow_silent

if [ ! -f "$ROOT/.github/pre-deploy-guard.enabled" ]; then
  allow_silent
fi

# Only after opt-in: blocking this globally would make the hook anything but
# inert in the user's other repositories.
case "$COMMAND" in
  *"--no-verify"*)
    deny_with_text "pre-deploy-guard: refusing to run a git command with --no-verify in this repo. It bypasses local validation and can leak secrets. Re-run without --no-verify and let the guard finish its checks." ;;
esac

# ── 4. Run the gate ─────────────────────────────────────────────────
cd "$ROOT" || allow_silent
OUT="$(mktemp -t pdg-out.XXXXXX)" || deny_with_text \
  "pre-deploy-guard: could not create a temp file for the validation output. Refusing to allow this command unvalidated."
trap 'rm -f "$OUT"' EXIT

if [ "$MODE" = "quick" ]; then
  bash "$RUN_QUICK" >"$OUT" 2>&1
  RC=$?
else
  bash "$RUN_FULL" >"$OUT" 2>&1
  RC=$?
fi

if [ "$RC" -eq 0 ]; then
  allow_silent
fi

REASON_FILE="$(mktemp -t pdg-reason.XXXXXX)" || deny_with_text \
  "pre-deploy-guard blocked this command; the validation output could not be written to a temp file."
{
  printf 'pre-deploy-guard blocked this command (mode=%s) in %s.\n\n' "$MODE" "$ROOT"
  printf 'This repo is public; nothing should ship until validation passes.\n\n'
  printf 'Validation output (tail):\n\n'
  tail -c 2400 "$OUT"
  printf '\n\nResolve the failures above. Do NOT bypass with --no-verify; if a finding is a false positive, update .gitleaks.toml allowlist or the underlying code. To re-run manually:\n'
  printf '  bash %s    # quick (pre-commit)\n' "$RUN_QUICK"
  printf '  bash %s    # full (pre-push / pre-deploy)\n' "$RUN_FULL"
} > "$REASON_FILE"

trap 'rm -f "$OUT" "$REASON_FILE"' EXIT
deny_with_reason_file "$REASON_FILE"
