export interface WhatsAppBusinessAccount {
  id: string;
  name?: string;
  currency?: string;
  timezone_id?: string;
  message_template_namespace?: string;
  account_review_status?: string;
  business_verification_status?: string;
  country?: string;
  ownership_type?: string;
  health_status?: Record<string, unknown>;
}

export interface WhatsAppPhoneNumber {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  code_verification_status?: string;
  quality_rating?: string;
  platform_type?: string;
  throughput?: { level?: string };
  status?: string;
  name_status?: string;
  messaging_limit_tier?: string;
}

export interface WhatsAppBusinessProfile {
  about?: string;
  address?: string;
  description?: string;
  email?: string;
  profile_picture_url?: string;
  websites?: string[];
  vertical?: string;
  messaging_product?: string;
}

export interface TemplateComponent {
  type: string;
  format?: string;
  text?: string;
  buttons?: Record<string, unknown>[];
  example?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface MessageTemplate {
  id: string;
  name?: string;
  status?: string;
  category?: string;
  language?: string;
  quality_score?: { score?: string; date?: number };
  components?: TemplateComponent[];
  rejected_reason?: string;
  parameter_format?: string;
}

export interface WhatsAppFlow {
  id: string;
  name?: string;
  status?: string;
  categories?: string[];
  validation_errors?: Record<string, unknown>[];
  json_version?: string;
  data_api_version?: string;
  endpoint_uri?: string;
  preview?: { preview_url?: string; expires_at?: string };
}

export interface WhatsAppQrCode {
  code: string;
  prefilled_message?: string;
  deep_link_url?: string;
  qr_image_url?: string;
}

export interface WebhookSubscription {
  whatsapp_business_api_data?: { id: string; name?: string; link?: string };
  override_callback_uri?: string;
}

export const WABA_DEFAULT_FIELDS = [
  "id",
  "name",
  "currency",
  "timezone_id",
  "message_template_namespace",
  "account_review_status",
  "business_verification_status",
  "country",
  "ownership_type",
] as const;

export const WA_PHONE_DEFAULT_FIELDS = [
  "id",
  "display_phone_number",
  "verified_name",
  "code_verification_status",
  "quality_rating",
  "platform_type",
  "throughput",
  "status",
  "name_status",
] as const;

export const WA_TEMPLATE_DEFAULT_FIELDS = [
  "id",
  "name",
  "status",
  "category",
  "language",
  "quality_score",
] as const;

export const WA_FLOW_DEFAULT_FIELDS = [
  "id",
  "name",
  "status",
  "categories",
  "validation_errors",
] as const;

export const WA_PROFILE_FIELDS = [
  "about",
  "address",
  "description",
  "email",
  "profile_picture_url",
  "websites",
  "vertical",
] as const;
