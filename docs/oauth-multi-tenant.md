# OAuth multi-tenant flow

End-to-end walkthrough of how an AI client (Claude, Cursor, Continue, …) signs
in **a new advertising-agency client** to a single deployment of Meta Ads MCP,
and how every subsequent tool call is routed to that client's own Meta token.

This is the doc to read if you're integrating an MCP client against
`https://<SERVER_URL>/mcp` or operating a deployment that serves multiple
agencies / advertisers from the same instance.

## TL;DR — the 8-step recipe

1. **MCP client discovers** the server via
   `GET /.well-known/oauth-authorization-server`.
2. **MCP client registers itself** with `POST /register` (Dynamic Client
   Registration, RFC 7591).
3. **MCP client opens** `GET /authorize?response_type=code&client_id=…&code_challenge=…&code_challenge_method=S256` in a browser.
4. The server redirects the browser to **Facebook Login** at `/auth/meta`.
5. User approves Facebook permissions; FB redirects to `/auth/meta/callback`,
   the server **exchanges code → long-lived token**, validates against the
   allowlist, **encrypts the token (AES-256-GCM)** and stores it in Firestore.
6. The browser lands on `/authorize` (consent UI). User clicks **Approve**.
7. The server redirects to the MCP client's `redirect_uri` with `?code=…`.
8. MCP client calls `POST /token` with the PKCE verifier; receives a signed
   MCP **access token** (JWT). It uses this on every `POST /mcp` request.

From this point on, **`AsyncLocalStorage`** in
[src/auth/token-store.ts](../src/auth/token-store.ts) resolves the right Meta
token per request and threads it transparently into every Graph API call.

## Sequence diagram

```mermaid
sequenceDiagram
    autonumber
    participant Client as AI client (Claude/Cursor)
    participant MCP as Meta Ads MCP
    participant FB as Facebook Login
    participant FS as Firestore (encrypted)

    Client->>MCP: GET /.well-known/oauth-authorization-server
    MCP-->>Client: { authorization_endpoint, token_endpoint, registration_endpoint, … }

    Client->>MCP: POST /register (DCR — RFC 7591)
    MCP-->>Client: { client_id, client_secret? }

    Client->>MCP: GET /authorize?response_type=code&client_id=…&code_challenge=…
    MCP-->>Client: 302 → /auth/meta?return=…

    Client->>FB: GET FB login + consent
    FB-->>MCP: 302 /auth/meta/callback?code=…

    MCP->>FB: GET /v26.0/oauth/access_token?code=…
    FB-->>MCP: short-lived token
    MCP->>FB: GET /v26.0/oauth/access_token?fb_exchange_token=…
    FB-->>MCP: long-lived (60-day) token
    MCP->>FB: GET /me?fields=id,email
    FB-->>MCP: { id, email }
    Note over MCP: allowlist check (email/domain/fbUserId)
    MCP->>FS: encrypt(token) + upsert by fbUserId
    MCP-->>Client: 302 → /authorize (consent UI)

    Client->>MCP: POST /authorize (Approve)
    MCP-->>Client: 302 → redirect_uri?code=…

    Client->>MCP: POST /token (code + code_verifier)
    MCP-->>Client: { access_token: <JWT>, refresh_token, expires_in }

    Client->>MCP: POST /mcp (Bearer <JWT>) tools/call
    Note over MCP: middleware → ALS context → Meta token resolved
    MCP->>FB: Graph API call with that user's Meta token
    FB-->>Client: result
```

## Discovery — what `/.well-known` returns

```bash
curl -s "https://mcp.example.com/.well-known/oauth-authorization-server" | jq
```

```json
{
  "issuer": "https://mcp.example.com",
  "authorization_endpoint": "https://mcp.example.com/authorize",
  "token_endpoint": "https://mcp.example.com/token",
  "registration_endpoint": "https://mcp.example.com/register",
  "revocation_endpoint": "https://mcp.example.com/revoke",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic", "none"]
}
```

Resource-server discovery (RFC 9728) is exposed at
`/.well-known/oauth-protected-resource` and points back at the same
authorization server.

## Step-by-step with cURL

### 1. Register a new MCP client (DCR)

```bash
curl -sX POST "https://mcp.example.com/register" \
  -H "Content-Type: application/json" \
  -d '{
    "client_name": "My AI Agent",
    "redirect_uris": ["https://my-agent.example.com/oauth/callback"],
    "grant_types": ["authorization_code", "refresh_token"],
    "response_types": ["code"],
    "token_endpoint_auth_method": "none"
  }' | jq
```

```json
{
  "client_id": "mcp_8f3a91…",
  "client_id_issued_at": 1716480000,
  "client_name": "My AI Agent",
  "redirect_uris": ["https://my-agent.example.com/oauth/callback"],
  "token_endpoint_auth_method": "none",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"]
}
```

`/register` is rate-limited to **20 requests / 15 min** per IP — see
[src/transport/http.ts:629](../src/transport/http.ts).

### 2. Send the user to `/authorize`

```text
https://mcp.example.com/authorize
  ?response_type=code
  &client_id=mcp_8f3a91…
  &redirect_uri=https://my-agent.example.com/oauth/callback
  &code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
  &code_challenge_method=S256
  &state=opaque-csrf-value
```

The handler:

1. Validates `client_id` + `redirect_uri` against the registered client (no
   open-redirect possible — see
   [src/transport/authorize-validation.ts](../src/transport/authorize-validation.ts)).
2. If the user is not yet signed in with Meta, redirects to
   `/auth/meta?return=/authorize?…` and runs the Facebook Login dance.
3. Renders the consent page once Meta auth is complete. The user clicks
   **Approve** and the form `POST`s back to `/authorize`.
4. Server issues a one-time auth code (10-minute TTL, hex-32 random) and
   redirects to `redirect_uri?code=…&state=…`.

### 3. Exchange the code for an MCP token

```bash
curl -sX POST "https://mcp.example.com/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "code=$AUTH_CODE" \
  --data-urlencode "client_id=mcp_8f3a91…" \
  --data-urlencode "redirect_uri=https://my-agent.example.com/oauth/callback" \
  --data-urlencode "code_verifier=$PKCE_VERIFIER" | jq
```

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiJ9…",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "eyJhbGciOiJIUzI1NiJ9…"
}
```

The `access_token` is a JWT signed with `OAUTH_SECRET` (audience
`mcp-oauth-access`). The MCP client puts it in `Authorization: Bearer …` on
every subsequent `POST /mcp`.

`/token` is rate-limited to **60 requests / 15 min** per IP.

### 4. Call MCP tools

```bash
curl -sX POST "https://mcp.example.com/mcp" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9…" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "ads_get_ad_accounts",
      "arguments": {}
    }
  }'
```

The Bearer JWT carries the `fbUserId`. The middleware looks up that user's
encrypted Meta token in Firestore, decrypts it, and stashes it in
`AsyncLocalStorage`. Every Graph API call inside the handler picks it up
implicitly:

```ts
// src/auth/token-store.ts
export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getAccessToken(): string {
  const ctx = requestContext.getStore();
  if (ctx?.accessToken) return ctx.accessToken;          // 1. per-request

  const managerToken = tokenManager.getActiveToken();
  if (managerToken) return managerToken;                  // 2. multi-token registry

  const envToken = process.env.META_ACCESS_TOKEN;
  if (envToken) return envToken;                          // 3. env-var fallback

  throw new Error("No Meta access token available. …");
}
```

That's the multi-tenant guarantee in 14 lines: **N agencies signed in →
N encrypted tokens in Firestore → AsyncLocalStorage picks the right one per
request → zero cross-tenant leakage**.

## Provisioning a new client / agency

To add a new advertising agency to a running deployment, the operator does:

1. **Add identity to the allowlist**. At least one of:
   - `AUTH_ALLOWED_EMAILS=ops@agency-a.com,ops@agency-b.com`
   - `AUTH_ALLOWED_DOMAINS=agency-a.com,agency-b.com`
   - `AUTH_ALLOWED_FB_USER_IDS=10220000000000001,10220000000000002`
2. **Restart Cloud Run** (or hot-reload via env vars) — the value is read
   at startup.
3. **Send the user the connect URL**: `https://mcp.example.com/mcp` (or
   the consent page directly: `https://mcp.example.com/authorize` to test).
4. The user signs in with Facebook → consent → done.
   Their long-lived (60-day) token lives encrypted in Firestore at
   `meta_tokens/<fbUserId>` and **never touches plaintext storage**.

If the agency wants a **non-expiring System User token** instead of a
60-day user token, after the first OAuth login they can open the consent
page and use the **"Registrar System User token"** form, which posts to
`/auth/register-system-token`. The token is validated against
`/me` on Graph API, encrypted and saved alongside the user token. Switch the
active token from the same UI.

The same page, also reachable as `/auth/connections`, is where a user
registers the two credentials that the paid tools need: an **Apify token**
for the `ads_library_*` scraping tools and a **Gemini API key** for
`ads_analyze_video`. Each is validated against its provider with a short
timeout, encrypted with the same AES-256-GCM layer under its own AAD
namespace, and stored per user; the tool calls then resolve the credential
from the OAuth identity of the caller and fail closed when there is none, so
one advertiser's scrapes and analyses are never billed to another's account.
The registration posts are same-origin only and rate-limited, because each
one makes an outbound validation call. The equivalent MCP tools are
`ads_library_register_apify_token` and `ads_register_gemini_key`, with a
status and a delete tool for each.

## Token lifecycle and rotation

| Event | What the server does |
|-------|----------------------|
| First sign-in | Exchanges short-lived → long-lived (60 days), encrypts, stores. |
| Subsequent sign-in within 60 days | Auto-extends the long-lived token. |
| Tool call | Resolves token via ALS, **never logs plaintext** (`maskToken()`). |
| Token expired | Tool returns 401 with hint to re-authenticate via `/authorize`. |
| `TOKEN_ENCRYPTION_KEY` rotation | Decrypt-with-old → re-encrypt-with-new → deploy. **Never deploy a new key without re-encrypting first** — every existing token becomes unreadable. |

## Endpoints reference

All endpoints are mounted in [src/transport/http.ts](../src/transport/http.ts)
via `mcpAuthRouter()` from the official MCP SDK plus custom handlers:

| Path | Method | Provided by | Purpose |
|------|--------|-------------|---------|
| `/.well-known/oauth-authorization-server` | GET | `mcpAuthRouter` | RFC 8414 discovery |
| `/.well-known/oauth-protected-resource` | GET | `mcpAuthRouter` | RFC 9728 discovery |
| `/register` | POST | `mcpAuthRouter` (RFC 7591) | DCR, 20 req / 15 min |
| `/authorize` | GET / POST | custom | Consent + Meta login bridge |
| `/auth/meta` | GET | custom | Kick off Facebook Login |
| `/auth/meta/callback` | GET | custom | Exchange FB code → long-lived token |
| `/auth/register-system-token` | POST | custom | Persist System User token |
| `/auth/select-token` | POST | custom | Choose which stored Meta token is active |
| `/auth/delete-token` | POST | custom | Remove a stored Meta token |
| `/auth/connections` | GET | custom | Connections page: Meta tokens, Apify token, Gemini key |
| `/auth/register-apify-token` | POST | custom | Validate and store the user's Apify token (encrypted); same-origin, rate-limited |
| `/auth/delete-apify-token` | POST | custom | Remove the stored Apify token |
| `/auth/register-gemini-key` | POST | custom | Validate and store the user's Gemini key (encrypted); same-origin, rate-limited |
| `/auth/delete-gemini-key` | POST | custom | Remove the stored Gemini key |
| `/auth/logout` | POST | custom | End the browser session |
| `/token` | POST | `mcpAuthRouter` | Code → JWT exchange, 60 req / 15 min |
| `/revoke` | POST | `mcpAuthRouter` | Revoke MCP refresh token |
| `/mcp` | POST | StreamableHTTP transport | All `tools/call` |

## Anti-patterns (don't ship integrations that do these)

- **Don't pass Meta tokens through MCP clients.** The MCP token is a JWT minted
  by the server; the Meta token is decrypted server-side per request. Never
  send `EAA…` tokens over the MCP channel.
- **Don't reuse `client_id` across users.** Every MCP client instance should
  call `/register` once on first run (or read its persisted `client_id`).
- **Don't skip PKCE.** The server enforces `code_challenge_method=S256`. Plain
  challenges are rejected.
- **Don't log the JWT or the auth code.** Both can be replayed within their
  TTL (auth code 10 min, access token 1 h).
- **Don't `git push` `.env`** — `OAUTH_SECRET`, `TOKEN_ENCRYPTION_KEY`,
  `SESSION_COOKIE_SECRET`, `META_APP_SECRET` are catastrophic if leaked. CI
  runs gitleaks; locally use the [pre-deploy-guard skill](../AGENTS.md).

## Troubleshooting

**`403 not on allowlist` after Facebook consent.**
The user's email or `fbUserId` doesn't match any of `AUTH_ALLOWED_EMAILS` /
`AUTH_ALLOWED_DOMAINS` / `AUTH_ALLOWED_FB_USER_IDS`. The check is
case-insensitive on email/domain. Check the logs for the hashed user id
(`hashPii()`) to confirm which identity hit the allowlist.

**`invalid_client` from `/token`.**
`client_id` does not match the one registered, or `redirect_uri` differs from
the one passed to `/authorize`. Both are pinned to the original DCR record.

**`invalid_grant` from `/token` after a fresh code.**
PKCE `code_verifier` does not hash to the `code_challenge` originally sent.
Make sure the verifier is the **raw** one, not its base64url-encoded hash.

**Tool call returns "No Meta token connected for this user".**
The MCP JWT was minted, but the user has no token in Firestore. Most often
they signed in before the allowlist was widened, then the OAuth state was
flushed but the Meta token was never persisted. Resolution: open `/authorize`
again, sign in fresh.

**Tokens disappear after Cloud Run revisions.**
You're hitting the in-memory fallback. Verify `FIRESTORE_PROJECT_ID` (or
`GOOGLE_CLOUD_PROJECT` on Cloud Run) is set in the runtime environment, and
that the runtime service account has `roles/datastore.user`.

## Verification

To smoke-test the full flow against a local emulator:

```bash
# Terminal 1
gcloud beta emulators firestore start --host-port=localhost:8085

# Terminal 2
export FIRESTORE_EMULATOR_HOST=localhost:8085
export SERVER_URL=http://localhost:3000
export META_APP_ID=…
export META_APP_SECRET=…
export AUTH_ALLOWED_EMAILS=you@example.com
export TOKEN_ENCRYPTION_KEY=$(openssl rand -hex 32)
export SESSION_COOKIE_SECRET=$(openssl rand -base64 32)
export OAUTH_SECRET=$(openssl rand -hex 32)
npm run dev

# Terminal 3 — drive the flow
curl -s "http://localhost:3000/.well-known/oauth-authorization-server" | jq
curl -sX POST "http://localhost:3000/register" \
  -H "Content-Type: application/json" \
  -d '{"client_name":"smoke","redirect_uris":["http://localhost/cb"],"grant_types":["authorization_code"],"response_types":["code"],"token_endpoint_auth_method":"none"}' | jq

open "http://localhost:3000/authorize?response_type=code&client_id=<id>&redirect_uri=http%3A%2F%2Flocalhost%2Fcb&code_challenge=$(openssl rand -base64 32 | tr -d '=' | tr '+/' '-_')&code_challenge_method=S256"
```

Then test that `ads_get_ad_accounts` works with the resulting JWT.
