import { isMetaApiVersionAtLeast } from "./api-version.js";
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

const EXPLICIT_ADVANTAGE_AUDIENCE_SINCE = "v23.0";

export interface AdaptedTargeting {
  targeting: TargetingSpec;
  warnings: string[];
}

/**
 * Makes targeting read from an existing ad set valid for creating a new one on
 * the given Marketing API version, reporting every change it makes.
 */
export function adaptCopiedTargetingForCreate(source: TargetingSpec, apiVersion: string): AdaptedTargeting {
  const targeting = structuredClone(source);
  const warnings: string[] = [];

  for (const { field, platform, value, removedIn } of REMOVED_PLACEMENTS) {
    if (!isMetaApiVersionAtLeast(apiVersion, removedIn)) continue;
    const positions = targeting[field];
    if (!Array.isArray(positions) || !positions.includes(value)) continue;

    const remaining = positions.filter((position) => position !== value);
    if (remaining.length > 0) {
      targeting[field] = remaining;
      warnings.push(`Removed ${field} "${value}" from the copied targeting: Meta removed that placement in Marketing API ${removedIn}.`);
      continue;
    }

    const platforms = targeting.publisher_platforms;
    if (!Array.isArray(platforms)) {
      throw new Error(`The source ad set limits ${platform} to the "${value}" placement, which Meta removed in Marketing API ${removedIn}, and does not set publisher_platforms. Dropping it would widen delivery to every ${platform} placement, so the ad set was not cloned. Set the source ad set's placements explicitly, then clone it again.`);
    }

    // Meta's guidance when the removed value was the only one: drop the whole
    // positions field and the platform, instead of widening to its defaults.
    delete targeting[field];
    if (platforms.includes(platform)) {
      targeting.publisher_platforms = platforms.filter((p) => p !== platform);
      warnings.push(`Removed ${field} "${value}" and the ${platform} platform from the copied targeting: it was the only ${platform} placement and Meta removed it in Marketing API ${removedIn}.`);
    } else {
      warnings.push(`Removed ${field} from the copied targeting: its only value, "${value}", was removed by Meta in Marketing API ${removedIn}.`);
    }
  }

  if (Array.isArray(targeting.publisher_platforms) && targeting.publisher_platforms.length === 0) {
    throw new Error("The source ad set has no placements left after removing the ones Meta no longer supports, so the ad set was not cloned. Update its placements, then clone it again.");
  }

  if (
    isMetaApiVersionAtLeast(apiVersion, EXPLICIT_ADVANTAGE_AUDIENCE_SINCE)
    && targeting.targeting_automation?.advantage_audience === undefined
  ) {
    // The flag cannot be inferred once the relaxation fields are stripped, and
    // Meta rejects non-default targeting without it; not expanding the audience
    // is the choice that never spends beyond the copied targeting.
    targeting.targeting_automation = { ...targeting.targeting_automation, advantage_audience: 0 };
    warnings.push(`The source ad set does not report an Advantage+ audience setting, so the copy sets targeting_automation.advantage_audience to 0 and does not expand the audience. Meta requires an explicit value for new ad sets with non-default targeting since Marketing API ${EXPLICIT_ADVANTAGE_AUDIENCE_SINCE}; update the copy if it should use Advantage+ audience.`);
  }

  return { targeting, warnings };
}
