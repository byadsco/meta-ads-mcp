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
