export type CampaignObjective =
  | "OUTCOME_AWARENESS"
  | "OUTCOME_ENGAGEMENT"
  | "OUTCOME_LEADS"
  | "OUTCOME_SALES"
  | "OUTCOME_TRAFFIC"
  | "OUTCOME_APP_PROMOTION";

export type CampaignStatus =
  | "ACTIVE"
  | "PAUSED"
  | "DELETED"
  | "ARCHIVED";

export type BidStrategy =
  | "LOWEST_COST_WITHOUT_CAP"
  | "LOWEST_COST_WITH_BID_CAP"
  | "COST_CAP"
  | "LOWEST_COST_WITH_MIN_ROAS";

export type BuyingType = "AUCTION" | "RESERVED";

export type SpecialAdCategory =
  | "NONE"
  | "EMPLOYMENT"
  | "HOUSING"
  | "CREDIT"
  | "ISSUES_ELECTIONS_POLITICS";

export interface Campaign {
  id: string;
  name: string;
  objective: CampaignObjective;
  status: CampaignStatus;
  effective_status: string;
  buying_type: BuyingType;
  daily_budget?: string;
  lifetime_budget?: string;
  budget_remaining?: string;
  bid_strategy?: BidStrategy;
  special_ad_categories: SpecialAdCategory[];
  created_time: string;
  updated_time: string;
  start_time?: string;
  stop_time?: string;
}

export const CAMPAIGN_DEFAULT_FIELDS = [
  "id",
  "name",
  "objective",
  "status",
  "effective_status",
  "buying_type",
  "daily_budget",
  "lifetime_budget",
  "budget_remaining",
  "bid_strategy",
  "special_ad_categories",
  "created_time",
  "updated_time",
  "start_time",
  "stop_time",
] as const;
