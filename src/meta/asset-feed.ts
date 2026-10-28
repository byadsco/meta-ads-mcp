import { MAX_HEADLINE_LENGTH } from "./creative-spec.js";

// Asset feeds beyond text options: dynamic creative, per-placement and
// per-language versions, and site links. Every shape here was accepted by
// Meta on v26.0, as a creative and as a paused ad (docs/meta-creative-ground-truth.md).

export type DynamicFormat = "SINGLE_IMAGE" | "SINGLE_VIDEO" | "CAROUSEL" | "AUTOMATIC_FORMAT";

export interface FeedVideo {
  videoId: string;
  thumbnailHash: string;
}

export interface DynamicCreativeInput {
  images: string[];
  videos: FeedVideo[];
  primaryTexts: string[];
  headlines: string[];
  descriptions: string[];
  callToActionTypes: string[];
  links: Array<{ url: string; displayUrl?: string }>;
  format: DynamicFormat;
}

// Meta's limits for a dynamic creative feed (Marketing API docs, read 2026-10-27).
const DYNAMIC_LIMITS = { images: 10, videos: 10, texts: 5, buttons: 5, links: 5, assets: 30, body: 1024 };

const texts = (values: string[]) => values.map((text) => ({ text }));

function checkTexts(values: string[], label: string, max: number, maxLength?: number): void {
  if (values.length > max) throw new Error(`A dynamic creative takes at most ${max} ${label}.`);
  const keys = values.map((value) => value.trim());
  if (keys.some((key) => key === "")) throw new Error(`${label} must not be blank.`);
  if (new Set(keys).size !== keys.length) throw new Error(`${label} repeat a text; Meta rejects duplicates.`);
  if (maxLength !== undefined && values.some((value) => value.length > maxLength)) {
    throw new Error(`${label} are capped at ${maxLength} characters.`);
  }
}

export function buildDynamicFeed(input: DynamicCreativeInput): Record<string, unknown> {
  if (input.images.length > DYNAMIC_LIMITS.images) throw new Error(`A dynamic creative takes at most ${DYNAMIC_LIMITS.images} images.`);
  if (input.videos.length > DYNAMIC_LIMITS.videos) throw new Error(`A dynamic creative takes at most ${DYNAMIC_LIMITS.videos} videos.`);
  checkTexts(input.primaryTexts, "primary texts", DYNAMIC_LIMITS.texts, DYNAMIC_LIMITS.body);
  checkTexts(input.headlines, "headlines", DYNAMIC_LIMITS.texts, MAX_HEADLINE_LENGTH);
  checkTexts(input.descriptions, "descriptions", DYNAMIC_LIMITS.texts, MAX_HEADLINE_LENGTH);
  if (input.links.length === 0) throw new Error("A dynamic creative needs at least one link (links).");
  if (input.links.length > DYNAMIC_LIMITS.links) throw new Error(`A dynamic creative takes at most ${DYNAMIC_LIMITS.links} links.`);
  if (input.callToActionTypes.length === 0) throw new Error("A dynamic creative needs at least one button (call_to_action_types).");
  if (input.callToActionTypes.length > DYNAMIC_LIMITS.buttons) throw new Error(`A dynamic creative takes at most ${DYNAMIC_LIMITS.buttons} buttons.`);
  if (input.images.length + input.videos.length === 0) throw new Error("A dynamic creative needs at least one image or video.");
  switch (input.format) {
    case "SINGLE_IMAGE":
      if (input.images.length === 0 || input.videos.length > 0) throw new Error("The SINGLE_IMAGE format needs images and takes no videos.");
      break;
    case "SINGLE_VIDEO":
      if (input.images.length > 0 || input.videos.length === 0) throw new Error("The SINGLE_VIDEO format takes only videos.");
      break;
    case "CAROUSEL":
      if (input.images.length < 2 || input.videos.length > 0) throw new Error("The CAROUSEL format needs at least 2 images and takes no videos.");
      break;
    default:
      break;
  }
  const assets = input.images.length + input.videos.length + input.primaryTexts.length + input.headlines.length
    + input.descriptions.length + input.callToActionTypes.length + input.links.length + 1;
  if (assets > DYNAMIC_LIMITS.assets) throw new Error(`A dynamic creative takes at most ${DYNAMIC_LIMITS.assets} assets in all (the format counts as one); this one has ${assets}.`);

  const feed: Record<string, unknown> = {};
  if (input.images.length > 0) feed.images = input.images.map((hash) => ({ hash }));
  if (input.videos.length > 0) feed.videos = input.videos.map((v) => ({ video_id: v.videoId, thumbnail_hash: v.thumbnailHash }));
  if (input.primaryTexts.length > 0) feed.bodies = texts(input.primaryTexts);
  if (input.headlines.length > 0) feed.titles = texts(input.headlines);
  if (input.descriptions.length > 0) feed.descriptions = texts(input.descriptions);
  feed.call_to_action_types = input.callToActionTypes;
  feed.link_urls = input.links.map((link) => (link.displayUrl ? { website_url: link.url, display_url: link.displayUrl } : { website_url: link.url }));
  feed.ad_formats = [input.format];
  feed.optimization_type = "REGULAR";
  return feed;
}

export interface Placements {
  publisherPlatforms: string[];
  facebookPositions?: string[];
  instagramPositions?: string[];
  messengerPositions?: string[];
  audienceNetworkPositions?: string[];
  threadsPositions?: string[];
}

// Positions Meta removed (the Facebook video feeds and Instagram Explore
// feed; Messenger Stories since v26), which a rule would now fail on.
const REMOVED_POSITIONS: Record<string, string[]> = {
  facebookPositions: ["video_feeds"],
  instagramPositions: ["explore"],
  messengerPositions: ["story"],
};

const POSITION_KEYS: Array<[keyof Placements, string]> = [
  ["facebookPositions", "facebook_positions"],
  ["instagramPositions", "instagram_positions"],
  ["messengerPositions", "messenger_positions"],
  ["audienceNetworkPositions", "audience_network_positions"],
  ["threadsPositions", "threads_positions"],
];

function customizationSpec(placements: Placements, where: string): Record<string, unknown> {
  if (placements.publisherPlatforms.length === 0) throw new Error(`${where} needs at least one publisher platform.`);
  const spec: Record<string, unknown> = { publisher_platforms: placements.publisherPlatforms };
  for (const [key, field] of POSITION_KEYS) {
    const positions = placements[key] as string[] | undefined;
    if (!positions || positions.length === 0) continue;
    const removed = positions.filter((position) => REMOVED_POSITIONS[key]?.includes(position));
    if (removed.length > 0) throw new Error(`${where} names ${removed.join(", ")} in ${field}, a placement Meta removed.`);
    spec[field] = positions;
  }
  return spec;
}

export interface PlacementVariant {
  placements: Placements;
  imageHash?: string;
  videoId?: string;
  thumbnailHash?: string;
}

export function buildPlacementFeed(input: {
  variants: PlacementVariant[];
  primaryText?: string;
  headline?: string;
  description?: string;
  linkUrl: string;
  callToActionType: string;
}): Record<string, unknown> {
  if (input.variants.length < 2) throw new Error("Placement versions need at least 2 placement variants.");
  if (!input.linkUrl) throw new Error("Placement versions need the ad's link_url.");
  const kinds = input.variants.map((variant, i) => {
    if (variant.videoId && variant.imageHash) throw new Error(`placement_variants[${i}] takes either an image_hash or a video_id, not both.`);
    if (variant.videoId) {
      if (!variant.thumbnailHash) throw new Error(`placement_variants[${i}] is a video and needs a thumbnail_hash.`);
      return "video";
    }
    if (variant.thumbnailHash) throw new Error(`placement_variants[${i}] has a thumbnail_hash, which only a video variant takes.`);
    if (variant.imageHash) return "image";
    throw new Error(`placement_variants[${i}] needs an image_hash or a video_id.`);
  });
  if (new Set(kinds).size > 1) throw new Error("Placement variants have to be all images or all videos.");
  const video = kinds[0] === "video";
  const label = (i: number) => ({ name: `placement_${i + 1}` });

  const feed: Record<string, unknown> = {};
  if (video) {
    feed.videos = input.variants.map((v, i) => ({ video_id: v.videoId, thumbnail_hash: v.thumbnailHash, adlabels: [label(i)] }));
  } else {
    feed.images = input.variants.map((v, i) => ({ hash: v.imageHash, adlabels: [label(i)] }));
  }
  if (input.primaryText) feed.bodies = [{ text: input.primaryText }];
  if (input.headline) feed.titles = [{ text: input.headline }];
  if (input.description) feed.descriptions = [{ text: input.description }];
  feed.link_urls = [{ website_url: input.linkUrl }];
  feed.call_to_action_types = [input.callToActionType];
  feed.ad_formats = [video ? "SINGLE_VIDEO" : "SINGLE_IMAGE"];
  feed.optimization_type = "PLACEMENT";
  feed.asset_customization_rules = input.variants.map((v, i) => ({
    customization_spec: customizationSpec(v.placements, `placement_variants[${i}]`),
    [video ? "video_label" : "image_label"]: label(i),
  }));
  return feed;
}

export interface LanguageVariant {
  locales: number[];
  isDefault?: boolean;
  primaryText: string;
  headline: string;
  description: string;
  linkUrl?: string;
}

export function buildLanguageFeed(input: {
  variants: LanguageVariant[];
  imageHash?: string;
  videoId?: string;
  thumbnailHash?: string;
  linkUrl: string;
  callToActionType: string;
}): Record<string, unknown> {
  if (input.variants.length < 2) throw new Error("Language versions need at least 2 language variants.");
  if (input.variants.filter((v) => v.isDefault).length !== 1) {
    throw new Error("Language versions need exactly one default language (default: true), shown to everyone outside the others.");
  }
  if (!input.imageHash && !input.videoId) throw new Error("Language versions need the ad's image_hash or video_id, shared by every language.");
  if (input.videoId && !input.thumbnailHash) throw new Error("A video needs a thumbnail_hash.");
  if (!input.linkUrl) throw new Error("Language versions need the ad's link_url.");
  input.variants.forEach((v, i) => {
    if (v.locales.length === 0) throw new Error(`language_variants[${i}] needs at least one locale.`);
    // Meta refuses the ad (subcode 1885817) when a language lacks one.
    for (const [field, value] of [["primary_text", v.primaryText], ["headline", v.headline], ["description", v.description]] as const) {
      if (!value || value.trim() === "") throw new Error(`language_variants[${i}] needs a ${field}: Meta refuses a language without one.`);
    }
  });
  const label = (i: number) => ({ name: `language_${i + 1}` });
  const labeled = (values: string[]) => values.map((text, i) => ({ text, adlabels: [label(i)] }));

  const feed: Record<string, unknown> = {};
  if (input.videoId) feed.videos = [{ video_id: input.videoId, thumbnail_hash: input.thumbnailHash }];
  else feed.images = [{ hash: input.imageHash }];
  feed.bodies = labeled(input.variants.map((v) => v.primaryText));
  feed.titles = labeled(input.variants.map((v) => v.headline));
  feed.descriptions = labeled(input.variants.map((v) => v.description));
  feed.link_urls = input.variants.map((v, i) => ({ website_url: v.linkUrl ?? input.linkUrl, adlabels: [label(i)] }));
  feed.call_to_action_types = [input.callToActionType];
  feed.ad_formats = [input.videoId ? "SINGLE_VIDEO" : "SINGLE_IMAGE"];
  feed.optimization_type = "LANGUAGE";
  feed.asset_customization_rules = input.variants.map((v, i) => ({
    ...(v.isDefault ? { is_default: true } : {}),
    customization_spec: { locales: v.locales },
    body_label: label(i),
    title_label: label(i),
    description_label: label(i),
    link_url_label: label(i),
  }));
  return feed;
}

export interface AssetGroup {
  imageHashes: string[];
  videoIds: string[];
  primaryTexts: string[];
  headlines: string[];
  descriptions: string[];
  callToAction: { type: string; link: string };
}

// Flexible format (creative_asset_groups_spec on the ad). Meta allows it on
// Sales and App promotion campaigns only, and every group needs media and
// the same button type (Marketing API docs, read 2026-10-27).
export function buildAssetGroups(groups: AssetGroup[]): Record<string, unknown> {
  if (groups.length === 0) throw new Error("The flexible format needs at least one group.");
  const buttons = new Set(groups.map((g) => g.callToAction.type));
  if (buttons.size > 1) throw new Error("Every flexible format group needs the same button type; Meta refuses mixed ones.");
  return {
    groups: groups.map((g, i) => {
      if (g.imageHashes.length + g.videoIds.length === 0) throw new Error(`groups[${i}] needs at least one image or video.`);
      for (const [list, label] of [[g.primaryTexts, "primary texts"], [g.headlines, "headlines"], [g.descriptions, "descriptions"]] as const) {
        if (list.length > 5) throw new Error(`groups[${i}] takes at most 5 ${label}.`);
      }
      const group: Record<string, unknown> = {};
      if (g.imageHashes.length > 0) group.images = g.imageHashes.map((hash) => ({ hash }));
      if (g.videoIds.length > 0) group.videos = g.videoIds.map((video_id) => ({ video_id }));
      group.texts = [
        ...g.primaryTexts.map((text) => ({ text, text_type: "primary_text" })),
        ...g.headlines.map((text) => ({ text, text_type: "headline" })),
        ...g.descriptions.map((text) => ({ text, text_type: "description" })),
      ];
      group.call_to_action = { type: g.callToAction.type, value: { link: g.callToAction.link } };
      return group;
    }),
  };
}

export interface SiteLink {
  title: string;
  url: string;
  imageHash?: string;
}

export function buildSiteLinks(links: SiteLink[]): Record<string, unknown> {
  return {
    site_links_spec: links.map((link, i) => {
      if (!link.title.trim() || !link.url) throw new Error(`site_links[${i}] needs a title and a url.`);
      return link.imageHash
        ? { site_link_title: link.title, site_link_url: link.url, site_link_image_hash: link.imageHash }
        : { site_link_title: link.title, site_link_url: link.url };
    }),
  };
}
