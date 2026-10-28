// Call-to-action types documented for AdCreativeLinkDataCallToAction (Marketing
// API v26.0, read 2026-10-26), plus SEND_MESSAGE, which earlier versions of
// this server accepted, and INSTAGRAM_MESSAGE, which Meta accepted for an
// Instagram Direct ad on 2026-10-27.
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
  "SEND_MESSAGE", "INSTAGRAM_MESSAGE",
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

// Where the ad's button takes people. Each shape is what Meta accepted on
// v26.0 (see docs/meta-creative-ground-truth.md); the website is the default.
export type Destination =
  | { type: "website" }
  | { type: "lead_form"; leadFormId: string }
  | { type: "messenger"; welcomeMessage?: string; iceBreakers?: Array<{ question: string; response: string }> }
  | { type: "whatsapp" }
  | { type: "instagram_direct" }
  | { type: "call"; phoneNumber: string };

export const PHONE_NUMBER_PATTERN = /^\+[1-9]\d{6,14}$/;

export interface CardInput {
  imageHash?: string;
  imageUrl?: string;
  videoId?: string;
  linkUrl?: string;
  headline?: string;
  description?: string;
  callToActionType?: string;
}

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
  destination?: Destination;
  // The link text shown under the media (link_data.caption).
  displayLink?: string;
  cards?: CardInput[];
  multiShareOptimized?: boolean;
  multiShareEndCard?: boolean;
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

// Texts are compared trimmed but sent as given, so single-text callers keep
// exactly the body they sent before.
function dedupe(texts: string[], label: string, warnings: string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const text of texts) {
    const key = text.trim();
    if (key === "") {
      warnings.push(`Dropped a blank ${label}.`);
      continue;
    }
    if (seen.has(key)) {
      warnings.push(`Dropped a repeated ${label} ("${key}"): Meta rejects duplicates.`);
      continue;
    }
    seen.add(key);
    kept.push(text);
  }
  return kept;
}

export const MAX_HEADLINE_LENGTH = 255;

// Rules Meta enforces on a DEGREES_OF_FREEDOM feed (measured on v26.0, see
// docs/meta-creative-ground-truth.md). Returns the first problem, if any.
export function dofFeedProblem(feed: {
  bodies?: Array<{ text: string }>;
  titles?: Array<{ text: string }>;
  descriptions?: Array<{ text: string }>;
}): string | undefined {
  const fields = [["bodies", feed.bodies ?? []], ["titles", feed.titles ?? []], ["descriptions", feed.descriptions ?? []]] as const;
  for (const [name, items] of fields) {
    const keys = items.map((item) => item.text.trim());
    if (keys.some((key) => key === "")) return `asset_feed_spec.${name} has a blank text.`;
    if (new Set(keys).size !== keys.length) return `asset_feed_spec.${name} repeats a text; Meta rejects duplicates.`;
  }
  if ((feed.titles ?? []).some((title) => title.text.length > MAX_HEADLINE_LENGTH)) {
    return `asset_feed_spec.titles has a title over ${MAX_HEADLINE_LENGTH} characters.`;
  }
  if (!fields.some(([, items]) => items.length > 1)) {
    return "a DEGREES_OF_FREEDOM feed needs at least one field with two or more texts; with one text of each kind, put the copy in object_story_spec.";
  }
  return undefined;
}

function warnLength(texts: string[], label: string, limit: number, warnings: string[]): void {
  const long = texts.filter((text) => text.length > limit).length;
  if (long > 0) {
    warnings.push(`${long} ${label}(s) exceed ${limit} characters; most placements truncate them.`);
  }
}

// The link and button value each destination needs. Messaging and lead ads
// carry Meta's own placeholder link, so the ad's link_url does not apply.
function destinationTarget(input: StorySpecInput): { link?: string; ctaType?: string; ctaValue?: Record<string, unknown>; extra: Record<string, unknown> } {
  const destination = input.destination ?? { type: "website" };
  const fixedLink = (link: string) => {
    if (input.linkUrl !== undefined) throw new Error(`link_url does not apply to a ${destination.type} destination: Meta sets that ad's link itself.`);
    return link;
  };
  switch (destination.type) {
    case "website":
      return { link: input.linkUrl, ctaType: input.callToActionType, ctaValue: input.linkUrl ? { link: input.linkUrl } : undefined, extra: {} };
    case "lead_form":
      return { link: fixedLink("http://fb.me/"), ctaType: input.callToActionType ?? "SIGN_UP", ctaValue: { lead_gen_form_id: destination.leadFormId }, extra: {} };
    case "messenger": {
      const extra: Record<string, unknown> = {};
      if (destination.iceBreakers?.length && !destination.welcomeMessage) {
        throw new Error("Messenger ice_breakers need a welcome_message to show with them.");
      }
      if (destination.welcomeMessage) {
        extra.page_welcome_message = JSON.stringify({
          type: "VISUAL_EDITOR",
          version: 2,
          landing_screen_type: "welcome_message",
          media_type: "text",
          text_format: {
            customer_action_type: "ice_breakers",
            message: {
              ice_breakers: (destination.iceBreakers ?? []).map((b) => ({ title: b.question, response: b.response })),
              quick_replies: [],
              text: destination.welcomeMessage,
            },
          },
          user_edit: false,
          surface: "visual_editor_new",
        });
      }
      return { link: fixedLink("https://fb.com/messenger_doc/"), ctaType: input.callToActionType ?? "MESSAGE_PAGE", ctaValue: { app_destination: "MESSENGER" }, extra };
    }
    case "whatsapp":
      return { link: fixedLink("https://api.whatsapp.com/send"), ctaType: input.callToActionType ?? "WHATSAPP_MESSAGE", ctaValue: { app_destination: "WHATSAPP" }, extra: {} };
    case "instagram_direct":
      if (!input.instagramUserId) throw new Error("An Instagram Direct destination needs the Instagram account (instagram_actor_id) the messages go to.");
      return { link: fixedLink("https://www.instagram.com"), ctaType: input.callToActionType ?? "INSTAGRAM_MESSAGE", ctaValue: { app_destination: "INSTAGRAM_DIRECT" }, extra: {} };
    case "call":
      if (!PHONE_NUMBER_PATTERN.test(destination.phoneNumber)) {
        throw new Error("phone_number must be in international format: + and the country code, then the number, digits only (e.g. +573001234567).");
      }
      if (!input.linkUrl) throw new Error("A call destination still needs the ad's link_url: Meta requires a link on the ad.");
      return { link: input.linkUrl, ctaType: input.callToActionType ?? "CALL_NOW", ctaValue: { link: `tel:${destination.phoneNumber}` }, extra: {} };
  }
}

function buildCards(input: StorySpecInput, defaultCta: string | undefined): Record<string, unknown>[] {
  const cards = input.cards ?? [];
  if (cards.length < 2 || cards.length > 10) throw new Error("A carousel takes 2 to 10 cards; Meta refuses a single one.");
  if (input.imageHash || input.imageUrl || input.videoId) {
    throw new Error("In a carousel, image_hash, image_url and video_id belong on the cards, not on the ad.");
  }
  if (input.headlines.length > 0 || input.descriptions.length > 0) {
    throw new Error("In a carousel, each card has its own headline and description: set them on the cards.");
  }
  if ((input.destination?.type ?? "website") !== "website") {
    throw new Error("A carousel here takes a website destination: each card links to a page.");
  }
  if (!input.linkUrl) throw new Error("A carousel needs link_url: the link of its last card and of cards without their own.");
  return cards.map((card, i) => {
    if (!card.imageHash && !card.imageUrl && !card.videoId) throw new Error(`cards[${i}] needs an image (image_hash or image_url) or a video.`);
    if (card.videoId && !card.imageHash && !card.imageUrl) throw new Error(`cards[${i}] is a video and needs a thumbnail (image_hash or image_url).`);
    const link = card.linkUrl ?? input.linkUrl!;
    const out: Record<string, unknown> = {};
    if (card.videoId) out.video_id = card.videoId;
    if (card.imageHash) out.image_hash = card.imageHash;
    else if (card.imageUrl) out.picture = card.imageUrl;
    out.link = link;
    if (card.headline) out.name = card.headline;
    if (card.description) out.description = card.description;
    const ctaType = card.callToActionType ?? defaultCta;
    if (ctaType) out.call_to_action = { type: ctaType, value: { link } };
    return out;
  });
}

// Ads Manager keeps several texts per ad in an asset feed with
// optimization_type DEGREES_OF_FREEDOM, leaving the copy out of
// object_story_spec. Meta rejects such a feed when every field has a single
// entry, so one text of each kind stays in link_data / video_data.
export function buildStorySpec(input: StorySpecInput): StorySpec {
  if (input.videoId && !input.imageHash && !input.imageUrl) {
    throw new Error("video creatives built from scratch require image_hash or image_url as a thumbnail.");
  }
  const carousel = input.cards !== undefined;
  if (!carousel && (input.multiShareOptimized !== undefined || input.multiShareEndCard !== undefined)) {
    throw new Error("multi_share_optimized and multi_share_end_card apply only to a carousel (cards).");
  }
  if (input.displayLink !== undefined && input.videoId) throw new Error("display_link applies to image and carousel ads, not to video.");
  const target = destinationTarget(input);
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

  if (carousel) {
    const linkData: Record<string, unknown> = { link: input.linkUrl };
    const childAttachments = buildCards(input, input.callToActionType);
    if (!multiText && primaryTexts[0]) linkData.message = primaryTexts[0];
    if (input.displayLink !== undefined) linkData.caption = input.displayLink;
    if (input.multiShareOptimized !== undefined) linkData.multi_share_optimized = input.multiShareOptimized;
    if (input.multiShareEndCard !== undefined) linkData.multi_share_end_card = input.multiShareEndCard;
    linkData.child_attachments = childAttachments;
    objectStorySpec.link_data = linkData;
  } else if (input.videoId) {
    const videoData: Record<string, unknown> = { video_id: input.videoId };
    if (input.imageHash) videoData.image_hash = input.imageHash;
    else if (input.imageUrl) videoData.image_url = input.imageUrl;
    if (!multiText) {
      if (primaryTexts[0]) videoData.message = primaryTexts[0];
      if (headlines[0]) videoData.title = headlines[0];
      if (descriptions[0]) videoData.link_description = descriptions[0];
    }
    // A video carries its destination only in its button.
    if (target.ctaType || target.ctaValue) {
      videoData.call_to_action = { type: target.ctaType ?? "LEARN_MORE", value: target.ctaValue };
    }
    Object.assign(videoData, target.extra);
    objectStorySpec.video_data = videoData;
  } else {
    const linkData: Record<string, unknown> = {};
    if (input.imageHash) linkData.image_hash = input.imageHash;
    else if (input.imageUrl) linkData.picture = input.imageUrl;
    if (target.link) linkData.link = target.link;
    if (!multiText) {
      if (primaryTexts[0]) linkData.message = primaryTexts[0];
      if (headlines[0]) linkData.name = headlines[0];
      if (descriptions[0]) linkData.description = descriptions[0];
    }
    if (input.displayLink !== undefined) linkData.caption = input.displayLink;
    if (target.ctaType) linkData.call_to_action = { type: target.ctaType, value: target.ctaValue };
    Object.assign(linkData, target.extra);
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
