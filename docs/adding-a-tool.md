# Adding a new MCP tool

This is the canonical guide for extending meta-ads-mcp with a Meta Marketing API endpoint that isn't already covered by the 93 built-in tools. Follow it end-to-end and your tool will inherit every security, rate-limit, circuit-breaker, error-handling, multi-tenant, and MCP-annotation guarantee the rest of the server provides.

If you're contributing for the first time, also read [CONTRIBUTING.md](../CONTRIBUTING.md) for setup, CI checks, commit conventions, and the auth-surface review policy.

## TL;DR — the 8-step recipe

1. Pick a category file in [src/tools/](../src/tools/) (`campaigns.ts`, `audiences.ts`, …) or create a new one (`mything.ts`).
2. Add a `register*Tools(server)` function (or extend the existing one) that calls `server.registerTool(name, config, handler)`.
3. Use the `ads_*` naming convention (no `meta_` prefix) and aligned vocabulary (`ad_set` not `adset`).
4. Spread the appropriate annotation constant from [src/tools/_register.ts](../src/tools/_register.ts) into `annotations`. Prefix write-tool descriptions with `WRITE_WARNING`.
5. In the handler, call **`metaApiClient.get / post / postForm / postMultipart / delete / getPaginated`** — never `fetch` directly. (One exception exists: the `ads_library_*` tools talk to Apify, not the Graph API, and route through `apifyApiClient` in [src/apify/client.ts](../src/apify/client.ts), which provides the same timeout / retry / typed-`McpError` guarantees. Any *new* non-Meta upstream needs its own such client — never a bare `fetch` in a handler.)
6. Validate IDs with `normalizeAccountId` / `validateMetaId` from [src/utils/format.ts](../src/utils/format.ts).
7. Reuse type definitions from [src/meta/types/](../src/meta/types/), register the new module in [src/tools/index.ts](../src/tools/index.ts), and bump the tool count assertion in [tests/tools/registration.test.ts](../tests/tools/registration.test.ts).
8. Mirror the source path under `tests/tools/` with a vitest, run `npm run lint && npm run typecheck && npm test && npm run build`, and open a PR using [.github/PULL_REQUEST_TEMPLATE.md](../.github/PULL_REQUEST_TEMPLATE.md).

## Architecture in 30 seconds

```
MCP client request
   │
   ▼
server.registerTool(name, { description, inputSchema, annotations }, handler)
   │
   ▼
metaApiClient.{get|post|postForm|delete|...}  ◄── shared singleton
   │
   ├── circuit-breaker  (assertClosed before any call)
   ├── write-pacer      (acquire token for POST/DELETE on account paths)
   ├── rate-limiter     (waitIfNeeded based on last X-App-Usage / X-BUC-Usage)
   ├── fetch (Graph API v25.0)
   ├── header parser    (updateFromHeaders → updates rate-limiter + pacer tier)
   ├── error classifier (classifyMetaError → McpError + retry/throttle policy)
   └── retry w/ exp. backoff + jitter (only on transient + 5xx)
```

The whole shared pipeline lives in [src/meta/client.ts](../src/meta/client.ts). You don't need to understand the internals to write a tool — you just have to **route every call through the client**.

## Naming convention (v3.0+)

Every tool is registered as `ads_*` to match Meta's official MCP server vocabulary. This is non-negotiable for new tools.

- ✅ `ads_get_campaigns`, `ads_create_ad_set`, `ads_insights_performance_trend`
- ❌ `meta_ads_*` (legacy, removed in v3.0.0)
- ❌ `adset` (use `ad_set` with underscore — matches Meta's official `ads_create_ad_set`)
- ❌ camelCase / TitleCase

Pick the right verb / category prefix:

| Prefix | When |
| --- | --- |
| `ads_get_*` | Read tool. Annotate with `READ`. |
| `ads_create_*` | Create new entity. `CREATE`. |
| `ads_update_*` | Update existing entity. `UPDATE`. |
| `ads_delete_*` | Soft or hard delete. `DELETE`. |
| `ads_search_*` | Search/list helper (interests, geos…). `READ`. |
| `ads_insights_*` | Semantic insight view. `READ`. |
| `ads_upload_*` | Media upload. `UPLOAD`. |
| `ads_<verb>_entity` | Generic dispatcher across entity_type. |

## Tool annotations are mandatory

Every tool must declare `ToolAnnotations` so MCP clients (Claude, ChatGPT, Perplexity) can render confirmation hints. The shared constants in [src/tools/_register.ts](../src/tools/_register.ts) cover every kind:

```ts
import { READ, CREATE, UPDATE, DELETE, TOGGLE, UPLOAD, TOKEN, WRITE_WARNING } from "./_register.js";

annotations: { ...READ }     // readOnlyHint: true
annotations: { ...CREATE }   // destructiveHint: false, idempotentHint: false (re-running creates duplicates)
annotations: { ...UPDATE }   // destructiveHint: false, idempotentHint: true
annotations: { ...DELETE }   // destructiveHint: true,  idempotentHint: true
annotations: { ...TOGGLE }   // destructiveHint: false, idempotentHint: true (status toggles, hide/unhide)
annotations: { ...UPLOAD }   // destructiveHint: false, idempotentHint: false (image/video uploads)
annotations: { ...TOKEN }    // destructiveHint: false, idempotentHint: true (token registry)
```

For write tools, **prepend `${WRITE_WARNING}` to the description** so clients that ignore annotations still see `⚠️ Modifies live ads/account data.` upfront.

> **Pitfall**: re-posting a Facebook comment is **not** idempotent — duplicates show up on the live ad. `ads_reply_comment` uses `CREATE`, not `TOGGLE`. Match the constant to the *real* HTTP semantics, not the tool's verb.

## Canonical example, line by line

The smallest tool in the codebase is [src/tools/budget.ts](../src/tools/budget.ts). Use this as your template for a write tool:

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { validateMetaId } from "../utils/format.js";
import { CREATE, WRITE_WARNING } from "./_register.js";

export function registerBudgetTools(server: McpServer): void {
  server.registerTool(
    "ads_create_budget_schedule",
    {
      description: `${WRITE_WARNING}Schedule a temporary budget increase for a campaign during high-demand periods (e.g., Black Friday, product launches).`,
      inputSchema: {
        campaign_id: z.string().describe("Campaign ID"),
        budget_value: z.string().describe("Budget amount in cents (for ABSOLUTE) or multiplier value (for MULTIPLIER)"),
        budget_value_type: z.enum(["ABSOLUTE", "MULTIPLIER"]).describe("ABSOLUTE = set exact budget in cents, MULTIPLIER = multiply current budget"),
        time_start: z.string().describe("ISO 8601 start time for the budget increase"),
        time_end: z.string().describe("ISO 8601 end time for the budget increase"),
      },
      annotations: { ...CREATE },
    },
    async ({ campaign_id, budget_value, budget_value_type, time_start, time_end }) => {
      const id = validateMetaId(campaign_id, "campaign");
      const result = await metaApiClient.postForm<{ id: string }>(
        `/${id}/budget_schedules`,
        { budget_value, budget_value_type, time_start, time_end },
      );
      return {
        content: [{
          type: "text",
          text: `Budget schedule created!\nID: ${result.id}\nCampaign: ${id}\nValue: ${budget_value} (${budget_value_type})\nPeriod: ${time_start} → ${time_end}`,
        }],
      };
    },
  );
}
```

What each part does:

- **`server.registerTool(name, config, handler)`** — modern SDK API. The deprecated `server.tool(...)` form is no longer used in this repo. The MCP SDK uses the Zod `inputSchema` both to validate inputs at runtime and to expose a JSON Schema to clients during `tools/list`. The description is what the AI sees when picking a tool — keep it specific and outcome-oriented.
- **`annotations: { ...CREATE }`** — spread of the standard ToolAnnotations for create operations. Clients render confirmation prompts based on these.
- **`${WRITE_WARNING}` prefix** — for write tools only. Clients that don't read annotations still see the warning.
- **`validateMetaId(campaign_id, "campaign")`** — defence-in-depth on top of `z.string()`. The helper enforces `^(act_\d+|\d+|\d+_\d+)$` and throws otherwise, so a malformed id can't add path segments / query strings to the URL. Every tool that interpolates a non-account id (campaign / ad set / ad / creative / page / business…) into a Graph path must call this at the start of the handler.
- **`metaApiClient.postForm(...)`** — issues `POST /v25.0/<id>/budget_schedules` with `application/x-www-form-urlencoded` body. Behind the scenes the client looks up the per-request access token, checks the circuit-breaker, throttles writes, retries transient failures, and converts any Meta error into a typed `McpError`.
- **Return shape** — every handler must return `{ content: [{ type: "text", text: "..." }, ...] }`. Adding a second `text` block with the raw JSON (`JSON.stringify(obj, null, 2)`) is a common pattern for read tools — see [src/tools/campaigns.ts](../src/tools/campaigns.ts).

## Templates

### GET (read) tool

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId } from "../utils/format.js";
import { buildFieldsParam } from "../utils/validation.js";
import { READ } from "./_register.js";
// import { MY_RESOURCE_DEFAULT_FIELDS } from "../meta/types/myresource.js";
// import type { MyResource, MetaApiResponse } from "../meta/types/index.js";

export function registerMyResourceTools(server: McpServer): void {
  server.registerTool(
    "ads_get_my_resources",
    {
      description: "TODO: one sentence describing what the tool does and when to use it.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID (act_... or numeric)"),
        limit: z.number().min(1).max(100).default(25),
        fields: z.array(z.string()).optional(),
      },
      annotations: { ...READ },
    },
    async ({ account_id, limit, fields }) => {
      const id = normalizeAccountId(account_id);
      const fieldsParam = buildFieldsParam(fields, ["id", "name" /* , ...DEFAULTS */]);

      const response = await metaApiClient.get<{ data: Array<{ id: string; name: string }> }>(
        `/${id}/my_resources`,
        { fields: fieldsParam, limit },
      );

      const items = response.data ?? [];
      const text = items.length === 0
        ? "No resources found."
        : items.map((r) => `• ${r.name} (${r.id})`).join("\n");

      return {
        content: [
          { type: "text", text: `Found ${items.length} resource(s):\n\n${text}` },
          { type: "text", text: JSON.stringify(items, null, 2) },
        ],
      };
    },
  );
}
```

### POST / write tool (account-scoped)

```ts
import { CREATE, WRITE_WARNING } from "./_register.js";

server.registerTool(
  "ads_create_my_resource",
  {
    description: `${WRITE_WARNING}TODO: describe the side-effect.`,
    inputSchema: {
      account_id: z.string(),
      name: z.string().min(1).max(400),
      status: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED"),
    },
    annotations: { ...CREATE },
  },
  async ({ account_id, name, status }) => {
    const id = normalizeAccountId(account_id);
    const result = await metaApiClient.postForm<{ id: string }>(
      `/${id}/my_resources`,
      { name, status },
    );
    return {
      content: [{ type: "text", text: `Created ${result.id} (${name}, ${status}).` }],
    };
  },
);
```

### Update / delete on a non-account resource

When the path is `/<resource_id>/...` (campaign, ad set, ad, creative, page, business, etc.) instead of `/act_<account>/...`, validate the id with `validateMetaId` before interpolation. Without it, the `z.string()` schema accepts payloads like `"123/insights"` and `metaApiClient` will dutifully send a `POST` to `/v25.0/123/insights/...`, hitting an unintended endpoint with the caller's token.

```ts
import { validateMetaId } from "../utils/format.js";
import { UPDATE, WRITE_WARNING } from "./_register.js";

server.registerTool(
  "ads_update_my_resource",
  {
    description: `${WRITE_WARNING}TODO: describe the update.`,
    inputSchema: {
      campaign_id: z.string(),
      name: z.string().optional(),
      status: z.enum(["ACTIVE", "PAUSED"]).optional(),
    },
    annotations: { ...UPDATE },
  },
  async ({ campaign_id, name, status }) => {
    const id = validateMetaId(campaign_id, "campaign");
    const body: Record<string, string | number | boolean> = {};
    if (name !== undefined) body.name = name;
    if (status !== undefined) body.status = status;

    await metaApiClient.postForm<{ success: boolean }>(`/${id}`, body);
    return { content: [{ type: "text", text: `Campaign ${id} updated.` }] };
  },
);
```

### Parameter naming for ad-set tools

Tool input params for ad-set IDs use `ad_set_id` (with underscore), even though Meta's Marketing API uses `adset_id` in URL params and JSON bodies. Translate at the handler boundary:

```ts
async ({ ad_set_id, ... }) => {
  const id = validateMetaId(ad_set_id, "adset");          // accept ad_set_id from caller
  await metaApiClient.postForm(`/.../ads`, {
    adset_id: id,                                         // send adset_id to Meta
  });
}
```

## `metaApiClient` reference

| Method | When to use | Defined at |
| --- | --- | --- |
| `get<T>(path, params?)` | Single read request. Auto-appends `access_token`. | [src/meta/client.ts](../src/meta/client.ts) |
| `getPaginated<T>(path, params?, maxItems?)` | Multi-page reads using Meta's cursor pagination. | [src/meta/client.ts](../src/meta/client.ts) |
| `post<T>(path, body?)` | JSON `POST` (rare; most Marketing API endpoints are form-encoded). | [src/meta/client.ts](../src/meta/client.ts) |
| `postForm<T>(path, params)` | Standard create / update — `application/x-www-form-urlencoded`. **Default for writes.** | [src/meta/client.ts](../src/meta/client.ts) |
| `postMultipart<T>(path, formData)` | Uploads (images, video chunks). | [src/meta/client.ts](../src/meta/client.ts) |
| `delete<T>(path)` | Hard delete. Most "deletes" in Marketing API are actually `postForm({ status: "DELETED" })`. | [src/meta/client.ts](../src/meta/client.ts) |

The singleton instance `metaApiClient` is exported from [src/meta/client.ts](../src/meta/client.ts). Always import it; never instantiate `new MetaApiClient()`.

## What the framework guarantees — and what's still on you

### Already handled for you (don't reimplement)

- **Multi-tenant token resolution.** `getAccessToken()` at [src/auth/token-store.ts](../src/auth/token-store.ts) reads from `AsyncLocalStorage` (set per HTTP request by the OAuth/API-key middleware), then the `tokenManager` registry, then `META_ACCESS_TOKEN`. You never touch the env var directly.
- **Encryption at rest.** Tokens stored in Firestore are AES-256-GCM encrypted at the application boundary by [src/auth/crypto.ts](../src/auth/crypto.ts). You only see plaintext for the duration of one request.
- **Self-throttling.** [src/meta/rate-limiter.ts](../src/meta/rate-limiter.ts) tracks `X-App-Usage`, `X-Business-Use-Case-Usage`, `x-fb-ads-insights-throttle`, and `x-ad-account-usage` per `(token, account, BUC type)` bucket and pre-emptively waits when usage > 75 %.
- **Circuit breaker.** [src/meta/circuit-breaker.ts](../src/meta/circuit-breaker.ts) trips on abuse signals (subcode 1996), platform/BUC rate-limit codes (4, 17, 32, 613, 80000-80014), or repeat throttling — opens the circuit for 2 / 30 / 60 minutes depending on severity.
- **Write pacing.** [src/meta/write-pacer.ts](../src/meta/write-pacer.ts) sizes a token bucket to the Ads Management hourly quota of the active access tier (`development_access` vs `standard_access`).
- **Error classification.** [src/meta/errors.ts](../src/meta/errors.ts) maps every documented Meta error code/subcode to a typed `McpError` with the right `ErrorCode` (`InvalidParams`, `InvalidRequest`, `InternalError`).
- **Retry with exponential backoff + jitter.** Only on transient (codes 1, 2) and HTTP 5xx. Throttles are **never** retried in-process per Meta's own guidance.
- **Token redaction in logs.** Use `hashToken(token)` from [src/auth/token-store.ts](../src/auth/token-store.ts) for log keys; use `maskToken(token)` from [src/auth/token-manager.ts](../src/auth/token-manager.ts) for human-readable output.

### Your responsibility on every new tool

- **Strict Zod schema.** Use the narrowest types possible: `z.enum([...])` over `z.string()`, `z.number().min(1).max(100)` over `z.number()`, `.describe()` on every field — it shows up in the tool's JSON schema.
- **`ads_*` naming + correct annotation constant.** Match the prefix to the verb; match the annotation to the HTTP semantics.
- **Validate IDs at the boundary.** Pass `account_id` through `normalizeAccountId(...)` and any other resource id through `validateMetaId(id, "campaign")` before interpolating into a path. Both throw on path-traversal / non-numeric input.
- **Reuse shared types.** Pull `Campaign`, `AdSet`, `Insights`, `Targeting`, `Audience`, etc. from [src/meta/types/index.ts](../src/meta/types/index.ts).
- **Reuse `buildFieldsParam`.** [src/utils/validation.ts](../src/utils/validation.ts) — keeps the `?fields=` API consistent across tools.
- **Insights guardrails.** If your endpoint hits `/insights` or accepts `breakdowns` / `time_range` / `date_preset`, call `enforceInsightsGuardrails(...)` from [src/tools/insights-guardrails.ts](../src/tools/insights-guardrails.ts) **before** the API call.
- **`use_unified_attribution_setting`.** For any insights call, route params through `applyAttributionDefault(...)` so responses match Ads Manager (Meta change, 2025-06-10).
- **Preserve cardinality of caller errors.** Let `McpError` thrown by the client surface — don't `try/catch` and turn it into a generic `Error`.

## Anti-patterns (do not ship a PR with any of these)

- ❌ `await fetch("https://graph.facebook.com/...")` directly — bypasses the rate-limiter, circuit-breaker, write-pacer, and error classifier.
- ❌ `server.tool(...)` (deprecated SDK API). Always use `server.registerTool(name, config, handler)`.
- ❌ `meta_ads_*` naming. Use `ads_*`.
- ❌ Tool without `annotations`. Every tool needs at least `{ readOnlyHint: true }` or one of the write annotation spreads.
- ❌ Reading `process.env.META_ACCESS_TOKEN` from a tool handler — breaks multi-tenant. Always go through `getAccessToken()` (or, more commonly, just call `metaApiClient.*`).
- ❌ Manually retrying a `code 4 / 17 / 32 / 613 / 80000-80014` error. Continued calls during throttling **extend `estimated_time_to_regain_access`**. The client already classifies these as non-retryable.
- ❌ `console.log(token)` or `logger.info({ token })`. Use `hashToken(token)` for keys, `maskToken(token)` for display.
- ❌ `try { ... } catch { /* swallow */ }` around a Meta call. Errors carry `fbtrace_id` and classification metadata — they need to bubble.
- ❌ Adding code comments that restate what the code does. Repository convention: comments only when the *why* is non-obvious. See [CONTRIBUTING.md](../CONTRIBUTING.md).

## Tests

Mirror the source path under [tests/](../tests/). For `src/tools/myresources.ts` write `tests/tools/myresources.test.ts`. The shared mocks in [tests/setup.ts](../tests/setup.ts) cover the common cases — note the mock supports `server.registerTool(name, config, handler)` (modern API) and falls back to the legacy `server.tool` form for any not-yet-migrated test.

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerMyResourceTools } from "../../src/tools/myresources.js";
import { createMockMcpServer, setupTestToken, cleanupTestToken, mockFetchResponse } from "../setup.js";

describe("registerMyResourceTools", () => {
  beforeEach(() => setupTestToken());
  afterEach(() => { cleanupTestToken(); vi.restoreAllMocks(); });

  it("registers the expected tools", () => {
    const server = createMockMcpServer();
    registerMyResourceTools(server as never);
    expect(server.registerTool).toHaveBeenCalledTimes(1);
    expect(server._registeredTools[0].name).toBe("ads_get_my_resources");
  });

  it("declares ToolAnnotations", () => {
    const server = createMockMcpServer();
    registerMyResourceTools(server as never);
    const tool = server._registeredTools[0];
    // For a read tool:
    expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  it("calls the Graph API with normalized account id and field defaults", async () => {
    const server = createMockMcpServer();
    registerMyResourceTools(server as never);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ data: [] })));

    const handler = server._registeredTools[0].handler;
    await handler({ account_id: "123", limit: 25, fields: undefined });

    const url = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
    expect(url.pathname).toContain("/act_123/my_resources");
    expect(url.searchParams.get("fields")).toContain("id,name");
  });
});
```

**Important:** [tests/tools/registration.test.ts](../tests/tools/registration.test.ts) hard-codes the total tool count (`expect(server.registerTool).toHaveBeenCalledTimes(93)` at the time of writing). When you add a tool, bump that number, add an `expect(names).toContain("ads_my_new_tool")` assertion, and update the count comment in [src/tools/index.ts](../src/tools/index.ts).

## Verification

Before pushing, run the full local check set — the same one CI enforces:

```bash
npm run lint        # eslint src/
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # tsc → dist/
```

[gitleaks](https://github.com/gitleaks/gitleaks) scans the diff in CI using [.gitleaks.toml](../.gitleaks.toml). If you accidentally paste an `EAA…` token into a fixture or log, it blocks the merge — fix the cause, never `--no-verify`.

For an end-to-end smoke test, point the dev server at the Firestore emulator and exercise the new tool from an MCP client (Claude Desktop, mcp-inspector):

```bash
gcloud beta emulators firestore start --host-port=localhost:8085 &
export FIRESTORE_EMULATOR_HOST=localhost:8085
npm run dev
```

Then call `tools/list` and `tools/call` against the new tool name. Watch the logs for `event=meta_error`, `event=meta_circuit_open`, or `event=META_ABUSE_SIGNAL` — none should fire on a happy-path test.

## PR checklist

The full checklist lives in [.github/PULL_REQUEST_TEMPLATE.md](../.github/PULL_REQUEST_TEMPLATE.md). The items that matter for a new-tool PR:

- [ ] New file under `src/tools/` plus mirror test under `tests/tools/`.
- [ ] Registered in [src/tools/index.ts](../src/tools/index.ts) with a `registerXxxTools(server)` call **and** total tool count bumped in [tests/tools/registration.test.ts](../tests/tools/registration.test.ts).
- [ ] Tool name uses `ads_*` prefix, with `ad_set` (not `adset`) where applicable.
- [ ] `annotations` declared with the right constant from [src/tools/_register.ts](../src/tools/_register.ts); write-tool descriptions prefixed with `WRITE_WARNING`.
- [ ] Zod schema with `.describe()` on every field; narrow enums where possible.
- [ ] All Graph API calls go through `metaApiClient` — no direct `fetch`. (Apify calls go through `apifyApiClient`; any other upstream needs its own client.)
- [ ] IDs validated with `normalizeAccountId` / `validateMetaId`.
- [ ] If the endpoint hits `/insights`, `enforceInsightsGuardrails(...)` is called.
- [ ] No raw token in logs (`hashToken` / `maskToken`).
- [ ] `npm run lint && npm run typecheck && npm test && npm run build` green.
- [ ] `README.md` "Tools" section updated if you want the tool listed publicly.
- [ ] `CHANGELOG.md` updated under the next release section.
- [ ] `CONTRIBUTING.md` — only update if the contribution flow itself changed.

If your tool touches `src/auth/`, `src/store/`, or [src/transport/security-config.ts](../src/transport/security-config.ts), expect maintainer review and explain the threat-model impact in the PR description.
