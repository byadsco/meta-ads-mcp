export interface AdStudyCell {
  id: string;
  name: string;
  description?: string;
  treatment_percentage?: number;
  campaigns?: Array<{ id: string }>;
  adsets?: Array<{ id: string }>;
  creation_template?: Record<string, unknown>;
}

export interface AdStudy {
  id: string;
  name: string;
  description?: string;
  type?: string;
  start_time?: string;
  end_time?: string;
  cooldown_start_time?: string;
  created_time?: string;
  updated_time?: string;
  cells?: Array<AdStudyCell>;
  objectives?: Array<{ type: string; name: string }>;
  confidence_level?: number;
}

export const STUDY_DEFAULT_FIELDS = [
  "id",
  "name",
  "description",
  "type",
  "start_time",
  "end_time",
  "cooldown_start_time",
  "created_time",
  "updated_time",
  "confidence_level",
] as const;
