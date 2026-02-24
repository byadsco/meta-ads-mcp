export interface CustomAudience {
  id: string;
  name: string;
  description?: string;
  subtype: string;
  approximate_count_lower_bound?: number;
  approximate_count_upper_bound?: number;
  time_created?: string;
  time_updated?: string;
  delivery_status?: { status: string };
  operation_status?: { status: number; description?: string };
  data_source?: { type: string; sub_type?: string };
  lookalike_spec?: {
    origin: Array<{ id: string; name?: string }>;
    ratio: number;
    country?: string;
  };
  retention_days?: number;
  rule?: string;
  customer_file_source?: string;
}

export const AUDIENCE_DEFAULT_FIELDS = [
  "id",
  "name",
  "description",
  "subtype",
  "approximate_count_lower_bound",
  "approximate_count_upper_bound",
  "time_created",
  "time_updated",
  "delivery_status",
  "operation_status",
  "data_source",
  "lookalike_spec",
  "retention_days",
  "customer_file_source",
] as const;
