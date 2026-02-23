import type { BidStrategy } from "./campaign.js";

export type AdSetStatus = "ACTIVE" | "PAUSED" | "DELETED" | "ARCHIVED";

export type OptimizationGoal =
  | "NONE"
  | "APP_INSTALLS"
  | "AD_RECALL_LIFT"
  | "ENGAGED_USERS"
  | "EVENT_RESPONSES"
  | "IMPRESSIONS"
  | "LEAD_GENERATION"
  | "QUALITY_LEAD"
  | "LINK_CLICKS"
  | "OFFSITE_CONVERSIONS"
  | "PAGE_LIKES"
  | "POST_ENGAGEMENT"
  | "QUALITY_CALL"
  | "REACH"
  | "LANDING_PAGE_VIEWS"
  | "VISIT_INSTAGRAM_PROFILE"
  | "VALUE"
  | "THRUPLAY"
  | "DERIVED_EVENTS"
  | "APP_INSTALLS_AND_OFFSITE_CONVERSIONS"
  | "CONVERSATIONS"
  | "IN_APP_VALUE"
  | "MESSAGING_PURCHASE_CONVERSION"
  | "MESSAGING_APPOINTMENT_CONVERSION"
  | "SUBSCRIBERS"
  | "REMINDERS_SET";

export type BillingEvent =
  | "IMPRESSIONS"
  | "LINK_CLICKS"
  | "POST_ENGAGEMENT"
  | "THRUPLAY";

export interface GeoLocation {
  countries?: string[];
  regions?: Array<{ key: string }>;
  cities?: Array<{
    key: string;
    radius?: number;
    distance_unit?: string;
  }>;
  zips?: Array<{ key: string }>;
  location_types?: string[];
}

export interface TargetingSpec {
  geo_locations?: GeoLocation;
  excluded_geo_locations?: GeoLocation;
  age_min?: number;
  age_max?: number;
  genders?: number[];
  interests?: Array<{ id: string; name?: string }>;
  behaviors?: Array<{ id: string; name?: string }>;
  custom_audiences?: Array<{ id: string }>;
  excluded_custom_audiences?: Array<{ id: string }>;
  publisher_platforms?: string[];
  facebook_positions?: string[];
  instagram_positions?: string[];
  device_platforms?: string[];
  flexible_spec?: Array<Record<string, unknown>>;
  exclusions?: Record<string, unknown>;
}

export interface FrequencyControlSpec {
  event: "IMPRESSIONS";
  interval_days: number;
  max_frequency: number;
}

export interface AdSet {
  id: string;
  name: string;
  campaign_id: string;
  status: AdSetStatus;
  effective_status: string;
  daily_budget?: string;
  lifetime_budget?: string;
  budget_remaining?: string;
  optimization_goal: OptimizationGoal;
  billing_event: BillingEvent;
  bid_amount?: string;
  bid_strategy?: BidStrategy;
  targeting: TargetingSpec;
  start_time?: string;
  end_time?: string;
  created_time: string;
  updated_time: string;
  frequency_control_specs?: FrequencyControlSpec[];
  promoted_object?: Record<string, unknown>;
  destination_type?: string;
}

export const ADSET_DEFAULT_FIELDS = [
  "id",
  "name",
  "campaign_id",
  "status",
  "effective_status",
  "daily_budget",
  "lifetime_budget",
  "budget_remaining",
  "optimization_goal",
  "billing_event",
  "bid_amount",
  "bid_strategy",
  "targeting",
  "start_time",
  "end_time",
  "created_time",
  "updated_time",
] as const;
