import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { extractLibraryVideoSources, isAdLibraryErrorItem, libraryVideoAt, normalizeLibraryAd } from "../apify/ad-library-schema.js";
import { getDatasetLookup, type DatasetLookup } from "../apify/dataset-lookup.js";
import type { VideoSource } from "./video-sources.js";

export interface AdLibraryVideoSourceInput {
  dataset_id: string;
  ad_archive_id: string;
  hint_offset?: number;
  /** Address one video by position in the record, before any presentation cap. */
  video_index?: number;
}

/** Videos of one scraped Ad Library ad, ready for the delivery pipeline. */
export async function resolveAdLibraryVideoSources(
  input: AdLibraryVideoSourceInput,
  lookup: DatasetLookup = getDatasetLookup(),
): Promise<VideoSource[]> {
  const { item, offset } = await lookup.findDatasetItem(input.dataset_id, input.ad_archive_id, { hintOffset: input.hint_offset });
  if (isAdLibraryErrorItem(item)) {
    throw new McpError(ErrorCode.InvalidParams, "Dataset item at offset " + offset + " is an actor error record, not an ad.");
  }
  if (input.video_index !== undefined) {
    const source = libraryVideoAt(item, input.video_index);
    if (!source) {
      throw new McpError(ErrorCode.InvalidParams, "video_index " + input.video_index + " is out of range for ad " + input.ad_archive_id + ".");
    }
    return [source];
  }
  return extractLibraryVideoSources(normalizeLibraryAd(item, offset));
}
