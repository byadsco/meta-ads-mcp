export interface AdRule {
  id: string;
  name: string;
  status: "ENABLED" | "DISABLED" | "DELETED";
  evaluation_spec?: {
    evaluation_type: string;
    trigger?: { type: string; field: string; value: number; operator: string };
    filters: Array<{ field: string; value: unknown; operator: string }>;
  };
  execution_spec?: {
    execution_type: string;
    execution_options?: Array<{ field: string; value: unknown; operator: string }>;
  };
  schedule_spec?: {
    schedule_type: string;
  };
  created_time?: string;
  updated_time?: string;
}

export interface AdRuleHistory {
  action: string;
  object_id: string;
  object_type: string;
  timestamp: string;
}

export const RULE_DEFAULT_FIELDS = [
  "id",
  "name",
  "status",
  "evaluation_spec",
  "execution_spec",
  "schedule_spec",
  "created_time",
  "updated_time",
] as const;
