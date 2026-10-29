# Parity with Meta's official Ads MCP server

Meta runs its own Ads MCP server at `mcp.facebook.com/ads`. This page maps each of its 86 tools to the tool here that does the same job. Meta published the list by category on its developer site; it was captured on 2026-10-28 into [tests/fixtures/official-meta-mcp-tools.json](../tests/fixtures/official-meta-mcp-tools.json). Meta does not publish the parameters of its tools, so the tools here keep this server's own parameter conventions.

[tests/parity/official-parity.test.ts](../tests/parity/official-parity.test.ts) reads the table below. It fails when an official tool has no row, when a row names a tool this server does not register, or when a tool registered under the official name is still marked as missing.

## Status values

- **same name**: this server registers a tool with the official name.
- **equivalent**: another tool here does the same job; its name is in the second column.
- **partial (5x)**: a tool here does part of the job and phase 5x widens it.
- **partial (follow-up)**: a tool here does part of the job, and what is missing is noted under its section for a later change.
- **pending (5x)**: nothing here does it yet; phase 5x adds it.

This server also has tools the official one lacks, among them WhatsApp Business, Business Manager access, video analysis, editing a live ad's copy while keeping its likes, and duplicating an ad with its post. They are listed in the [tool map](../skills/meta-ads-mcp-guide/references/tool-map.md).

## Ad creation and management

| Official tool | Here | Status |
| --- | --- | --- |
| `ads_get_ad_accounts` | `ads_get_ad_accounts` | same name |
| `ads_get_ad_account_pages` | `ads_get_ad_account_pages` | same name |
| `ads_get_pages_for_business` | `ads_get_pages_for_business` | same name |
| `ads_get_user_pages` | `ads_get_user_pages` | same name |
| `ads_get_field_context` | `ads_get_field_context` | same name |
| `ads_create_campaign` | `ads_create_campaign` | same name |
| `ads_create_ad_set` | `ads_create_ad_set` | same name |
| `ads_create_ad` | `ads_create_ad` | same name |
| `ads_update_entity` | `ads_update_entity` | same name |
| `ads_activate_entity` | `ads_activate_entity` | same name |
| `ads_create_creative` | `ads_create_ad_creative` | equivalent |
| `ads_get_creatives` | `ads_get_ad_creatives` | equivalent |
| `ads_get_creative_ads` | `ads_get_creative_ads` | same name |
| `ads_get_ad_images` | `ads_get_ad_images` | same name |
| `ads_get_ad_videos` | `ads_get_ad_videos` | same name |
| `ads_get_ad_preview` | `ads_get_ad_preview` | same name |
| `ads_get_ad_entities` | `ads_get_ad_entities` | same name |
| `ads_library_search` | `ads_library_search` | same name |
| `ads_get_ig_accounts` | `ads_get_instagram_account` | partial (5f) |
| `ads_get_ig_media` | `ads_get_instagram_media` | equivalent |
| `ads_boost_ig_post` | `ads_boost_ig_post` | same name |
| `ads_get_ad_account_custom_audiences` | `ads_get_custom_audiences` | equivalent |
| `ads_get_custom_audience` | `ads_get_audience_details` | equivalent |
| `ads_get_custom_audience_adsets` | `ads_get_custom_audience_adsets` | same name |
| `ads_create_custom_audience` | `ads_create_custom_audience` | same name |
| `ads_update_custom_audience` | `ads_update_custom_audience` | same name |
| `ads_update_custom_audience_users` | `ads_update_custom_audience_users` | same name |
| `ads_delete_custom_audience` | `ads_delete_custom_audience` | same name |

`ads_get_ig_accounts` lists the Instagram accounts linked to an ad account; `ads_get_instagram_account` finds the one linked to a Page.

`ads_update_custom_audience` does not set ad labels: Meta accepts `adlabels` on an audience but cannot read them back (measured on v26.0), so a change could not be confirmed. `ads_get_custom_audience_adsets` reads the account's ad sets with their targeting, because an audience has no ad sets edge and Meta does not filter ad sets by audience (both measured).

## Comprehensive reporting

| Official tool | Here | Status |
| --- | --- | --- |
| `ads_get_opportunity_score` | `ads_get_opportunity_score` | same name |
| `ads_insights_advertiser_context` | `ads_insights_advertiser_context` | same name |
| `ads_insights_anomaly_signal` | `ads_insights_anomaly_signal` | same name |
| `ads_insights_auction_ranking_benchmarks` | `ads_insights_auction_ranking_benchmarks` | same name |
| `ads_insights_industry_benchmark` | `ads_insights_industry_benchmark` | same name |
| `ads_insights_performance_trend` | `ads_insights_performance_trend` | same name |

## Catalog creation and management

Catalogs need the `catalog_management` permission, which goes through Meta's app review.

| Official tool | Here | Status |
| --- | --- | --- |
| `ads_catalog_create` | — | pending (5e) |
| `ads_catalog_update_catalog` | — | pending (5e) |
| `ads_catalog_list_catalogs` | — | pending (5e) |
| `ads_catalog_get_diagnostics` | — | pending (5e) |
| `ads_catalog_get_dynamic_ads_health` | — | pending (5e) |
| `ads_catalog_get_data_sources` | — | pending (5e) |
| `ads_catalog_list_products` | — | pending (5e) |
| `ads_catalog_product_create` | — | pending (5e) |
| `ads_catalog_update_product` | — | pending (5e) |
| `ads_catalog_delete_product` | — | pending (5e) |
| `ads_catalog_create_product_set` | — | pending (5e) |
| `ads_catalog_update_product_set` | — | pending (5e) |
| `ads_catalog_list_product_sets` | — | pending (5e) |
| `ads_catalog_product_set_delete` | — | pending (5e) |
| `ads_catalog_create_product_feed` | — | pending (5e) |
| `ads_catalog_update_product_feed` | — | pending (5e) |
| `ads_catalog_list_product_feeds` | — | pending (5e) |
| `ads_catalog_create_product_feed_upload_session` | — | pending (5e) |
| `ads_catalog_get_product_feed_upload_sessions` | — | pending (5e) |
| `ads_catalog_product_feed_delete` | — | pending (5e) |
| `ads_catalog_create_feed_rule` | — | pending (5e) |
| `ads_catalog_get_feed_rules` | — | pending (5e) |
| `ads_catalog_product_feed_delete_rule` | — | pending (5e) |
| `ads_catalog_event_source_get` | — | pending (5e) |
| `ads_catalog_event_source_get_catalogs` | — | pending (5e) |
| `ads_catalog_event_source_get_health` | — | pending (5e) |
| `ads_catalog_event_source_get_recommendations` | — | pending (5e) |
| `ads_catalog_event_source_connect` | — | pending (5e) |
| `ads_catalog_event_source_disconnect` | — | pending (5e) |

## Signals and datasets

| Official tool | Here | Status |
| --- | --- | --- |
| `ads_get_datasets` | `ads_get_pixels` | partial (5d) |
| `ads_get_dataset_details` | `ads_get_pixel_details` | partial (5d) |
| `ads_get_dataset_stats` | `ads_get_pixel_events` | partial (5d) |
| `ads_get_dataset_quality` | `ads_get_dataset_quality` | same name |
| `ads_pixel_event_read` | — | pending (5d) |
| `ads_pixel_event_create` | — | pending (5d) |
| `ads_pixel_event_update` | — | pending (5d) |
| `ads_pixel_event_delete` | — | pending (5d) |
| `ads_pixel_parameter_read` | — | pending (5d) |
| `ads_pixel_parameter_create` | — | pending (5d) |
| `ads_pixel_parameter_update` | — | pending (5d) |
| `ads_pixel_parameter_delete` | — | pending (5d) |
| `ads_get_customconversions` | `ads_get_custom_conversions` | equivalent |

## Help and troubleshooting

| Official tool | Here | Status |
| --- | --- | --- |
| `ads_get_errors` | `ads_get_errors` | same name |
| `ads_get_help_article` | `ads_get_help_article` | same name |

## A/B tests and conversion lift studies

| Official tool | Here | Status |
| --- | --- | --- |
| `ads_experiment_list_tests` | `ads_get_ad_studies` | equivalent |
| `ads_experiment_check_eligibility` | `ads_experiment_check_eligibility` | same name |
| `ads_experiment_abtest_create_test` | `ads_create_ad_study` | equivalent |
| `ads_experiment_abtest_get_test` | `ads_get_study_details` | partial (follow-up) |
| `ads_experiment_abtest_update_test` | `ads_experiment_abtest_update_test` | same name |
| `ads_experiment_lift_create_test` | `ads_create_ad_study` | equivalent |
| `ads_experiment_lift_get_test` | `ads_get_study_details` | partial (follow-up) |

`ads_get_study_details` gives a study's type, state, times, cells and objectives, but not its results: the official tools return those too.

## Activity logs

| Official tool | Here | Status |
| --- | --- | --- |
| `ads_account_get_activity_logs` | `ads_account_get_activity_logs` | same name |
