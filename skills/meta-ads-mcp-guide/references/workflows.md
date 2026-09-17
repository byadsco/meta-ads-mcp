# Workflows

Call sequences for the jobs that come up repeatedly. Each one starts from what the human actually asked, not from a tool name.

## Account snapshot

"How are things going?"

1. `ads_get_ad_accounts` if no account id is known.
2. `ads_get_account_info` — currency, timezone, spend cap, account status. Everything below is meaningless without the currency.
3. `ads_insights_advertiser_context` for the account-level read.
4. `ads_get_campaigns` with `effective_status: ["ACTIVE"]`, then `ads_get_insights` at campaign level for the period.
5. `ads_get_errors` — anything disapproved or with issues is usually the first thing to report.

Report spend, results and cost per result against the previous period, then the exceptions. A list of every campaign is not a snapshot.

## Diagnosing an underperformer

"This campaign stopped working."

1. `ads_diagnose_underperformance` on the object, with `pixel_id` when the objective is conversions. It combines anomaly detection, rankings, pixel health and active issues.
2. Follow its hypotheses down: it names the axis, not the ad. `ads_get_insights` at ad level, sorted by spend, finds the ad carrying the loss.
3. `ads_get_ad_dossier` on that ad. The dossier's retention funnel and rankings usually settle whether it is the creative, the offer or the audience.
4. For a video, the video-analysis skill decides how to actually look at it.

Frequency above roughly 3 in a short window, a falling CTR with a stable CPM, and a below-average quality ranking together mean creative fatigue. A stable CTR with a rising cost per result points at the landing page or the offer instead.

## Creative review

"Which of these is working, and why?"

1. `ads_get_insights` at ad level for the period, with enough spend behind each ad to mean anything.
2. `ads_get_ad_dossier` on the best and the worst. Reviewing only the losers tells you half the story.
3. Compare hooks, offers and formats, not just numbers. The creative-analysis skill has the rubric.
4. Write the conclusion as a testable change, not as praise.

## Budget change

"Increase the budget on the winner."

1. `ads_get_campaign_details` or `ads_get_ad_set_details` — read the current budget and bid strategy.
2. `ads_get_account_info` — confirm the spend cap leaves room.
3. Say the change in the advertiser's currency, and get agreement.
4. `ads_update_campaign` or `ads_update_ad_set`, or `ads_create_budget_schedule` when it should take effect later.

Large jumps reset the learning phase. Meta's own guidance is roughly 20% at a time; say so when someone asks for a tripling.

## Automated rules

"Pause anything with a CPA above 50."

1. `ads_get_ad_rules` — an overlapping rule is the usual cause of surprising pauses.
2. `ads_create_ad_rule` with an explicit evaluation spec and schedule.
3. `ads_get_rule_details` afterwards to confirm what Meta stored, which is not always what was asked for.

A rule that pauses on a short window will pause ads that were merely unlucky. Prefer a window with enough conversions behind it.

## Reporting on a wide window

Insights refuse wide windows with breakdowns in a synchronous call, because Meta does.

1. `ads_create_async_report`, or `ads_run_report_and_wait` to have the server poll.
2. `ads_get_report_status` if polling yourself.
3. `ads_get_report_results`.

## Audience work

1. `ads_get_custom_audiences` — reuse before creating.
2. `ads_estimate_audience_size` on the targeting spec before committing to it.
3. `ads_create_custom_audience` or `ads_create_lookalike_audience`.
4. `ads_share_custom_audience` for another account in the same business.

An audience below roughly 1000 people will not deliver. Say that before it is created, not after.

## Competitor research

See the competitor-research skill. It spends the advertiser's Apify credit, so it has its own rules.
