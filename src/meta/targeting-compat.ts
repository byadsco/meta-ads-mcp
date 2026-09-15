import type { TargetingSpec } from "./types/adset.js";

type PositionsField = "facebook_positions" | "instagram_positions" | "messenger_positions";

interface RemovedPlacement {
  field: PositionsField;
  platform: string;
  value: string;
  removedIn: string;
}

// Creating an ad set with video_feeds or explore returns an error; Messenger
// story is dropped silently and Meta asks callers to remove it.
const REMOVED_PLACEMENTS: readonly RemovedPlacement[] = [
  { field: "facebook_positions", platform: "facebook", value: "video_feeds", removedIn: "v24.0" },
  { field: "instagram_positions", platform: "instagram", value: "explore", removedIn: "v26.0" },
  { field: "messenger_positions", platform: "messenger", value: "story", removedIn: "v26.0" },
];

export interface AdaptedTargeting {
  targeting: TargetingSpec;
  warnings: string[];
}

/**
 * Makes targeting read from an existing ad set valid for creating a new one on
 * the current Marketing API version, reporting every change it makes.
 */
export function adaptCopiedTargetingForCreate(source: TargetingSpec): AdaptedTargeting {
  const targeting = structuredClone(source);
  const warnings: string[] = [];

  for (const { field, platform, value, removedIn } of REMOVED_PLACEMENTS) {
    const positions = targeting[field];
    if (!Array.isArray(positions) || !positions.includes(value)) continue;

    const remaining = positions.filter((position) => position !== value);
    if (remaining.length > 0) {
      targeting[field] = remaining;
      warnings.push(`Removed ${field} "${value}" from the copied targeting: Meta removed that placement in Marketing API ${removedIn}.`);
      continue;
    }

    // Meta's guidance when the removed value was the only one: drop the whole
    // positions field and the platform, instead of widening to its defaults.
    delete targeting[field];
    if (Array.isArray(targeting.publisher_platforms)) {
      targeting.publisher_platforms = targeting.publisher_platforms.filter((p) => p !== platform);
    }
    warnings.push(`Removed ${field} "${value}" and the ${platform} platform from the copied targeting: it was the only ${platform} placement and Meta removed it in Marketing API ${removedIn}.`);
  }

  if (Array.isArray(targeting.publisher_platforms) && targeting.publisher_platforms.length === 0) {
    throw new Error("The source ad set has no placements left after removing the ones Meta no longer supports. Update its placements before cloning it.");
  }

  if (targeting.targeting_automation?.advantage_audience === undefined) {
    // An ad set without the flag predates Advantage+ audience defaults, so it
    // never expanded its audience. Opting out keeps the copy equivalent.
    targeting.targeting_automation = { ...targeting.targeting_automation, advantage_audience: 0 };
    warnings.push("The source ad set has no Advantage+ audience setting, so the copy sets targeting_automation.advantage_audience to 0 to keep the same audience. Meta requires an explicit value for new ad sets with non-default targeting since Marketing API v23.0.");
  }

  return { targeting, warnings };
}
