import { describe, expect, it } from "vitest";
import { adaptCopiedTargetingForCreate } from "../../src/meta/targeting-compat.js";

const withAudienceFlag = { targeting_automation: { advantage_audience: 1 } };

describe("adaptCopiedTargetingForCreate", () => {
  it("only removes placements that are gone in the API version the client calls", () => {
    const { targeting, warnings } = adaptCopiedTargetingForCreate({
      ...withAudienceFlag,
      geo_locations: { countries: ["CL"] },
      publisher_platforms: ["facebook", "instagram", "messenger"],
      facebook_positions: ["feed", "video_feeds"],
      instagram_positions: ["stream", "explore"],
      messenger_positions: ["sponsored_messages", "story"],
    }, "v25.0");

    expect(targeting.facebook_positions).toEqual(["feed"]);
    expect(targeting.instagram_positions).toEqual(["stream", "explore"]);
    expect(targeting.messenger_positions).toEqual(["sponsored_messages", "story"]);
    expect(warnings).toEqual([expect.stringContaining("video_feeds")]);
  });

  // Without publisher_platforms Meta delivers on every platform, so dropping
  // "instagram_positions" would open all of Instagram instead of closing it.
  it("refuses to drop a platform's only placement when publisher_platforms is not set", () => {
    expect(() => adaptCopiedTargetingForCreate({
      ...withAudienceFlag,
      geo_locations: { countries: ["CL"] },
      facebook_positions: ["feed"],
      instagram_positions: ["explore"],
    }, "v26.0")).toThrow(/publisher_platforms/);
  });

  it("drops a removed only placement of a platform that was not selected, leaving the platforms alone", () => {
    const { targeting, warnings } = adaptCopiedTargetingForCreate({
      ...withAudienceFlag,
      geo_locations: { countries: ["CL"] },
      publisher_platforms: ["facebook"],
      facebook_positions: ["feed"],
      instagram_positions: ["explore"],
    }, "v26.0");

    expect(targeting.publisher_platforms).toEqual(["facebook"]);
    expect(targeting).not.toHaveProperty("instagram_positions");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toMatch(/platform/);
  });

  it("does not touch the source targeting it was given", () => {
    const source = {
      ...withAudienceFlag,
      geo_locations: { countries: ["CL"] },
      publisher_platforms: ["instagram"],
      instagram_positions: ["stream", "explore"],
    };

    adaptCopiedTargetingForCreate(source, "v26.0");

    expect(source.instagram_positions).toEqual(["stream", "explore"]);
  });

  it("leaves the Advantage+ audience flag unset below v23.0, where Meta does not require it", () => {
    const { targeting, warnings } = adaptCopiedTargetingForCreate({
      geo_locations: { countries: ["CL"] },
      age_min: 30,
    }, "v22.0");

    expect(targeting).not.toHaveProperty("targeting_automation");
    expect(warnings).toEqual([]);
  });

  it("keeps an existing Advantage+ audience choice and the rest of targeting_automation", () => {
    const { targeting, warnings } = adaptCopiedTargetingForCreate({
      geo_locations: { countries: ["CL"] },
      targeting_automation: { advantage_audience: 1, individual_setting: { age: 1 } },
    }, "v26.0");

    expect(targeting.targeting_automation).toEqual({ advantage_audience: 1, individual_setting: { age: 1 } });
    expect(warnings).toEqual([]);
  });
});
