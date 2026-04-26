# Security Policy

`meta-ads-mcp` is a public, open-source server that brokers access to the Meta Marketing API and stores encrypted user tokens. We take security reports seriously and treat any leak of Meta access tokens, the application encryption key, or the OAuth signing secret as critical incidents.

## Reporting a vulnerability

**Please do not open a public GitHub Issue or pull request for security problems.**

Email **[security@byads.co](mailto:security@byads.co)** with:

- A clear description of the vulnerability and the affected component (route, file, function).
- Reproduction steps or a proof of concept (a private gist, a curl recipe, a small repo).
- Your assessment of impact (confidentiality / integrity / availability, blast radius).
- Whether the issue has been disclosed elsewhere and any deadlines you operate under.

If you prefer GitHub's private channel, you can also use **Security → "Report a vulnerability"** on the repo (Private Vulnerability Reporting). Both inboxes are monitored.

We do not currently run a paid bug-bounty program. We do offer **public credit** in this file (see [Acknowledgments](#acknowledgments)) and a written thank-you note from the maintainers.

### Response SLA

| Step | Target |
|------|--------|
| Acknowledge receipt | within **72 hours** |
| Triage + severity assessment | within **5 business days** |
| Fix or mitigation in `main` | within **30 days** for High/Critical, **90 days** for Medium/Low |
| Coordinated public disclosure | after the fix ships, with reporter agreement on timing |

If we miss any of these targets, ping us again on the same thread.

## Supported versions

This project does not yet ship versioned releases. Only the **latest commit on `main`** is supported.

| Version | Supported |
|---------|-----------|
| `main` (latest) | ✅ |
| Anything older  | ❌ |

If we publish tagged releases later, we will update this table to call out which minor versions still receive security fixes.

## Scope

### In scope

The following are always treated as security issues:

- **Authentication bypass** on `/authorize`, `/auth/meta/*`, `/mcp` or any of the OAuth-protected endpoints.
- **Allowlist bypass** — any path that lets a user *not* in `AUTH_ALLOWED_EMAILS` / `AUTH_ALLOWED_DOMAINS` / `AUTH_ALLOWED_FB_USER_IDS` complete a Meta login.
- **Cross-tenant access (IDOR)** — any path where one authenticated user can read, modify or delete another user's encrypted Meta tokens, sessions, or OAuth records.
- **Plaintext leak of Meta access tokens** in logs, error responses, query strings, redirect URLs, Firestore documents, or anywhere else accessible without the encryption key.
- **Compromise of `TOKEN_ENCRYPTION_KEY`, `OAUTH_SECRET`, or `SESSION_COOKIE_SECRET`** through any input vector (env-var injection, log injection, side-channel).
- **CSRF, session fixation, or open redirect** in the OAuth flow.
- **XSS** on the consent page or any HTML the server renders.
- **Server-Side Request Forgery (SSRF)** via any user-controlled URL parameter.
- **Supply-chain compromise** — malicious dependencies, install scripts, or build steps that could land a backdoor.
- **Insecure cryptography** — wrong AES mode, weak randomness, predictable IVs, missing AAD validation.
- **Privilege escalation in the deploy pipeline** — anything that lets a non-maintainer push code, deploy a revision, or read GitHub Actions secrets.

### Out of scope

- Throttling, suspensions, or bans imposed by Meta on your app or ad accounts. The server tries to keep you compliant (see the [Meta API compliance section in the README](README.md#meta-api-compliance)) but the policies are Meta's.
- **Self-XSS** with no cross-user impact.
- Misconfigurations in *your* deployment that this codebase does not cause (e.g. you exposed `/.env` via a reverse proxy, you committed secrets to a fork, you gave the Cloud Run SA `roles/owner`).
- Vulnerabilities in dependencies that are already in the [GitHub Advisory Database](https://github.com/advisories) without a working PoC against this codebase. We track them via Dependabot; please file a PR if you have a fix.
- Denial of service that requires sustained, distributed traffic and is fundamentally a network-layer concern (use Cloud Armor / WAF / rate limits at the edge).
- Reports based purely on automated scanner output without manual validation.
- Best-practice nits without a concrete impact ("CSP could be stricter", "you could add HPKP", etc.) — file them as regular issues.

## Security architecture

The runtime defences below are summarised in the [Security section of the README](README.md#security). For reviewers, the relevant entry points are:

- **Token encryption** — AES-256-GCM at the application layer, before any write to Firestore. Key from `TOKEN_ENCRYPTION_KEY` (32 bytes hex). See [src/auth/crypto.ts](src/auth/crypto.ts).
- **Allowlist enforcement** — every successful Facebook Login callback is checked against `AUTH_ALLOWED_EMAILS`, `AUTH_ALLOWED_DOMAINS`, `AUTH_ALLOWED_FB_USER_IDS` *before* a session is issued. See [src/auth/email-allowlist.ts](src/auth/email-allowlist.ts).
- **Sessions** — `HttpOnly`, `Secure` (in production), `SameSite=Lax` cookies signed with `jose` JWT using `SESSION_COOKIE_SECRET`. See [src/auth/session.ts](src/auth/session.ts).
- **MCP OAuth provider** — implements the MCP OAuth 2.1 spec with PKCE; authorization codes and registered clients persist in Firestore. See [src/auth/oauth-provider.ts](src/auth/oauth-provider.ts).
- **Security headers** — `Strict-Transport-Security` (production), `X-Content-Type-Options=nosniff`, `X-Frame-Options=DENY`, `Referrer-Policy=no-referrer` on every response. The consent page sets a strict `Content-Security-Policy`. See [src/transport/http.ts](src/transport/http.ts).
- **HTTPS-only** — production redirects any `http` request to `https` via the `x-forwarded-proto` header.
- **In-process rate limiting** — `/register` (20 req / 15 min) and `/token` (60 req / 15 min) per IP.
- **Token masking in logs** — `maskToken()` is the only allowed way to refer to a Meta token in logs; raw tokens never appear.
- **Deploy auth** — Workload Identity Federation. **No service-account JSON keys** are ever committed or stored as GitHub secrets.

## Sensitive variables

The following environment variables are treated as hard secrets. If any of them leaks through any channel (commit history, logs, Slack screenshot, browser DevTools, etc.), rotate immediately. The full impact matrix is documented in [CLAUDE.md](CLAUDE.md#sensitive-variables-this-project-handles).

| Variable | Impact if leaked |
|----------|------------------|
| `META_APP_SECRET` | Attacker can impersonate the Meta app and mint OAuth tokens for any user. |
| `META_ACCESS_TOKEN` / `META_TOKENS` | Direct API access on the owner's behalf; mass compromise of every advertiser. |
| `OAUTH_SECRET` | Forge MCP session tokens for any user. |
| `SESSION_COOKIE_SECRET` | Forge in-flight authenticating sessions. |
| `TOKEN_ENCRYPTION_KEY` | Decrypt every Meta token at rest in Firestore. **Catastrophic.** |
| `MCP_API_KEY` | Bypass OAuth entirely. |
| GCP credentials (WIF / service account) | Deploy malicious revisions, read Firestore, escalate via IAM. |

## Pre-commit / pre-push secret scanning

Every PR and every push to `main` runs [gitleaks](https://github.com/gitleaks/gitleaks) with a [project-specific config](.gitleaks.toml) that recognises:

- Meta access tokens (`EAA[A-Za-z0-9]{20,}`).
- The full multi-tenant token map (`META_TOKENS={…EAA…}`).
- Our named secrets (`META_APP_SECRET=`, `OAUTH_SECRET=`, `OAUTH_APPROVAL_PIN=`, `SESSION_COOKIE_SECRET=`, `TOKEN_ENCRYPTION_KEY=`, `MCP_API_KEY=`).
- Google API keys (`AIza…`), OAuth tokens (`ya29.…`), service-account JSON.
- Generic patterns: `-----BEGIN PRIVATE KEY-----`, GitHub PATs (`gh[pousr]_…`), AWS keys (`AKIA…`). <!-- gitleaks:allow -->

The deploy job in [.github/workflows/deploy.yml](.github/workflows/deploy.yml) depends on the preflight job, so a failed scan blocks the deployment.

Maintainers are encouraged to install the local [pre-deploy-guard](.github/pre-deploy-guard.enabled) hook for Claude Code, which runs the same checks before `git commit -m`, `git push`, `gcloud run deploy`, `docker push` and `npm publish`. See the bottom of [CLAUDE.md](CLAUDE.md) for installation instructions.

## Hardening recommendations for self-hosters

If you are running your own deployment, please:

1. **Store secrets in a managed vault** — Google Secret Manager, AWS Secrets Manager, HashiCorp Vault — not as plaintext Cloud Run env vars whenever possible.
2. **Restrict Firestore IAM** — only the Cloud Run runtime service account should hold `roles/datastore.user`. Use a separate database / collection per environment.
3. **Front the service with a WAF** — Cloud Armor, Cloudflare, or equivalent. Cap request size and rate at the edge.
4. **Lock down CORS** — the default `cors()` is permissive for ease of integration; tighten it before exposing the service to untrusted browser clients.
5. **Rotate `TOKEN_ENCRYPTION_KEY` carefully** — the procedure is "decrypt all → set new key → re-encrypt → deploy". Do not change the key without re-encrypting; every existing token will become unreadable.
6. **Rotate Meta app credentials** if `META_APP_SECRET` is ever exposed. The Meta dashboard supports rolling the secret, after which old tokens minted by the leaked secret continue working until they expire — which means treating leaked secrets as a "rotate + audit" event.
7. **Audit your allowlist regularly.** Anyone listed in `AUTH_ALLOWED_*` who leaves the team should be removed *before* their next deploy.
8. **Pin Docker image digests** if you ship to multiple environments — `:latest` is fine for staging, less great for production.
9. **Enable Cloud Run audit logs** and forward them to a SIEM. Pay attention to `event=META_ABUSE_SIGNAL` and `event=meta_circuit_open` from the application logs.

## Coordinated disclosure

When you report something:

1. We acknowledge within 72 hours and ask any clarifying questions on the same thread.
2. We agree on a fix timeline and a coordinated disclosure date.
3. We ship the fix, deploy it, and verify in production.
4. We open a public advisory (GitHub Security Advisory) crediting you by name / handle / pseudonym — your choice. You can also opt out of credit.
5. If the issue affected sensitive runtime state (tokens, secrets), we rotate the affected credentials and notify deployers privately before the public advisory if practical.

We will not pursue legal action against good-faith security researchers who follow this policy. Please do not access data that is not yours, do not run sustained / disruptive scans against production deployments, and do not exfiltrate or retain real user tokens.

## Acknowledgments

We will list contributors here as soon as we have validated reports to credit. Want to be the first?
