export interface LeadForm {
  id: string;
  name: string;
  status: string;
  leads_count?: number;
  locale?: string;
  created_time?: string;
  questions?: Array<{ key: string; label: string; type: string }>;
  privacy_policy?: { url: string; link_text?: string };
  follow_up_action_url?: string;
}

export interface Lead {
  id: string;
  created_time: string;
  field_data: Array<{ name: string; values: string[] }>;
  ad_id?: string;
  ad_name?: string;
  adset_id?: string;
  campaign_id?: string;
  form_id?: string;
  platform?: string;
}

export const LEAD_FORM_DEFAULT_FIELDS = [
  "id",
  "name",
  "status",
  "leads_count",
  "locale",
  "created_time",
  "questions",
  "privacy_policy",
  "follow_up_action_url",
] as const;

export const LEAD_DEFAULT_FIELDS = [
  "id",
  "created_time",
  "field_data",
  "ad_id",
  "ad_name",
  "adset_id",
  "campaign_id",
  "form_id",
  "platform",
] as const;
