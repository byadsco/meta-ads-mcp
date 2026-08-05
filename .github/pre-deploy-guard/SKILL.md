---
name: pre-deploy-guard
description: Use BEFORE running git commit, git push, gcloud run deploy, docker push, or npm publish on a public/open-source repo. Verifies lint, typecheck, tests and build pass AND that no sensitive data (API keys, tokens, .env files, credentials, private keys) is being committed. ALWAYS invoke this skill when the user mentions committing, pushing, deploying, releasing, or shipping code on this repo (meta-ads-mcp) or any repo that has `.github/pre-deploy-guard.enabled`. Critical safety check; do not skip even for "small" or "doc-only" changes — secrets routinely leak through README edits, debug logs, or test fixtures.
---

# Pre-deploy Guard

This skill protects public open-source repositories from two preventable disasters:

1. **Secret leakage** — once a token, API key or credential is pushed to a public branch, treat it as compromised forever. Rotation is mandatory; deletion of history is best-effort.
2. **Broken main** — for `meta-ads-mcp` specifically, a push to `main` triggers a Cloud Run deploy. There is no PR gate by default, so a broken commit ships to production.

The skill works in concert with three other pieces; understand the picture before touching them:

| Layer | What it does | Where it lives |
|---|---|---|
| `CLAUDE.md` rule | Stating the policy so any agent reading the repo follows it | committed in repo root |
| **This skill** | The playbook for *how* to validate when about to commit/push/deploy | `~/.claude/skills/pre-deploy-guard/` |
| `pre-deploy-guard` agent | A subagent that runs the same audit and returns a structured report | `~/.claude/agents/pre-deploy-guard.md` |
| Hook (`hook-gate.sh`) | PreToolUse hook that *blocks* offending Bash calls | `~/.claude/settings.json` |
| `ci.yml` workflow | Server-side defense that runs on every PR/push | `.github/workflows/ci.yml` |

## When to activate

Activate this skill **before** Claude executes any of the following Bash patterns:

- `git commit -m …`, `git commit -am …`, `git commit --message …`
- `git push …` (any remote)
- `gcloud run deploy …`, `gcloud run services replace …`
- `docker push …`
- `npm publish`, `pnpm publish`, `yarn publish`
- `gh pr merge …` (publishing the work)

The hook will *also* try to block these calls automatically — but the skill exists so Claude understands *why* the block happened, *what* to do, and how to handle false positives without bypassing safety.

If the user says things like "commit and push", "ship it", "deploy", "release", "merge to main": activate this skill **before** you start running git/deploy commands.

## Two modes

| Mode | When | Script | What it runs |
|---|---|---|---|
| **quick** | before `git commit -m` | `scripts/quick-checks.sh` | file guard, custom regex secret scan, gitleaks --staged, typecheck. Target <10s. |
| **full** | before `git push`, `gcloud run deploy`, `docker push`, `npm publish` | `scripts/run-checks.sh` | quick checks **plus** lint, full test suite, build. Can take 1-5 min. |

Default to **quick** for commits and **full** for pushes/deploys. If the diff being committed is large (>500 LOC) or touches `src/auth/`, `src/transport/security-config.ts`, or other security surface, escalate to **full** even on commit.

## Procedure

1. **Identify mode** from the user intent (commit → quick; push/deploy/publish → full).
2. **Run the script** from the repo root:

   ```bash
   bash ~/.claude/skills/pre-deploy-guard/scripts/quick-checks.sh
   # or
   bash ~/.claude/skills/pre-deploy-guard/scripts/run-checks.sh
   ```

   These scripts auto-detect git repo, package.json, and tsconfig presence. They're safe to run on any project (no-op outside git repos).

3. **Read the summary block at the bottom** (`PASS / FAIL / SKIP` counts plus a `Blocking failures` list when applicable). Each failure is named so you can map it back to a fix.

4. **If exit code is 0** → report briefly to the user ("pre-deploy-guard: all checks passed (mode=quick)") and proceed with the original git/deploy command.

5. **If exit code is non-zero** → STOP. Do **not** attempt to bypass with `--no-verify`, `git push -f`, or any other escape hatch. Report the failures to the user. Then:

   - **If failure is `prohibited files staged`** (e.g. `.env`, `*.key`): the user almost certainly added it by mistake. Suggest `git restore --staged <file>` and ensure it's covered by `.gitignore`. Do **not** delete the file from disk without confirming.
   - **If failure is a secret detection** (`gitleaks reported findings` or `custom regex scanner found secrets`): treat the secret as **already compromised** even if the commit hasn't landed yet — local environments leak through swap, IDE indexes, container logs. Tell the user to:
     1. Rotate the credential at the source (Meta App console, OAuth provider, GCP IAM, etc.).
     2. Then remove the value from the working tree (use a placeholder or load from `.env`).
     3. Then re-stage and re-run the guard.
     The skill `references/sensitive-patterns.md` has rotation playbooks per credential type.
   - **If failure is `npm run lint` / `typecheck` / `test` / `build`**: it's a regular CI failure. Investigate, fix the underlying issue, re-run the guard.

6. **For false positives** (gitleaks flags a value that genuinely isn't a secret): edit `.gitleaks.toml` `[allowlist]` and add a precise pattern or path-level exclusion. Commit that change as part of the same review. **Never** add `--no-verify` or globally disable a rule.

## When to delegate to the agent

If the diff is large (rough rule of thumb: >500 added lines, or touches >15 files), invoke the `pre-deploy-guard` subagent with the Agent tool instead of running the script in the foreground:

```
Agent({
  description: "Pre-deploy audit",
  subagent_type: "pre-deploy-guard",
  prompt: "Audit the staged changes on branch <name> in <path-to>/meta-ads-mcp. Run the full validation. Report PASS/FAIL with findings."
})
```

The subagent runs in its own context window, so its output (which can be very long for big diffs) doesn't pollute the main conversation. The subagent returns a single structured report you can relay to the user.

## Patterns watched

The custom regex scanner (`scripts/scan-secrets.sh`) watches for these in the staged diff. Full descriptions in `references/sensitive-patterns.md`.

| Name | Matches | Why it matters |
|---|---|---|
| `META_APP_SECRET=` | Meta app secret assignment | Lets attacker impersonate the app, mint OAuth tokens for any user. |
| `EAA[A-Za-z0-9]{20,}` | Meta long-lived access token | Reads/writes ad accounts on the user's behalf. |
| `OAUTH_SECRET=` | This server's JWT signing key | Attacker can mint MCP session tokens for any user. |
| `TOKEN_ENCRYPTION_KEY=` (64 hex) | AES-256-GCM key for tokens-at-rest | Decrypts every Meta token in Firestore. |
| `SESSION_COOKIE_SECRET=` | Cookie signing secret | Forge user sessions. |
| `MCP_API_KEY=` | Service-to-service key | Bypass OAuth entirely. |
| `META_TOKENS` (JSON map of `EAA…` tokens) | Multi-tenant token map | Mass compromise. |
| `ya29\....` | Google OAuth access token | GCP API access. |
| `AIza[A-Za-z0-9_-]{35}` | Google API key | GCP/Firebase API access. |
| `-----BEGIN … PRIVATE KEY-----` | Any private key block | Service account, RSA, EC keys. |
| `gh[pousr]_` | GitHub PAT/app token | Repo write/admin. |
| `AKIA[0-9A-Z]{16}` | AWS access key | Cloud account access. |

Plus everything `gitleaks` default ruleset catches (Stripe, Slack, Twilio, Datadog, etc.).

The custom scanner skips `.env.example`, lock files, `.gitleaks.toml` and itself by path, and skips any line containing `fixture`, `placeholder`, `YOUR_` or `gitleaks:allow`. There is no blanket `tests/**` exemption — a realistic-looking fixture must carry one of those markers. gitleaks honours the `.gitleaks.toml` allowlist.

## Why this matters (so you can explain to the user)

`meta-ads-mcp` is a public OSS server that holds Meta API tokens for many advertisers. The threat model is clear:

- **`META_APP_SECRET` leak**: Meta forces app re-auth, every user must reconnect. Ops nightmare.
- **`OAUTH_SECRET` leak**: every issued MCP session token is forgeable. All users must be invalidated.
- **`TOKEN_ENCRYPTION_KEY` leak**: Firestore is now plaintext. Every advertiser's tokens are exposed. Catastrophic.
- **GCP service account leak**: attacker can deploy malicious revisions to Cloud Run, read Firestore directly, escalate via IAM.

These aren't hypothetical: credential leaks through public repositories are common enough that GitHub runs secret scanning by default. Treat the guard as the last line of defense between Claude and a postmortem.

## Files in this skill

```
~/.claude/skills/pre-deploy-guard/
├── SKILL.md                            # this file
├── scripts/
│   ├── run-checks.sh                   # full audit
│   ├── quick-checks.sh                 # fast pre-commit audit
│   ├── scan-secrets.sh                 # custom regex scanner
│   └── hook-gate.sh                    # PreToolUse hook entrypoint
└── references/
    └── sensitive-patterns.md           # detail per pattern + rotation playbooks
```
