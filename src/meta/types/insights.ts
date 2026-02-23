export type DatePreset =
  | "today"
  | "yesterday"
  | "this_month"
  | "last_month"
  | "this_quarter"
  | "maximum"
  | "last_3d"
  | "last_7d"
  | "last_14d"
  | "last_28d"
  | "last_30d"
  | "last_90d"
  | "last_week_mon_sun"
  | "last_week_sun_sat"
  | "last_quarter"
  | "last_year"
  | "this_week_mon_today"
  | "this_week_sun_today"
  | "this_year";

export type Breakdown =
  | "age"
  | "gender"
  | "country"
  | "region"
  | "dma"
  | "impression_device"
  | "device_platform"
  | "platform_position"
  | "publisher_platform"
  | "product_id"
  | "frequency_value"
  | "hourly_stats_aggregated_by_advertiser_time_zone"
  | "hourly_stats_aggregated_by_audience_time_zone"
  | "body_asset"
  | "call_to_action_asset"
  | "description_asset"
  | "image_asset"
  | "link_url_asset"
  | "title_asset"
  | "video_asset";

export type AttributionWindow =
  | "1d_click"
  | "7d_click"
  | "1d_view"
  | "28d_click";

export type InsightsLevel = "ad" | "adset" | "campaign" | "account";

export interface ActionValue {
  action_type: string;
  value: string;
  "1d_click"?: string;
  "7d_click"?: string;
  "1d_view"?: string;
  "28d_click"?: string;
}

export interface InsightsResult {
  date_start: string;
  date_stop: string;
  impressions?: string;
  clicks?: string;
  spend?: string;
  reach?: string;
  frequency?: string;
  ctr?: string;
  cpc?: string;
  cpm?: string;
  cpp?: string;
  actions?: ActionValue[];
  cost_per_action_type?: ActionValue[];
  conversions?: ActionValue[];
  cost_per_conversion?: ActionValue[];
  // Breakdown fields (dynamic based on request)
  age?: string;
  gender?: string;
  country?: string;
  publisher_platform?: string;
  device_platform?: string;
  platform_position?: string;
  [key: string]: unknown;
}

export const INSIGHTS_DEFAULT_FIELDS = [
  "impressions",
  "clicks",
  "spend",
  "reach",
  "frequency",
  "ctr",
  "cpc",
  "cpm",
  "actions",
  "cost_per_action_type",
] as const;
