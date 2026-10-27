import { MAX_HEADLINE_LENGTH } from "./creative-spec.js";
import { asRecord, carryOverFields, hasFeedContent, resolveInstagramUserId, withInstagramIdentity } from "./creative-rebuild.js";
import { effectiveLinkUrl } from "./effective-link.js";
import type { AdCreative } from "./types/index.js";

const MAX_TEXT_OPTIONS = 5;

export interface TextChange {
  set?: string[];
  add?: string[];
  remove?: string[];
}

export interface ContentChanges {
  primary_texts?: TextChange;
  headlines?: TextChange;
  descriptions?: TextChange;
  link_url?: string;
  call_to_action_type?: string;
  image_hash?: string;
  image_url?: string;
  video_id?: string;
  url_tags?: string;
}

export interface Copy {
  primary: string[];
  headlines: string[];
  descriptions: string[];
}

export type CopySource = "text_options" | "link_data" | "video_data" | "post";

export type Route = "same_post" | "new_post" | "edit_post";

// Route B: the ad's post itself gets the new message.
export interface PostEdit {
  post_id: string;
  page_id: string;
  message: string;
  // The creative reuses the post (object_story_id) rather than having created
  // it: only such a creative can carry the ad again after the edit.
  reuses_post: boolean;
}

export interface FieldChange {
  field: "link_url" | "call_to_action_type" | "image_hash" | "image_url" | "video_id" | "url_tags";
  before?: string;
  after?: string;
}

const SHOWN_FIELDS: FieldChange["field"][] = ["link_url", "call_to_action_type", "image_hash", "image_url", "video_id", "url_tags"];

// Why a plan has no route, as a code: the reason text stays in the summary.
export type ReasonCode =
  | "unsupported_creative"
  | "url_tags_only"
  | "nothing_to_change"
  | "per_platform_media"
  | "promoted_post"
  | "needs_new_post"
  | "image_to_video"
  | "post_edit_url_tags"
  | "post_edit_unsupported"
  | "post_edit_alone"
  | "post_edit_permission"
  | "post_edit_scan_incomplete";

export interface ContentPlan {
  before: Copy;
  after: Copy;
  route?: Route;
  body?: Record<string, string>;
  reason?: string;
  reason_code?: ReasonCode;
  // A reason that leaves part of the request undone. It stops the whole batch;
  // "nothing to change" does not.
  blocking?: boolean;
  // Link, button, media and url_tags values that would change, for the preview.
  // With a route they are read from the replacement itself, so they include
  // anything the body changes beyond the request.
  field_changes?: FieldChange[];
  post_edit?: PostEdit;
  social_proof?: { facebook: "kept" | "reset"; instagram: "kept" | "reset" };
  warnings: string[];
}

function texts(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => asRecord(item)?.["text"]).filter((text): text is string => typeof text === "string")
    : [];
}

function str(value: unknown): string[] {
  return typeof value === "string" && value !== "" ? [value] : [];
}

// Where the creative keeps its copy, and what it is. Undefined when this
// editor cannot place copy in it (carousels, dynamic creative feeds, ...).
export function readCopy(creative: AdCreative): { source: CopySource; copy: Copy } | { unsupported: string } {
  const feed = asRecord(creative.asset_feed_spec);
  const spec = asRecord(creative.object_story_spec);
  if (feed && Object.keys(feed).some((key) => key !== "promotional_metadata")) {
    if (feed.optimization_type !== "DEGREES_OF_FREEDOM") {
      return { unsupported: "dynamic creative or asset feed with images, videos or placement rules; edit it in Ads Manager or rebuild it with ads_create_ad_creative" };
    }
    const copy = { primary: texts(feed.bodies), headlines: texts(feed.titles), descriptions: texts(feed.descriptions) };
    if (spec) return { source: "text_options", copy };
    // What the same-post route leaves behind: the existing post plus text
    // options, with no spec to rebuild from.
    if (creative.effective_object_story_id) return { source: "post", copy };
    return { unsupported: "text options without an object_story_spec or a post" };
  }
  const linkData = asRecord(spec?.link_data);
  const videoData = asRecord(spec?.video_data);
  if (linkData) {
    if (Array.isArray(linkData.child_attachments)) {
      return { unsupported: "carousel; editing carousel cards is not supported yet" };
    }
    return {
      source: "link_data",
      copy: { primary: str(linkData.message), headlines: str(linkData.name), descriptions: str(linkData.description) },
    };
  }
  if (videoData) {
    return {
      source: "video_data",
      copy: { primary: str(videoData.message), headlines: str(videoData.title), descriptions: str(videoData.link_description) },
    };
  }
  if (creative.effective_object_story_id) {
    return { source: "post", copy: { primary: str(creative.body), headlines: str(creative.title), descriptions: [] } };
  }
  return { unsupported: "creative has no post, object_story_spec or text options to edit" };
}

export type PlanErrorCode = "text_not_found" | "blank_text" | "repeated_text" | "too_many_options" | "headline_too_long";

// The message may quote ad copy; the code never does, so it is what can be
// shown outside the untrusted-content fence.
export class PlanError extends Error {
  constructor(readonly code: PlanErrorCode, message: string) {
    super(message);
  }
}

function applyChange(current: string[], change: TextChange | undefined, label: string): string[] {
  if (!change) return current;
  let next = change.set ? [...change.set] : [...current];
  for (const text of change.remove ?? []) {
    const index = next.findIndex((existing) => existing.trim() === text.trim());
    if (index === -1) throw new PlanError("text_not_found", `Cannot remove ${label} "${text}": the ad does not have it.`);
    next.splice(index, 1);
  }
  next = [...next, ...(change.add ?? [])];
  const keys = next.map((text) => text.trim());
  if (keys.some((key) => key === "")) throw new PlanError("blank_text", `A ${label} would be blank.`);
  if (new Set(keys).size !== keys.length) {
    throw new PlanError("repeated_text", `The ${label}s would repeat a text; Meta rejects duplicates.`);
  }
  if (next.length > MAX_TEXT_OPTIONS) {
    throw new PlanError("too_many_options", `The ad would have ${next.length} ${label}s; the limit is ${MAX_TEXT_OPTIONS}.`);
  }
  if (label === "headline" && next.some((text) => text.length > MAX_HEADLINE_LENGTH)) {
    throw new PlanError("headline_too_long", `A headline would exceed ${MAX_HEADLINE_LENGTH} characters.`);
  }
  return next;
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((text, i) => text === b[i]);

function currentDestination(creative: AdCreative): {
  link?: string; ctaType?: string; imageHash?: string; imageUrl?: string; videoId?: string;
} {
  const spec = asRecord(creative.object_story_spec);
  const linkData = asRecord(spec?.link_data);
  const videoData = asRecord(spec?.video_data);
  const target = linkData ?? videoData;
  const cta = asRecord(target?.call_to_action);
  const ctaLink = asRecord(cta?.value)?.link;
  const pick = (value: unknown) => (typeof value === "string" ? value : undefined);
  return {
    link: effectiveLinkUrl(creative) ?? pick(ctaLink),
    ctaType: pick(cta?.type) ?? creative.call_to_action_type,
    imageHash: pick(target?.image_hash),
    imageUrl: pick(linkData?.picture) ?? pick(videoData?.image_url),
    videoId: pick(videoData?.video_id),
  };
}

function shownFields(creative: AdCreative): Partial<Record<FieldChange["field"], string>> {
  const now = currentDestination(creative);
  return {
    link_url: now.link,
    call_to_action_type: now.ctaType,
    image_hash: now.imageHash,
    image_url: now.imageUrl,
    video_id: now.videoId,
    url_tags: creative.url_tags || undefined,
  };
}

// The preview is the difference between the source creative and the
// replacement about to be sent, read the same way from both, so it cannot
// leave out something the body changes beyond the request (like the button a
// video needs for a new link).
function previewOf(creative: AdCreative, body: Record<string, string>): { after: Copy; field_changes: FieldChange[] } {
  const json = (key: string) => (body[key] === undefined ? undefined : asRecord(JSON.parse(body[key])));
  const sent: AdCreative = {
    id: "",
    name: body.name ?? "",
    object_story_spec: json("object_story_spec"),
    asset_feed_spec: json("asset_feed_spec"),
    effective_object_story_id: body.object_story_id,
    link_url: body.link_url,
    url_tags: body.url_tags,
  };
  const read = readCopy(sent);
  if ("unsupported" in read) throw new Error(`Cannot preview the replacement creative: ${read.unsupported}.`);
  const before = shownFields(creative);
  // A replacement that reuses the post shows that post's link, button and
  // media, which are the source's.
  const after = body.object_story_id ? { ...before, url_tags: sent.url_tags || undefined } : shownFields(sent);
  const field_changes = SHOWN_FIELDS
    .filter((field) => before[field] !== after[field])
    .map((field) => ({ field, before: before[field], after: after[field] }));
  return { after: read.copy, field_changes };
}

// Clones the source spec, swaps media / link / button as asked and lays the
// copy out the way ads_create_ad_creative does: several texts in a
// DEGREES_OF_FREEDOM feed with no copy in the spec, one of each in the spec.
function buildNewPostBody(creative: AdCreative, after: Copy, changes: ContentChanges): Record<string, string> {
  const spec = withInstagramIdentity(structuredClone(asRecord(creative.object_story_spec) ?? {}), creative);
  const linkData = asRecord(spec.link_data);
  const videoData = asRecord(spec.video_data);
  const target = linkData ?? videoData ?? {};

  if (changes.link_url !== undefined) {
    if (linkData) linkData.link = changes.link_url;
    const cta = asRecord(target.call_to_action);
    if (cta) {
      target.call_to_action = { ...cta, value: { ...(asRecord(cta.value) ?? {}), link: changes.link_url } };
    } else if (videoData) {
      // A video carries its destination only in its button, so a new link
      // needs one; LEARN_MORE is the default ads_create_ad_creative uses.
      target.call_to_action = { type: changes.call_to_action_type ?? "LEARN_MORE", value: { link: changes.link_url } };
    }
  }
  if (changes.call_to_action_type !== undefined) {
    const cta = asRecord(target.call_to_action) ?? {};
    const link = changes.link_url ?? (linkData?.link as string | undefined);
    target.call_to_action = { ...cta, type: changes.call_to_action_type, ...(cta.value || !link ? {} : { value: { link } }) };
  }
  if (changes.image_hash !== undefined || changes.image_url !== undefined) {
    const holder = linkData ?? videoData!;
    delete holder.image_hash;
    delete holder.picture;
    delete holder.image_url;
    if (changes.image_hash !== undefined) holder.image_hash = changes.image_hash;
    else if (linkData) linkData.picture = changes.image_url;
    else holder.image_url = changes.image_url;
  }
  if (changes.video_id !== undefined && videoData) videoData.video_id = changes.video_id;

  const copyKeys = videoData
    ? { primary: "message", headlines: "title", descriptions: "link_description" }
    : { primary: "message", headlines: "name", descriptions: "description" };
  for (const key of Object.values(copyKeys)) delete target[key];

  const body: Record<string, string> = {};
  if (creative.name) body.name = creative.name;
  const multiText = [after.primary, after.headlines, after.descriptions].some((list) => list.length > 1);
  if (multiText) {
    const feed: Record<string, unknown> = {};
    if (after.primary.length > 0) feed.bodies = after.primary.map((text) => ({ text }));
    if (after.headlines.length > 0) feed.titles = after.headlines.map((text) => ({ text }));
    if (after.descriptions.length > 0) feed.descriptions = after.descriptions.map((text) => ({ text }));
    feed.optimization_type = "DEGREES_OF_FREEDOM";
    body.asset_feed_spec = JSON.stringify(feed);
  } else {
    if (after.primary[0]) target[copyKeys.primary] = after.primary[0];
    if (after.headlines[0]) target[copyKeys.headlines] = after.headlines[0];
    if (after.descriptions[0]) target[copyKeys.descriptions] = after.descriptions[0];
  }
  body.object_story_spec = JSON.stringify(spec);
  return body;
}

export function planContentEdit(
  creative: AdCreative,
  changes: ContentChanges,
  allowNewPost: boolean,
  allowPostEdit = false,
): ContentPlan {
  const read = readCopy(creative);
  const empty: Copy = { primary: [], headlines: [], descriptions: [] };
  if ("unsupported" in read) {
    return { before: empty, after: empty, reason: read.unsupported, reason_code: "unsupported_creative", blocking: true, warnings: [] };
  }

  const before = read.copy;
  const after: Copy = {
    primary: applyChange(before.primary, changes.primary_texts, "primary text"),
    headlines: applyChange(before.headlines, changes.headlines, "headline"),
    descriptions: applyChange(before.descriptions, changes.descriptions, "description"),
  };

  const primaryChanged = !sameList(before.primary, after.primary);
  const otherCopyChanged = !sameList(before.headlines, after.headlines) || !sameList(before.descriptions, after.descriptions);
  // Compared with what the creative has now, so repeating an applied change
  // (say, after a lost response) does not rebuild it and reset its post again.
  const current = currentDestination(creative);
  // image_hash wins when both are given, so only the medium that would be
  // written is compared.
  const requested: Array<{ field: FieldChange["field"]; value: string | undefined; now: string | undefined }> = [
    { field: "link_url", value: changes.link_url, now: current.link },
    { field: "call_to_action_type", value: changes.call_to_action_type, now: current.ctaType },
    { field: "image_hash", value: changes.image_hash, now: current.imageHash },
    { field: "image_url", value: changes.image_hash === undefined ? changes.image_url : undefined, now: current.imageUrl },
    { field: "video_id", value: changes.video_id, now: current.videoId },
  ];
  const field_changes: FieldChange[] = requested
    .filter((r) => r.value !== undefined && r.value !== r.now)
    .map((r) => ({ field: r.field, before: r.now, after: r.value as string }));
  const otherChanged = field_changes.length > 0;
  const urlTagsChanged = changes.url_tags !== undefined && changes.url_tags !== (creative.url_tags ?? "");
  if (urlTagsChanged) field_changes.push({ field: "url_tags", before: creative.url_tags, after: changes.url_tags as string });

  if (!primaryChanged && !otherCopyChanged && !otherChanged) {
    if (urlTagsChanged) {
      return {
        before, after, field_changes,
        reason: "only url_tags change: use ads_update_ad_url_tags, which keeps the post where it can",
        reason_code: "url_tags_only", blocking: true, warnings: [],
      };
    }
    return { before, after, reason: "nothing to change", reason_code: "nothing_to_change", blocking: false, warnings: [] };
  }

  const mediaChanged = field_changes.some((c) => c.field === "image_hash" || c.field === "image_url" || c.field === "video_id");
  if (mediaChanged && asRecord((creative as AdCreative & { platform_customizations?: unknown }).platform_customizations)) {
    return {
      before,
      after,
      field_changes,
      reason: "the ad uses per-platform media (platform_customizations): replacing its image or video here would leave the other platforms showing the old one. Change its media in Ads Manager.",
      reason_code: "per_platform_media",
      blocking: true,
      warnings: [],
    };
  }

  const carried = carryOverFields(creative);
  const warnings = [...carried.warnings];
  const finish = (body: Record<string, string>) => {
    Object.assign(body, carried.body);
    // The carried link_url is the source's destination override; a new link
    // has to replace it, or the creative would keep pointing at the old one.
    if (changes.link_url !== undefined && body.link_url !== undefined) body.link_url = changes.link_url;
    const urlTags = changes.url_tags ?? creative.url_tags;
    if (urlTags) body.url_tags = urlTags;
    return body;
  };

  // Same post with new primary texts: Meta keeps the Facebook post, so its
  // likes, comments and shares stay; the Instagram side gets a new media and
  // the Facebook headline stays the post's own (measured on v26.0). A feed
  // needs a field with two or more entries, so this needs two primary texts.
  if (!otherCopyChanged && !otherChanged && creative.effective_object_story_id && after.primary.length >= 2) {
    if (before.headlines.length > 1) {
      warnings.push("Its headline options stop rotating on Facebook: the post's own headline is shown.");
    }
    const feed: Record<string, unknown> = { bodies: after.primary.map((text) => ({ text })) };
    if (before.headlines.length > 0) feed.titles = before.headlines.map((text) => ({ text }));
    if (before.descriptions.length > 0) feed.descriptions = before.descriptions.map((text) => ({ text }));
    feed.optimization_type = "DEGREES_OF_FREEDOM";
    const body: Record<string, string> = {};
    if (creative.name) body.name = creative.name;
    body.object_story_id = creative.effective_object_story_id;
    const instagramUserId = resolveInstagramUserId(creative);
    if (instagramUserId) body.instagram_user_id = instagramUserId;
    body.asset_feed_spec = JSON.stringify(feed);
    const sent = finish(body);
    return { before, ...previewOf(creative, sent), route: "same_post", body: sent, social_proof: { facebook: "kept", instagram: "reset" }, warnings };
  }

  // Route B: edit the post itself. Only its message can change (Meta refuses
  // link_edit for headline and description), and an ad shows that message
  // only when it has one primary text: an image or link ad, or a promoted post
  // without text options.
  const onlyPrimaryToOne = primaryChanged && !otherCopyChanged && !otherChanged && after.primary.length === 1;
  if (allowPostEdit && onlyPrimaryToOne && creative.effective_object_story_id) {
    const showsPostMessage = read.source === "link_data" || (read.source === "post" && !hasFeedContent(creative));
    if (showsPostMessage && urlTagsChanged) {
      return {
        before, after, field_changes,
        reason: "url_tags cannot change while the post is edited: change them on their own afterwards",
        reason_code: "post_edit_url_tags", blocking: true, warnings,
      };
    }
    if (showsPostMessage) {
      // A creative that reuses the post carries its ads again as it is; one
      // that created the post is replaced, with what it carries over.
      const reusesPost = read.source === "post";
      const postWarnings = reusesPost ? [] : [
        ...warnings,
        "Instagram starts over for these ads: once the post is edited, Meta does not let an ad go back to the creative that created it, so they move to a creative that reuses the post.",
      ];
      return {
        before,
        after,
        field_changes: [],
        route: "edit_post",
        post_edit: {
          post_id: creative.effective_object_story_id,
          page_id: creative.effective_object_story_id.split("_")[0],
          message: after.primary[0],
          reuses_post: reusesPost,
        },
        social_proof: { facebook: "kept", instagram: reusesPost ? "kept" : "reset" },
        warnings: postWarnings,
      };
    }
    if (!allowNewPost) {
      return {
        before, after, field_changes,
        reason: "editing the post changes only the text of image or link ads with one primary text and of promoted posts; this ad shows other text (a video or text options). Pass allow_new_post: true to give it a new post instead.",
        reason_code: "post_edit_unsupported", blocking: true, warnings,
      };
    }
  }

  if (read.source === "post") {
    return {
      before,
      after,
      field_changes,
      reason: "the ad promotes an existing post: only its primary texts can change while keeping the post, and the result needs at least two of them. For other changes create a new creative with ads_create_ad_creative.",
      reason_code: "promoted_post",
      blocking: true,
      warnings,
    };
  }

  if (!allowNewPost) {
    const needs = otherCopyChanged || otherChanged
      ? "changing headlines, descriptions, link, button or media"
      : "a single primary text";
    return {
      before,
      after,
      field_changes,
      reason: `${needs} needs a new post, which resets the likes, comments and shares people see. Pass allow_new_post: true to do it.`,
      reason_code: "needs_new_post",
      blocking: true,
      warnings,
    };
  }

  const isVideo = Boolean(asRecord(asRecord(creative.object_story_spec)?.video_data));
  if (changes.video_id !== undefined && !isVideo) {
    return {
      before, after, field_changes,
      reason: "switching an image ad to video is not supported; create a new creative instead",
      reason_code: "image_to_video", blocking: true, warnings,
    };
  }

  const sent = finish(buildNewPostBody(creative, after, changes));
  return {
    before,
    ...previewOf(creative, sent),
    route: "new_post",
    body: sent,
    social_proof: { facebook: "reset", instagram: "reset" },
    warnings,
  };
}
