export type CallToActionType =
  | "LEARN_MORE"
  | "SHOP_NOW"
  | "SIGN_UP"
  | "SUBSCRIBE"
  | "CONTACT_US"
  | "GET_OFFER"
  | "BOOK_TRAVEL"
  | "DOWNLOAD"
  | "APPLY_NOW"
  | "BUY_NOW"
  | "GET_QUOTE"
  | "ORDER_NOW"
  | "WATCH_MORE"
  | "SEND_MESSAGE"
  | "WHATSAPP_MESSAGE";

export interface AdCreative {
  id: string;
  name: string;
  title?: string;
  body?: string;
  image_hash?: string;
  image_url?: string;
  thumbnail_url?: string;
  object_story_spec?: Record<string, unknown>;
  asset_feed_spec?: Record<string, unknown>;
  call_to_action_type?: CallToActionType;
  link_url?: string;
  effective_object_story_id?: string;
  status?: string;
}

export interface ImageUploadResult {
  images: Record<
    string,
    {
      hash: string;
      url: string;
      name?: string;
      width?: number;
      height?: number;
    }
  >;
}

export const CREATIVE_DEFAULT_FIELDS = [
  "id",
  "name",
  "title",
  "body",
  "image_hash",
  "image_url",
  "thumbnail_url",
  "object_story_spec",
  "asset_feed_spec",
  "call_to_action_type",
  "link_url",
  "effective_object_story_id",
  "status",
] as const;
