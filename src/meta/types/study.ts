interface IdList {
  data?: Array<{ id?: string }>;
}

export interface AdStudyCell {
  id?: string;
  name?: string;
  treatment_percentage?: number;
  control_percentage?: number;
  campaigns?: IdList;
  adsets?: IdList;
}

export interface AdStudyObjective {
  id?: string;
  name?: string;
  type?: string;
  is_primary?: boolean;
}

export interface AdStudy {
  id?: string;
  name?: string;
  description?: string;
  type?: string;
  start_time?: string;
  end_time?: string;
  cooldown_start_time?: string;
  observation_end_time?: string;
  canceled_time?: string;
  created_time?: string;
  updated_time?: string;
  results_first_available_date?: string;
  cells?: { data?: AdStudyCell[] };
  objectives?: { data?: AdStudyObjective[] };
}

/**
 * The fields Meta documents on an AdStudy. confidence_level is accepted when
 * a study is written but cannot be read: asking for it fails with #100
 * ("Tried accessing nonexisting field"), measured on v26.0.
 */
export const STUDY_DEFAULT_FIELDS = [
  "id",
  "name",
  "description",
  "type",
  "start_time",
  "end_time",
  "cooldown_start_time",
  "observation_end_time",
  "canceled_time",
  "created_time",
  "updated_time",
  "results_first_available_date",
] as const;
