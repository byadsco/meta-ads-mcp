import { fbcdnExpiresAt, type VideoSource } from "../media/video-sources.js";

/**
 * One item of the curious_coder/facebook-ads-library-scraper dataset (build
 * 2.7.x). The actor mirrors the snake_case node of the Ad Library web GraphQL
 * response; every field is treated as optional because the actor also pushes
 * error records and login-gated ads come back without media or link_url.
 */
export interface AdLibraryRawItem {
  [key: string]: unknown;
  ad_archive_id?: unknown;
  error?: unknown;
  snapshot?: unknown;
}

export interface LibraryImage {
  original_url: string | null;
  resized_url: string | null;
}

export interface LibraryVideo {
  hd_url: string | null;
  sd_url: string | null;
  preview_image_url: string | null;
}

export interface LibraryCard {
  index: number;
  body: string | null;
  title: string | null;
  caption: string | null;
  link_description: string | null;
  link_url: string | null;
  cta_text: string | null;
  cta_type: string | null;
  image: LibraryImage | null;
  video: LibraryVideo | null;
}

export interface LibraryCopy {
  body: string | null;
  title: string | null;
  caption: string | null;
  link_description: string | null;
  cta_text: string | null;
  cta_type: string | null;
  link_url: string | null;
  byline: string | null;
  /** DCO / DPA ads carry {{product.*}} placeholders here; the real creative lives in cards. */
  is_template: boolean;
}

export interface LibraryPage {
  id: string | null;
  name: string | null;
  profile_uri: string | null;
  profile_picture_url: string | null;
  categories: string[];
  like_count: number | null;
  is_deleted: boolean | null;
}

export interface LibraryMediaSummary {
  display_format: string | null;
  image_count: number;
  video_count: number;
  has_video: boolean;
  /** Expiry of the signed CDN URLs, decoded from the fbcdn oe parameter. */
  expires_at?: string;
  /** Counts after the size caps, i.e. what the media tools can actually address; absent in cheap listings. */
  images_available?: number;
  videos_available?: number;
}

export interface LibraryAd {
  ad_archive_id: string;
  offset: number | null;
  ad_library_url: string;
  page: LibraryPage;
  is_active: boolean | null;
  start_date: string | null;
  end_date: string | null;
  publisher_platforms: string[];
  display_format: string | null;
  copy: LibraryCopy;
  cards: LibraryCard[];
  images: LibraryImage[];
  videos: LibraryVideo[];
  extra_texts: unknown[];
  extra_links: unknown[];
  impressions_text: string | null;
  spend: unknown;
  currency: string | null;
  reach_estimate: unknown;
  collation_count: number | null;
  total_active_time: number | null;
  contains_digital_created_media: boolean | null;
  /** Top-level blocks the actor adds with scrapeAdDetails (advertiser, aaa_info, insights, transparency). */
  details?: Record<string, unknown>;
  media_summary: LibraryMediaSummary;
  /** Fields cut down to the size caps (a hostile or pathological record cannot balloon the response). */
  truncated: string[];
}

const DETAIL_KEYS = ["advertiser", "aaa_info", "insights", "violation_types", "finserv_data", "regional_regulation_data"];
const TEMPLATE_PATTERN = /\{\{\s*[a-z_]+\.[a-z_.]+\s*\}\}/i;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
export const MAX_CARDS = 30;
export const MAX_MEDIA_ITEMS = 20;
export const MAX_EXTRA_ITEMS = 20;
export const MAX_TEXT_CHARS = 4000;
/** Longer URLs are omitted whole: truncating a signed CDN URL would only produce a broken link. */
export const MAX_URL_CHARS = 2048;
const TRUNCATION_MARKER = " [truncated]";
// Epoch seconds up to year 2100; anything else is not a date the actor would emit.
const MAX_EPOCH_SECONDS = 4_102_444_800;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number") return String(value);
  return null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * The actor returns some copy fields as { text } objects and others as plain
 * strings; the legacy format wrapped body in { markup: { __html } }.
 */
function text(value: unknown, onTruncate?: () => void): string | null {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("text" in record) return str(record.text);
    const html = asRecord(record.markup).__html;
    if (typeof html === "string") return str(stripTags(html, onTruncate));
  }
  return str(value);
}

/** Single linear pass over a bounded prefix: a tag regex backtracks quadratically on unclosed "<". */
function stripTags(html: string, onTruncate?: () => void): string {
  const cut = html.length > MAX_TEXT_CHARS * 4;
  if (cut) onTruncate?.();
  const input = cut ? html.slice(0, MAX_TEXT_CHARS * 4) : html;
  let out = "";
  let inTag = false;
  let lastSpace = true;
  for (const ch of input) {
    if (ch === "<") {
      inTag = true;
      continue;
    }
    if (inTag) {
      if (ch === ">") {
        inTag = false;
        if (!lastSpace) {
          out += " ";
          lastSpace = true;
        }
      }
      continue;
    }
    const isSpace = /\s/.test(ch);
    if (isSpace) {
      if (!lastSpace) {
        out += " ";
        lastSpace = true;
      }
      continue;
    }
    out += ch;
    lastSpace = false;
  }
  return out.trim();
}

function isoDate(epochSeconds: unknown): string | null {
  const n = num(epochSeconds);
  if (n === null || n <= 0 || n > MAX_EPOCH_SECONDS) return null;
  try {
    return new Date(n * 1000).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

/** ad_archive_id in the current actor format, adArchiveID in the legacy one; numbers are tolerated. */
export function archiveIdOf(item: unknown): string | null {
  const record = asRecord(item);
  return idString(record.ad_archive_id) ?? idString(record.adArchiveID);
}

/** Ids are strings; a number is accepted only when JSON could not have rounded it. */
function idString(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}

function capText(value: string | null, label: string, truncated: string[]): string | null {
  if (value === null || value.length <= MAX_TEXT_CHARS) return value;
  truncated.push(label);
  return value.slice(0, MAX_TEXT_CHARS) + TRUNCATION_MARKER;
}

function capList<T>(items: T[], max: number, label: string, truncated: string[]): T[] {
  if (items.length <= max) return items;
  truncated.push(label);
  return items.slice(0, max);
}

function urlOrNull(value: unknown, label: string, truncated: string[]): string | null {
  const url = str(value);
  if (url === null) return null;
  if (url.length > MAX_URL_CHARS) {
    truncated.push(label + " (url omitted)");
    return null;
  }
  return url;
}

function strings(value: unknown): string[] {
  return asArray(value).map(str).filter((s): s is string => s !== null);
}

export function isAdLibraryErrorItem(item: unknown): boolean {
  const record = asRecord(item);
  return typeof record.error === "string" || archiveIdOf(record) === null;
}

export function isTemplateCopy(value: string | null | undefined): boolean {
  return typeof value === "string" && TEMPLATE_PATTERN.test(value);
}

function image(record: Record<string, unknown>, label: string, truncated: string[]): LibraryImage | null {
  const original_url = urlOrNull(record.original_image_url, label + ".original_image_url", truncated);
  const resized_url = urlOrNull(record.resized_image_url, label + ".resized_image_url", truncated);
  return original_url || resized_url ? { original_url, resized_url } : null;
}

function video(record: Record<string, unknown>, label: string, truncated: string[]): LibraryVideo | null {
  const hd_url = urlOrNull(record.video_hd_url, label + ".video_hd_url", truncated);
  const sd_url = urlOrNull(record.video_sd_url, label + ".video_sd_url", truncated);
  const preview_image_url = urlOrNull(record.video_preview_image_url, label + ".video_preview_image_url", truncated);
  return hd_url || sd_url ? { hd_url, sd_url, preview_image_url } : null;
}

function card(record: Record<string, unknown>, index: number, truncated: string[]): LibraryCard {
  const label = "cards[" + index + "]";
  return {
    index,
    body: capText(text(record.body, () => truncated.push(label + ".body")), label + ".body", truncated),
    title: capText(str(record.title), label + ".title", truncated),
    caption: capText(str(record.caption), label + ".caption", truncated),
    link_description: capText(str(record.link_description), label + ".link_description", truncated),
    link_url: urlOrNull(record.link_url, label + ".link_url", truncated),
    cta_text: capText(str(record.cta_text), label + ".cta_text", truncated),
    cta_type: str(record.cta_type),
    image: image(record, label, truncated),
    video: video(record, label, truncated),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Counts media over the raw arrays without materializing anything, so listings stay cheap. */
function countMedia(snapshot: Record<string, unknown>): { image_count: number; video_count: number; first_url?: string } {
  let image_count = 0;
  let video_count = 0;
  let first_url: string | undefined;
  const note = (url: string | null) => {
    if (!first_url && url) first_url = url;
  };
  for (const v of asArray(snapshot.videos)) {
    if (!isRecord(v)) continue;
    const hd = str(v.video_hd_url);
    const sd = str(v.video_sd_url);
    if (hd || sd) {
      video_count += 1;
      note(sd ?? hd);
    }
  }
  for (const i of asArray(snapshot.images)) {
    if (!isRecord(i)) continue;
    const url = str(i.original_image_url) ?? str(i.resized_image_url);
    if (url) {
      image_count += 1;
      note(url);
    }
  }
  for (const c of asArray(snapshot.cards)) {
    if (!isRecord(c)) continue;
    const vid = str(c.video_sd_url) ?? str(c.video_hd_url);
    const img = str(c.original_image_url) ?? str(c.resized_image_url);
    if (vid) {
      video_count += 1;
      note(vid);
    } else if (img) {
      image_count += 1;
      note(img);
    }
  }
  return { image_count, video_count, first_url };
}

function summarize(snapshot: Record<string, unknown>): LibraryMediaSummary {
  const { image_count, video_count, first_url } = countMedia(snapshot);
  return {
    display_format: str(snapshot.display_format),
    image_count,
    video_count,
    has_video: video_count > 0,
    expires_at: fbcdnExpiresAt(first_url),
  };
}

/** Builds at most max items, stopping as soon as one more valid item would exceed the cap. */
function takeMedia<T>(raw: unknown[], build: (record: Record<string, unknown>, index: number) => T | null, max: number, label: string, truncated: string[]): T[] {
  const out: T[] = [];
  for (let index = 0; index < raw.length; index++) {
    const record = raw[index];
    if (!isRecord(record)) continue;
    if (out.length >= max) {
      truncated.push(label);
      break;
    }
    const built = build(record, index);
    if (built !== null) out.push(built);
  }
  return out;
}

function collectMedia(snapshot: Record<string, unknown>, truncated: string[]): { images: LibraryImage[]; videos: LibraryVideo[]; cards: LibraryCard[] } {
  const images = takeMedia(asArray(snapshot.images), (r, i) => image(r, "images[" + i + "]", truncated), MAX_MEDIA_ITEMS, "images", truncated);
  const videos = takeMedia(asArray(snapshot.videos), (r, i) => video(r, "videos[" + i + "]", truncated), MAX_MEDIA_ITEMS, "videos", truncated);
  const cards = takeMedia(asArray(snapshot.cards), (r, i) => card(r, i, truncated), MAX_CARDS, "cards", truncated);
  return { images, videos, cards };
}

/** Cheap projection for listings: enough to decide whether an ad deserves ads_library_get_ad_details. */
export function mediaSummary(raw: AdLibraryRawItem): LibraryMediaSummary {
  return summarize(asRecord(raw.snapshot));
}

export function normalizeLibraryAd(raw: AdLibraryRawItem, offset: number | null): LibraryAd {
  const snapshot = asRecord(raw.snapshot);
  const id = archiveIdOf(raw) ?? "";
  const truncated: string[] = [];
  const { images, videos, cards } = collectMedia(snapshot, truncated);
  const impressions = asRecord(raw.impressions_with_index);
  const details: Record<string, unknown> = {};
  for (const key of DETAIL_KEYS) {
    if (raw[key] !== undefined && raw[key] !== null) details[key] = raw[key];
  }
  for (const key of Object.keys(raw)) {
    if (UNSAFE_KEYS.has(key)) continue;
    if (key.endsWith("_transparency") && raw[key] !== null) details[key] = raw[key];
  }
  const body = capText(text(snapshot.body, () => truncated.push("copy.body")), "copy.body", truncated);
  const title = capText(str(snapshot.title), "copy.title", truncated);
  const linkDescription = capText(str(snapshot.link_description), "copy.link_description", truncated);

  return {
    ad_archive_id: id,
    offset,
    ad_library_url: str(raw.ad_library_url) ?? "https://www.facebook.com/ads/library/?id=" + id,
    page: {
      id: str(raw.page_id) ?? str(snapshot.page_id) ?? str(raw.pageID),
      name: capText(str(raw.page_name) ?? str(snapshot.page_name) ?? str(raw.pageName), "page.name", truncated),
      profile_uri: urlOrNull(snapshot.page_profile_uri, "page.profile_uri", truncated),
      profile_picture_url: urlOrNull(snapshot.page_profile_picture_url, "page.profile_picture_url", truncated),
      categories: strings(snapshot.page_categories),
      like_count: num(snapshot.page_like_count),
      is_deleted: bool(raw.page_is_deleted) ?? bool(snapshot.page_is_deleted),
    },
    is_active: bool(raw.is_active),
    start_date: isoDate(raw.start_date),
    end_date: isoDate(raw.end_date),
    publisher_platforms: strings(raw.publisher_platform),
    display_format: str(snapshot.display_format),
    copy: {
      body,
      title,
      caption: capText(str(snapshot.caption), "copy.caption", truncated),
      link_description: linkDescription,
      cta_text: capText(str(snapshot.cta_text), "copy.cta_text", truncated),
      cta_type: str(snapshot.cta_type),
      link_url: urlOrNull(snapshot.link_url, "copy.link_url", truncated),
      byline: capText(str(snapshot.byline), "copy.byline", truncated),
      is_template: isTemplateCopy(body) || isTemplateCopy(title) || isTemplateCopy(linkDescription),
    },
    cards,
    images,
    videos,
    extra_texts: capList(asArray(snapshot.extra_texts), MAX_EXTRA_ITEMS, "extra_texts", truncated),
    extra_links: capList(asArray(snapshot.extra_links), MAX_EXTRA_ITEMS, "extra_links", truncated),
    impressions_text: str(impressions.impressions_text),
    spend: raw.spend ?? null,
    currency: str(raw.currency),
    reach_estimate: raw.reach_estimate ?? null,
    collation_count: num(raw.collation_count),
    total_active_time: num(raw.total_active_time),
    contains_digital_created_media: bool(raw.contains_digital_created_media),
    details: Object.keys(details).length > 0 ? details : undefined,
    media_summary: {
      ...summarize(snapshot),
      images_available: images.length + cards.filter((c) => c.image !== null && c.video === null).length,
      videos_available: videos.length + cards.filter((c) => c.video !== null).length,
    },
    truncated,
  };
}

export interface LibraryImageAsset {
  role: "primary" | "card";
  card_index?: number;
  url: string;
}

/** Downloadable images in reading order: top-level images first, then image cards (video cards are skipped). */
export function libraryImageAssets(ad: LibraryAd, size: "full" | "small"): LibraryImageAsset[] {
  const pick = (img: LibraryImage): string | null =>
    size === "small" ? img.resized_url ?? img.original_url : img.original_url ?? img.resized_url;
  const assets: LibraryImageAsset[] = [];
  for (const img of ad.images) {
    const url = pick(img);
    if (url) assets.push({ role: "primary", url });
  }
  for (const c of ad.cards) {
    if (c.video || !c.image) continue;
    const url = pick(c.image);
    if (url) assets.push({ role: "card", card_index: c.index, url });
  }
  return assets;
}

function buildLibrarySource(adId: string, pageName: string | null, v: LibraryVideo, index: number): VideoSource {
  return {
    key: "library:" + adId + ":video:" + index,
    label: "Video " + index + " of Ad Library ad " + adId + (pageName ? " — " + pageName : ""),
    origin: "ad_library",
    ad_archive_id: adId,
    card_index: index,
    source_url: v.hd_url ?? v.sd_url ?? undefined,
    low_res_url: v.sd_url ?? undefined,
    thumbnail_url: v.preview_image_url ?? undefined,
  };
}

/** Video sources for the delivery pipeline: HD as source, SD as the preferred download, preview as thumbnail. */
export function extractLibraryVideoSources(ad: LibraryAd): VideoSource[] {
  const sources = ad.videos.map((v, i) => buildLibrarySource(ad.ad_archive_id, ad.page.name, v, i));
  for (const c of ad.cards) {
    if (!c.video) continue;
    // Top-level videos and video cards never coexist in real records; offset the
    // card index only when they do, so keys and resource URIs stay unique.
    sources.push(buildLibrarySource(ad.ad_archive_id, ad.page.name, c.video, ad.videos.length > 0 ? ad.videos.length + c.index : c.index));
  }
  return sources;
}

/**
 * Addresses the n-th video of a raw record (top-level videos first, then
 * video cards, in order) without materializing the capped collections, so a
 * caller can reach videos beyond the presentation caps.
 */
export function libraryVideoAt(raw: AdLibraryRawItem, index: number): VideoSource | undefined {
  const adId = archiveIdOf(raw) ?? "";
  const snapshot = asRecord(raw.snapshot);
  const pageName = str(raw.page_name) ?? str(snapshot.page_name) ?? str(raw.pageName);
  const scratch: string[] = [];
  let position = 0;
  const videos = asArray(snapshot.videos);
  for (let i = 0; i < videos.length; i++) {
    const record = videos[i];
    if (!isRecord(record)) continue;
    const v = video(record, "videos[" + i + "]", scratch);
    if (!v) continue;
    if (position === index) return buildLibrarySource(adId, pageName, v, position);
    position += 1;
  }
  const topLevel = position;
  const cards = asArray(snapshot.cards);
  for (let i = 0; i < cards.length; i++) {
    const record = cards[i];
    if (!isRecord(record)) continue;
    const v = video(record, "cards[" + i + "]", scratch);
    if (!v) continue;
    const cardIndex = topLevel > 0 ? topLevel + i : i;
    if (position === index) return buildLibrarySource(adId, pageName, v, cardIndex);
    position += 1;
  }
  return undefined;
}
