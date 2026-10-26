import { MAX_HEADLINE_LENGTH } from "./creative-spec.js";
import { asRecord, carryOverFields, resolveInstagramUserId } from "./creative-rebuild.js";
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

export type Route = "same_post" | "new_post";

export interface ContentPlan {
  before: Copy;
  after: Copy;
  route?: Route;
  body?: Record<string, string>;
  reason?: string;
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
    if (!spec) return { unsupported: "text options without an object_story_spec" };
    return {
      source: "text_options",
      copy: { primary: texts(feed.bodies), headlines: texts(feed.titles), descriptions: texts(feed.descriptions) },
    };
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

function applyChange(current: string[], change: TextChange | undefined, label: string): string[] {
  if (!change) return current;
  let next = change.set ? [...change.set] : [...current];
  for (const text of change.remove ?? []) {
    const index = next.findIndex((existing) => existing.trim() === text.trim());
    if (index === -1) throw new Error(`Cannot remove ${label} "${text}": the ad does not have it.`);
    next.splice(index, 1);
  }
  next = [...next, ...(change.add ?? [])];
  const keys = next.map((text) => text.trim());
  if (keys.some((key) => key === "")) throw new Error(`A ${label} would be blank.`);
  if (new Set(keys).size !== keys.length) throw new Error(`The ${label}s would repeat a text; Meta rejects duplicates.`);
  if (next.length > MAX_TEXT_OPTIONS) throw new Error(`The ad would have ${next.length} ${label}s; the limit is ${MAX_TEXT_OPTIONS}.`);
  if (label === "headline" && next.some((text) => text.length > MAX_HEADLINE_LENGTH)) {
    throw new Error(`A headline would exceed ${MAX_HEADLINE_LENGTH} characters.`);
  }
  return next;
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((text, i) => text === b[i]);

// Clones the source spec, swaps media / link / button as asked and lays the
// copy out the way ads_create_ad_creative does: several texts in a
// DEGREES_OF_FREEDOM feed with no copy in the spec, one of each in the spec.
function buildNewPostBody(creative: AdCreative, after: Copy, changes: ContentChanges): Record<string, string> {
  const spec = structuredClone(asRecord(creative.object_story_spec) ?? {});
  const linkData = asRecord(spec.link_data);
  const videoData = asRecord(spec.video_data);
  const target = linkData ?? videoData ?? {};

  if (changes.link_url !== undefined) {
    if (linkData) linkData.link = changes.link_url;
    const cta = asRecord(target.call_to_action);
    if (cta) target.call_to_action = { ...cta, value: { ...(asRecord(cta.value) ?? {}), link: changes.link_url } };
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

export function planContentEdit(creative: AdCreative, changes: ContentChanges, allowNewPost: boolean): ContentPlan {
  const read = readCopy(creative);
  const empty: Copy = { primary: [], headlines: [], descriptions: [] };
  if ("unsupported" in read) return { before: empty, after: empty, reason: read.unsupported, warnings: [] };

  const before = read.copy;
  const after: Copy = {
    primary: applyChange(before.primary, changes.primary_texts, "primary text"),
    headlines: applyChange(before.headlines, changes.headlines, "headline"),
    descriptions: applyChange(before.descriptions, changes.descriptions, "description"),
  };

  const primaryChanged = !sameList(before.primary, after.primary);
  const otherCopyChanged = !sameList(before.headlines, after.headlines) || !sameList(before.descriptions, after.descriptions);
  const otherChanged = [changes.link_url, changes.call_to_action_type, changes.image_hash, changes.image_url, changes.video_id]
    .some((value) => value !== undefined);
  const urlTagsChanged = changes.url_tags !== undefined && changes.url_tags !== (creative.url_tags ?? "");

  if (!primaryChanged && !otherCopyChanged && !otherChanged) {
    const reason = urlTagsChanged
      ? "only url_tags change: use ads_update_ad_url_tags, which keeps the post where it can"
      : "nothing to change";
    return { before, after, reason, warnings: [] };
  }

  const carried = carryOverFields(creative);
  const warnings = [...carried.warnings];
  const finish = (body: Record<string, string>) => {
    Object.assign(body, carried.body);
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
    return { before, after, route: "same_post", body: finish(body), social_proof: { facebook: "kept", instagram: "reset" }, warnings };
  }

  if (read.source === "post") {
    return {
      before,
      after,
      reason: "the ad promotes an existing post: only its primary texts can change while keeping the post, and the result needs at least two of them. For other changes create a new creative with ads_create_ad_creative.",
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
      reason: `${needs} needs a new post, which resets the likes, comments and shares people see. Pass allow_new_post: true to do it.`,
      warnings,
    };
  }

  const isVideo = Boolean(asRecord(asRecord(creative.object_story_spec)?.video_data));
  if (changes.video_id !== undefined && !isVideo) {
    return { before, after, reason: "switching an image ad to video is not supported; create a new creative instead", warnings };
  }

  return {
    before,
    after,
    route: "new_post",
    body: finish(buildNewPostBody(creative, after, changes)),
    social_proof: { facebook: "reset", instagram: "reset" },
    warnings,
  };
}
