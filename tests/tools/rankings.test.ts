import { describe, expect, it } from "vitest";
import { describeRankings, renderRankings } from "../../src/tools/rankings.js";

describe("describeRankings", () => {
  it("reads the three rankings in a fixed order and flags only the below bands", () => {
    const readings = describeRankings({
      quality_ranking: "BELOW_AVERAGE_10",
      engagement_rate_ranking: "ABOVE_AVERAGE",
      conversion_rate_ranking: "AVERAGE",
    });

    expect(readings.map((r) => r.field)).toEqual(["quality_ranking", "engagement_rate_ranking", "conversion_rate_ranking"]);
    expect(readings[0]).toMatchObject({ below: true, unknown: false, hypothesis: expect.stringMatching(/creative/i) });
    expect(readings[1]).toMatchObject({ below: false, unknown: false });
    expect(readings[1].hypothesis).toBeUndefined();
    expect(readings[2].below).toBe(false);
  });

  it("flags every below band Meta emits", () => {
    for (const value of ["BELOW_AVERAGE_10", "BELOW_AVERAGE_20", "BELOW_AVERAGE_35", "below_average_10"]) {
      expect(describeRankings({ quality_ranking: value })[0].below).toBe(true);
    }
  });

  it("treats UNKNOWN as missing data rather than a problem", () => {
    const readings = describeRankings({ quality_ranking: "UNKNOWN" });
    expect(readings[0]).toMatchObject({ unknown: true, below: false });
    expect(readings[0].hypothesis).toBeUndefined();
  });

  it("returns nothing for a row without rankings, or no row at all", () => {
    expect(describeRankings({ spend: "10" })).toEqual([]);
    expect(describeRankings(null)).toEqual([]);
    expect(describeRankings(undefined)).toEqual([]);
  });

  it("ignores values that are not strings", () => {
    expect(describeRankings({ quality_ranking: 3, engagement_rate_ranking: null, conversion_rate_ranking: "" })).toEqual([]);
  });
});

describe("renderRankings", () => {
  it("writes one readable line per ranking", () => {
    const lines = renderRankings(describeRankings({ quality_ranking: "BELOW_AVERAGE_10", conversion_rate_ranking: "UNKNOWN" }));
    expect(lines).toEqual(["Quality: below average 10", "Conversion rate: not enough data yet"]);
  });
});
