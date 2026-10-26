import { MAX_HEADLINE_LENGTH } from "./creative-spec.js";
import { asRecord, carryOverFields, resolveInstagramUserId, withInstagramIdentity } from "./creative-rebuild.js";
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

export type Route = "same_post" | "new_post";

export interface ContentPlan {
  before: Copy;
  after: Copy;
  route?: Route;
  body?: Record<string, string>;
  reason?: string;
  // A reason that leaves part of the request undone. It stops the whole batch;
  // "nothing to change" does not.
  blocking?: boolean;
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

export function planContentEdit(creative: AdCreative, changes: ContentChanges, allowNewPost: boolean): ContentPlan {
  const read = readCopy(creative);
  const empty: Copy = { primary: [], headlines: [], descriptions: [] };
  if ("unsupported" in read) return { before: empty, after: empty, reason: read.unsupported, blocking: true, warnings: [] };

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
  const differs = (requested: string | undefined, now: string | undefined) => requested !== undefined && requested !== now;
  const otherChanged =
    differs(changes.link_url, current.link) ||
    differs(changes.call_to_action_type, current.ctaType) ||
    // image_hash wins when both are given, so only the medium that would be
    // written is compared.
    differs(changes.image_hash, current.imageHash) ||
    (changes.image_hash === undefined && differs(changes.image_url, current.imageUrl)) ||
    differs(changes.video_id, current.videoId);
  const urlTagsChanged = changes.url_tags !== undefined && changes.url_tags !== (creative.url_tags ?? "");

  if (!primaryChanged && !otherCopyChanged && !otherChanged) {
    if (urlTagsChanged) {
      return { before, after, reason: "only url_tags change: use ads_update_ad_url_tags, which keeps the post where it can", blocking: true, warnings: [] };
    }
    return { before, after, reason: "nothing to change", blocking: false, warnings: [] };
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
    return { before, after, route: "same_post", body: finish(body), social_proof: { facebook: "kept", instagram: "reset" }, warnings };
  }

  if (read.source === "post") {
    return {
      before,
      after,
      reason: "the ad promotes an existing post: only its primary texts can change while keeping the post, and the result needs at least two of them. For other changes create a new creative with ads_create_ad_creative.",
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
      reason: `${needs} needs a new post, which resets the likes, comments and shares people see. Pass allow_new_post: true to do it.`,
      blocking: true,
      warnings,
    };
  }

  const isVideo = Boolean(asRecord(asRecord(creative.object_story_spec)?.video_data));
  if (changes.video_id !== undefined && !isVideo) {
    return { before, after, reason: "switching an image ad to video is not supported; create a new creative instead", blocking: true, warnings };
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
