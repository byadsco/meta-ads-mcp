# Sensitive patterns reference

Detail for each pattern the guard watches: what it identifies, blast radius if leaked, and a rotation playbook. Use this when you need to explain to the user *why* a finding matters and *how* to recover.

## Meta / Facebook

### `META_APP_SECRET`
- **Regex**: `(?i)META_APP_SECRET\s*=\s*["']?[A-Za-z0-9]{16,}`
- **What**: The Facebook App Secret used in OAuth flows and to verify Meta webhook signatures.
- **Blast radius**: An attacker with `META_APP_ID` + `META_APP_SECRET` can impersonate the application, exchange short-lived tokens, and request user-scoped tokens for anyone who has authorized the app — effectively reading/writing ad accounts on their behalf.
- **Rotation**:
  1. developers.facebook.com → App → Settings → Basic → Reset App Secret.
  2. Update Cloud Run env var (`OAUTH_SECRET` is **different** — don't confuse them).
  3. Notify users that re-auth may be required if you change the OAuth flow at the same time.

### `META_ACCESS_TOKEN` / Long-lived user tokens (`EAA…`)
- **Regex**: `EAA[A-Za-z0-9]{20,}`
- **What**: Meta access tokens. The `EAA` prefix is the Graph API token format.
- **Blast radius**: Direct API access on behalf of the token's owner — read/write campaigns, fetch private insights, post on owned pages.
- **Rotation**: Revoke at developers.facebook.com → Tools → Access Token Debugger → Revoke. The user must re-authorize.

### `META_TOKENS` (multi-tenant map)
- **Regex**: `META_TOKENS\s*=\s*["']?\{[^}]*EAA`
- **What**: JSON map of `{ "agency_a": "EAA...", ... }` for the legacy multi-tenant fallback.
- **Blast radius**: Mass compromise of every advertiser whose token is in the map. Worst-case scenario.
- **Rotation**: Revoke each token individually. Never store this as JSON in code; use Firestore.

## OAuth / session

### `OAUTH_SECRET`
- **Regex**: `(?i)OAUTH_SECRET\s*=\s*["']?[A-Za-z0-9+/=]{32,}`
- **What**: This server's secret for signing MCP OAuth JWTs (`src/auth/oauth-provider.ts`).
- **Blast radius**: An attacker who has this secret can mint valid MCP session tokens for any user the server knows about. Total compromise of the auth boundary.
- **Rotation**:
  1. Generate a new value: `openssl rand -hex 32`.
  2. Set in Cloud Run env var.
  3. **All existing sessions become invalid** — users must re-authorize. Communicate this in advance.

### `OAUTH_APPROVAL_PIN`
- **Regex**: `(?i)OAUTH_APPROVAL_PIN\s*=\s*["']?[A-Za-z0-9]{6,}`
- **What**: Out-of-band approval PIN gating new OAuth client registrations.
- **Blast radius**: Attacker can register arbitrary OAuth clients against the server, increasing attack surface.
- **Rotation**: Generate new random value, update Cloud Run env, communicate to admins via secure channel.

### `SESSION_COOKIE_SECRET`
- **Regex**: `(?i)SESSION_COOKIE_SECRET\s*=\s*["']?[A-Za-z0-9+/=]{32,}`
- **What**: Secret for signing browser session cookies during the Meta OAuth flow.
- **Blast radius**: Forge user sessions during OAuth handshake — can impersonate any in-flight authenticating user.
- **Rotation**: `openssl rand -base64 32` → Cloud Run env. Existing flows in progress will fail and users will need to retry.

## Encryption

### `TOKEN_ENCRYPTION_KEY`
- **Regex**: `(?i)TOKEN_ENCRYPTION_KEY\s*=\s*["']?[A-Fa-f0-9]{64}`
- **What**: AES-256-GCM key encrypting Meta tokens at rest in Firestore (`src/auth/crypto.ts`, `src/auth/token-store.ts`).
- **Blast radius**: **Catastrophic.** With this key, anyone with read access to Firestore can decrypt every advertiser's Meta token. Even if Firestore itself is locked down, the value being public means a future Firestore read (e.g. via a different vulnerability) becomes a token theft.
- **Rotation**:
  1. Generate new key: `openssl rand -hex 32`.
  2. Implement (or use existing) re-encryption migration: read every doc, decrypt with old key, encrypt with new key, write back.
  3. Roll out new key as Cloud Run env var **after** migration completes.
  4. Until the migration runs, treat all existing tokens as compromised — ideally force re-auth.

## Internal API

### `MCP_API_KEY`
- **Regex**: `(?i)MCP_API_KEY\s*=\s*["']?[A-Za-z0-9]{20,}`
- **What**: Service-to-service API key that bypasses OAuth entirely.
- **Blast radius**: Direct access to the MCP tool surface as a fully-authenticated client. No user consent required.
- **Rotation**: Generate new value. Update both server and any client services calling with the old key. Old key invalidated immediately.

## Google Cloud

### `ya29...` OAuth access tokens
- **Regex**: `ya29\.[0-9A-Za-z_-]{30,}`
- **What**: Short-lived Google OAuth access tokens.
- **Blast radius**: Whatever scopes the token had. Often used for `gcloud` CLI tokens — could include project admin access.
- **Rotation**: Tokens expire in 1 hour, but during that hour they're fully valid. Revoke via `gcloud auth revoke` or the OAuth playground. Investigate how it leaked.

### `AIza...` API keys
- **Regex**: `AIza[0-9A-Za-z_-]{35}`
- **What**: Google API keys — Firebase, Maps, generic GCP API access.
- **Blast radius**: Depends on key restrictions. If unrestricted, potentially any GCP API. If restricted, just the allowed APIs but with the project's quota and billing.
- **Rotation**: GCP Console → APIs & Services → Credentials → Regenerate or delete the key. Update consuming code.

### Service account JSON / private keys
- **Regex**: `"private_key":\s*"-----BEGIN` and `-----BEGIN(\s+(RSA|EC|DSA|OPENSSH|PGP))?\s+PRIVATE KEY-----`
- **What**: Any JSON service-account file or raw PEM private key.
- **Blast radius**: Full IAM-bound access to whatever the SA can do. For this project, that includes Firestore (read all tokens), Cloud Run (deploy malicious code), Artifact Registry (push poisoned images).
- **Rotation**: GCP Console → IAM → Service Accounts → revoke the key. Investigate whether it was used. Audit logs in Cloud Logging.

## Other vendor tokens

### GitHub Personal Access Tokens
- **Regex**: `gh[pousr]_[A-Za-z0-9]{36,}` (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`)
- **Blast radius**: Whatever scopes the token has. Often `repo:*` which means write access to all repos the user can access.
- **Rotation**: github.com → Settings → Developer settings → Personal access tokens → Revoke. Investigate.

### AWS access keys
- **Regex**: `AKIA[0-9A-Z]{16}`
- **Blast radius**: Whatever IAM policy is attached to the user/role.
- **Rotation**: IAM Console → Users → Security credentials → Delete the access key. Audit CloudTrail.

## Generic indicators

### `.env` files in staging
Any path matching `(^|/)\.env($|\.)` (excluding `.env.example`) is rejected unconditionally. There is no legitimate reason to commit these.

### Private key blocks
Any line containing `-----BEGIN ... PRIVATE KEY-----` is rejected. Keys belong in secret managers (GCP Secret Manager, AWS Secrets Manager, Vault), not in repos.

---

## After any rotation: post-incident checklist

1. Document the leak in an internal incident report (date, value type, exposure window, suspected/confirmed access).
2. Audit logs for the affected service for the exposure window. Look for unusual access patterns from unfamiliar IPs/UAs.
3. If the value was committed (even to a feature branch that wasn't merged), the value is in `git reflog` and any clone. Force-pushing over the commit is *not* sufficient. Consider the value compromised forever.
4. Update `.gitleaks.toml` and `.github/pre-deploy-guard/scripts/scan-secrets.sh` if the regex didn't catch the leak — file an issue or PR.
