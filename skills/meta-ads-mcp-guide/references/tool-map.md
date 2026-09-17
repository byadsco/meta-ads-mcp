# Tool map

Every tool this server registers, grouped by what you are trying to do. 142 in total; 79 are read-only.

A ⚠️ marks a tool that changes live data, spends money or touches stored credentials. Read the tool's own description before calling one: it carries the argument rules this map deliberately leaves out.

## Accounts and pages

- `ads_get_ad_accounts` — List the ad accounts this token can reach. Start here when no account id is known.
- `ads_get_account_info` — Account currency, timezone, spend cap and status. Read before interpreting any money figure.
- `ads_get_pages_for_business` — The Facebook Pages available for ad creation.

## Campaigns

- `ads_get_campaigns` — List the campaigns on an account, filterable by status.
- `ads_get_campaign_details` — One campaign in full, including budget and special ad categories.
- `ads_create_campaign` ⚠️ — Create a campaign. Objective and special_ad_categories cannot be changed later.
- `ads_update_campaign` ⚠️ — Change a campaign's name, status, budget or bid strategy.
- `ads_delete_campaign` ⚠️ — Delete a campaign and everything under it.

## Ad sets

- `ads_get_ad_sets` — List the ad sets in a campaign or account.
- `ads_get_ad_set_details` — One ad set in full, including its targeting spec.
- `ads_create_ad_set` ⚠️ — Create an ad set: budget, schedule, optimization goal and targeting.
- `ads_update_ad_set` ⚠️ — Change an ad set's budget, schedule, status or targeting.
- `ads_clone_ad_set_bundle` ⚠️ — Copy an ad set with its ads into another campaign, keeping creatives and targeting.
- `ads_delete_ad_set` ⚠️ — Delete an ad set and its ads.

## Ads

- `ads_get_ads` — List the ads in an ad set, campaign or account.
- `ads_get_ad_details` — One ad in full. For a review, prefer ads_get_ad_dossier.
- `ads_create_ad` ⚠️ — Create an ad from an existing creative, in an ad set.
- `ads_update_ad` ⚠️ — Change an ad's name, status or creative.
- `ads_update_ad_url_tags` ⚠️ — Rewrite the UTM tags on an ad's creative without rebuilding it.
- `ads_delete_ad` ⚠️ — Delete an ad. Pausing it with ads_activate_entity is reversible; this is not.

## Creatives and assets

- `ads_get_ad_creatives` — List creatives for an ad or account, with their UTM tags.
- `ads_get_creative_details` — One creative in full, including the derived effective landing URL.
- `ads_create_ad_creative` ⚠️ — Create a creative from a page post, image, video or asset feed.
- `ads_update_ad_creative` ⚠️ — Change a creative's name or its URL tags.
- `ads_upload_ad_image` ⚠️ — Upload an image and get the hash a creative needs.
- `ads_get_ad_images` — List the images uploaded to an account, by hash.
- `ads_get_ad_videos` — List the videos uploaded to an account.
- `ads_get_video_details` — One video's metadata, including its signed source URL and permalink.
- `ads_upload_ad_video` ⚠️ — Upload a video and wait for Meta to finish processing it.

## Looking at the creative

- `ads_get_ad_dossier` — Everything about one of your ads in one call: ad, ad set, campaign, creative, targeting, performance and media.
- `ads_get_creative_media` — See a creative: images inline, plus video posters or keyframes. The cheapest way to look at an ad.
- `ads_get_video_media` — Get an ad video a model can actually analyze: keyframes, the MP4 itself, or signed links. Own videos and Ad Library videos.
- `ads_analyze_video` — Have the server watch a video with Gemini and return a structured read. Needs the tenant's Gemini key.
- `ads_get_ad_preview` — A shareable preview link for an ad.
- `ads_generate_preview` — Render a preview for a creative in a given placement.

## Generic entity helpers

- `ads_get_ad_entities` — Fetch several entities of any level by id in one call.
- `ads_update_entity` ⚠️ — Update any entity by id, when the specific tool does not fit.
- `ads_activate_entity` ⚠️ — Activate, pause or archive any entity by id.

## Insights

- `ads_get_insights` — The general insights tool: any level, any fields, any breakdown. Guardrails reject combinations Meta rejects.
- `ads_insights_performance_trend` — How a metric moved over time, period against period.
- `ads_insights_anomaly_signal` — What changed abnormally against the prior period.
- `ads_insights_auction_ranking_benchmarks` — The three auction rankings and what they imply.
- `ads_insights_industry_benchmark` — Performance against the industry benchmark.
- `ads_insights_advertiser_context` — Account-level context an agency reads before judging a campaign.

## Async reports

- `ads_create_async_report` ⚠️ — Start an async insights report for a wide query.
- `ads_get_report_status` — Whether an async report has finished yet.
- `ads_get_report_results` — Read the rows of a finished async report.
- `ads_run_report_and_wait` ⚠️ — Start an async report and poll until it is ready.

## Targeting

- `ads_search_interests` — Find interest targeting terms by keyword.
- `ads_get_interest_suggestions` — Interests related to ones already chosen.
- `ads_search_behaviors` — Browse the behaviour targeting options Meta offers.
- `ads_search_demographics` — Browse the demographic targeting options Meta offers.
- `ads_search_geo_locations` — Find countries, regions, cities and radius targets.
- `ads_estimate_audience_size` — Estimated reach for a targeting spec, before spending on it.
- `ads_get_targeting_description` — Meta's own sentences describing an ad set's targeting.

## Audiences

- `ads_get_custom_audiences` — List the custom and lookalike audiences on the account.
- `ads_get_audience_details` — One audience: size, type and delivery status.
- `ads_create_custom_audience` ⚠️ — Create a custom audience from a rule or a source.
- `ads_create_lookalike_audience` ⚠️ — Create a lookalike from an existing audience.
- `ads_share_custom_audience` ⚠️ — Share an audience with another ad account.
- `ads_unshare_custom_audience` ⚠️ — Stop sharing an audience with an account.
- `ads_get_audience_shared_accounts` — Which accounts an audience is shared with.
- `ads_delete_custom_audience` ⚠️ — Delete a custom or lookalike audience, and any ad sets stop using it.

## Budget and billing

- `ads_create_budget_schedule` ⚠️ — Schedule a budget increase for a campaign or ad set.
- `ads_get_billing_info` — Payment methods and the account billing state.
- `ads_get_spend_limit` — The account spend cap and how much of it is used.
- `ads_update_spend_cap` ⚠️ — Raise, lower or clear the account spend cap.
- `ads_get_invoices` — Invoices Meta has issued to the account.

## Leads

- `ads_get_lead_forms` — List the instant lead forms on a page.
- `ads_create_lead_form` ⚠️ — Create an instant form for lead ads.
- `ads_get_leads` — Download the leads submitted through a form.
- `ads_get_ad_leads` — Download leads attributed to one ad.

## Pixels and conversions

- `ads_get_pixels` — List the pixels available on the account.
- `ads_get_pixel_details` — One pixel: last fired, match rate, availability.
- `ads_get_pixel_events` — The events a pixel has received recently.
- `ads_get_custom_conversions` — List the custom conversions defined on the account.
- `ads_create_custom_conversion` ⚠️ — Create a custom conversion from pixel events.

## Comments

- `ads_get_ad_comments` — Read the comments on an ad post.
- `ads_hide_comment` ⚠️ — Hide a comment so only its author still sees it.
- `ads_reply_comment` ⚠️ — Reply to a comment on an ad post, as the page.
- `ads_delete_comment` ⚠️ — Delete a comment from the ad post, permanently.

## Automated rules

- `ads_get_ad_rules` — List the automated rules defined on the account.
- `ads_create_ad_rule` ⚠️ — Create an automated rule: a condition, a schedule and an action.
- `ads_get_rule_details` — One rule in full, including its evaluation spec.
- `ads_update_ad_rule` ⚠️ — Change a rule's condition, schedule or action.
- `ads_delete_ad_rule` ⚠️ — Delete an automated rule, with its history.

## A/B testing

- `ads_get_ad_studies` — List A/B tests (ad studies) on the account.
- `ads_create_ad_study` ⚠️ — Create a split test between two or more cells.
- `ads_get_study_details` — One study and its results so far.

## Diagnostics and health

- `ads_diagnose_underperformance` — Compound diagnosis of an underperforming object: anomalies, rankings, pixel health and issues.
- `ads_get_opportunity_score` — Meta's opportunity score and what it suggests fixing.
- `ads_get_dataset_quality` — Signal quality for a dataset: match rate, deduplication, freshness.
- `ads_get_errors` — The ads currently disapproved or flagged with issues.
- `ads_rate_status` — Live quota usage, open circuits and write-pacer state for this server.
- `ads_get_help_article` — Search Meta Business Help Center articles.

## Agency macros

- `ads_portfolio_summary` — Cross-account roll-up for an agency view.
- `ads_bulk_create_video_ads` ⚠️ — Video URLs to live ads in one call: upload, wait, thumbnail, creative, ad.

## Instagram

- `ads_get_instagram_account` — The Instagram account linked to a page or ad account.
- `ads_get_instagram_media` — Recent Instagram media, for boosting or reference.

## Competitor research (Ad Library, via Apify)

- `ads_library_scrape` ⚠️ — Start an Ad Library scrape by keyword or page. Costs money; a hard spend cap is sent with it.
- `ads_library_get_run_status` — Whether a scrape has finished, and what it charged.
- `ads_library_get_results` — Page through scraped ads: compact projection with a media summary and each ad's offset.
- `ads_library_get_ad_details` — One scraped ad in full: copy per card, images inline, videos as posters, keyframes or links.
- `ads_library_list_runs` — Past scrapes, newest first. Reuse a dataset instead of paying twice.
- `ads_library_abort_run` ⚠️ — Stop a running scrape.
- `ads_library_register_apify_token` ⚠️ — Store the tenant's Apify token, encrypted, after validating it.
- `ads_library_get_apify_token_status` — Whether an Apify token is available and where it comes from.
- `ads_library_delete_apify_token` ⚠️ — Delete the tenant's stored Apify token.

## Credentials

- `ads_list_tokens` — List the Meta tokens registered for this user.
- `ads_set_active_token` ⚠️ — Choose which registered Meta token the session uses.
- `ads_register_token` ⚠️ — Register a Meta System User token, encrypted at rest.
- `ads_delete_token` ⚠️ — Delete a registered Meta token.
- `ads_register_gemini_key` ⚠️ — Store the tenant's Gemini API key, encrypted, after validating it.
- `ads_get_gemini_key_status` — Whether a Gemini key is available and where it comes from.
- `ads_delete_gemini_key` ⚠️ — Delete the tenant's stored Gemini key.

## WhatsApp Business

- `whatsapp_get_business_accounts` — List WhatsApp Business accounts.
- `whatsapp_get_phone_numbers` — Phone numbers on a WABA and their verification state.
- `whatsapp_register_phone` ⚠️ — Register a phone number for the Cloud API.
- `whatsapp_deregister_phone` ⚠️ — Deregister a phone number from the Cloud API.
- `whatsapp_request_verification_code` ⚠️ — Request a verification code for a number.
- `whatsapp_verify_code` ⚠️ — Complete number verification with the code.
- `whatsapp_get_business_profile` — Read the business profile shown in chats.
- `whatsapp_update_business_profile` ⚠️ — Update the business profile.
- `whatsapp_get_templates` — List message templates with their approval status.
- `whatsapp_create_template` ⚠️ — Submit a message template for approval.
- `whatsapp_update_template` ⚠️ — Edit a template that is not yet approved.
- `whatsapp_delete_template` ⚠️ — Delete a message template from the WABA.
- `whatsapp_get_analytics` — Messaging, conversation and pricing analytics for a WABA.
- `whatsapp_get_template_analytics` — Per-template send, delivery and read analytics.
- `whatsapp_get_flows` — List the WhatsApp Flows on a WABA.
- `whatsapp_create_flow` ⚠️ — Create a WhatsApp Flow in draft.
- `whatsapp_update_flow` ⚠️ — Update a Flow, including its Flow JSON.
- `whatsapp_publish_flow` ⚠️ — Publish a Flow so it can be used in messages.
- `whatsapp_deprecate_flow` ⚠️ — Deprecate a published Flow.
- `whatsapp_delete_flow` ⚠️ — Delete a draft WhatsApp Flow.
- `whatsapp_get_qr_codes` — List the QR deep links on a phone number.
- `whatsapp_create_qr_code` ⚠️ — Create a QR deep link with a prefilled message.
- `whatsapp_update_qr_code` ⚠️ — Change a QR deep link's message.
- `whatsapp_delete_qr_code` ⚠️ — Delete a QR deep link.
- `whatsapp_get_webhook_subscriptions` — Which apps are subscribed to a WABA's webhooks.
- `whatsapp_subscribe_webhook` ⚠️ — Subscribe this app to a WABA's webhooks.
- `whatsapp_unsubscribe_webhook` ⚠️ — Unsubscribe from a WABA's webhooks.
