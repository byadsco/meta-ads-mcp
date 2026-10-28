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

## An ad with several texts

"Run this image with these three primary texts and two headlines."

1. `ads_upload_ad_image` (or `ads_upload_ad_video`) for the media, unless it is already in the account.
2. `ads_generate_preview` with the same fields you will create with, to check the copy renders. It shows one combination.
3. `ads_create_ad_creative` with `primary_texts`, `headlines` and `descriptions` (up to 5 each, headlines up to 255 characters, no repeats). Meta shows each person the combination likely to work best, as Ads Manager's text options do.
4. `ads_create_ad` in a regular ad set. It is created paused; activating it is a separate, confirmed step.

Advantage+ AI features that rewrite copy or edit media stay off unless you list them in `advantage_creative`. The ad's post appears a few minutes after the ad exists.

## A carousel, or an ad that does not lead to a website

"Run these four products as a carousel." "Send people to WhatsApp." "Collect leads in a form."

1. **Carousel:** `ads_create_ad_creative` with `cards`.
   - 2 to 10 cards, each with its own image (or a video with a thumbnail), headline, description, link and button.
   - The ad's `link_url` covers cards without their own link.
   - `multi_share_optimized` lets Meta order the cards by performance.
2. **Other destinations:** `ads_create_ad_creative` with `destination`.
   - **`lead_form`:** with a form from `ads_create_lead_form` or `ads_get_lead_forms`.
   - **Messaging:** `messenger` (with a welcome message and up to 4 ice breakers), `whatsapp` or `instagram_direct`.
   - **`call`:** with a phone number in international format.
   - Lead forms and messaging use Meta's own link, so `link_url` does not apply to them.
   - The ad set's destination has to match, as in Ads Manager:
     - a lead form needs a leads campaign with `ON_AD`;
     - Messenger, WhatsApp and Instagram Direct need the matching messaging destination;
     - a call needs `PHONE_CALL`.
3. `ads_create_ad`, paused, with `conversion_domain` when the campaign optimizes for conversions.

A WhatsApp ad needs a WhatsApp number connected to the Page to deliver: Meta accepts the ad without one, so check the Page first. Lead forms are read and created with a Page token, so the person has to manage the Page.

## Changing the copy of a live ad

"Drop the second headline and add a primary text to these ads."

1. `ads_update_ad_content` with the changes (`primary_texts`, `headlines`, `descriptions`, each with `set` / `add` / `remove`). It is a dry run by default.
2. Show the person what the dry run reports for each creative: the copy before and after, and what happens to the post's likes, comments and shares.
   - Only primary texts change and two or more remain: the ad keeps its Facebook post, while Instagram starts over.
   - One primary text changes on a one-text ad: with `allow_post_edit: true` the post itself is edited.
     - Facebook keeps its engagement, and Instagram too when the ad reuses the post rather than having created it.
     - The new text shows on every ad using the post, and the preview lists them.
     - Active ones keep running on a temporary copy of the ad with the new text for about a minute. An active ad with several text options on that post blocks the edit: pause it first. After an edit, the same post can be edited again three minutes later.
     - The token needs `pages_manage_posts`.
   - Anything else needs `allow_new_post: true`, and the new post starts from zero.
3. Once they agree, run it again with `dry_run: false` and the `plan_token` the dry run returned. Only that exact plan is applied: if the ads changed in between, nothing is written and you get a new preview to show.

Every changed ad goes back through review. To undo, point the ad at its previous creative with `ads_update_ad`; that brings its old post and engagement back.

## Keeping likes, comments and shares

"Launch this winning ad in two more ad sets without losing its engagement."

Likes, comments and shares live on the ad's post (and its Instagram media), not on the ad.

1. `ads_get_ad_social_proof` on the ad: what its post has, which other ads show the same post, and each ad's own engagement. The post's Facebook counts need `pages_read_user_content`; each ad's own counts always come back.
2. `ads_duplicate_ad` with the target `ad_set_ids`, a `dry_run: true` first if the person wants to see it.
   - The copies use the same creative, so they show the same post and Instagram media and every text option, and they pile engagement onto the same post.
   - They are created paused, with the source's tracking specs.
   - A real run needs an `idempotency_key`, and a server with its Firestore store. If the answer is unclear, run it again with the same key: it never creates twice.
   - `keep_social_proof: false` gives each copy a post of its own that starts from zero, for when the old post's comments should not follow.
3. Activating the copies is a separate, confirmed step.

What keeps the engagement and what resets it:

- **Keeps it:**
  - Name, status and `url_tags` changes on a one-post creative.
  - Primary-text changes through `ads_update_ad_content` (same post; Instagram starts over unless the post itself is edited).
  - `ads_duplicate_ad` with the default `keep_social_proof`.
  - Pointing an ad back at its previous creative.
- **Resets it:** anything that makes a new post, which needs `allow_new_post: true` or `keep_social_proof: false`.
- Editing the post changes the text on every ad that shares it, the copies included.

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
