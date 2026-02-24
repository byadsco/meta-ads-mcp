export interface AdsPixel {
  id: string;
  name: string;
  code?: string;
  creation_time?: string;
  last_fired_time?: string;
  is_created_by_app?: boolean;
  owner_ad_account?: { account_id: string; name?: string };
}

export interface PixelEvent {
  event: string;
  count: number;
  value?: number;
}

export interface PixelStats {
  aggregation: string;
  timestamp: string;
  data: PixelEvent[];
}

export interface CustomConversion {
  id: string;
  name: string;
  description?: string;
  pixel?: { id: string };
  rule?: string;
  custom_event_type?: string;
  default_conversion_value?: number;
  event_source_type?: string;
  retention_days?: number;
  creation_time?: string;
}

export const PIXEL_DEFAULT_FIELDS = [
  "id",
  "name",
  "code",
  "creation_time",
  "last_fired_time",
  "is_created_by_app",
  "owner_ad_account",
] as const;

export const CUSTOM_CONVERSION_DEFAULT_FIELDS = [
  "id",
  "name",
  "description",
  "pixel",
  "rule",
  "custom_event_type",
  "default_conversion_value",
  "event_source_type",
  "retention_days",
  "creation_time",
] as const;
