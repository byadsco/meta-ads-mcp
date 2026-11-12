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
  field_data?: Array<{ name: string; values: string[] }>;
  custom_disclaimer_responses?: Array<{ checkbox_key?: string; is_checked?: string | boolean }>;
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
  "privacy_policy_url",
  "follow_up_action_url",
] as const;

export const LEAD_FIELDS = [
  "id",
  "created_time",
  "field_data",
  "custom_disclaimer_responses",
  "ad_id",
  "ad_name",
  "adset_id",
  "adset_name",
  "campaign_id",
  "campaign_name",
  "form_id",
  "platform",
  "is_organic",
  "partner_name",
  "retailer_item_id",
] as const;

export const LEAD_DEFAULT_FIELDS = [
  "id",
  "created_time",
  "field_data",
  "custom_disclaimer_responses",
  "ad_id",
  "ad_name",
  "adset_id",
  "campaign_id",
  "form_id",
  "platform",
] as const;

// Meta's list for POST /{page_id}/leadgen_forms (Graph API v27 reference).
// MARITIAL_STATUS is Meta's own spelling.
export const LEAD_QUESTION_TYPES = [
  "CUSTOM", "CITY", "COMPANY_NAME", "COUNTRY", "DOB", "EMAIL", "GENDER", "FIRST_NAME", "FULL_NAME", "JOB_TITLE",
  "LAST_NAME", "MARITIAL_STATUS", "WHATSAPP_NUMBER", "EDUCATION_LEVEL", "WEBSITE", "PHONE", "PHONE_OTP", "POST_CODE",
  "PROVINCE", "RELATIONSHIP_STATUS", "STATE", "STREET_ADDRESS", "ZIP", "WORK_EMAIL", "MILITARY_STATUS",
  "WORK_PHONE_NUMBER", "LOCAL_DEALER", "SLIDER", "STORE_LOOKUP", "STORE_LOOKUP_WITH_TYPEAHEAD", "DATE_TIME",
  "ID_CPF", "ID_AR_DNI", "ID_CL_RUT", "ID_CO_CC", "ID_EC_CI", "ID_PE_DNI", "ID_MX_RFC", "JOIN_CODE",
  "USER_PROVIDED_PHONE_NUMBER", "FACEBOOK_LEAD_ID", "EMAIL_ALIAS", "MESSENGER", "VIN", "LICENSE_PLATE", "THREAD_LINK",
  "ADDRESS_LINE_TWO",
] as const;

export const THANK_YOU_BUTTON_TYPES = [
  "VIEW_WEBSITE", "CALL_BUSINESS", "MESSAGE_BUSINESS", "DOWNLOAD", "SCHEDULE_APPOINTMENT", "VIEW_ON_FACEBOOK",
  "PROMO_CODE", "NONE", "WHATSAPP", "P2B_MESSENGER", "BOOK_ON_WEBSITE",
] as const;
