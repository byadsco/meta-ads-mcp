export interface Interest {
  id: string;
  name: string;
  audience_size_lower_bound?: number;
  audience_size_upper_bound?: number;
  path?: string[];
  description?: string;
  topic?: string;
}

export interface Behavior {
  id: string;
  name: string;
  audience_size_lower_bound?: number;
  audience_size_upper_bound?: number;
  path?: string[];
  description?: string;
  type?: string;
}

export interface DemographicOption {
  id: string;
  name: string;
  audience_size_lower_bound?: number;
  audience_size_upper_bound?: number;
  path?: string[];
  description?: string;
  type?: string;
}

export interface GeoLocationResult {
  key: string;
  name: string;
  type: string;
  country_code?: string;
  country_name?: string;
  region?: string;
  region_id?: number;
  primary_city?: string;
  primary_city_id?: number;
  supports_city?: boolean;
  supports_region?: boolean;
}

export interface AudienceEstimate {
  users_lower_bound: number;
  users_upper_bound: number;
  estimate_ready: boolean;
}

export type DemographicClass =
  | "demographics"
  | "work_employers"
  | "work_positions"
  | "education_schools"
  | "education_majors"
  | "family_statuses"
  | "life_events"
  | "industries"
  | "income"
  | "net_worth"
  | "home_type"
  | "home_ownership"
  | "home_value"
  | "ethnic_affinity"
  | "generation"
  | "politics";
