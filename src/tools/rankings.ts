/**
 * Meta's three auction quality rankings, read the same way everywhere. The
 * API returns a decile band or one of two sentinels; only the two BELOW bands
 * are actionable, and UNKNOWN means "not enough impressions yet", which is
 * information rather than a problem.
 */

export type RankingField = "quality_ranking" | "engagement_rate_ranking" | "conversion_rate_ranking";

export interface RankingReading {
  field: RankingField;
  label: string;
  value: string;
  /** Below average in any band: Meta is telling you this ad loses auctions on that axis. */
  below: boolean;
  unknown: boolean;
  /** What to do about it, when there is something to do. */
  hypothesis?: string;
}

const RANKINGS: Array<{ field: RankingField; label: string; hypothesis: string }> = [
  {
    field: "quality_ranking",
    label: "Quality",
    hypothesis: "Refresh the creative — Meta is suppressing delivery because the ad scores poorly against others shown to the same people.",
  },
  {
    field: "engagement_rate_ranking",
    label: "Engagement rate",
    hypothesis: "The hook is weak — the first three seconds or the headline are not earning attention.",
  },
  {
    field: "conversion_rate_ranking",
    label: "Conversion rate",
    hypothesis: "The landing page or the offer may be the problem rather than the ad itself.",
  },
];

const UNKNOWN_VALUES = new Set(["UNKNOWN", "", "-"]);

/**
 * Reads whichever of the three rankings the row carries. Insights omit them
 * entirely below 500 impressions, and report UNKNOWN when Meta has data but
 * not enough of it, so an empty result is normal for a young ad.
 */
export function describeRankings(row: Record<string, unknown> | null | undefined): RankingReading[] {
  if (!row) return [];
  const readings: RankingReading[] = [];
  for (const { field, label, hypothesis } of RANKINGS) {
    const raw = row[field];
    if (typeof raw !== "string" || raw.length === 0) continue;
    const value = raw.toUpperCase();
    const unknown = UNKNOWN_VALUES.has(value);
    const below = !unknown && value.includes("BELOW");
    readings.push({ field, label, value: raw, below, unknown, ...(below ? { hypothesis } : {}) });
  }
  return readings;
}

/** One line per ranking, in the fixed order above; empty when none were reported. */
export function renderRankings(readings: RankingReading[]): string[] {
  return readings.map((r) => `${r.label}: ${r.unknown ? "not enough data yet" : r.value.replace(/_/g, " ").toLowerCase()}`);
}
