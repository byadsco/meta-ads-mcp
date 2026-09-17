import { logger } from "../utils/logger.js";
import { downloadSafePublicImage, type SafeImageDownloadOptions, type SafeImageDownload } from "../utils/safe-download.js";
import { scrubCredentials } from "../utils/scrub-credentials.js";
import { imageBlock, safeHostname, type ContentBlock } from "./content-blocks.js";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const IMAGE_TOTAL_BYTES_BUDGET = 20 * 1024 * 1024;

/**
 * The parts of an image asset this helper reads and writes. Callers keep their
 * own richer shapes (role, hashes, dimensions) around it.
 */
export interface DownloadableImage {
  source_url?: string;
  downloaded: boolean;
  block_index?: number;
  mime_type?: string;
  bytes?: number;
  error?: string;
  skipped?: "max_images" | "size_budget" | "aborted";
  /** Only used for the log line, never for the response. */
  role?: string;
}

export interface FetchImageBlocksOptions {
  maxImages: number;
  /** Shared with whatever else the response carries (video media, above all). */
  totalBytesBudget?: number;
  /** Already spent by the caller before these images. */
  bytesUsed?: number;
  signal?: AbortSignal;
  allowedHostSuffixes?: string[];
  download?: (url: string, options?: SafeImageDownloadOptions) => Promise<SafeImageDownload>;
}

export interface FetchImageBlocksResult {
  blocks: ContentBlock[];
  bytes: number;
}

/**
 * Downloads creative images into MCP image blocks under a count and a byte
 * budget, recording on each asset what happened to it. Extracted from
 * ads_get_creative_media so the dossier attaches images the same way, with
 * the same caps and the same failure reporting.
 */
export async function fetchCreativeImageBlocks(
  assets: DownloadableImage[],
  options: FetchImageBlocksOptions,
): Promise<FetchImageBlocksResult> {
  const download = options.download ?? downloadSafePublicImage;
  const budget = options.totalBytesBudget ?? IMAGE_TOTAL_BYTES_BUDGET;
  const blocks: ContentBlock[] = [];
  let used = options.bytesUsed ?? 0;
  const startedAt = used;

  for (const asset of assets) {
    if (!asset.source_url) continue;
    if (options.signal?.aborted) {
      asset.skipped = "aborted";
      continue;
    }
    if (blocks.length >= options.maxImages) {
      asset.skipped = "max_images";
      continue;
    }
    const remaining = budget - used;
    if (remaining <= 0) {
      asset.skipped = "size_budget";
      continue;
    }
    try {
      const downloaded = await download(asset.source_url, {
        maxBytes: Math.min(MAX_IMAGE_BYTES, remaining),
        signal: options.signal,
        allowedHostSuffixes: options.allowedHostSuffixes,
      });
      used += downloaded.buffer.length;
      asset.block_index = blocks.length;
      blocks.push(imageBlock(downloaded.buffer, downloaded.contentType));
      asset.downloaded = true;
      asset.mime_type = downloaded.contentType;
      asset.bytes = downloaded.buffer.length;
    } catch (err) {
      // A download error quotes the url it failed on, credentials included.
      asset.error = scrubCredentials(err instanceof Error ? err.message : String(err));
      logger.warn({ imageHost: safeHostname(asset.source_url), role: asset.role }, "Creative image download failed");
    }
  }

  return { blocks, bytes: used - startedAt };
}
