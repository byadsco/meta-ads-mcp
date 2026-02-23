export type AdStatus = "ACTIVE" | "PAUSED" | "DELETED" | "ARCHIVED";

export interface Ad {
  id: string;
  name: string;
  adset_id: string;
  campaign_id: string;
  status: AdStatus;
  effective_status: string;
  creative?: {
    id: string;
  };
  tracking_specs?: Array<Record<string, unknown>>;
  created_time: string;
  updated_time: string;
  bid_amount?: string;
}

export const AD_DEFAULT_FIELDS = [
  "id",
  "name",
  "adset_id",
  "campaign_id",
  "status",
  "effective_status",
  "creative{id}",
  "created_time",
  "updated_time",
] as const;
