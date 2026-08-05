# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- **`npm audit` clean again — 0 vulnerabilities.** Advisories published after
  v3.4.1 had turned CI red on `main`: `ip-address` (SSRF / trust-boundary
  bypass via leading-zero octets, CIDR suffixes and IPv4-mapped IPv6),
  `fast-uri` (host confusion via backslash authority introducer),
  `brace-expansion` (DoS) and `hono` (ReDoS in CORS middleware). Resolved by
  patch-level bumps of six transitive packages; lockfile only, no direct
  dependency changed.

### Added

- **`ads_update_ad_url_tags` — edit the UTM parameters of live ads (1-50 per
  call).** Meta creatives are immutable (`POST /{creative_id}` only accepts
  `name` / `status` / `adlabels`), so the tool clones each ad's creative with
  the new `url_tags` and repoints the ad at the clone. Every strategy
  re-references the source wholesale rather than rebuilding it field by field
  — the existing Facebook post (`object_story_id`, preserving likes and
  comments), the creative spec (`object_story_spec`), or the Instagram post
  (`source_instagram_media_id`) — so media, copy, destination link and CTA
  survive even when they are not readable back individually. Fields that live
  beside the story rather than inside it are carried explicitly: `link_url`,
  `degrees_of_freedom_spec` (dropping it would silently reset an ad's
  Advantage+ creative enhancements), `adlabels`, and the rebuilt
  `call_to_action` for Instagram creatives, which store their CTA on the
  creative itself. Ads sharing a creative mint a single replacement. Ads whose `url_tags` already match are
  skipped, which makes re-running a batch safe; dynamic (`asset_feed_spec`)
  creatives are reported as skipped rather than silently altered. `url_tags:
  ""` removes tracking parameters, a leading `?` is stripped, and `dry_run:
  true` previews the plan without writing. The response reports every ad as
  updated / skipped / failed and warns that updated ads re-enter Meta review.
- **`url_tags` in creative reads** — added to the creative default fields (so
  `ads_get_creative_details` and `ads_get_ad_creatives` surface UTMs) and
  `ads_get_ad_creatives` gained an optional `fields` param, making an
  account-wide UTM audit a single call.

### Fixed

- **`effective_link_url` no longer fails with Meta error #100.** The field is
  derived by this server, not stored by Meta, but it appears in responses — so
  clients echoed it back in `fields` and every such call died with
  `-32602 Invalid parameter: (#100) Tried accessing nonexisting field`. Both
  creative read tools now accept it as a virtual field: it is stripped from the
  Graph request, its sources (`link_url`, `object_story_spec`,
  `asset_feed_spec`) are requested instead, and the derived value is still
  returned.
- **Empty updates no longer report a false success.** `ads_update_ad_creative`
  called without `name`, and `ads_update_ad` called with no updatable field,
  used to POST an empty body to Meta and answer "updated successfully". Both
  now fail with an explanation — the creative error points at
  `ads_update_ad_url_tags` for UTM changes.

- `ads_bulk_create_video_ads` — turns a list of public video URLs into ads in a
  single call: uploads each video, waits for Meta to finish processing, picks the
  preferred thumbnail automatically, builds the creative and creates the ad in the
  target ad set. Ads are created `PAUSED` by default.

  A video rejected by Meta does not abort the batch — each item reports its own
  outcome and failure stage — but an account-wide error (expired token, rate
  limit, abuse signal) stops it immediately instead of retrying under a block.
  The call aims to finish within 180s, well under the Cloud Run request timeout,
  so it returns the IDs it already created; videos left over come back marked
  `skipped`, making a re-run of just those safe from paid duplicates. As with
  `ads_run_report_and_wait`, the budget is best-effort — an individual Graph
  request can still overrun it.

## [3.4.1] — 2026-07-22

### Security

- **`npm audit` clean — 0 vulnerabilities.** Bumped `tsx` 4.21.0 → 4.23.1 and
  `vitest` 4.1.8 → 4.1.10, pulling `esbuild` 0.28.1 (GHSA-g7r4-m6w7-qqqr,
  dev-only arbitrary file read via dev server on Windows). Added an npm
  override forcing `@hono/node-server` ^2.0.5 (resolved 2.0.11) inside
  `@modelcontextprotocol/sdk`, fixing GHSA-frvp-7c67-39w9 (path traversal in
  `serve-static` on Windows via encoded backslash). Full test suite, build,
  and an HTTP-transport smoke test pass with the override.

### Changed

- **`ads_create_ad_set` budget guidance** (#97, thanks @gitlares) — the tool
  description no longer claims a budget is required. It now documents that
  budget belongs at exactly one level: omit both ad-set budget fields when the
  parent campaign owns a daily/lifetime budget (CBO), and only pass them for
  ABO campaigns. `daily_budget` / `lifetime_budget` field descriptions updated
  to match, plus a regression test proving omitted budget fields are not sent
  to Meta.

## [3.4.0] — 2026-07-22

### Added

- **WhatsApp Business management (27 new `whatsapp_*` tools)** — full
  management surface for the WhatsApp Business Platform via the Graph API,
  in four new modules:
  - `src/tools/whatsapp.ts` (8): WABA discovery
    (`whatsapp_get_business_accounts`, with automatic `/me/businesses`
    scanning), phone number list/details, register/deregister,
    request/verify ownership code, and business profile get/update.
  - `src/tools/whatsapp-templates.ts` (6): message template CRUD
    (`whatsapp_get_templates`, `whatsapp_create_template`,
    `whatsapp_update_template`, `whatsapp_delete_template`) plus WABA
    analytics (`whatsapp_get_analytics` — MESSAGING / CONVERSATION /
    PRICING families) and `whatsapp_get_template_analytics`.
  - `src/tools/whatsapp-flows.ts` (6): WhatsApp Flows lifecycle — list,
    create (inline Flow JSON), update (metadata + Flow JSON asset upload),
    publish, deprecate (irreversible), delete (drafts only).
  - `src/tools/whatsapp-config.ts` (7): QR code deep links
    (`message_qrdls` CRUD) and webhook subscription management
    (`subscribed_apps` get/subscribe/unsubscribe). No webhook receiver
    endpoint is included — events go to the Meta App's configured webhook.
  Message sending and media upload are intentionally out of scope.
  The OAuth flow now requests the `whatsapp_business_management` scope;
  previously issued tokens must re-authorize before `whatsapp_*` tools work.
  `MetaApiClient.delete()` now accepts optional query params (needed for
  template deletion by name). Tool count: 97 → 124.
- **`ads_get_invoices`** — read a business's invoices via Meta's
  `GET /{business_id}/business_invoices` edge, returning each invoice's amount,
  billing period, payment status, and PDF download link (`download_uri` /
  `cdn_download_uri`). Accepts a `business_id` directly or an `account_id`
  (the owning business is resolved automatically), plus optional `start_date` /
  `end_date` / `invoice_id` / `type` (`CM` / `DM` / `INV` / `PRO_FORMA`)
  filters. Annotated `READ`. Meta only exposes invoices for businesses on a
  credit line / monthly invoicing and requires a token with the
  `FINANCE_EDITOR` or `FINANCE_ANALYST` role; the tool returns a clear
  explanatory message for card-billed accounts that have no API invoices.
  Tool count: 96 → 97.

## [3.2.1] — 2026-06-04

Documentation and validation hardening. No new tools — tool count stays at 96.

### Fixed

- **`ads_delete_custom_audience`** now validates Meta's response and throws
  when the API does not confirm `success: true`, instead of reporting a
  false positive on any 2xx body. Brings it in line with the
  `ads_share_custom_audience` / `ads_unshare_custom_audience` write tools
  added in 3.2.0.
- **Docs**: README tool count corrected from `93` to `96` (TOC, comparison
  table, features list, and the `Tools` section heading) to match the actual
  registered tool count and the 3.2.0 CHANGELOG.

### Changed

- **Dev dependencies**: lockfile refreshed (vitest/vite toolchain moved from
  `rollup` to `rolldown` bindings). No runtime/production dependency changes.

Cross-account custom-audience sharing. Meta exposes audience sharing via
`POST /{audience_id}/adaccounts` but the MCP had no tool for it — agencies
managing several ad accounts under one Business Manager could create an
audience but not lend it to a sibling account without leaving the assistant.

### Added

- **`ads_share_custom_audience`** — share a custom audience with one or more
  ad accounts in the same Business Manager (`POST /{audience_id}/adaccounts`).
  Accepts numeric or `act_`-prefixed account ids and an optional
  `relationship_type`. Annotated `UPDATE` (idempotent: re-sharing is a no-op).
- **`ads_unshare_custom_audience`** — revoke a share from one or more accounts
  (`DELETE /{audience_id}/adaccounts`). The audience itself is untouched.
- **`ads_get_audience_shared_accounts`** — list the accounts that currently
  have shared access to an audience (`GET /{audience_id}/adaccounts`).

Both write tools validate Meta's response and fail loudly when the API does
not confirm `success: true`, instead of reporting a false positive on any
2xx body. Tool count: 93 → 96.

## [3.1.0] — 2026-05-13

Audit-driven fixes for `ads_clone_ad_set_bundle` after Meta API error
2500 surfaced a duplicate `destination_type` in the GET fields list.
Verified against Marketing API v25 docs and an independent code review.

### Fixed

- **v22 compat**: `instagram_actor_id` removed from
  `AdCreativeObjectStorySpec` (deprecated in v22.0 changelog). The bundle
  now reads `instagram_user_id` with a fallback for legacy creatives and
  always writes the new field. Also applied in `ads_create_ad_creative`.
- **Write safety**: `MetaApiClient` no longer retries `POST` to
  `/act_*/<collection>` paths on timeout/5xx/transient errors. Meta has no
  native idempotency on creates, so the prior retry behavior could mint
  duplicate ad sets/creatives/ads within a single tool invocation.
  `POST /<id>` (updates) and `DELETE` are unaffected.
- **Targeting roundtrip**: strip read-only fields
  (`targeting_relaxation_types`, `is_whatsapp_destination_ad`,
  `targeting_optimization`) returned by Meta on GET before sending the
  targeting back on POST.
- **Geo override**: `applyGeoOverride` now replaces `geo_locations`
  instead of merging. Previously a Chile-source with city targeting cloned
  to Colombia would inherit Chilean cities — Meta's docs recommend
  redefining `geo_locations` on country swaps.
- **Budget priority**: user-provided `target_ad_set.daily_budget` or
  `lifetime_budget` now wins over the source budget regardless of source
  shape. Previously a daily-budget override was silently dropped when the
  source had a lifetime budget.
- **Empty bundle**: throws before claiming idempotency when no source
  creatives are clonable, instead of creating an empty ad set.
- **`asset_feed_spec` order**: the unsupported-feed check now runs before
  the video/link checks, so dynamic creatives that also expose a
  `link_data` shape aren't silently cloned as static.
- **Hard-coded `WEBSITE` fallback** removed for `destination_type` —
  source value (or user override) is used, otherwise omitted.

### Changed

- **Idempotency cache**: moved from an in-process `Map` to a
  Firestore-backed store (`clone_bundle_operations` collection). Survives
  Cloud Run restarts and multi-instance deployments. Falls back to in-
  memory when Firestore env vars are not set.
- **Partial-failure tracking**: the store records created resources
  incrementally; if a step fails, the error surfaces the partial state
  (`ad_set=…, creatives=[…], ads=[…]`) and the run is marked `failed`.
  Retries with the same `idempotency_key` are rejected with the orphan
  list until the user cleans up.
- **Stale lock reclaim**: `in_progress` records older than 15 minutes
  (e.g. orphaned by a process crash between `claim` and `markFailed`) are
  taken over on retry instead of blocking forever.
- **CTA validation**: `creative_overrides.call_to_action_type` is now
  validated against the shared `ctaEnum` — typos are rejected at schema
  time instead of after creating the ad set.

### Added

- `target_ad_set.end_time` on `ads_clone_ad_set_bundle` (required when
  the user provides `lifetime_budget`).
- CBO support: bundle no longer requires source-level budget when the
  parent campaign uses Campaign Budget Optimization.

## [3.0.0] — 2026-05-06

### Why this release

On 2026-04-29 Meta launched its own remote MCP server at
`mcp.facebook.com/ads` with a curated naming convention (`ads_create_campaign`,
`ads_update_entity`, `ads_insights_*`) and supports ChatGPT, Claude, and
Perplexity natively.

This project's **agency multi-tenant** angle is unchanged — Meta's official MCP
is per-user OAuth and cannot operate across N client accounts on behalf of an
agency. v3.0.0 aligns the **vocabulary** so an agent that learned the official
MCP transfers seamlessly to ours, and adds the diagnostic / help / cross-account
tools the official server doesn't cover.

### Breaking changes

- **All tool names changed**: `meta_ads_*` → `ads_*`. Drop the `meta_` prefix.
- `adset` → `ad_set` (with underscore) in tool names *and* parameter names —
  matches Meta's official `ads_create_ad_set`, `ads_update_ad_set`, etc.
- `ads_get_pages` → `ads_get_pages_for_business` (matches official MCP).
- `meta_ads_get_account_insights` **removed** — replaced by
  `ads_insights_advertiser_context` (richer first-message account snapshot).
- All write tools now declare `ToolAnnotations`
  (`destructiveHint` / `idempotentHint`) and prefix descriptions with
  `⚠️ Modifies live ads/account data.`. MCP clients (Claude, ChatGPT) display
  these as confirmation hints.
- Internal tool registration migrated from the deprecated
  `server.tool(...)` API to `server.registerTool(name, config, handler)`.
  No user-facing change; downstream code that imported `register*Tools` is
  unaffected.

### Added

**Generic entity helpers** (mirror Meta's official vocabulary):
- `ads_get_ad_entities` — generic getter, dispatches by `entity_type`
  (campaign / ad_set / ad).
- `ads_update_entity` — generic updater.
- `ads_activate_entity` — toggle status (ACTIVE / PAUSED / ARCHIVED).

**Insight views** (semantic, agent-friendly):
- `ads_insights_performance_trend` — daily/weekly/monthly KPI series.
- `ads_insights_anomaly_signal` — auto-compare last N days vs prior.
- `ads_insights_auction_ranking_benchmarks` — quality / engagement / conversion
  rankings (ad-level only).
- `ads_insights_industry_benchmark` — observed CTR/CPC/CPM vs curated industry
  medians.
- `ads_insights_advertiser_context` — first-message account snapshot
  (replaces `ads_get_account_insights`).

**Diagnostic tools** (parity with Meta's official MCP):
- `ads_get_opportunity_score` — Meta's 0-100 health/improvement signal.
- `ads_get_dataset_quality` — synthetic pixel/dataset health overview
  (last fired, match rate, AAM status, health score 0-100).
- `ads_get_errors` — current account errors / disapproved ads / restrictions.

**Help center search**:
- `ads_get_help_article` — full-text search across a curated set of
  Meta Business Help Center articles (rejection reasons, pixel setup,
  audience requirements, billing, learning phase, ad rankings, AEM, etc.).

**Agency macros** (cross-account — not in the official MCP):
- `ads_diagnose_underperformance` — bundles anomaly detection,
  ranking lookup, pixel quality, account issues, returns a unified report.
- `ads_portfolio_summary` — parallel aggregation across N ad accounts.

### Tool-name migration table

#### Renamed (drop `meta_` prefix)

| v2 | v3 |
| --- | --- |
| `meta_ads_get_ad_accounts` | `ads_get_ad_accounts` |
| `meta_ads_get_account_info` | `ads_get_account_info` |
| `meta_ads_get_pages` | `ads_get_pages_for_business` |
| `meta_ads_get_campaigns` | `ads_get_campaigns` |
| `meta_ads_get_campaign_details` | `ads_get_campaign_details` |
| `meta_ads_create_campaign` | `ads_create_campaign` |
| `meta_ads_update_campaign` | `ads_update_campaign` |
| `meta_ads_delete_campaign` | `ads_delete_campaign` |
| `meta_ads_get_adsets` | `ads_get_ad_sets` |
| `meta_ads_get_adset_details` | `ads_get_ad_set_details` |
| `meta_ads_clone_adset_bundle` | `ads_clone_ad_set_bundle` |
| `meta_ads_create_adset` | `ads_create_ad_set` |
| `meta_ads_update_adset` | `ads_update_ad_set` |
| `meta_ads_delete_adset` | `ads_delete_ad_set` |
| `meta_ads_get_ads` | `ads_get_ads` |
| `meta_ads_get_ad_details` | `ads_get_ad_details` |
| `meta_ads_create_ad` | `ads_create_ad` |
| `meta_ads_update_ad` | `ads_update_ad` |
| `meta_ads_delete_ad` | `ads_delete_ad` |
| `meta_ads_get_ad_creatives` | `ads_get_ad_creatives` |
| `meta_ads_get_creative_details` | `ads_get_creative_details` |
| `meta_ads_create_ad_creative` | `ads_create_ad_creative` |
| `meta_ads_update_ad_creative` | `ads_update_ad_creative` |
| `meta_ads_upload_ad_image` | `ads_upload_ad_image` |
| `meta_ads_get_ad_images` | `ads_get_ad_images` |
| `meta_ads_get_ad_videos` | `ads_get_ad_videos` |
| `meta_ads_get_video_details` | `ads_get_video_details` |
| `meta_ads_upload_ad_video` | `ads_upload_ad_video` |
| `meta_ads_get_insights` | `ads_get_insights` |
| `meta_ads_search_interests` | `ads_search_interests` |
| `meta_ads_get_interest_suggestions` | `ads_get_interest_suggestions` |
| `meta_ads_search_behaviors` | `ads_search_behaviors` |
| `meta_ads_search_demographics` | `ads_search_demographics` |
| `meta_ads_search_geo_locations` | `ads_search_geo_locations` |
| `meta_ads_estimate_audience_size` | `ads_estimate_audience_size` |
| `meta_ads_get_targeting_description` | `ads_get_targeting_description` |
| `meta_ads_create_budget_schedule` | `ads_create_budget_schedule` |
| `meta_ads_get_lead_forms` | `ads_get_lead_forms` |
| `meta_ads_get_leads` | `ads_get_leads` |
| `meta_ads_get_ad_leads` | `ads_get_ad_leads` |
| `meta_ads_create_lead_form` | `ads_create_lead_form` |
| `meta_ads_get_custom_audiences` | `ads_get_custom_audiences` |
| `meta_ads_get_audience_details` | `ads_get_audience_details` |
| `meta_ads_create_custom_audience` | `ads_create_custom_audience` |
| `meta_ads_create_lookalike_audience` | `ads_create_lookalike_audience` |
| `meta_ads_delete_custom_audience` | `ads_delete_custom_audience` |
| `meta_ads_generate_preview` | `ads_generate_preview` |
| `meta_ads_get_ad_preview` | `ads_get_ad_preview` |
| `meta_ads_get_pixels` | `ads_get_pixels` |
| `meta_ads_get_pixel_details` | `ads_get_pixel_details` |
| `meta_ads_get_pixel_events` | `ads_get_pixel_events` |
| `meta_ads_get_custom_conversions` | `ads_get_custom_conversions` |
| `meta_ads_create_custom_conversion` | `ads_create_custom_conversion` |
| `meta_ads_get_ad_comments` | `ads_get_ad_comments` |
| `meta_ads_hide_comment` | `ads_hide_comment` |
| `meta_ads_reply_comment` | `ads_reply_comment` |
| `meta_ads_delete_comment` | `ads_delete_comment` |
| `meta_ads_get_ad_rules` | `ads_get_ad_rules` |
| `meta_ads_get_rule_details` | `ads_get_rule_details` |
| `meta_ads_create_ad_rule` | `ads_create_ad_rule` |
| `meta_ads_update_ad_rule` | `ads_update_ad_rule` |
| `meta_ads_delete_ad_rule` | `ads_delete_ad_rule` |
| `meta_ads_get_ad_studies` | `ads_get_ad_studies` |
| `meta_ads_get_study_details` | `ads_get_study_details` |
| `meta_ads_create_ad_study` | `ads_create_ad_study` |
| `meta_ads_create_async_report` | `ads_create_async_report` |
| `meta_ads_get_report_status` | `ads_get_report_status` |
| `meta_ads_get_report_results` | `ads_get_report_results` |
| `meta_ads_run_report_and_wait` | `ads_run_report_and_wait` |
| `meta_ads_get_billing_info` | `ads_get_billing_info` |
| `meta_ads_get_spend_limit` | `ads_get_spend_limit` |
| `meta_ads_update_spend_cap` | `ads_update_spend_cap` |
| `meta_ads_rate_status` | `ads_rate_status` |
| `meta_ads_get_instagram_account` | `ads_get_instagram_account` |
| `meta_ads_get_instagram_media` | `ads_get_instagram_media` |
| `meta_ads_list_tokens` | `ads_list_tokens` |
| `meta_ads_set_active_token` | `ads_set_active_token` |
| `meta_ads_register_token` | `ads_register_token` |
| `meta_ads_delete_token` | `ads_delete_token` |

#### Removed

| v2 | Replacement |
| --- | --- |
| `meta_ads_get_account_insights` | `ads_insights_advertiser_context` |

#### Added in v3

| Tool | Category |
| --- | --- |
| `ads_get_ad_entities` | Generic helper |
| `ads_update_entity` | Generic helper |
| `ads_activate_entity` | Generic helper |
| `ads_insights_performance_trend` | Insight view |
| `ads_insights_anomaly_signal` | Insight view |
| `ads_insights_auction_ranking_benchmarks` | Insight view |
| `ads_insights_industry_benchmark` | Insight view |
| `ads_insights_advertiser_context` | Insight view |
| `ads_get_opportunity_score` | Diagnostic |
| `ads_get_dataset_quality` | Diagnostic |
| `ads_get_errors` | Diagnostic |
| `ads_get_help_article` | Help search |
| `ads_diagnose_underperformance` | Agency macro |
| `ads_portfolio_summary` | Agency macro |

### Migration

For client-side updates, see [docs/migration-v3.md](docs/migration-v3.md).

The internal API of `register*Tools(server)` exporters is unchanged, so anyone
embedding this server programmatically only needs to update tool names that
their callers reference.

### Compatibility

- Node 20+ (unchanged)
- `@modelcontextprotocol/sdk` ^1.29
- Same auth model: per-user Meta OAuth + System User token registry, server-to-server
  with API key, encrypted-at-rest token storage in Firestore.
- Same transports: HTTP and stdio.

---

## [2.0.2] — Prior to 2026-05-06

See git history. v2.x ships 80 tools under the `meta_ads_*` prefix.
