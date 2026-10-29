# Meta creative ground truth (Marketing API v26.0)

What Meta actually accepts when creating and changing ad creatives, measured against a live ad account on 2026-10-26. Every object was created PAUSED, never activated, and deleted afterwards. IDs and copy below are synthetic.

Use this when building or changing creative tools: the public docs omit several of these rules.

## Several texts in one ad (Ads Manager "text options")

Ads Manager stores several primary texts, headlines and descriptions like this, on a regular ad set (`is_dynamic_creative: false`):

```json
{
  "object_story_spec": {
    "page_id": "<page_id>",
    "instagram_user_id": "<ig_user_id>",
    "link_data": {
      "link": "https://example.com/",
      "image_hash": "<image_hash>",
      "call_to_action": { "type": "LEARN_MORE", "value": { "link": "https://example.com/" } }
    }
  },
  "asset_feed_spec": {
    "bodies": [{ "text": "Primary text one" }, { "text": "Primary text two" }],
    "titles": [{ "text": "Headline one" }, { "text": "Headline two" }],
    "descriptions": [{ "text": "Description one" }],
    "optimization_type": "DEGREES_OF_FREEDOM"
  }
}
```

- `DEGREES_OF_FREEDOM` is not in the public `optimization_type` list, but Meta accepts it from the API for image (`link_data`) and video (`video_data` with `video_id`, `image_hash`, `call_to_action`) creatives.
- The copy lives only in `asset_feed_spec`; `object_story_spec` keeps page, Instagram account, media, link and button.
- A field with one option still goes in the feed as a one-item array, but at least one field must have two or more items: an all-singular feed is rejected (subcode 2446218). With one text of each kind, use plain `link_data.message/name/description`.
- Duplicate texts in one field are rejected (subcode 2446206).
- Titles are capped at 255 characters (subcode 2061005). Bodies of 2,200 characters, six bodies, and 256-character descriptions were accepted.
- The ad is accepted on a regular ad set, and `/{creative_id}/previews` renders it.

## Advantage+ creative features

- A creative created without `degrees_of_freedom_spec` reports every feature (84 of them) as `OPT_OUT`.
- An explicit `OPT_OUT` for the 23 features documented in "Advantage+ creative — get started" is accepted, and so is `contextual_multi_ads: { "enroll_status": "OPT_OUT" }` (multi-advertiser ads). Without it, the creative reports no `contextual_multi_ads` value.
- `standard_enhancements` is rejected in any form, `OPT_IN` or `OPT_OUT` (subcode 3858504). Real creatives built before the deprecation still carry it, so a tool that clones `degrees_of_freedom_spec` wholesale must drop that key first.

## The ad's post appears asynchronously

Right after an ad is created, its creative may report no `effective_object_story_id` or `effective_instagram_media_id` (ad status `IN_PROCESS`). They appear within minutes. Tools that need the post must wait or report it as pending.

## Keeping social proof (likes, comments, shares)

| Action | Facebook post | Instagram media |
| --- | --- | --- |
| New creative with `object_story_spec` | new | new |
| New creative with `object_story_id` = another ad's post | same | **new** |
| `object_story_id` + `source_instagram_media_id` together | rejected: ambiguous promoted object (subcode 1487929) | — |
| `source_instagram_media_id` = an ad's Instagram media | rejected: not an organic post (subcode 1815897) | — |
| `POST /{ad_id}/copies` without `creative_parameters` | **new** | **new** |
| New ad on the source ad's own creative (`creative_id`), in another ad set | same | same: the media belongs to the creative |
| Point the ad at another creative, then back at the original | original again | original again |
| "Route A": new creative with `object_story_id` + `asset_feed_spec` (new bodies) | same | new |
| "Route B": edit the post itself, then point ads that reuse the post back at their creatives | same | same |
| "Route B" for an ad whose creative created the post: back on a new creative reusing the post | same | **new** |

Route A:

- Accepted for posts from single-text and multi-text ads.
- The ad shows the new primary text on Facebook and Instagram. The Facebook headline stays the post's original headline, so route A only changes primary text.

Route B (editing the post):

- `POST /{post_id}` with `message` needs a Page access token (`pages_manage_posts`). A user token gets `(#200) Viewer does not have permission to edit content`.
- It fails with `(#100) Failed to edit object` while any ad uses the post. After every ad using it is pointed at another creative, the edit is accepted 40 to 50 seconds later, with one ad or with two on the same post.
- The other creative has to make its own post. In one run the ads waited on an exact copy of the original spec, and the edit never went through in three and a half minutes; the copy most likely got the same post. With a different text, the edit went through every time.
- Once the post is edited, an ad cannot go back to the creative that **created** the post (`object_story_spec`): `subcode 1815697`, "the post was edited after it was created, choose other content".
  - A creative that **reuses** the post (`object_story_id`) carries the ad again, with the same Facebook post and the same Instagram media.
  - An ad whose own creative created the post moves to a new creative reusing it: same Facebook post, new Instagram media.
- After the edit:
  - The post's `message` and the Instagram media's `caption` show the new text.
  - The creative's `body` shows it too.
  - Its `object_story_spec.message` keeps the old one.
- Headline and description cannot be edited. `name`, `description` and `call_to_action` are refused as top-level parameters and inside `link_edit[link_data]` ("Invalid keys … were found"); other `link_edit` shapes answer `requires exactly one key`.
- `/act_{id}/ads` cannot filter by `effective_object_story_id` (nor `creative.effective_object_story_id`, `creative.object_story_id`): finding the ads on a post means reading the account's ads.
- Deleting the temporary creative once its ads moved back: refused once (`subcode 3858800`, content used in ads), and accepted right away in two later runs, after the post edit went through.
- Ad posts report `is_published: false`, `status_type: "shared_story"`.
- Meta's reads can lag behind its own writes. In one run, an ad whose move back was reported as failed had in fact moved, and an ad created minutes earlier was missing from the `/act_{id}/ads` scan.

## Changing an ad's creative

- `POST /{ad_id}` with `creative={"creative_id": …}` keeps the ad's ID. Meta allows it at most once every 30 seconds per ad: a second change within that window fails with `(#613) Calls to this API have exceeded the concurrent request rate limit of 1 calls per 30 seconds`, and the ad keeps its previous creative.
- A creative read back with `asset_feed_spec` and `object_story_spec` (text options) can be resent as is to create a replacement: Meta accepted it, with a new post.
- A creative made by route A (`object_story_id` + text options, no spec) can go through route A again.

## Reading engagement

- Instagram: `GET /{ig_media_id}?fields=like_count,comments_count` works with `instagram_basic`.
- Facebook post reactions, comments and shares (`reactions.summary(total_count)`, `comments.summary(total_count)`, `shares`): error #10 with a user token (`pages_read_engagement` is not enough) and with a Page token. Meta asks for `pages_read_user_content` or Page Public Content Access.
- Each ad's own engagement needs no Page permission: `GET /act_{id}/insights?level=ad&date_preset=maximum&fields=ad_id,actions` with `filtering` on `ad.id`. The actions `post_reaction`, `comment`, `post` (shares) and `onsite_conversion.post_save` count what people did on that ad. An ad that never delivered has no row.

## Duplicating an ad

- A new ad in another ad set on the source ad's own creative (`creative: {"creative_id": …}`) is accepted, also for a creative with text options. It shows the same post and Instagram media, and all the text options.
- Meta sets its tracking specs itself; on a copy into an ad set of the same campaign they matched the source's, the post's own entries included.
- `POST /{ad_id}/copies` with `adset_id`, `status_option` and `rename_options: {"rename_strategy": "NO_RENAME"}` makes a new creative and a new post, and keeps the source's name. Its tracking specs follow the new post.

## Carousels (measured 2026-10-27)

- **The shape.** `link_data` with `link`, `message`, `caption` (the display link), `multi_share_optimized`, `multi_share_end_card` and `child_attachments`. Each card has `link`, `image_hash` (or `picture`), `name`, `description` and `call_to_action`.
- **Accepted:**
  - the creative, its preview and an ad in a traffic ad set;
  - a card with `video_id` plus an `image_hash` thumbnail;
  - cards without their own `link`.
- **One card is rejected:** `(#194) param child_attachments has too few elements`.
- **Several primary texts:** a carousel creative with `asset_feed_spec.bodies` (several) and `optimization_type: "DEGREES_OF_FREEDOM"`, the message left out of `link_data`, was accepted as a creative.

## Destinations other than a website (measured 2026-10-27)

| Destination | `link_data.link` | `call_to_action` | Ad set |
| --- | --- | --- | --- |
| Lead form | `http://fb.me/` | `SIGN_UP`, `value: { lead_gen_form_id }` | `OUTCOME_LEADS`, `destination_type: ON_AD`, `optimization_goal: LEAD_GENERATION`, `promoted_object.page_id` |
| Messenger | `https://fb.com/messenger_doc/` | `MESSAGE_PAGE`, `value: { app_destination: "MESSENGER" }` | `OUTCOME_ENGAGEMENT`, `destination_type: MESSENGER`, `optimization_goal: CONVERSATIONS` |
| WhatsApp | `https://api.whatsapp.com/send` | `WHATSAPP_MESSAGE`, `value: { app_destination: "WHATSAPP" }` | `OUTCOME_ENGAGEMENT`, `destination_type: WHATSAPP`, `optimization_goal: CONVERSATIONS` |
| Instagram Direct | `https://www.instagram.com` | `INSTAGRAM_MESSAGE`, `value: { app_destination: "INSTAGRAM_DIRECT" }` | `OUTCOME_ENGAGEMENT`, `destination_type: INSTAGRAM_DIRECT`, Instagram placements |
| Phone call | the advertiser's site | `CALL_NOW`, `value: { link: "tel:+<number>" }` | `OUTCOME_TRAFFIC`, `destination_type: PHONE_CALL`, `optimization_goal: QUALITY_CALL` |

- Every row was accepted as a creative and as a paused ad in the ad set shown.
- **Messenger welcome message.** `link_data.page_welcome_message` is a JSON string (`type: "VISUAL_EDITOR"`, `text_format.message` with `text` and `ice_breakers: [{ title, response }]`). It was accepted.
- **WhatsApp.** Meta accepted the WhatsApp ad on a Page with no WhatsApp number connected; such an ad cannot deliver.
- **Phone numbers.** Meta checks the number itself. `tel:+573001234567` was accepted; `tel:+5716015555555` and `tel:+5716012345678` were rejected (`subcode 2061044`, "invalid phone number").
- **Not measured:** app installs. The test account's apps are instant games and a canvas app, with no store URL.

## Ad-level fields

- `conversion_domain` and `adlabels: [{ "name": … }]` on `POST /act_{id}/ads` are accepted and read back.

## Dynamic creative, versions, music, site links and flexible format (measured 2026-10-27)

Each of these was accepted as a creative and as a paused ad.

- **Dynamic creative.**
  - The shape: `object_story_spec` holds only `page_id` and `instagram_user_id`. `asset_feed_spec` has `images: [{ hash }]`, `videos: [{ video_id, thumbnail_hash }]`, `bodies`, `titles`, `descriptions`, `call_to_action_types`, `link_urls: [{ website_url, display_url }]`, `ad_formats` and `optimization_type: "REGULAR"`.
  - Formats: `SINGLE_IMAGE`, and `AUTOMATIC_FORMAT` mixing images and a video.
  - The ad set needs `is_dynamic_creative: true`.
  - A second ad in that ad set is rejected (`subcode 1885553`), and so is the creative in a regular ad set (`subcode 1885998`).
  - Meta adds `additional_data`, `reasons_to_shop` and `shops_bundle` to the feed it reads back.
- **Placement versions.**
  - `optimization_type: "PLACEMENT"`.
  - Labeled images (`adlabels: [{ name }]`), with one `asset_customization_rules` entry per label: `customization_spec` with `publisher_platforms` and positions, plus `image_label`.
  - Accepted with Facebook `feed`/`story` and Instagram `stream`/`story`.
- **Language versions.**
  - `optimization_type: "LANGUAGE"`.
  - Labeled bodies, titles, descriptions and link URLs, and one rule per language: `customization_spec.locales`, the four labels, and `is_default: true` on exactly one.
  - Without a description per language, the creative is accepted but the ad is rejected (`subcode 1885817`, "too few link descriptions").
  - Locale keys come from `GET /search?type=adlocale&q=`, named in the token user's language: "Español" is 23, "Español (España)" 7, "Español (todos)" 1002, "English (US)" 6. A search for "Spanish" from a Spanish-language user found nothing.
- **Music.**
  - `asset_feed_spec: { audios: [{ type: "random" }] }` was accepted:
    - next to a single-image `object_story_spec`;
    - inside a text-options feed;
    - on a carousel.
  - The creative does not return `audios` when read back.
- **Site links.**
  - `creative_sourcing_spec.site_links_spec: [{ site_link_title, site_link_url, site_link_image_hash }]`, with `degrees_of_freedom_spec.creative_features_spec.site_extensions: OPT_IN`.
  - 3 links were accepted and read back.
- **Flexible format.**
  - `creative_asset_groups_spec.groups` on `POST /act_{id}/ads`, next to an existing `creative_id`. Each group has `images`, `videos`, `texts: [{ text, text_type }]` (`primary_text`, `headline`, `description`) and `call_to_action`.
  - Accepted on an `OUTCOME_SALES` campaign with a pixel; one group is read back. It was rejected on traffic (`subcode 3858343`, see above).

## Campaign and ad set fields, previews, other creative fields (measured 2026-10-27)

- **Campaign `spend_cap`.**
  - It is in the currency's minor unit, like the budgets, unlike the account cap, which is written in whole currency.
  - On a USD account, `5000` is refused as under the minimum (subcode 2446307, "at least $100.00 for this currency"), and `10000` is accepted and read back as `10000`.
- **Special ad categories.**
  - As text, `"HOUSING,EMPLOYMENT"` is read back as both and `"NONE"` as `[]`.
  - An empty list sent as text arrives empty, and Meta answers "The parameter special_ad_categories is required".
  - A JSON list is taken, empty or not: `[]`, `["HOUSING"]`.
  - `special_ad_category_country: ["CO"]` is read back.
- **Campaign dates.** `start_time` and `stop_time` on `POST /act_{id}/campaigns` are accepted and not stored. The schedule lives on the ad sets.
- **EU transparency (DSA).** An ad set targeting Spain is accepted without `dsa_beneficiary` and `dsa_payor`. With them, both are stored.
- **Attribution.** `attribution_spec: [{ event_type: "CLICK_THROUGH", window_days: 7 }, { event_type: "VIEW_THROUGH", window_days: 1 }]`, on a conversions ad set with a pixel, is read back as sent.
- **Frequency cap.**
  - `frequency_control_specs: [{ event: "IMPRESSIONS", interval_days: 7, max_frequency: 2 }]`, on an `OUTCOME_AWARENESS` ad set optimizing for `REACH`, is read back with `type: "CAP"`.
  - That ad set takes `destination_type` `WEBSITE`, `UNDEFINED` or `MESSENGER` (subcode 1815715 lists them).
- **Previews.**
  - `GET /act_{id}/generatepreviews` with a `creative` spec, and `GET /{creative_id}/previews`, both render dynamic creative, placement versions, carousels and site links.
  - The second also takes `ad_format`, e.g. `INSTAGRAM_STORY`.
- **Other creative fields.** `applink_treatment: "web_only"` on `POST /act_{id}/adcreatives` is accepted and read back.
- **Not reachable from this app yet.**
  - Catalog ads fail with "application has not been approved" until the app has `catalog_management`.
  - Instant Experiences (`/{page_id}/canvases`) answer only to a Page token, and the test Page had none.

## Pages, field filters, activity log and Ad Library (measured 2026-10-28)

- **Rate limit.** The app runs on `development_access`. About 60 calls to one ad account within a few minutes end in code 17, subcode 2446079 ("too many calls from this ad account"), for several minutes. Probes have to be paced.
- **Pages.**
  - `GET /act_{id}/promote_pages` lists the Pages used for ads on the account.
  - `GET /me/accounts` lists the Pages the person has a role on, with `tasks` (`ADVERTISE` among them) and `instagram_business_account{id,username}`. Without `fields` it answers with each Page's access token, so the fields are always named.
- **Ads of a creative.**
  - `/act_{id}/ads` refuses `filtering` on `creative.id`, `creative_id`, `creative`, `ad.creative.id` and `adcreative.id`, all with "Filtering field … is not supported".
  - The creative has no `ads` or `adgroups` edge ("nonexisting field").
  - The creative's `account_id` is readable, so the ads are found by walking that account's ads with `creative{id}`.
- **Field metadata.** `GET /{id}?metadata=1` returns only `id` in v26.0.
- **Fields per level.** One GET of a real node per level, naming every candidate field, was answered in full. [tests/fixtures/meta-field-probe-2026-10-28.json](../tests/fixtures/meta-field-probe-2026-10-28.json) records each field found and each filter result. The table behind `ads_get_field_context` is tested against that file.
- **Filters.**
  - Meta accepts an unknown value inside a filter without complaint. A filter counts as applied only if an impossible value (`IN ["1"]`, `CONTAIN "zz-no-such-name"`, `GREATER_THAN` a future time or 10^12) returns no rows where the unfiltered list has some.
  - **Applied on campaigns:** `id`, `name`, `status`, `effective_status`, `objective`, `buying_type`, `bid_strategy`, `daily_budget`, `lifetime_budget`, `spend_cap`, `created_time`, `updated_time`, `start_time`, `stop_time`, `adset.id`.
  - **Applied on ad sets:** `id`, `name`, `effective_status`, `campaign.id`, `campaign.objective`, `optimization_goal`, `daily_budget`, `created_time`, `updated_time`.
  - **Applied on ads:** `id`, `name`, `effective_status`, `campaign.id`, `adset.id`, `created_time`, `updated_time`.
  - **Refused on campaigns:** `configured_status`, `budget_remaining`, `special_ad_categories`.
  - Times filter as Unix seconds.
- **`effective_status` values.** Given an unknown value in the edge parameter, Meta lists `ACTIVE, PAUSED, DELETED, PENDING_REVIEW, DISAPPROVED, PREAPPROVED, PENDING_BILLING_INFO, CAMPAIGN_PAUSED, ARCHIVED, ADSET_PAUSED, IN_PROCESS, WITH_ISSUES` for campaigns and ad sets. For ads it answers subcode 1487176 without a list.
- **Activity log** (`GET /act_{id}/activities`).
  - **Fields:** `event_type`, `event_time`, `translated_event_type` (in the token user's language), `object_id`, `object_type`, `object_name`, `actor_id`, `actor_name`, `application_id`, `application_name`, `date_time_in_timezone` (localized text), and `extra_data`. `extra_data` is a JSON string with `type` and usually `old_value` and `new_value`.
  - **Object types** use the old names: `CAMPAIGN_GROUP` is a campaign, `CAMPAIGN` an ad set, `ADGROUP` an ad.
  - **Filters:**
    - `oid` and `uid` filter by object and by person; `uid=1` is refused ("The global id 1 is not allowed").
    - `since` and `until` take Unix seconds.
    - `category` must be one of `ACCOUNT, AD, AD_KEYWORDS, AD_SET, AUDIENCE, BID, BUDGET, CAMPAIGN, DATE, STATUS, TARGETING`.
- **Ad Library API** (`GET /ads_archive`).
  - It answers this app's user token. `ad_reached_countries` is required, and searches reaching `CO` and `ES` both returned ads.
  - `ad_snapshot_url` is `https://www.facebook.com/ads/archive/render_ad/?id=…&access_token=…`, so it carries the caller's token.
- **Instagram boosting.**
  - `GET /{ig_media_id}?fields=boost_eligibility_info` answers `{ eligible_to_boost: true }` for the test account's image and video feed posts.
  - A creative with `source_instagram_media_id`, `instagram_user_id` and `object_id` (the Page) was accepted, and so was a paused ad with it in a `POST_ENGAGEMENT` ad set placed on Instagram stream.
  - The creative's `effective_instagram_media_id` is another media than the post, so the ad does not run as the organic post itself.
  - `POST /act_{id}/ads` also takes that creative spec inline (`creative: { source_instagram_media_id, instagram_user_id, object_id, degrees_of_freedom_spec, contextual_multi_ads }`) and makes the ad and its creative in one call.
    - The creative read back with the post as its source, all 83 features `OPT_OUT` and `contextual_multi_ads` `OPT_OUT`.
    - Meta names that creative itself.
    - A `name CONTAIN` filter on the ad set's ads found the ad by a tag in its name.
- **Business Manager Pages.** `GET /{business_id}/owned_pages` and `/client_pages` both work. The test Business Manager neither owns the test Page nor has it as a client.

## A/B tests and lift studies (measured 2026-10-28)

Measured with paused campaigns and ad sets, and studies scheduled a week ahead, all deleted afterwards.

- **Where a study is made.**
  - `POST /act_{id}/ad_studies` is "Unsupported post request".
  - `POST /{business_id}/ad_studies` works; the account's Business Manager is `GET /act_{id}?fields=business{id}`. `POST /me/ad_studies` works too.
- **Times.** `start_time` and `end_time` are Unix seconds. ISO text is refused: "Param end_time must be a number".
- **No dry run.** `execution_options: ["validate_only"]` is ignored and the study is created.
- **Rules Meta enforces.**
  - An ad object cannot be in two tests active at the same time (subcode 1840001).
  - The end must come after the start (subcode 1840010).
  - A lift study needs `observation_end_time` at or after the end (subcode 1840009), and `cooldown_start_time` (subcode 1840013).
- **Lift study.** Accepted with:
  - `cooldown_start_time` = `start_time` and `observation_end_time` = `end_time`;
  - one cell `{ treatment_percentage: 90, control_percentage: 10, adsets: [id] }`;
  - an objective `{ name, type: "CONVERSIONS", is_primary: true, adspixels: [{ id, event_names: ["fb_pixel_purchase"] }] }`.

  It reads back as `type: "LIFT"` with its objective.
- **Reading.**
  - A study's fields: `business`, `cells`, `created_by`, `end_time`, `id`, `name`, `start_time`, `type`; `canceled_time` when canceled.
  - `confidence_level` can be written but not read: "Tried accessing nonexisting field (confidence_level)".
  - Cells read through `cells{id,name,treatment_percentage,control_percentage,adsets{id},campaigns{id}}`, objectives through `objectives{id,name,type,is_primary}`.
- **Listing.**
  - A study made through the API is not listed by `/act_{id}/ad_studies`, `/{business_id}/ad_studies` (with or without fields) or `/me/ad_studies`.
  - It is listed by the `ad_studies` edge of each campaign or ad set in its cells, and by `/act_{id}/adsets?fields=ad_studies{…}` and `/act_{id}/campaigns?fields=ad_studies{…}`.
  - A campaign's edge does not list a study whose cells hold only its ad sets.
- **Changing a study.**
  - `POST /{study_id}` with `name`, `description` or a later `end_time` answers `{ success, cell_ids, objective_ids }`.
  - Before the start, `cells: [{ id, treatment_percentage }, …, { name, treatment_percentage, adsets }]` changed the split to 34/33/33 and added a cell.
- **Deleting.** `DELETE /{study_id}` on a study that has not started answers `{ success: true }`, and the study can no longer be read. Meta documents that the start and the split of a running study cannot change, and that its end can only move to a time in the future.

## Custom audiences (measured 2026-10-28)

Measured with a customer-list audience, a website audience and paused ad sets, all deleted afterwards. Only fictional people were sent (`@example.com` addresses, 555 numbers).

- **Customer list.** `POST /act_{id}/customaudiences` with `subtype: CUSTOM` and `customer_file_source: USER_PROVIDED_ONLY` creates one.
- **Changing an audience.** `POST /{audience_id}` with `name` or `description` answers `{ success: true }`. A new `rule` on a website audience is applied and reads back.
- **What Meta does not check.**
  - A `rule` sent to a customer list answers `{ success: true }`, though a list has no events to match.
  - People sent to a website audience are accepted, with the same answer a customer list gets.
- **Labels.** `adlabels` on an audience is accepted but cannot be read: "Tried accessing nonexisting field (adlabels)".
- **Adding people.** `POST /{audience_id}/users` with `payload = { schema: [...], data: [[...], ...] }`, every value SHA-256 hashed after normalizing, answers `{ audience_id, session_id, num_received, num_invalid_entries, invalid_entry_samples }`. Several keys per row (`EMAIL`, `PHONE`, …) work, and so does a `session` for large uploads.
- **Removing people.** The same payload, sent as `POST /{audience_id}/users` with `method=DELETE`, or as `DELETE` with the payload in the form body. Both answer like an addition.
- **Ad sets using an audience.**
  - `/{audience_id}/adsets` does not exist.
  - `GET /act_{id}/adsets?fields=targeting{custom_audiences,excluded_custom_audiences}` gives each ad set's audiences as `{ id, name }`.
  - Filtering ad sets on `targeting.custom_audiences` is refused: "Filtering field 'targeting.custom_audiences' is not supported".
- **Deleting an audience in use.** Deleting an audience that a paused ad set targets succeeds.

## Lead forms

- `GET` and `POST /{page_id}/leadgen_forms` answer only to a Page token: a user token gets `(#190) This method must be called with a Page Access Token`.
- With a Page token (from a person with `pages_manage_ads`), a form was created with:
  - prefilled questions;
  - a `CUSTOM` multiple-choice question (`options: [{ value, key }]`) and a free-text `CUSTOM` one;
  - `privacy_policy: { url, link_text }`;
  - `context_card: { title, content: [...], style: "PARAGRAPH_STYLE" }`;
  - `thank_you_page: { title, body, button_type: "VIEW_WEBSITE", button_text, website_url }`;
  - `locale: "es_LA"`.
- Forms cannot be deleted; `POST /{form_id}` with `status: ARCHIVED` (Page token) archives one.
- **Question types.** The phone question is `PHONE`, not `PHONE_NUMBER`: Meta lists the valid types in its error.
- **Answer keys.** A multiple-choice answer without a `key` makes Meta fail with "An unknown error has occurred", and no form is made.
- **After the form.** A form needs `thank_you_page` or `follow_up_action_url` (`subcode 1892085`, "missing FollowUpActionURL").
- **Lead ads.** Lead creatives with an image and with a video (`video_data.call_to_action.value.lead_gen_form_id`) both ran as paused ads in an `ON_AD` ad set.

## Dynamic creative

- An ad in an `is_dynamic_creative` ad set (feed `optimization_type: "REGULAR"`) can be pointed at another creative.
- Deleting it is rejected (subcode 1340029): delete the ad set instead.

## Flexible format

- `creative_asset_groups_spec` on `POST /act_<id>/ads` requires `object_story_spec.link_data.link` (subcode 2061015).
- The first image or video of the first group must match the one in `object_story_spec` (subcode 3858355).
- It is rejected on an `OUTCOME_TRAFFIC` campaign (subcode 3858343). Meta documents it for Sales and App promotion only.
