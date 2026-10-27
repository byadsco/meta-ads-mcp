import type { AdCreative } from "./types/index.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function nested(value: unknown, path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) current = record(current)?.[key];
  return typeof current === "string" && current.length > 0 ? current : undefined;
}

// Where a click on the ad lands, in the order Meta applies: the creative-level
// link_url override first, then the video's button, the link ad's own link
// and button, and the first link of an asset feed.
export function effectiveLinkUrl(creative: Pick<AdCreative, "link_url" | "object_story_spec" | "asset_feed_spec">): string | undefined {
  if (creative.link_url) return creative.link_url;
  const spec = record(creative.object_story_spec);
  return (
    nested(spec, ["video_data", "call_to_action", "value", "link"])
    ?? nested(spec, ["link_data", "link"])
    ?? nested(spec, ["link_data", "call_to_action", "value", "link"])
    ?? nested(creative.asset_feed_spec, ["link_urls", "0", "website_url"])
  );
}
