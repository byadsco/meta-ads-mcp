# pre-deploy-guard

Local validation that runs before a commit, push or deploy leaves your machine.

This repo is public and a push to `main` deploys to Cloud Run, so a leaked token is permanent and a broken commit ships. [CI](../workflows/ci.yml) catches both server-side; this guard catches them seconds earlier, before anything is published.

## Run it without Claude Code

The scripts are plain bash and need no agent:

```bash
bash .github/pre-deploy-guard/scripts/quick-checks.sh   # before a commit  (~10s)
bash .github/pre-deploy-guard/scripts/run-checks.sh     # before a push    (1-5 min)
```

Both exit non-zero on any finding and print a `PASS / FAIL / SKIP` summary naming each failure.

| Check | quick | full |
|---|:--:|:--:|
| Prohibited files staged (`.env`, `*.key`, `*.pem`, service accounts) | ● | ● |
| `.gitignore` covers those paths | | ● |
| Custom regex secret scan ([scan-secrets.sh](scripts/scan-secrets.sh)) | ● | ● |
| gitleaks on the staged diff | ● | ● |
| `npm run lint` / `typecheck` / `test` / `build` | typecheck only | ● |

Requires [gitleaks](https://github.com/gitleaks/gitleaks) (`brew install gitleaks`); the step is skipped with a warning if it is absent.

## Install the Claude Code integration

```bash
cp -r .github/pre-deploy-guard ~/.claude/skills/
cp .github/pre-deploy-guard/agent.md ~/.claude/agents/pre-deploy-guard.md
```

Then register the hook in `~/.claude/settings.json`:

```json
"hooks": {
  "PreToolUse": [
    {
      "matcher": "Bash",
      "hooks": [
        { "type": "command", "command": "/Users/<you>/.claude/skills/pre-deploy-guard/scripts/hook-gate.sh" }
      ]
    }
  ]
}
```

[hook-gate.sh](scripts/hook-gate.sh) intercepts `git commit -m`, `git push`, `gcloud run deploy`, `docker push` and `npm publish`, runs the matching mode, and denies the call with the failure output when anything fails. It also refuses any guarded command carrying `--no-verify`.

**Opt-in is per repo**, via the marker file `.github/pre-deploy-guard.enabled`. That file is committed here, so the hook is active in this repo and silently inert everywhere else — installing it will not interfere with your other projects.

## What it looks for

[references/sensitive-patterns.md](references/sensitive-patterns.md) documents every pattern: what it identifies, the blast radius if it leaks, and a rotation playbook. Read it when a finding lands — rotation order matters, and for `TOKEN_ENCRYPTION_KEY` a re-encryption migration has to run before the new key is deployed.

Two independent layers scan for secrets, deliberately: gitleaks with the repo [.gitleaks.toml](../../.gitleaks.toml) (`EAA` tokens from 40 chars, to stay quiet on test fixtures) and the custom scanner (from 20 chars, tighter). A finding from either one blocks.

## If the guard fails

Fix the cause. Never `--no-verify`, never `git push -f` over a finding.

A secret finding means the value is **already compromised**, even if the commit never lands — local environments leak through swap, IDE indexes and container logs. Rotate at the source first, then remove the value from the working tree, then re-stage and re-run.

For a genuine false positive, add a precise rule to the `.gitleaks.toml` allowlist or to the `ALLOWLIST` array in [scan-secrets.sh](scripts/scan-secrets.sh), and include that change in the same review so it gets scrutiny.
