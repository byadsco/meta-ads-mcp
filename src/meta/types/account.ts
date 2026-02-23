export interface AdAccount {
  id: string;
  account_id: string;
  name: string;
  account_status: number;
  currency: string;
  timezone_name: string;
  timezone_offset_hours_utc: number;
  business_name?: string;
  business?: {
    id: string;
    name: string;
  };
  amount_spent: string;
  balance: string;
  spend_cap: string;
  owner?: string;
  age: number;
  created_time: string;
  funding_source?: string;
  funding_source_details?: Record<string, unknown>;
  disable_reason?: number;
  capabilities?: string[];
}

export interface Page {
  id: string;
  name: string;
  access_token?: string;
  category?: string;
  category_list?: Array<{ id: string; name: string }>;
  tasks?: string[];
}

export const AD_ACCOUNT_DEFAULT_FIELDS = [
  "id",
  "account_id",
  "name",
  "account_status",
  "currency",
  "timezone_name",
  "business_name",
  "amount_spent",
  "balance",
  "spend_cap",
  "age",
  "created_time",
  "disable_reason",
] as const;

export const AD_ACCOUNT_DETAIL_FIELDS = [
  ...AD_ACCOUNT_DEFAULT_FIELDS,
  "owner",
  "business",
  "funding_source_details",
  "capabilities",
  "timezone_offset_hours_utc",
] as const;

export const PAGE_DEFAULT_FIELDS = [
  "id",
  "name",
  "category",
  "category_list",
] as const;
