// Call-to-action types documented for AdCreativeLinkDataCallToAction (Marketing
// API v26.0, read 2026-10-26), plus SEND_MESSAGE, which earlier versions of
// this server accepted.
export const CTA_TYPES = [
  "OPEN_LINK", "LIKE_PAGE", "SHOP_NOW", "PLAY_GAME", "INSTALL_APP", "USE_APP", "CALL", "CALL_ME",
  "VIDEO_CALL", "INSTALL_MOBILE_APP", "USE_MOBILE_APP", "MOBILE_DOWNLOAD", "BOOK_TRAVEL", "LISTEN_MUSIC",
  "WATCH_VIDEO", "LEARN_MORE", "SIGN_UP", "DOWNLOAD", "WATCH_MORE", "NO_BUTTON", "VISIT_PAGES_FEED",
  "CALL_NOW", "APPLY_NOW", "CONTACT", "BUY_NOW", "GET_OFFER", "GET_OFFER_VIEW", "BUY_TICKETS",
  "UPDATE_APP", "GET_DIRECTIONS", "BUY", "SEND_UPDATES", "MESSAGE_PAGE", "DONATE", "SUBSCRIBE",
  "SAY_THANKS", "SELL_NOW", "SHARE", "DONATE_NOW", "GET_QUOTE", "CONTACT_US", "ORDER_NOW",
  "START_ORDER", "ADD_TO_CART", "VIEW_CART", "VIEW_IN_CART", "VIDEO_ANNOTATION", "RECORD_NOW",
  "INQUIRE_NOW", "CONFIRM", "REFER_FRIENDS", "REQUEST_TIME", "GET_SHOWTIMES", "LISTEN_NOW", "TRY_DEMO",
  "WOODHENGE_SUPPORT", "SOTTO_SUBSCRIBE", "FOLLOW_USER", "RAISE_MONEY", "SEE_SHOP", "GET_DETAILS",
  "FIND_OUT_MORE", "VISIT_WEBSITE", "BROWSE_SHOP", "EVENT_RSVP", "WHATSAPP_MESSAGE",
  "FOLLOW_NEWS_STORYLINE", "SEE_MORE", "BOOK_NOW", "FIND_A_GROUP", "FIND_YOUR_GROUPS", "PAY_TO_ACCESS",
  "PURCHASE_GIFT_CARDS", "FOLLOW_PAGE", "SEND_A_GIFT", "SWIPE_UP_SHOP", "SWIPE_UP_PRODUCT",
  "SEND_GIFT_MONEY", "PLAY_GAME_ON_FACEBOOK", "GET_STARTED", "OPEN_INSTANT_APP", "AUDIO_CALL",
  "GET_PROMOTIONS", "JOIN_CHANNEL", "MAKE_AN_APPOINTMENT", "ASK_ABOUT_SERVICES", "BOOK_A_CONSULTATION",
  "GET_A_QUOTE", "BUY_VIA_MESSAGE", "ASK_FOR_MORE_INFO", "CHAT_WITH_US", "VIEW_PRODUCT", "VIEW_CHANNEL",
  "GET_IN_TOUCH", "ASK_A_QUESTION", "START_A_CHAT", "CHAT_NOW", "ASK_US", "WATCH_LIVE_VIDEO",
  "JOIN_LIVE_VIDEO", "SHOP_WITH_AI", "TRY_ON_WITH_AI", "WATCH_NOW", "STREAM_NOW", "BUY_ACTIVITY_TICKETS",
  "SEND_MESSAGE",
] as const;

// Individual Advantage+ creative features documented in "Advantage+ creative —
// get started" (v26.0, read 2026-10-26). Meta accepted an explicit OPT_OUT for
// all of them in a live check on that date.
export const ADVANTAGE_CREATIVE_FEATURES = [
  "adapt_to_placement", "add_text_overlay", "creative_stickers", "description_automation", "enhance_cta",
  "image_animation", "image_background_gen", "image_brightness_and_contrast", "image_templates",
  "image_text_translation", "image_touchups", "image_uncrop", "inline_comment", "media_type_automation",
  "pac_relaxation", "product_extensions", "reveal_details_over_time", "text_optimizations",
  "text_translation", "translate_voiceover", "video_auto_crop", "video_filtering", "video_uncrop",
] as const;

export const FEATURE_NAME_PATTERN = /^[a-z0-9_]+$/;

// Meta deprecated it in v22.0 and rejects it in any form (subcode 3858504),
// even though creatives built before then still report it.
export const DEPRECATED_FEATURES = ["standard_enhancements"] as const;

// What most placements show before truncating behind "See more".
const DISPLAY_LIMITS = { primary: 125, headline: 40, description: 30 };

export type EnrollStatus = "OPT_IN" | "OPT_OUT";

export interface StorySpecInput {
  pageId: string;
  instagramUserId?: string;
  imageHash?: string;
  imageUrl?: string;
  videoId?: string;
  linkUrl?: string;
  primaryTexts: string[];
  headlines: string[];
  descriptions: string[];
  callToActionType?: string;
}

export interface StorySpec {
  objectStorySpec: Record<string, unknown>;
  assetFeedSpec?: Record<string, unknown>;
  warnings: string[];
}

export interface FeatureSpec {
  degrees_of_freedom_spec: { creative_features_spec: Record<string, { enroll_status: EnrollStatus }> };
  contextual_multi_ads: { enroll_status: EnrollStatus };
}

function dedupe(texts: string[], label: string, warnings: string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const text of texts) {
    const key = text.trim();
    if (seen.has(key)) {
      warnings.push(`Dropped a repeated ${label} ("${key}"): Meta rejects duplicates.`);
      continue;
    }
    seen.add(key);
    kept.push(key);
  }
  return kept;
}

function warnLength(texts: string[], label: string, limit: number, warnings: string[]): void {
  const long = texts.filter((text) => text.length > limit).length;
  if (long > 0) {
    warnings.push(`${long} ${label}(s) exceed ${limit} characters; most placements truncate them.`);
  }
}

// Ads Manager keeps several texts per ad in an asset feed with
// optimization_type DEGREES_OF_FREEDOM, leaving the copy out of
// object_story_spec. Meta rejects such a feed when every field has a single
// entry, so one text of each kind stays in link_data / video_data.
export function buildStorySpec(input: StorySpecInput): StorySpec {
  const warnings: string[] = [];
  const primaryTexts = dedupe(input.primaryTexts, "primary text", warnings);
  const headlines = dedupe(input.headlines, "headline", warnings);
  const descriptions = dedupe(input.descriptions, "description", warnings);
  warnLength(primaryTexts, "primary text", DISPLAY_LIMITS.primary, warnings);
  warnLength(headlines, "headline", DISPLAY_LIMITS.headline, warnings);
  warnLength(descriptions, "description", DISPLAY_LIMITS.description, warnings);

  const multiText = [primaryTexts, headlines, descriptions].some((texts) => texts.length > 1);
  const objectStorySpec: Record<string, unknown> = { page_id: input.pageId };
  if (input.instagramUserId) objectStorySpec.instagram_user_id = input.instagramUserId;

  if (input.videoId) {
    const videoData: Record<string, unknown> = { video_id: input.videoId };
    if (input.imageHash) videoData.image_hash = input.imageHash;
    else if (input.imageUrl) videoData.image_url = input.imageUrl;
    if (!multiText) {
      if (primaryTexts[0]) videoData.message = primaryTexts[0];
      if (headlines[0]) videoData.title = headlines[0];
      if (descriptions[0]) videoData.link_description = descriptions[0];
    }
    if (input.callToActionType || input.linkUrl) {
      videoData.call_to_action = {
        type: input.callToActionType ?? "LEARN_MORE",
        value: input.linkUrl ? { link: input.linkUrl } : undefined,
      };
    }
    objectStorySpec.video_data = videoData;
  } else {
    const linkData: Record<string, unknown> = {};
    if (input.imageHash) linkData.image_hash = input.imageHash;
    else if (input.imageUrl) linkData.picture = input.imageUrl;
    if (input.linkUrl) linkData.link = input.linkUrl;
    if (!multiText) {
      if (primaryTexts[0]) linkData.message = primaryTexts[0];
      if (headlines[0]) linkData.name = headlines[0];
      if (descriptions[0]) linkData.description = descriptions[0];
    }
    if (input.callToActionType) {
      linkData.call_to_action = {
        type: input.callToActionType,
        value: input.linkUrl ? { link: input.linkUrl } : undefined,
      };
    }
    objectStorySpec.link_data = linkData;
  }

  if (!multiText) return { objectStorySpec, warnings };

  const assetFeedSpec: Record<string, unknown> = {};
  if (primaryTexts.length > 0) assetFeedSpec.bodies = primaryTexts.map((text) => ({ text }));
  if (headlines.length > 0) assetFeedSpec.titles = headlines.map((text) => ({ text }));
  if (descriptions.length > 0) assetFeedSpec.descriptions = descriptions.map((text) => ({ text }));
  assetFeedSpec.optimization_type = "DEGREES_OF_FREEDOM";
  return { objectStorySpec, assetFeedSpec, warnings };
}

export function buildFeatureSpec(
  overrides: Record<string, EnrollStatus> = {},
  multiAdvertiserAds = false,
): FeatureSpec {
  const features: Record<string, { enroll_status: EnrollStatus }> = {};
  for (const name of ADVANTAGE_CREATIVE_FEATURES) features[name] = { enroll_status: "OPT_OUT" };

  for (const [name, status] of Object.entries(overrides)) {
    if ((DEPRECATED_FEATURES as readonly string[]).includes(name)) {
      throw new Error(`${name} is deprecated and Meta rejects it: opt into the individual features instead (${ADVANTAGE_CREATIVE_FEATURES.join(", ")}).`);
    }
    if (!FEATURE_NAME_PATTERN.test(name)) {
      throw new Error(`"${name}" is not a valid Advantage+ creative feature name.`);
    }
    features[name] = { enroll_status: status };
  }

  return {
    degrees_of_freedom_spec: { creative_features_spec: features },
    contextual_multi_ads: { enroll_status: multiAdvertiserAds ? "OPT_IN" : "OPT_OUT" },
  };
}
