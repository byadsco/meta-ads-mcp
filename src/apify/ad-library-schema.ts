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
}

const DETAIL_KEYS = ["advertiser", "aaa_info", "insights", "violation_types", "finserv_data", "regional_regulation_data"];
const TEMPLATE_PATTERN = /\{\{\s*[a-z_]+\.[a-z_.]+\s*\}\}/i;

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

/** The actor returns some copy fields as { text } objects and others as plain strings. */
function text(value: unknown): string | null {
  if (value && typeof value === "object" && "text" in (value as Record<string, unknown>)) {
    return str((value as Record<string, unknown>).text);
  }
  return str(value);
}

function isoDate(epochSeconds: unknown): string | null {
  const n = num(epochSeconds);
  if (n === null || n <= 0) return null;
  return new Date(n * 1000).toISOString().slice(0, 10);
}

function strings(value: unknown): string[] {
  return asArray(value).map(str).filter((s): s is string => s !== null);
}

export function isAdLibraryErrorItem(item: unknown): boolean {
  const record = asRecord(item);
  return typeof record.error === "string" || str(record.ad_archive_id) === null;
}

export function isTemplateCopy(value: string | null | undefined): boolean {
  return typeof value === "string" && TEMPLATE_PATTERN.test(value);
}

function image(record: Record<string, unknown>): LibraryImage | null {
  const original_url = str(record.original_image_url);
  const resized_url = str(record.resized_image_url);
  return original_url || resized_url ? { original_url, resized_url } : null;
}

function video(record: Record<string, unknown>): LibraryVideo | null {
  const hd_url = str(record.video_hd_url);
  const sd_url = str(record.video_sd_url);
  const preview_image_url = str(record.video_preview_image_url);
  return hd_url || sd_url ? { hd_url, sd_url, preview_image_url } : null;
}

function card(record: Record<string, unknown>, index: number): LibraryCard {
  return {
    index,
    body: text(record.body),
    title: str(record.title),
    caption: str(record.caption),
    link_description: str(record.link_description),
    link_url: str(record.link_url),
    cta_text: str(record.cta_text),
    cta_type: str(record.cta_type),
    image: image(record),
    video: video(record),
  };
}

function firstMediaUrl(images: LibraryImage[], videos: LibraryVideo[], cards: LibraryCard[]): string | undefined {
  for (const v of videos) {
    const url = v.sd_url ?? v.hd_url ?? v.preview_image_url;
    if (url) return url;
  }
  for (const i of images) {
    const url = i.original_url ?? i.resized_url;
    if (url) return url;
  }
  for (const c of cards) {
    const url = c.video?.sd_url ?? c.video?.hd_url ?? c.image?.original_url ?? c.image?.resized_url;
    if (url) return url;
  }
  return undefined;
}

function summarize(displayFormat: string | null, images: LibraryImage[], videos: LibraryVideo[], cards: LibraryCard[]): LibraryMediaSummary {
  const image_count = images.length + cards.filter((c) => c.image !== null && c.video === null).length;
  const video_count = videos.length + cards.filter((c) => c.video !== null).length;
  return {
    display_format: displayFormat,
    image_count,
    video_count,
    has_video: video_count > 0,
    expires_at: fbcdnExpiresAt(firstMediaUrl(images, videos, cards)),
  };
}

function collectMedia(snapshot: Record<string, unknown>): { images: LibraryImage[]; videos: LibraryVideo[]; cards: LibraryCard[] } {
  const images = asArray(snapshot.images).map((i) => image(asRecord(i))).filter((i): i is LibraryImage => i !== null);
  const videos = asArray(snapshot.videos).map((v) => video(asRecord(v))).filter((v): v is LibraryVideo => v !== null);
  const cards = asArray(snapshot.cards).map((c, index) => card(asRecord(c), index));
  return { images, videos, cards };
}

/** Cheap projection for listings: enough to decide whether an ad deserves ads_library_get_ad_details. */
export function mediaSummary(raw: AdLibraryRawItem): LibraryMediaSummary {
  const snapshot = asRecord(raw.snapshot);
  const { images, videos, cards } = collectMedia(snapshot);
  return summarize(str(snapshot.display_format), images, videos, cards);
}

export function normalizeLibraryAd(raw: AdLibraryRawItem, offset: number | null): LibraryAd {
  const snapshot = asRecord(raw.snapshot);
  const id = str(raw.ad_archive_id) ?? "";
  const { images, videos, cards } = collectMedia(snapshot);
  const impressions = asRecord(raw.impressions_with_index);
  const details: Record<string, unknown> = {};
  for (const key of DETAIL_KEYS) {
    if (raw[key] !== undefined && raw[key] !== null) details[key] = raw[key];
  }
  for (const key of Object.keys(raw)) {
    if (key.endsWith("_transparency") && raw[key] !== null) details[key] = raw[key];
  }
  const body = text(snapshot.body);
  const title = str(snapshot.title);
  const linkDescription = str(snapshot.link_description);

  return {
    ad_archive_id: id,
    offset,
    ad_library_url: str(raw.ad_library_url) ?? "https://www.facebook.com/ads/library/?id=" + id,
    page: {
      id: str(raw.page_id) ?? str(snapshot.page_id),
      name: str(raw.page_name) ?? str(snapshot.page_name),
      profile_uri: str(snapshot.page_profile_uri),
      profile_picture_url: str(snapshot.page_profile_picture_url),
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
      caption: str(snapshot.caption),
      link_description: linkDescription,
      cta_text: str(snapshot.cta_text),
      cta_type: str(snapshot.cta_type),
      link_url: str(snapshot.link_url),
      byline: str(snapshot.byline),
      is_template: isTemplateCopy(body) || isTemplateCopy(title) || isTemplateCopy(linkDescription),
    },
    cards,
    images,
    videos,
    extra_texts: asArray(snapshot.extra_texts),
    extra_links: asArray(snapshot.extra_links),
    impressions_text: str(impressions.impressions_text),
    spend: raw.spend ?? null,
    currency: str(raw.currency),
    reach_estimate: raw.reach_estimate ?? null,
    collation_count: num(raw.collation_count),
    total_active_time: num(raw.total_active_time),
    contains_digital_created_media: bool(raw.contains_digital_created_media),
    details: Object.keys(details).length > 0 ? details : undefined,
    media_summary: summarize(str(snapshot.display_format), images, videos, cards),
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

/** Video sources for the delivery pipeline: HD as source, SD as the preferred download, preview as thumbnail. */
export function extractLibraryVideoSources(ad: LibraryAd): VideoSource[] {
  const pageName = ad.page.name ? " — " + ad.page.name : "";
  const build = (v: LibraryVideo, index: number): VideoSource => ({
    key: "library:" + ad.ad_archive_id + ":video:" + index,
    label: "Video " + index + " of Ad Library ad " + ad.ad_archive_id + pageName,
    origin: "ad_library",
    ad_archive_id: ad.ad_archive_id,
    card_index: index,
    source_url: v.hd_url ?? v.sd_url ?? undefined,
    low_res_url: v.sd_url ?? undefined,
    thumbnail_url: v.preview_image_url ?? undefined,
  });
  const sources = ad.videos.map((v, i) => build(v, i));
  for (const c of ad.cards) {
    if (!c.video) continue;
    // Top-level videos and video cards never coexist in real records; offset the
    // card index only when they do, so keys and resource URIs stay unique.
    sources.push(build(c.video, ad.videos.length > 0 ? ad.videos.length + c.index : c.index));
  }
  return sources;
}
