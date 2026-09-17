import { fbcdnExpiresAt, type VideoSource } from "../media/video-sources.js";
import { boundedClone } from "../utils/bounded-json.js";

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
  /** Renditions dropped by the url policy (e.g. "video_hd_url"), attached to this video only. */
  omitted_urls?: string[];
  /** Position in the record video order (top-level videos, then video cards); what video_index addresses. */
  selector?: number;
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
// Only the first top-level keys of a record are inspected for detail blocks (real records have ~40).
const MAX_TOP_LEVEL_KEYS_SCANNED = 64;
const MAX_DETAIL_BLOCKS = 8;
const DETAIL_BOUNDS = { maxDepth: 6, maxNodes: 400, maxString: 2000, maxKeys: 100, maxTotalChars: 20_000 };
const DELIVERY_DATA_BOUNDS = { maxDepth: 4, maxNodes: 100, maxString: 500, maxKeys: 50, maxTotalChars: 4_000 };
export const MAX_CARDS = 30;
export const MAX_MEDIA_ITEMS = 20;
export const MAX_EXTRA_ITEMS = 20;
export const MAX_TEXT_CHARS = 4000;
const MAX_ENUM_CHARS = 80;
// Detail block keys are field names (payer_beneficiary_transparency and the like).
const MAX_DETAIL_KEY_CHARS = 64;
// Notes emitted for media the url policy drops: a hostile record can carry millions of them.
const MAX_MEDIA_DROP_NOTES = 5;
// Raw image entries inspected; videos need the full walk to keep selectors stable, images do not.
const MAX_MEDIA_SCANNED = 200;
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

/** Enum-like fields (format, currency, cta_type) are short by nature; a longer value is hostile input. */
function capEnum(value: string | null, label: string, truncated: string[]): string | null {
  if (value === null || value.length <= MAX_ENUM_CHARS) return value;
  truncated.push(label);
  return value.slice(0, MAX_ENUM_CHARS) + TRUNCATION_MARKER;
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

const MAX_LIST_ITEMS = 20;
const MAX_LIST_ITEM_CHARS = 64;
// Entries inspected before giving up: real records carry a handful, a hostile
// one can carry millions of nulls in front of the first usable value.
const MAX_LIST_SCANNED = 200;

/** Bounded before conversion: a hostile record can carry millions of entries here. */
function strings(value: unknown, label: string, truncated: string[]): string[] {
  const raw = asArray(value);
  const out: string[] = [];
  let itemTruncated = false;
  for (let index = 0; index < raw.length; index++) {
    if (out.length >= MAX_LIST_ITEMS || index >= MAX_LIST_SCANNED) {
      truncated.push(label);
      break;
    }
    const text = str(raw[index]);
    if (text === null) continue;
    if (text.length > MAX_LIST_ITEM_CHARS) itemTruncated = true;
    out.push(text.length > MAX_LIST_ITEM_CHARS ? text.slice(0, MAX_LIST_ITEM_CHARS) : text);
  }
  if (itemTruncated) truncated.push(label + " (item text truncated)");
  return out;
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

interface VideoCandidate {
  video: LibraryVideo | null;
  /** Renditions dropped by the url policy; the caller decides how to label them. */
  omitted: string[];
}

function video(record: Record<string, unknown>): VideoCandidate {
  const omitted: string[] = [];
  const hd_url = urlOrNull(record.video_hd_url, "video_hd_url", omitted);
  const sd_url = urlOrNull(record.video_sd_url, "video_sd_url", omitted);
  const preview_image_url = urlOrNull(record.video_preview_image_url, "video_preview_image_url", omitted);
  if (!hd_url && !sd_url) return { video: null, omitted };
  const omitted_urls = omitted.map((note) => note.slice(0, note.indexOf(" (")));
  return { video: { hd_url, sd_url, preview_image_url, ...(omitted_urls.length > 0 ? { omitted_urls } : {}) }, omitted };
}

/**
 * The selector predicate: a raw video is addressable when at least one of its
 * renditions survives the url policy, which is exactly when video() builds
 * one. Answered without allocating, so both walks can skip records cheaply —
 * and because there is a single rule, a selector means the same thing on the
 * normalized path and on libraryVideoAt.
 */
function classifyVideo(record: Record<string, unknown>): { addressable: boolean; dropped: boolean } {
  const hd = str(record.video_hd_url);
  const sd = str(record.video_sd_url);
  const hdUsable = hd !== null && hd.length <= MAX_URL_CHARS;
  const sdUsable = sd !== null && sd.length <= MAX_URL_CHARS;
  return { addressable: hdUsable || sdUsable, dropped: (hd !== null && !hdUsable) || (sd !== null && !sdUsable) };
}

function card(record: Record<string, unknown>, index: number, truncated: string[]): LibraryCard {
  const label = "cards[" + index + "]";
  const candidate = video(record);
  for (const note of candidate.omitted) truncated.push(label + "." + note);
  return {
    index,
    body: capText(text(record.body, () => truncated.push(label + ".body")), label + ".body", truncated),
    title: capText(str(record.title), label + ".title", truncated),
    caption: capText(str(record.caption), label + ".caption", truncated),
    link_description: capText(str(record.link_description), label + ".link_description", truncated),
    link_url: urlOrNull(record.link_url, label + ".link_url", truncated),
    cta_text: capText(str(record.cta_text), label + ".cta_text", truncated),
    cta_type: capEnum(str(record.cta_type), label + ".cta_type", truncated),
    image: image(record, label, truncated),
    video: candidate.video,
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
  // Only a url the media tools would actually use: the expiry parser
  // materializes every query parameter, so an oversized one never reaches it.
  const note = (url: string | null) => {
    if (!first_url && url && url.length <= MAX_URL_CHARS) first_url = url;
  };
  for (const v of asArray(snapshot.videos)) {
    if (!isRecord(v)) continue;
    const hd = str(v.video_hd_url);
    const sd = str(v.video_sd_url);
    if (hd || sd) {
      video_count += 1;
      note(sd);
      note(hd);
    }
  }
  for (const i of asArray(snapshot.images)) {
    if (!isRecord(i)) continue;
    const original = str(i.original_image_url);
    const resized = str(i.resized_image_url);
    if (original || resized) {
      image_count += 1;
      note(original);
      note(resized);
    }
  }
  for (const c of asArray(snapshot.cards)) {
    if (!isRecord(c)) continue;
    const sd = str(c.video_sd_url);
    const hd = str(c.video_hd_url);
    const original = str(c.original_image_url);
    const resized = str(c.resized_image_url);
    if (sd || hd) {
      video_count += 1;
      note(sd);
      note(hd);
    } else if (original || resized) {
      image_count += 1;
      note(original);
      note(resized);
    }
  }
  return { image_count, video_count, first_url };
}

function summarize(snapshot: Record<string, unknown>, truncated: string[] = []): LibraryMediaSummary {
  const { image_count, video_count, first_url } = countMedia(snapshot);
  return {
    display_format: capEnum(str(snapshot.display_format), "display_format", truncated),
    image_count,
    video_count,
    has_video: video_count > 0,
    expires_at: fbcdnExpiresAt(first_url),
  };
}

/** Builds at most max items, stopping as soon as one more valid item would exceed the cap. */
/**
 * Builds at most max items, stopping as soon as one more valid item would
 * exceed the cap. The builder receives the raw index and the position the
 * item will take in the compacted output.
 */
function takeMedia<T>(raw: unknown[], build: (record: Record<string, unknown>, rawIndex: number, position: number) => T | null, max: number, label: string, truncated: string[]): T[] {
  const out: T[] = [];
  for (let index = 0; index < raw.length; index++) {
    const record = raw[index];
    if (!isRecord(record)) continue;
    if (out.length >= max) {
      truncated.push(label);
      break;
    }
    const built = build(record, index, out.length);
    if (built !== null) out.push(built);
  }
  return out;
}

function collectMedia(snapshot: Record<string, unknown>, truncated: string[]): { images: LibraryImage[]; videos: LibraryVideo[]; cards: LibraryCard[] } {
  // Images have no selector contract, so the walk itself is bounded: a record
  // full of unusable entries must not turn into thousands of omission notes.
  const images: LibraryImage[] = [];
  const rawImages = asArray(snapshot.images);
  let imagesCut = false;
  let imageDropNotes = 0;
  let inspected = 0;
  for (let index = 0; index < rawImages.length; index++) {
    const record = rawImages[index];
    // Entries that are not objects cost nothing, so they do not spend the budget.
    if (!isRecord(record)) continue;
    if (images.length >= MAX_MEDIA_ITEMS || inspected >= MAX_MEDIA_SCANNED) {
      imagesCut = true;
      break;
    }
    inspected += 1;
    const notes: string[] = [];
    const built = image(record, "images[" + images.length + "]", notes);
    if (built) {
      for (const note of notes) truncated.push(note);
      images.push(built);
      continue;
    }
    // Labelled by raw index: the surviving images have shifted up.
    if (notes.length > 0 && imageDropNotes < MAX_MEDIA_DROP_NOTES) {
      truncated.push("images[raw " + index + "] dropped (urls too long)");
      imageDropNotes += 1;
    }
  }
  if (imagesCut) truncated.push("images");
  // Every addressable video gets a selector = its position in the record video
  // order (top-level videos, then video cards), the same walk libraryVideoAt
  // does with the same predicate, so video_index means the same thing on both
  // paths regardless of the presentation caps.
  let selector = 0;
  const videos: LibraryVideo[] = [];
  const rawVideos = asArray(snapshot.videos);
  let beyondCap = false;
  let dropNotes = 0;
  for (let index = 0; index < rawVideos.length; index++) {
    const record = rawVideos[index];
    if (!isRecord(record)) continue;
    const { addressable, dropped } = classifyVideo(record);
    if (!addressable) {
      // Labelled by raw index: the surviving videos have shifted, and each one
      // carries its own omissions in omitted_urls.
      if (dropped && dropNotes < MAX_MEDIA_DROP_NOTES) {
        truncated.push("videos[raw " + index + "] dropped (renditions too long)");
        dropNotes += 1;
      }
      continue;
    }
    const position = selector++;
    if (videos.length >= MAX_MEDIA_ITEMS) {
      beyondCap = true;
      continue;
    }
    const candidate = video(record);
    if (!candidate.video) continue;
    candidate.video.selector = position;
    for (const note of candidate.omitted) truncated.push("videos[" + videos.length + "]." + note);
    videos.push(candidate.video);
  }
  if (beyondCap) truncated.push("videos");
  const cards = takeMedia(asArray(snapshot.cards), (r, i) => {
    const c = card(r, i, truncated);
    if (c.video) c.video.selector = selector++;
    return c;
  }, MAX_CARDS, "cards", truncated);
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
    if (raw[key] !== undefined && raw[key] !== null) details[key] = boundedClone(raw[key], DETAIL_BOUNDS);
  }
  let scanned = 0;
  for (const key in raw) {
    if (++scanned > MAX_TOP_LEVEL_KEYS_SCANNED || Object.keys(details).length >= MAX_DETAIL_BLOCKS) break;
    if (UNSAFE_KEYS.has(key) || key.length > MAX_DETAIL_KEY_CHARS || !Object.prototype.hasOwnProperty.call(raw, key)) continue;
    if (key.endsWith("_transparency") && raw[key] !== null && raw[key] !== undefined) details[key] = boundedClone(raw[key], DETAIL_BOUNDS);
  }
  const body = capText(text(snapshot.body, () => truncated.push("copy.body")), "copy.body", truncated);
  const title = capText(str(snapshot.title), "copy.title", truncated);
  const linkDescription = capText(str(snapshot.link_description), "copy.link_description", truncated);

  return {
    ad_archive_id: id,
    offset,
    ad_library_url: urlOrNull(raw.ad_library_url, "ad_library_url", truncated) ?? "https://www.facebook.com/ads/library/?id=" + id,
    page: {
      id: str(raw.page_id) ?? str(snapshot.page_id) ?? str(raw.pageID),
      name: capText(str(raw.page_name) ?? str(snapshot.page_name) ?? str(raw.pageName), "page.name", truncated),
      profile_uri: urlOrNull(snapshot.page_profile_uri, "page.profile_uri", truncated),
      profile_picture_url: urlOrNull(snapshot.page_profile_picture_url, "page.profile_picture_url", truncated),
      categories: strings(snapshot.page_categories, "page.categories", truncated),
      like_count: num(snapshot.page_like_count),
      is_deleted: bool(raw.page_is_deleted) ?? bool(snapshot.page_is_deleted),
    },
    is_active: bool(raw.is_active),
    start_date: isoDate(raw.start_date),
    end_date: isoDate(raw.end_date),
    publisher_platforms: strings(raw.publisher_platform, "publisher_platforms", truncated),
    display_format: capEnum(str(snapshot.display_format), "display_format", truncated),
    copy: {
      body,
      title,
      caption: capText(str(snapshot.caption), "copy.caption", truncated),
      link_description: linkDescription,
      cta_text: capText(str(snapshot.cta_text), "copy.cta_text", truncated),
      cta_type: capEnum(str(snapshot.cta_type), "copy.cta_type", truncated),
      link_url: urlOrNull(snapshot.link_url, "copy.link_url", truncated),
      byline: capText(str(snapshot.byline), "copy.byline", truncated),
      is_template: isTemplateCopy(body) || isTemplateCopy(title) || isTemplateCopy(linkDescription),
    },
    cards,
    images,
    videos,
    extra_texts: capList(asArray(snapshot.extra_texts), MAX_EXTRA_ITEMS, "extra_texts", truncated),
    extra_links: capList(asArray(snapshot.extra_links), MAX_EXTRA_ITEMS, "extra_links", truncated),
    impressions_text: capText(str(impressions.impressions_text), "impressions_text", truncated),
    // Delivery data is opaque and tenant-controlled: bounded here so later stages never touch the raw object.
    spend: raw.spend === undefined ? null : boundedClone(raw.spend, DELIVERY_DATA_BOUNDS),
    currency: capEnum(str(raw.currency), "currency", truncated),
    reach_estimate: raw.reach_estimate === undefined ? null : boundedClone(raw.reach_estimate, DELIVERY_DATA_BOUNDS),
    collation_count: num(raw.collation_count),
    total_active_time: num(raw.total_active_time),
    contains_digital_created_media: bool(raw.contains_digital_created_media),
    details: Object.keys(details).length > 0 ? details : undefined,
    media_summary: {
      // The same fields are capped above; the note is recorded there once.
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

const MAX_LABEL_PAGE_CHARS = 120;

function buildLibrarySource(adId: string, pageName: string | null, v: LibraryVideo, index: number): VideoSource {
  const page = pageName ? pageName.slice(0, MAX_LABEL_PAGE_CHARS) : "";
  const omitted = v.omitted_urls ?? [];
  return {
    key: "library:" + adId + ":video:" + index,
    label: "Video " + index + " of Ad Library ad " + adId + (page ? " — " + page : ""),
    origin: "ad_library",
    ad_archive_id: adId,
    card_index: index,
    source_url: v.hd_url ?? v.sd_url ?? undefined,
    low_res_url: v.sd_url ?? undefined,
    thumbnail_url: v.preview_image_url ?? undefined,
    error: omitted.length > 0 ? "Rendition URL(s) omitted as too long: " + omitted.join(", ") + "; using the remaining rendition(s)." : undefined,
  };
}

/**
 * Video sources for the delivery pipeline: HD as source, SD as the preferred
 * download, preview as thumbnail. The index is the video selector, so it is
 * the value video_index accepts and it matches libraryVideoAt exactly.
 */
export function extractLibraryVideoSources(ad: LibraryAd): VideoSource[] {
  const sources = ad.videos.map((v, i) => buildLibrarySource(ad.ad_archive_id, ad.page.name, v, v.selector ?? i));
  for (const c of ad.cards) {
    if (!c.video) continue;
    sources.push(buildLibrarySource(ad.ad_archive_id, ad.page.name, c.video, c.video.selector ?? c.index));
  }
  return sources;
}

/**
 * Addresses the n-th video of a raw record (top-level videos first, then
 * video cards, in order) without materializing the capped collections, so a
 * caller can reach videos beyond the presentation caps. Same walk and same
 * selector arithmetic as collectMedia.
 */
export function libraryVideoAt(raw: AdLibraryRawItem, index: number): VideoSource | undefined {
  const adId = archiveIdOf(raw) ?? "";
  const snapshot = asRecord(raw.snapshot);
  const pageName = str(raw.page_name) ?? str(snapshot.page_name) ?? str(raw.pageName);
  let selector = 0;
  for (const list of [asArray(snapshot.videos), asArray(snapshot.cards)]) {
    for (const record of list) {
      if (!isRecord(record) || !classifyVideo(record).addressable) continue;
      if (selector === index) {
        const built = video(record).video;
        return built ? buildLibrarySource(adId, pageName, built, selector) : undefined;
      }
      selector += 1;
    }
  }
  return undefined;
}
