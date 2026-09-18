# Migrating from v2 to v3

v3.0.0 aligns this MCP's vocabulary with Meta's official MCP server
(`mcp.facebook.com/ads`), released 2026-04-29 under the "Ads AI Connectors"
umbrella. After upgrading, agents that learned the official MCP transfer
seamlessly to ours, and you gain 14 new tools the official server doesn't ship.

This is a **hard breaking change** — there are no aliases for old names.

## TL;DR

1. Update your MCP client config (Claude Desktop, ChatGPT custom connector,
   internal agent code, prompts) to call `ads_*` instead of `meta_ads_*`.
2. Replace `adset` with `ad_set` everywhere it appears in tool names and
   parameter names.
3. Replace `meta_ads_get_pages` with `ads_get_pages_for_business`.
4. Replace `meta_ads_get_account_insights` with
   `ads_insights_advertiser_context` (richer return shape).
5. (Optional) Take advantage of new tools: `ads_get_opportunity_score`,
   `ads_get_dataset_quality`, `ads_get_errors`, `ads_get_help_article`,
   `ads_diagnose_underperformance`, `ads_portfolio_summary`, the 5
   `ads_insights_*` views, and 3 generic entity helpers.

## What changed

### Naming convention

| Pattern | v2 | v3 |
| --- | --- | --- |
| Prefix | `meta_ads_` | `ads_` |
| Ad-set noun | `adset` (one word) | `ad_set` (with underscore) |
| Pages getter | `meta_ads_get_pages` | `ads_get_pages_for_business` |

Find-and-replace recipes:

```bash
# Tool names
sed -i '' 's/meta_ads_get_pages\b/ads_get_pages_for_business/g' your-config.json
sed -i '' 's/meta_ads_get_account_insights\b/ads_insights_advertiser_context/g' your-config.json
sed -i '' 's/meta_ads_/ads_/g' your-config.json

# adset → ad_set in tool names (apply AFTER the prefix change)
sed -i '' 's/ads_get_adsets\b/ads_get_ad_sets/g' your-config.json
sed -i '' 's/ads_get_adset_details\b/ads_get_ad_set_details/g' your-config.json
sed -i '' 's/ads_clone_adset_bundle\b/ads_clone_ad_set_bundle/g' your-config.json
sed -i '' 's/ads_create_adset\b/ads_create_ad_set/g' your-config.json
sed -i '' 's/ads_update_adset\b/ads_update_ad_set/g' your-config.json
sed -i '' 's/ads_delete_adset\b/ads_delete_ad_set/g' your-config.json

# Parameter names — adset_id → ad_set_id
sed -i '' 's/\badset_id\b/ad_set_id/g' your-config.json
sed -i '' 's/\bsource_adset_id\b/source_ad_set_id/g' your-config.json
sed -i '' 's/\btarget_adset\b/target_ad_set/g' your-config.json
sed -i '' 's/\bnew_adset\b/new_ad_set/g' your-config.json
```

### Parameter renames

The `adset` → `ad_set` change extends to parameters and response fields:

| Tool | v2 param/field | v3 param/field |
| --- | --- | --- |
| `ads_get_ad_set_details`, `ads_update_ad_set`, `ads_delete_ad_set` | `adset_id` | `ad_set_id` |
| `ads_get_ads` | `adset_id` (filter) | `ad_set_id` (filter) |
| `ads_clone_ad_set_bundle` | `source_adset_id`, `target_adset` | `source_ad_set_id`, `target_ad_set` |
| `ads_clone_ad_set_bundle` (return shape) | `new_adset` | `new_ad_set` |
| `ads_create_ad`, returned ad clone shape | `adset_id` | `ad_set_id` |

The Marketing API URL parameters that Meta itself uses (`adset_id`) stay as-is
inside JSON bodies — only our tool surface uses `ad_set_id`.

### Tool annotations

All tools now declare `ToolAnnotations`. Compatible MCP clients use these for
display:

- `readOnlyHint: true` on every read tool (44+ tools).
- `destructiveHint: true` on every delete (campaign / ad set / ad / audience /
  comment / rule / token).
- `idempotentHint: true` on updates, deletes, status toggles.
- Write-tool descriptions are prefixed with `⚠️ Modifies live ads/account data.`
  for clients that ignore annotations.

If your client handles MCP annotations natively (Claude Desktop / Claude.ai),
delete operations now show a confirmation prompt by default.

### Removed tools

`meta_ads_get_account_insights` no longer exists. Replace with
`ads_insights_advertiser_context`, which returns:

- Account-level KPIs for the period (spend, impressions, CTR, CPC, CPM,
  frequency, actions).
- Top N campaigns by spend with per-campaign metrics.
- Account metadata (name, currency, status, balance).

This is a richer first-message snapshot and matches the official Meta MCP's
`ads_insights_advertiser_context` semantics.

### New capabilities

#### Generic entity helpers

Coexist with the entity-specific tools — use whichever fits your prompt style.

```jsonc
// list ad sets under a campaign — equivalent calls
{ "tool": "ads_get_ad_sets",     "args": { "campaign_id": "123" } }
{ "tool": "ads_get_ad_entities", "args": { "entity_type": "ad_set", "parent_id": "123" } }
```

Tools: `ads_get_ad_entities`, `ads_update_entity`, `ads_activate_entity`.

#### Insight views (semantic, easier for LLMs to pick correctly)

- `ads_insights_performance_trend` — time series of spend / clicks / CTR / CPC
  by day, week, or month.
- `ads_insights_anomaly_signal` — auto-compares last N days against the prior
  N days, flags metrics that moved >threshold%.
- `ads_insights_auction_ranking_benchmarks` — quality, engagement-rate, and
  conversion-rate rankings (ad-level only, after ~500 impressions).
- `ads_insights_industry_benchmark` — observed CTR/CPC/CPM vs curated
  baselines (igaming, ecommerce, lead_gen, saas, finance, education).
- `ads_insights_advertiser_context` — first-message account snapshot
  (replaces `meta_ads_get_account_insights`).

The power tool `ads_get_insights` (formerly `meta_ads_get_insights`) remains
for arbitrary breakdowns, attribution windows, custom field sets, and time
increments.

#### Diagnostics

- `ads_get_opportunity_score` — Meta's 0-100 health/improvement signal at
  account or campaign level (mirrors official MCP).
- `ads_get_dataset_quality` — synthetic pixel/dataset health overview with
  match-rate, last-fired age, AAM status, and a 0-100 health score.
  Distinct from `ads_get_pixel_details` (raw pixel data + install code) and
  `ads_get_pixel_events` (raw event stats).
- `ads_get_errors` — current account-level issues: disapproved ads, ads with
  delivery issues, account restrictions. Pair with `ads_get_help_article` to
  look up rejection reasons.

#### Help center search

`ads_get_help_article` searches a curated set of Meta Business Help Center
articles by query (e.g. `"why was my ad rejected"`). Backed by a static
dataset; for the current authoritative version always follow the returned URL.

#### Agency macros (cross-account)

These are differentiators vs the official Meta MCP, which is per-user OAuth
and cannot operate across multiple advertiser accounts.

- `ads_diagnose_underperformance` — bundles anomaly + ranking + pixel quality
  + active issues into a single call. Returns findings + hypotheses.
- `ads_portfolio_summary` — parallel aggregation of spend / impressions /
  clicks / CTR / CPC / CPM across up to 20 accounts.

## Compatibility

- Node 20+ for the 3.x line. From 4.0.0 the floor is Node 22.13+.
- `@modelcontextprotocol/sdk` ^1.29 (annotations + `registerTool` API). 4.0.0 moves to ^1.30; see [migration-v4.md](migration-v4.md).
- HTTP and stdio transports unchanged.
- Per-user OAuth, System User token registry, server-to-server API key,
  Firestore-backed encrypted token store — all unchanged.
- The `register*Tools(server)` exports remain stable; only the tool name
  strings registered with the server changed.

## Why no aliases?

Soft aliases double the visible tool list and add ambient noise that pushes
agents toward the wrong (deprecated) names. Since the rename is a one-time
search-and-replace and we surface a CHANGELOG with every old → new mapping,
the cost is well-defined and short. Carrying both names indefinitely is the
worse trade-off.
