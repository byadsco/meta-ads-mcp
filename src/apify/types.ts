/** Apify API v2 shapes. Every endpoint except /datasets/{id}/items wraps its payload in `{ data: ... }`. */

export type ApifyRunStatus =
  | "READY"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "ABORTING"
  | "ABORTED"
  | "TIMING-OUT"
  | "TIMED-OUT";

export const TERMINAL_RUN_STATUSES: readonly ApifyRunStatus[] = [
  "SUCCEEDED",
  "FAILED",
  "ABORTED",
  "TIMED-OUT",
];

export interface ApifyRun {
  id: string;
  actId: string;
  status: ApifyRunStatus;
  startedAt: string;
  finishedAt: string | null;
  defaultDatasetId: string;
  usageTotalUsd?: number;
  stats?: { runTimeSecs?: number };
}

export interface ApifyUser {
  id: string;
  username: string;
}

export interface ApifyEnvelope<T> {
  data: T;
}

export interface ApifyErrorBody {
  error: { type?: string; message?: string };
}

/**
 * Input for curious_coder/facebook-ads-library-scraper, build 2.7.x.
 *
 * The `scrapePageAds.*` keys are literal dotted property names in the actor's
 * INPUT_SCHEMA, and they only apply to Facebook *page* URLs — for Ad Library
 * search URLs the equivalent filters travel inside the URL query string.
 */
export interface AdLibraryActorInput {
  urls: Array<{ url: string }>;
  count: number;
  scrapeAdDetails: boolean;
  "scrapePageAds.activeStatus": AdLibraryActiveStatus;
  "scrapePageAds.countryCode": string;
  "scrapePageAds.period": AdLibraryPeriod;
  "scrapePageAds.sortBy": AdLibrarySortBy;
}

export type AdLibraryActiveStatus = "all" | "active" | "inactive";
export type AdLibraryPeriod = "" | "last24h" | "last7d" | "last14d" | "last30d";
export type AdLibrarySortBy = "impressions_desc" | "most_recent";
export type AdLibraryAdType =
  | "all"
  | "political_and_issue_ads"
  | "housing_ads"
  | "employment_ads"
  | "financial_products_and_services_ads";
export type AdLibrarySearchType = "keyword_unordered" | "keyword_exact_phrase";

/** USD charged per ad in the default dataset (PAY_PER_EVENT `apify-default-dataset-item`). */
export const USD_PER_AD = 0.00075;
/** One-time `apify-actor-start` event, per GB of actor memory. */
export const USD_PER_RUN_START = 0.00005;
