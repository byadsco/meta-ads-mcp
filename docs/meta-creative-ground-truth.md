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
| Point the ad at another creative, then back at the original | original again | original again |
| "Route A": new creative with `object_story_id` + `asset_feed_spec` (new bodies) | same | new |
| "Route B": edit the post itself, then point the ads back at their original creatives | same | same |

Route A:

- Accepted for posts from single-text and multi-text ads.
- The ad shows the new primary text on Facebook and Instagram. The Facebook headline stays the post's original headline, so route A only changes primary text.

Route B (editing the post):

- `POST /{post_id}` with `message` needs a Page access token (`pages_manage_posts`). A user token gets `(#200) Viewer does not have permission to edit content`.
- It fails with `(#100) Failed to edit object` while any ad uses the post. After every ad using it is pointed at another creative, the edit is accepted after a short delay: the first attempt still failed, and it went through about 30 seconds later.
- Pointing each ad back at **its original creative** restores the same Facebook post and the same Instagram media. The edited text shows on both.
- Headline and description: `name` and `description` are not accepted parameters, and `link_edit` answered `requires exactly one key` with a single-key object. Not solved.
- Ad posts report `is_published: false`, `status_type: "shared_story"`.

## Reading engagement

- Instagram: `GET /{ig_media_id}?fields=like_count,comments_count` works with `instagram_basic`.
- Facebook post reactions, comments and shares (`reactions.summary(total_count)`, `comments.summary(total_count)`, `shares`): error #10 with a user token (`pages_read_engagement` is not enough) and with a Page token. Meta asks for `pages_read_user_content` or Page Public Content Access.

## Dynamic creative

- An ad in an `is_dynamic_creative` ad set (feed `optimization_type: "REGULAR"`) can be pointed at another creative.
- Deleting it is rejected (subcode 1340029): delete the ad set instead.

## Flexible format

- `creative_asset_groups_spec` on `POST /act_<id>/ads` requires `object_story_spec.link_data.link` (subcode 2061015).
- The first image or video of the first group must match the one in `object_story_spec` (subcode 3858355).
- It is rejected on an `OUTCOME_TRAFFIC` campaign (subcode 3858343). Meta documents it for Sales and App promotion only.
