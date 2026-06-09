# Meta Ads MCP Server

> **Self-hosted Model Context Protocol (MCP) server that gives Claude, ChatGPT and other AI agents secure, multi-tenant access to the Meta Marketing API for Facebook Ads and Instagram Ads.** Built for advertising agencies managing many client ad accounts from a single AI assistant — with OAuth login, encrypted-at-rest tokens, rate-limit compliance and circuit breakers baked in.
>
> **v3.0.0 (2026-05-06)** — vocabulary aligned with Meta's official MCP server (`mcp.facebook.com/ads`). Tool names switched from `meta_ads_*` to `ads_*`, added 14 new tools (insights views, diagnostics, help search, agency macros). Breaking change — see [CHANGELOG](CHANGELOG.md) and [docs/migration-v3.md](docs/migration-v3.md).

[![License: MIT](https://img.shields.io/github/license/byadsco/meta-ads-mcp)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/byadsco/meta-ads-mcp/ci.yml?branch=main&label=CI)](https://github.com/byadsco/meta-ads-mcp/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-1.29-7c3aed)](https://modelcontextprotocol.io)
[![Cloud Run ready](https://img.shields.io/badge/Cloud_Run-ready-4285F4?logo=googlecloud&logoColor=white)](https://cloud.google.com/run)

## Table of contents

- [What is Meta Ads MCP?](#what-is-meta-ads-mcp)
- [Who is this for?](#who-is-this-for)
- [Aligned with Meta's official MCP](#aligned-with-metas-official-mcp)
- [Features](#features)
- [Tools (96 total)](#tools-96-total)
- [Quick start](#quick-start)
- [Authentication — three modes](#authentication--three-modes)
- [Setting up Sign in with Meta](#setting-up-sign-in-with-meta)
- [Registering System User tokens (no expiry)](#registering-system-user-tokens-no-expiry)
- [Connecting AI clients](#connecting-ai-clients)
- [Common workflows](#common-workflows)
- [Architecture overview](#architecture-overview)
- [Meta API compliance](#meta-api-compliance)
- [Deployment](#deployment)
- [Local development](#local-development)
- [Security](#security)
- [FAQ / troubleshooting](#faq--troubleshooting)
- [Contributing](#contributing)
- [Resources](#resources)
- [License](#license)

## What is Meta Ads MCP?

**Meta Ads MCP Server** is an open-source [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the [Meta Marketing API](https://developers.facebook.com/docs/marketing-apis) — the API behind Facebook Ads and Instagram Ads — as a set of well-typed tools that any MCP-compatible AI agent can call. Drop it in front of Claude, ChatGPT, Cline, Continue or any other MCP client and your assistant can manage campaigns, ad sets, creatives, audiences, insights, leads, comments and pixels across an unlimited number of ad accounts.

It is **multi-tenant by design**. Each user signs in with **Facebook Login** on a consent page, their long-lived (60-day) Meta token is encrypted with AES-256-GCM and stored in Firestore, and every MCP request automatically picks up the right token. There is no shared PIN, no token pasting, no plaintext at rest.

It is **compliance-first**. Every Meta throttling header (`X-App-Usage`, `X-Business-Use-Case-Usage`, `x-fb-ads-insights-throttle`, `x-ad-account-usage`, reach throttle) is parsed and respected per `(token, account, use-case)` bucket. A circuit breaker stops all calls for an account on abuse signal `1996` or repeated throttles. Insights guardrails reject dangerous parameter combinations *before* they hit Graph API.

It is **deploy-ready**. Stateless Streamable HTTP transport, Docker image, GitHub Actions workflow that ships to Google Cloud Run with Workload Identity Federation, gitleaks-scanned on every push, masked health checks. Or run it via `stdio` for single-tenant local use with Claude Desktop.

## Who is this for?

- **Marketing agencies** that manage many client ad accounts and want one AI assistant that can act across all of them.
- **In-house marketing teams** with multiple users who need their own Meta token but a shared MCP endpoint.
- **Developers** building AI-powered tools, copilots or autonomous agents on top of Meta Ads.
- **Solo operators** who want to drive their own Meta account from Claude Desktop with zero infrastructure (`stdio` mode).

## Aligned with Meta's official MCP

On 2026-04-29 Meta launched a first-party remote MCP server at
`mcp.facebook.com/ads` (the "Ads AI Connectors" umbrella) with native support
for ChatGPT, Claude, and Perplexity. v3.0.0 of this project aligns its
vocabulary so the same prompts and agent patterns transfer cleanly between
both servers.

| | Meta's official MCP (`mcp.facebook.com/ads`) | This project |
|---|---|---|
| Auth model | Per-user OAuth in your AI client | **Multi-tenant**: agency operator handles N client accounts from one server |
| Tool surface | 29 tools (campaigns, ads, catalogs, 5 insight views, opportunity_score, dataset, errors, help) | **96 tools** including the official 29-equivalent + audiences, lookalikes, lead forms, automated rules, A/B studies, async reports, custom conversions, asset uploads, comment moderation, cross-account macros |
| Hosting | Hosted by Meta | Self-hosted on Cloud Run / your infra; tokens encrypted at rest in Firestore |
| Cross-account | Per-user, single Meta login | Yes — `ads_portfolio_summary` aggregates across N accounts |
| Token control | Lives in your AI client | Server-side System User token registry per agency operator |
| Naming | `ads_create_campaign`, `ads_update_entity`, `ads_insights_*` | **Same naming**, plus all the tools the official MCP doesn't ship |

When to use which:

- **Single advertiser running their own ads from Claude/ChatGPT** → Meta's
  official MCP. Zero setup, first-party.
- **Agency operating across many client accounts**, internal staff that should
  not have direct Facebook login to every client, custom workflow / governance
  needs, integration with internal stack → this project.

## Features

- **96 tools** covering campaign management, creatives, targeting, audiences, reporting, comments, billing, tokens, Instagram workflows, rate-limit observability, semantic insight views, diagnostics, help-center search, and agency-tier cross-account macros.
- **Aligned vocabulary** with Meta's official MCP server so agents transfer cleanly between both.
- **Sign in with Meta (Facebook Login)** — replaces shared PINs. Each user lands their own long-lived (60-day) Meta token.
- **System User token registry** — for tokens that don't expire, register them per user from the consent UI.
- **Encrypted persistence** — Meta tokens stored AES-256-GCM in Firestore; survive restarts so connections never drop.
- **Email / domain / FB-id allowlist** — public repo, private deployment: only listed identities can sign in.
- **Multi-account support** — each request carries its own Meta access token via `AsyncLocalStorage` request context.
- **Cloud-ready** — Streamable HTTP transport, stateless, Docker-ready, Google Cloud Run reference deploy.
- **Stdio support** — for local development with MCP clients like Claude Desktop.
- **Compliance-first rate limiting** — per-`(token, ad-account, use-case)` bucketing of every throttle signal Meta publishes; reacts to `estimated_time_to_regain_access` instead of blind backoff.
- **Circuit breaker** — abuse-signal (subcode 1996), temporary-block and repeated-throttle events stop all calls for the affected account, following Meta's explicit *"stop making API calls"* rule.
- **Preventive write pacing** — Ads Management `POST`/`DELETE` are paced against the hourly BUC quota so bursts from agents never blow the limit.
- **Insights guardrails** — dangerous parameter combinations (account-level + high-cardinality breakdowns, lifetime + breakdowns in sync, `time_range` > 37 months) are rejected *before* hitting Meta.
- **Async reports with safe polling** — `ads_run_report_and_wait` one-shot with 5 s-min / 60 s-max backoff, proper `Job Failed` / `Job Skipped` handling.
- **Retry logic** — exponential backoff on truly transient errors only (never on throttled requests).

## Tools (96 total)

All tools use the `ads_*` naming convention, aligned with Meta's official MCP server. Read tools declare `readOnlyHint: true`; mutating tools declare `destructiveHint` / `idempotentHint` and prefix descriptions with `⚠️ Modifies live ads/account data.`

| Category | Tools | Description |
|---|---|---|
| Accounts | 3 | `ads_get_ad_accounts`, `ads_get_account_info`, `ads_get_pages_for_business` |
| Campaigns | 5 | CRUD + status management |
| Ad Sets | 6 | CRUD + clone bundle (native ad-copy, 100% creative-type coverage incl. dynamic/Advantage+) |
| Ads | 5 | CRUD with creative assignment |
| Creatives | 9 | List, details, create/update, image/video library and uploads |
| Generic entity helpers | 3 | `ads_get_ad_entities`, `ads_update_entity`, `ads_activate_entity` (mirror official MCP) |
| Insights — power tool | 1 | `ads_get_insights` — full control over breakdowns, attribution, time series |
| Insights views | 5 | `performance_trend`, `anomaly_signal`, `auction_ranking_benchmarks`, `industry_benchmark`, `advertiser_context` |
| Targeting | 7 | Interest / behavior / demographic / geo search, audience estimation, targeting description |
| Budget | 1 | Budget schedule management |
| Leads | 4 | Lead forms and lead retrieval |
| Audiences | 8 | Custom audiences, lookalikes, and cross-account sharing |
| Previews | 2 | Ad previews before launch |
| Pixels | 5 | Pixel details, events, custom conversions |
| Comments | 4 | Ad comment moderation |
| Rules | 5 | Automated rules and rule details |
| A/B Testing | 3 | Ad study creation and inspection |
| Reports | 4 | Async report creation, status, retrieval, and one-shot run+wait |
| Billing | 3 | Billing info and spend limits |
| Diagnostics | 3 | `ads_get_opportunity_score`, `ads_get_dataset_quality`, `ads_get_errors` |
| Help search | 1 | `ads_get_help_article` — curated Meta Business Help Center search |
| Agency macros | 2 | `ads_diagnose_underperformance`, `ads_portfolio_summary` (cross-account) |
| Instagram | 2 | IG account and media lookup |
| Tokens | 4 | List / set-active / register / delete |
| Rate Status | 1 | Live view of quota usage, open circuits and write-pacer state |

Tool definitions live under [src/tools/](src/tools/), wired together in [src/tools/index.ts](src/tools/index.ts).

## Quick start

### Prerequisites

- **Node.js 20.10+** (the project uses Import Attributes for JSON imports). Node 22 is used in the Docker image.
- A **Meta access token** with `ads_management` and `ads_read` permissions, *or* a Meta App configured for Facebook Login (see below).

### Install & run

**Option A — from source (contributors, self-hosters):**

```bash
git clone https://github.com/byadsco/meta-ads-mcp.git
cd meta-ads-mcp
npm install
npm run build
npm start
```

**Option B — from GitHub Packages (npm):** scoped to `@byadsco`, hosted on `npm.pkg.github.com`. Requires a GitHub Personal Access Token with `read:packages` scope.

```bash
# tell npm where the @byadsco scope lives
echo "@byadsco:registry=https://npm.pkg.github.com" >> .npmrc
echo "//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}" >> .npmrc

npm install @byadsco/meta-ads-mcp
npx meta-ads-mcp                 # HTTP transport, port 3000
npx meta-ads-mcp --transport stdio
```

**Option C — from GitHub Container Registry (Docker):**

```bash
docker pull ghcr.io/byadsco/meta-ads-mcp:latest
docker run --rm -p 3000:3000 --env-file .env ghcr.io/byadsco/meta-ads-mcp:latest
```

The server starts on `http://localhost:3000` with the `/mcp` endpoint and a health check at `/health`. New versions are published on every GitHub Release ([releases](https://github.com/byadsco/meta-ads-mcp/releases)).

### Environment variables

See [.env.example](.env.example) for the full list. The minimum to run an HTTP deployment with Meta OAuth login:

```bash
SERVER_URL=https://your-host.com   # required for OAuth redirect URIs
META_APP_ID=...                    # your Meta app
META_APP_SECRET=...
AUTH_ALLOWED_EMAILS=you@x.com      # at least one allowlist source required
TOKEN_ENCRYPTION_KEY=$(openssl rand -hex 32)
SESSION_COOKIE_SECRET=$(openssl rand -base64 32)
OAUTH_SECRET=$(openssl rand -hex 32)
FIRESTORE_PROJECT_ID=my-gcp-project
```

For local development with `stdio` (no OAuth, no Firestore needed):

```bash
META_ACCESS_TOKEN=EAA...           # the only required value in stdio mode
```

## Authentication — three modes

| Mode | Activated by | Used for |
|---|---|---|
| **Sign in with Meta** (recommended) | `META_APP_ID` + `META_APP_SECRET` + `TOKEN_ENCRYPTION_KEY` + allowlist | Each user signs in with Facebook Login on `/authorize`. Their long-lived (60-day) token is encrypted in Firestore and auto-refreshed. |
| **API key (service-to-service)** | `MCP_API_KEY=...` | Server-to-server clients pass `X-API-Key` and `X-Meta-Token` headers; bypasses the human OAuth flow. |
| **Stdio / single-tenant** | `META_ACCESS_TOKEN=...` | Local development, single user; no HTTP server required. |

The repo is public but the deployment is private: nothing sensitive lives in the code. All secrets, allowlists, and tokens are runtime-only and never checked in. See [SECURITY.md](SECURITY.md) for the full security policy.

## Setting up Sign in with Meta

1. **Create a Meta App** at <https://developers.facebook.com>:
   - Add the *Facebook Login* product.
   - In *Facebook Login → Settings*, set the Valid OAuth Redirect URI to `<SERVER_URL>/auth/meta/callback`.
   - In *App Review → Permissions and Features*, request `ads_management`, `ads_read`, `pages_show_list`, `pages_read_engagement`, `business_management`, `email`. While the app is in *Development* mode, only people listed under *Roles* can sign in.

2. **Provision Firestore** in your GCP project:
   - In the Cloud Console: Firestore → Create database → Native mode → pick a region.
   - Grant the Cloud Run runtime service account `roles/datastore.user`.

3. **Generate the encryption key and secrets**:

   ```bash
   echo "TOKEN_ENCRYPTION_KEY=$(openssl rand -hex 32)"
   echo "SESSION_COOKIE_SECRET=$(openssl rand -base64 32)"
   echo "OAUTH_SECRET=$(openssl rand -hex 32)"
   ```

   Store them as Cloud Run env vars (or in Secret Manager).

4. **Configure the allowlist**: at least one of `AUTH_ALLOWED_EMAILS`, `AUTH_ALLOWED_DOMAINS`, `AUTH_ALLOWED_FB_USER_IDS` must be set when Meta OAuth is enabled — otherwise startup fails.

5. **Connect Claude**: point Claude (Desktop or Web) to `https://<SERVER_URL>/mcp`. On the first tool call Claude will open the `/authorize` page in your browser, kick off Facebook Login, and you'll land on a consent screen with your token already provisioned. Approve once and Claude is connected.

For the full end-to-end flow with sequence diagram, cURL examples for `/.well-known`, `/register`, `/authorize`, `/token`, multi-tenant token resolution via `AsyncLocalStorage`, troubleshooting and verification steps, see [docs/oauth-multi-tenant.md](docs/oauth-multi-tenant.md).

## Registering System User tokens (no expiry)

Long-lived user tokens last 60 days and are auto-refreshed. If you prefer a token that does not expire (typical for agency System Users), open the `/authorize` consent page and use **"Registrar System User token"** — paste the System User access token, it is validated against Graph API `/me`, encrypted, and saved alongside your personal token. Switch the active token from the same UI.

## Connecting AI clients

### Claude Desktop (stdio)

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "meta-ads": {
      "command": "node",
      "args": ["/path/to/meta-ads-mcp/dist/index.js", "--transport", "stdio"],
      "env": {
        "META_ACCESS_TOKEN": "your_token"
      }
    }
  }
}
```

### Claude Web / Claude API (remote HTTP)

Deploy the server and configure the MCP endpoint URL:

```text
URL: https://your-server.com/mcp
```

When connecting from Claude, the OAuth flow opens a browser tab pointed at `/authorize` → Facebook Login → consent. After approval, Claude receives an MCP token and can call all the tools without you ever pasting a Meta token.

### Service-to-service (no browser)

Use the API-key path: set `MCP_API_KEY` on the server, then send:

```http
POST /mcp HTTP/1.1
X-API-Key: <key>
X-Meta-Token: <meta_token>
Content-Type: application/json
```

### Other MCP clients

Any client that speaks the [Model Context Protocol](https://modelcontextprotocol.io) over Streamable HTTP works — Cline, Continue, Cursor, custom Anthropic SDK or OpenAI SDK integrations, etc. Point them at `https://<SERVER_URL>/mcp`.

## Common workflows

### Updating an ad set's budget

Adjusting the budget of a live ad set is a high-frequency operation for agencies — daily caps need to scale up and down based on pacing, while keeping the rest of the targeting and creative untouched. Use `ads_update_ad_set` and only pass the fields you want to change; everything else stays as-is on Meta's side. Budget values are sent **in cents**, matching the Meta Marketing API convention (`2000` = `$20.00`). Authentication is transparent: whichever mode the deployment uses (Sign in with Meta OAuth, registered System User token, or `MCP_API_KEY` + `X-Meta-Token` headers), the active token is resolved per request and applied automatically.

The `tools/call` payload an MCP client sends:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "ads_update_ad_set",
    "arguments": {
      "ad_set_id": "120200000000000000",
      "daily_budget": 5000
    }
  }
}
```

Expected response (the handler returns one MCP `text` block):

```text
Ad set 120200000000000000 updated successfully.
Changes: {"daily_budget":"5000"}
```

Notes:

- To switch to a `lifetime_budget`, pass `lifetime_budget` together with `end_time` (ISO 8601). Meta rejects a `lifetime_budget` on an ad set with no `end_time`.
- Changing `bid_amount`, `bid_strategy`, or replacing `targeting` can re-trigger Meta's learning phase.
- Under the hood the tool issues `POST /v25.0/<adset_id>` against the Meta Graph API, routed through the shared client (rate-limit, write-pacer, circuit-breaker, error classifier). See [src/tools/adsets.ts](src/tools/adsets.ts) for the full schema.

### Working with custom audiences

A typical agency workflow: build a CRM-derived seed audience, expand it into a lookalike, attach the lookalike to one or more ad sets, and check the addressable size before launching. The relevant tools split across two modules:

| Tool | Source | Purpose |
|---|---|---|
| `ads_get_custom_audiences` | [src/tools/audiences.ts](src/tools/audiences.ts) | List audiences (custom, website, lookalikes…) on an ad account. |
| `ads_get_audience_details` | [src/tools/audiences.ts](src/tools/audiences.ts) | Inspect one audience: subtype, retention, size estimate. |
| `ads_create_custom_audience` | [src/tools/audiences.ts](src/tools/audiences.ts) | Create CUSTOM / WEBSITE / APP / OFFLINE_CONVERSION / ENGAGEMENT subtypes. |
| `ads_create_lookalike_audience` | [src/tools/audiences.ts](src/tools/audiences.ts) | Build a lookalike (1 %–20 %) from a seed audience + country. |
| `ads_share_custom_audience` | [src/tools/audiences.ts](src/tools/audiences.ts) | Share an audience with one or more ad accounts in the same Business Manager. |
| `ads_unshare_custom_audience` | [src/tools/audiences.ts](src/tools/audiences.ts) | Revoke the share from one or more ad accounts. |
| `ads_get_audience_shared_accounts` | [src/tools/audiences.ts](src/tools/audiences.ts) | List which ad accounts currently have shared access to an audience. |
| `ads_delete_custom_audience` | [src/tools/audiences.ts](src/tools/audiences.ts) | Permanent delete; cannot be undone. |
| `ads_estimate_audience_size` | [src/tools/targeting.ts](src/tools/targeting.ts) | Get reach estimate before pushing the audience to an ad set. |
| `ads_update_ad_set` | [src/tools/adsets.ts](src/tools/adsets.ts) | **Apply** the audience by writing to `targeting.custom_audiences`. |

The MCP `tools/call` payload for an end-to-end run:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": { "name": "ads_create_custom_audience",
    "arguments": {
      "account_id": "act_1234567890",
      "name": "FTDs last 90d",
      "subtype": "CUSTOM",
      "customer_file_source": "USER_PROVIDED_ONLY",
      "retention_days": 90,
      "description": "First-time depositors, weekly export"
    } } }
```

Returns an audience id (e.g. `23842000000000000`). Then upload hashed PII via the customer-list endpoint (separate flow — Meta requires SHA-256 of normalized email / phone), and build the lookalike:

```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": { "name": "ads_create_lookalike_audience",
    "arguments": {
      "account_id": "act_1234567890",
      "name": "LAL 3% US — FTDs",
      "origin_audience_id": "23842000000000000",
      "ratio": 0.03,
      "country": "US"
    } } }
```

Lookalike ids land in seconds but Meta needs ~24 h to compute the actual users. **Apply** the lookalike to a live ad set:

```json
{ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
  "params": { "name": "ads_update_ad_set",
    "arguments": {
      "ad_set_id": "120200000000000000",
      "targeting": {
        "custom_audiences": [{ "id": "23842000000000099" }],
        "geo_locations": { "countries": ["US"] }
      }
    } } }
```

Validate reach before spend:

```json
{ "jsonrpc": "2.0", "id": 4, "method": "tools/call",
  "params": { "name": "ads_estimate_audience_size",
    "arguments": {
      "account_id": "act_1234567890",
      "targeting_spec": {
        "custom_audiences": [{ "id": "23842000000000099" }],
        "geo_locations": { "countries": ["US"] },
        "age_min": 25, "age_max": 55
      }
    } } }
```

Notes:

- **PII must be hashed** (SHA-256 of trimmed lower-case value) before uploading to a `CUSTOM` audience with `customer_file_source=USER_PROVIDED_ONLY`. Plaintext uploads are rejected by Meta.
- **Lookalike source minimum** is ~100 people in the seed; below that, Meta returns a "too small to model" error and `subtype=LOOKALIKE` creation fails.
- **Removing an audience from an ad set** isn't done by deleting the audience (which kills it everywhere). Call `ads_update_ad_set` with `targeting.custom_audiences = []` (or omit and pass a different combination).
- All audience reads/writes go through the same shared `metaApiClient` ([src/meta/client.ts](src/meta/client.ts)) — bucketed rate-limits, circuit-breaker, write-pacer, and per-request token resolution apply automatically.

## Architecture overview

- **Transport** — Express 5 with the official MCP SDK's `StreamableHTTPServerTransport`. Stateless: each request gets its own transport + server pair. See [src/transport/http.ts](src/transport/http.ts).
- **OAuth provider** — implements the MCP OAuth 2.1 spec (authorization code + PKCE) bridged to Facebook Login. Authorization codes and registered clients persist in Firestore. See [src/auth/oauth-provider.ts](src/auth/oauth-provider.ts).
- **Token store** — `AsyncLocalStorage`-based request context resolves the right Meta token per request: header (`X-Meta-Token`), per-user encrypted store, env-var fallback. See [src/auth/token-store.ts](src/auth/token-store.ts) and [src/store/](src/store/).
- **Encryption layer** — AES-256-GCM at the application boundary, before anything reaches Firestore. See [src/auth/crypto.ts](src/auth/crypto.ts).
- **Meta client** — Graph API wrapper with circuit breaker, write pacer, and full throttling-header parsing. See [src/meta/](src/meta/).

## Meta API compliance

This server is designed to keep your app and your clients' ad accounts clear of throttling, suspensions or bans. It implements the full set of guardrails from Meta's documented policies:

- [Graph API rate limiting](https://developers.facebook.com/docs/graph-api/overview/rate-limiting)
- [Marketing API insights best practices](https://developers.facebook.com/docs/marketing-api/insights/best-practices)

### Headers parsed on every response

| Header | What we do with it |
| --- | --- |
| `X-App-Usage` | Platform (token) usage — self-throttle when `>75 %` |
| `X-Business-Use-Case-Usage` | Per-`(business_id, type)` usage; honours `estimated_time_to_regain_access` |
| `x-fb-ads-insights-throttle` | App + account insights load; captures `ads_api_access_tier` |
| `x-ad-account-usage` | Account-level quota + `reset_time_duration` |
| `x-Fb-Ads-Insights-Reach-Throttle` | Reach + breakdowns >13-month cap (10 req/day) |

### Error codes handled explicitly

| Code / subcode | Action |
| --- | --- |
| `4`, `17`, `32`, `613` | Throw, no retry, circuit after 3 events / 5 min |
| `80000-80014` | Same — includes Ads Insights, Ads Management, CA, etc. |
| `613` + subcode `1996` | **Critical abuse signal** — 60 min circuit for that `(token, account)`, `FATAL` log |
| `4` + subcode `1504022` | Global Insights rate limit — 2 min circuit |
| `100` + subcode `1487534` | Data-per-call limit — surfaced as `InvalidParams`, no retry |
| `368`, `1487742` | Temporary user / business block — 30 min circuit |
| `1`, `2` | Transient — retried with exponential backoff |

### Insights guardrails (pre-flight, before hitting Meta)

- Account-level + high-cardinality breakdowns (`product_id`, `action_target_id`, asset-level) → rejected.
- Wide date ranges (`maximum`, `>90 days`) + breakdowns on a sync call → rejected, pointing at `ads_run_report_and_wait`.
- `time_range` > 37 months → rejected.
- `use_unified_attribution_setting=true` by default so responses match Ads Manager (Meta change, 2025-06-10).
- `filtering` parameter exposed and recommended (e.g. `ad.impressions > 0`) to skip empty objects.

### Observability

Call `ads_rate_status` at any time to see usage, open circuits and the write-pacer state — it returns in-process state and does not call Meta. Sample JSON output (the second `text` block of the MCP response):

```json
{
  "usage": [
    { "kind": "app",       "key": "app:9c3f…",                 "callCount": 47, "cpuTime": 31, "totalTime": 22, "estimatedTimeToRegainAccessMs": 0,        "adsApiAccessTier": "standard_access" },
    { "kind": "buc",       "key": "buc:9c3f…:act_1234567890",  "callCount": 71, "cpuTime": 64, "totalTime": 58, "estimatedTimeToRegainAccessMs": 0,        "adsApiAccessTier": "standard_access" },
    { "kind": "insights",  "key": "insights:9c3f…:act_1234567890", "callCount": 18, "cpuTime": 12, "totalTime": 9, "estimatedTimeToRegainAccessMs": 0,    "adsApiAccessTier": "standard_access" },
    { "kind": "acc",       "key": "acc:act_1234567890",        "callCount": 33, "cpuTime": 0,  "totalTime": 0,  "estimatedTimeToRegainAccessMs": 0,        "adsApiAccessTier": null },
    { "kind": "local_retry","key": "local_retry:9c3f…:act_1234567890:CUSTOM_AUDIENCE", "callCount": 0, "cpuTime": 0, "totalTime": 0, "estimatedTimeToRegainAccessMs": 184000, "adsApiAccessTier": null }
  ],
  "circuits": [
    { "key": "9c3f…:act_1234567890", "reason": "repeated_throttle", "openUntil": 1716482700000, "tripCount": 1, "lastError": "User request limit reached (4)" }
  ],
  "writePacer": [
    { "key": "9c3f…:act_1234567890", "tokens": 7, "capacity": 60, "rateRps": 0.5, "tier": "standard_access" }
  ]
}
```

Field reference:

- `kind` — `app` (per-token X-App-Usage), `buc` (X-Business-Use-Case-Usage), `insights` (x-fb-ads-insights-throttle), `acc` (x-ad-account-usage), `reach` (x-Fb-Ads-Insights-Reach-Throttle), `local_retry` (parsed from `error.error_user_msg`'s `Retry-After` hint).
- `callCount` / `cpuTime` / `totalTime` — % of quota used (0–100).
- `estimatedTimeToRegainAccessMs` — countdown from Meta when throttled.
- `adsApiAccessTier` — `development_access` (no IDs allowed in some endpoints, harsher quotas) or `standard_access`.
- `circuits[]` — open circuits blocking calls; `reason` is one of `abuse_signal`, `retry_after_hint`, `repeated_throttle`, `temporary_block`.
- `writePacer[]` — token-bucket state for `POST`/`DELETE` Ads Management calls; `tokens` available, `capacity`, `rateRps` refill rate.

Structured logs fire on every Meta error (`event=meta_error`), abuse signal (`event=META_ABUSE_SIGNAL`, `level=FATAL`), circuit change (`event=meta_circuit_open`) and periodic usage snapshot (`event=meta_rate_usage`).

### Circuit-breaker thresholds

Constants live in [src/meta/circuit-breaker.ts](src/meta/circuit-breaker.ts):

| Trigger | Cooldown | Notes |
|---|---|---|
| Abuse signal — error 613, subcode `1996` | **60 min** | Meta's documented "stop calling" rule. Logged as `level=FATAL`. |
| Temporary user/business block — codes 368, 1487742 | **30 min** | Surfaced from explicit error subcodes. |
| Repeated throttle — ≥3 throttle events in 5 min on the same `(token, account, type)` bucket | **15 min** | Local heuristic to head off a hard ban. |
| `retry-after` hint in error body | honored as-is | Whatever Meta returns — never overridden. |
| Data-per-call limit (100/1487534) | none | The query is wrong, not the rate. Returned as `InvalidParams`. |

### Retry policy

Throttled errors are **never retried inside the same request** — Meta's docs warn that continuing to call extends `estimated_time_to_regain_access`. Only truly transient errors (codes 1, 2; HTTP 5xx; aborts) are retried, with capped exponential backoff:

```ts
// src/meta/client.ts
private async backoff(attempt: number): Promise<void> {
  const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);   // 1s, 2s, 4s
  const jitter = delay * (Math.random() * 0.4 - 0.2);      // ±20 %
  await new Promise((resolve) => setTimeout(resolve, delay + jitter));
}
```

`MAX_RETRIES = 3`, `RETRY_BASE_DELAY = 1000ms`. After exhausting retries the original error bubbles up classified as an `McpError` with the right `ErrorCode`.

## Deployment

### Docker

Pre-built images are published to **GitHub Container Registry** (`ghcr.io/byadsco/meta-ads-mcp`) on every release — tagged with the semver version (`2.0.1`, `2.0`, `2`) and `latest`.

```bash
# pull a published release
docker run --rm -p 3000:3000 --env-file .env ghcr.io/byadsco/meta-ads-mcp:latest

# or build from source
docker compose up
```

The provided [Dockerfile](Dockerfile) is a multi-stage Node 22 Alpine build that runs as a non-root `node` user, exposes port 3000 and ships with a `/health` health check:

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/dist/ dist/
COPY --from=builder /app/node_modules/ node_modules/
COPY package.json ./

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

USER node
CMD ["node", "dist/index.js"]
```

For local development the repository ships a [docker-compose.yml](docker-compose.yml) that wires every supported env var. Drop a `.env` next to it and run `docker compose up`:

```yaml
services:
  meta-ads-mcp:
    build: .
    ports:
      - "3000:3000"
    environment:
      - SERVER_URL=${SERVER_URL:-http://localhost:3000}
      - META_APP_ID=${META_APP_ID:-}
      - META_APP_SECRET=${META_APP_SECRET:-}
      - META_OAUTH_REDIRECT_URI=${META_OAUTH_REDIRECT_URI:-}
      - AUTH_ALLOWED_EMAILS=${AUTH_ALLOWED_EMAILS:-}
      - AUTH_ALLOWED_DOMAINS=${AUTH_ALLOWED_DOMAINS:-}
      - AUTH_ALLOWED_FB_USER_IDS=${AUTH_ALLOWED_FB_USER_IDS:-}
      - TOKEN_ENCRYPTION_KEY=${TOKEN_ENCRYPTION_KEY:-}
      - SESSION_COOKIE_SECRET=${SESSION_COOKIE_SECRET:-}
      - OAUTH_SECRET=${OAUTH_SECRET:-}
      - FIRESTORE_PROJECT_ID=${FIRESTORE_PROJECT_ID:-}
      - GOOGLE_APPLICATION_CREDENTIALS=${GOOGLE_APPLICATION_CREDENTIALS:-}
      - META_ACCESS_TOKEN=${META_ACCESS_TOKEN:-}
      - META_TOKENS=${META_TOKENS:-}
      - MCP_API_KEY=${MCP_API_KEY:-}
      - META_API_VERSION=${META_API_VERSION:-v22.0}
      - PORT=3000
      - LOG_LEVEL=${LOG_LEVEL:-info}
      - NODE_ENV=production
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:3000/health"]
      interval: 30s
      timeout: 3s
      retries: 3
```

A minimum `.env` for a multi-tenant local run:

```bash
SERVER_URL=http://localhost:3000
META_APP_ID=...
META_APP_SECRET=...
AUTH_ALLOWED_EMAILS=you@example.com
TOKEN_ENCRYPTION_KEY=$(openssl rand -hex 32)
SESSION_COOKIE_SECRET=$(openssl rand -base64 32)
OAUTH_SECRET=$(openssl rand -hex 32)
FIRESTORE_PROJECT_ID=my-gcp-project   # or use the emulator
```

### Google Cloud Run (reference deploy)

[.github/workflows/deploy.yml](.github/workflows/deploy.yml) ships the service automatically on every push to `main`:

1. **Preflight** — runs `lint`, `typecheck`, `test`, `build`, `gitleaks` (same checks as CI).
2. **Validate secrets** — fails the deploy if any of `OAUTH_SECRET`, `TOKEN_ENCRYPTION_KEY`, `SESSION_COOKIE_SECRET`, `META_APP_ID`, `META_APP_SECRET`, `SERVER_URL`, `FIRESTORE_PROJECT_ID`, `GCP_RUNTIME_SERVICE_ACCOUNT` or any allowlist source is missing or has placeholder content. Format-checks `SERVER_URL` (public `https://`), `TOKEN_ENCRYPTION_KEY` (64 hex chars), `META_APP_ID`, `META_APP_SECRET`, runtime SA email, and minimum lengths for the other secrets.
3. **Auth to GCP** — Workload Identity Federation; **no service-account JSON keys** are committed or stored as GitHub secrets.
4. **Build & push** to Artifact Registry, tagged with the commit SHA + `latest`.
5. **Deploy** to Cloud Run (512 Mi / 1 CPU / concurrency 80 / min 0 / max 10 / port 3000) with all env vars wired from GitHub secrets.
6. **Smoke test** the deployed `/health` and `/.well-known/oauth-authorization-server` endpoints (URL stays masked in logs).

To bootstrap a fresh GCP project, see [scripts/setup-gcloud.sh](scripts/setup-gcloud.sh).

#### First-time deploy / fork bootstrap

The deploy gate requires `SERVER_URL` upfront because the server uses it to mint OAuth redirect URIs and the `issuer` field in `/.well-known/oauth-authorization-server`. Two paths to populate it on a brand-new environment:

**Recommended — custom domain.** Map a domain you own (`mcp.example.com`) to the Cloud Run service before the first deploy. Set `SERVER_URL=https://mcp.example.com` as a GitHub secret, point Facebook Login → *Valid OAuth Redirect URIs* at `<SERVER_URL>/auth/meta/callback`, then push to `main`. This is the path the project is designed for: the URL is stable across redeploys and never depends on a Cloud Run-generated hostname.

**Bootstrap with the autogenerated `*.run.app` URL.** If you want to use Cloud Run's autogenerated hostname (e.g. for staging or a quick fork test), the URL only exists after the service is created, so you have to deploy once before the secret can be set:

```bash
# 1. Create the service stub manually (one-shot, outside the workflow).
gcloud run deploy meta-ads-mcp \
  --image=gcr.io/cloudrun/hello \
  --region=<YOUR_REGION> \
  --allow-unauthenticated \
  --project=<YOUR_PROJECT_ID>

# 2. Capture the autogenerated URL (do NOT paste it into commits or chat).
URL=$(gcloud run services describe meta-ads-mcp \
  --region=<YOUR_REGION> --project=<YOUR_PROJECT_ID> \
  --format='value(status.url)')

# 3. Store as a GitHub secret on your fork.
gh secret set SERVER_URL --repo <YOUR_FORK> --body "$URL"
unset URL

# 4. Register the OAuth redirect URI in Facebook Login → Settings using the
#    same value (path: /auth/meta/callback).

# 5. Push to main — the workflow now passes the SERVER_URL gate and replaces
#    the stub with the real image.
```

Treat the `*.run.app` URL as low-confidentiality: it is publicly resolvable and cannot be hidden, but the workflow already redacts it from logs via `::add-mask::`. Don't paste it into the repo, commit messages, or PR bodies.

### Local + Firestore emulator

```bash
# 1. Start the emulator
gcloud beta emulators firestore start --host-port=localhost:8085 &
export FIRESTORE_EMULATOR_HOST=localhost:8085

# 2. Configure .env (copy from .env.example) — set
#    SERVER_URL=http://localhost:3000
#    META_APP_ID + META_APP_SECRET (test app)
#    AUTH_ALLOWED_EMAILS=<your email>
#    TOKEN_ENCRYPTION_KEY, SESSION_COOKIE_SECRET, OAUTH_SECRET

# 3. Run
npm run dev

# 4. Open the consent page to test the flow
open "http://localhost:3000/authorize?client_id=test&redirect_uri=http://localhost/cb&response_type=code&code_challenge=x&code_challenge_method=S256"
```

## Local development

```bash
npm run dev          # HTTP mode with hot reload (tsx watch)
npm run dev:stdio    # Stdio mode with hot reload
npm run typecheck    # tsc --noEmit
npm run lint         # eslint src/
npm test             # vitest run
npm run test:watch   # vitest in watch mode
npm run build        # production build → dist/
```

Tests live under [tests/](tests/) and mirror the `src/` layout (auth, meta, tools, transport, utils).

## Security

This is a **public repository** that handles sensitive credentials at runtime. Read the full [SECURITY.md](SECURITY.md) for the vulnerability disclosure policy, threat model, and hardening recommendations.

Quick summary of the runtime defences:

- AES-256-GCM token encryption at the application layer, before Firestore.
- Email / domain / FB-id allowlist enforced on every Meta OAuth callback.
- HttpOnly, Secure, SameSite=Lax session cookies signed with `jose` JWT.
- HSTS, `X-Content-Type-Options`, `X-Frame-Options=DENY`, `Referrer-Policy=no-referrer` on every response; CSP on the consent page.
- HTTPS-only redirect in production.
- In-process rate limiting on `/register` and `/token`.
- Tokens never logged in plaintext (`maskToken()` everywhere).
- [gitleaks](https://github.com/gitleaks/gitleaks) preflight in CI with a [custom config](.gitleaks.toml) covering Meta tokens (`EAA…`), GCP keys, and our own named secrets — blocks pushes that would leak a credential.
- Workload Identity Federation for Cloud Run deploys: no service-account keys to leak.

### Public repo, private deployment

| Lives in the public repo | Lives only in your deployment |
|---|---|
| Source code | `META_APP_SECRET`, `TOKEN_ENCRYPTION_KEY`, `SESSION_COOKIE_SECRET`, `OAUTH_SECRET` |
| `.env.example` (with empty values) | The actual `AUTH_ALLOWED_*` lists |
| README and docs | Encrypted Meta tokens (Firestore) |

## FAQ / troubleshooting

**The server crashes on startup with `TOKEN_ENCRYPTION_KEY is required in production`.**
Generate one with `openssl rand -hex 32` and set it as an env var. It must be exactly 64 hex characters (32 bytes). In non-production a key is auto-generated, but tokens encrypted with that key won't decrypt after a restart.

**OAuth callback returns 403 with `not on allowlist`.**
Check `AUTH_ALLOWED_EMAILS`, `AUTH_ALLOWED_DOMAINS` and `AUTH_ALLOWED_FB_USER_IDS`. At least one must be set in production, and the email or FB user id from your Facebook profile must match. The check is case-insensitive on emails and domains.

**Tokens disappear after every restart.**
You're running without Firestore. Set `FIRESTORE_PROJECT_ID` (or run on GCP with `GOOGLE_CLOUD_PROJECT`), or point `FIRESTORE_EMULATOR_HOST` at the emulator. The server falls back to in-memory stores when Firestore isn't configured — fine for development, fatal for production.

**A Meta token expires — what happens?**
Long-lived user tokens auto-refresh as long as the user signs in within their 60-day window. If the token has fully expired, the next MCP call returns a 401 with a "re-authenticate via /authorize" hint. System User tokens never expire.

**How do I rotate `TOKEN_ENCRYPTION_KEY`?**
Decrypt all tokens with the current key, set the new key, re-encrypt, deploy. The procedure is short but **don't deploy a new key without re-encrypting first** — every existing token will become unreadable. Plan a maintenance window.

**Can I run without Firestore?**
For local dev / single-user, yes — set `META_ACCESS_TOKEN` and use `npm run dev:stdio`. For multi-tenant HTTP you really want Firestore (or any persistent store you wire in); the in-memory fallback exists only so dev environments don't die.

**API key vs Meta OAuth — when do I use which?**
OAuth is for human users with a browser (Claude Desktop, Claude Web, Cursor users). API key + `X-Meta-Token` header is for server-to-server agents that can't open a browser tab. They can coexist on the same deployment.

**How do I add a new tool?**
Full walkthrough in [docs/adding-a-tool.md](docs/adding-a-tool.md). The short version: create a `register*Tools(server)` module under [src/tools/](src/tools/), call `server.registerTool(name, { description, inputSchema, annotations }, handler)` with the `ads_*` naming convention, and route every Graph API call through `metaApiClient` ([src/meta/client.ts](src/meta/client.ts)) — never `fetch` directly. The shared client is what gives every tool bucketed rate-limiting, circuit breaking, write pacing, multi-tenant token resolution, and Meta-error → `McpError` classification for free. The smallest end-to-end example in the codebase is [src/tools/budget.ts](src/tools/budget.ts):

```ts
import { CREATE, WRITE_WARNING } from "./_register.js";

server.registerTool(
  "ads_create_budget_schedule",
  {
    description: `${WRITE_WARNING}Schedule a temporary budget increase for a campaign…`,
    inputSchema: {
      campaign_id: z.string().describe("Campaign ID"),
      budget_value: z.string(),
      budget_value_type: z.enum(["ABSOLUTE", "MULTIPLIER"]),
      time_start: z.string(),
      time_end: z.string(),
    },
    annotations: { ...CREATE },
  },
  async ({ campaign_id, budget_value, budget_value_type, time_start, time_end }) => {
    const id = validateMetaId(campaign_id, "campaign");
    const result = await metaApiClient.postForm<{ id: string }>(
      `/${id}/budget_schedules`,
      { budget_value, budget_value_type, time_start, time_end },
    );
    return { content: [{ type: "text", text: `Budget schedule created! ID: ${result.id}` }] };
  },
);
```

Register the new module in [src/tools/index.ts](src/tools/index.ts), bump the count in [tests/tools/registration.test.ts](tests/tools/registration.test.ts), mirror the source path with a vitest under `tests/tools/` (use the helpers in [tests/setup.ts](tests/setup.ts)), and run `npm run lint && npm run typecheck && npm test && npm run build`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the auth-surface review policy and [docs/adding-a-tool.md](docs/adding-a-tool.md) for the security/compliance checklist.

## Contributing

Contributions are welcome — issues, PRs, security reports.

- Run `npm install && npm run build` once after cloning.
- Before opening a PR, make sure `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` all pass. CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the same checks plus a [gitleaks](https://github.com/gitleaks/gitleaks) secret scan.
- Auth surface (`src/auth/`, `src/transport/security-config.ts`) changes deserve extra review even when small.
- See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide and [SECURITY.md](SECURITY.md) before reporting a vulnerability.

## Resources

- [Model Context Protocol — official spec](https://modelcontextprotocol.io)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Meta Marketing API documentation](https://developers.facebook.com/docs/marketing-apis)
- [Graph API rate limiting](https://developers.facebook.com/docs/graph-api/overview/rate-limiting)
- [Marketing API insights best practices](https://developers.facebook.com/docs/marketing-api/insights/best-practices)
- [Claude Desktop](https://claude.ai/download)
- [Google Cloud Run](https://cloud.google.com/run)
- [Firestore in Native mode](https://cloud.google.com/firestore/docs/quickstart-native)

## Author

Built and maintained by **[ByAds](https://byads.co)** — author **Santiago Bastidas**. General contact: [dev@byads.co](mailto:dev@byads.co).

Issues, PRs and security reports are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2025 ByAds — Santiago Bastidas
