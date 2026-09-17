import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { apifyApiClient, validateApifyId, type ApifyApiClient } from "./client.js";
import type { AdLibraryRawItem } from "./ad-library-schema.js";

const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_MAX_ITEMS = 5000;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_DATASETS = 50;
const AD_ARCHIVE_ID_PATTERN = /^\d{5,25}$/;

export class DatasetItemNotFoundError extends McpError {
  constructor(adArchiveId: string, datasetId: string, scanned: number) {
    super(
      ErrorCode.InvalidParams,
      "Ad " + adArchiveId + " was not found in dataset " + datasetId + " (scanned " + scanned + " items). Check the ad_archive_id, or pass hint_offset from ads_library_get_results.",
    );
    this.name = "DatasetItemNotFoundError";
  }
}

export function validateAdArchiveId(id: string): string {
  const trimmed = id.trim();
  if (!AD_ARCHIVE_ID_PATTERN.test(trimmed)) {
    throw new McpError(ErrorCode.InvalidParams, "Invalid ad_archive_id \"" + id + "\": expected 5-25 digits.");
  }
  return trimmed;
}

export interface DatasetLookupConfig {
  client?: ApifyApiClient;
  pageSize?: number;
  maxItems?: number;
  ttlMs?: number;
  maxDatasets?: number;
  now?: () => number;
}

export interface FoundDatasetItem {
  item: AdLibraryRawItem;
  offset: number;
}

export interface DatasetLookup {
  findDatasetItem(datasetId: string, adArchiveId: string, options?: { hintOffset?: number }): Promise<FoundDatasetItem>;
}

interface CacheEntry {
  at: number;
  offsets: Map<string, number>;
  scanned: number;
  complete: boolean;
}

/**
 * Locates one scraped ad inside an Apify dataset. Reading a dataset is free on
 * Apify, so the only cost is latency: the scan projects records down to
 * ad_archive_id (fields=) in large pages, remembers the id -> offset map per
 * dataset, and only then fetches the single full record.
 *
 * skipHidden (not clean) keeps positional alignment: clean would drop items
 * that become empty under the projection (the actor error records), shifting
 * every later offset.
 */
export function createDatasetLookup(config: DatasetLookupConfig = {}): DatasetLookup {
  const client = config.client ?? apifyApiClient;
  const pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxItems = config.maxItems ?? DEFAULT_MAX_ITEMS;
  const ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
  const maxDatasets = config.maxDatasets ?? DEFAULT_MAX_DATASETS;
  const now = config.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();

  const itemsPath = (datasetId: string) => "/v2/datasets/" + datasetId + "/items";

  const fetchOne = async (datasetId: string, offset: number): Promise<AdLibraryRawItem | undefined> => {
    const items = await client.get<AdLibraryRawItem[]>(itemsPath(datasetId), {
      offset,
      limit: 1,
      skipHidden: true,
      format: "json",
    });
    return Array.isArray(items) ? items[0] : undefined;
  };

  const idOf = (item: AdLibraryRawItem | undefined): string | null => {
    const raw = item?.ad_archive_id;
    return typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : null;
  };

  const getCache = (datasetId: string): CacheEntry | undefined => {
    const entry = cache.get(datasetId);
    if (!entry) return undefined;
    if (now() - entry.at > ttlMs) {
      cache.delete(datasetId);
      return undefined;
    }
    return entry;
  };

  const putCache = (datasetId: string, entry: CacheEntry): void => {
    cache.delete(datasetId);
    cache.set(datasetId, entry);
    while (cache.size > maxDatasets) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  const scan = async (datasetId: string, adArchiveId: string): Promise<CacheEntry> => {
    const offsets = new Map<string, number>();
    let scanned = 0;
    let complete = false;
    for (let offset = 0; offset < maxItems; offset += pageSize) {
      const limit = Math.min(pageSize, maxItems - offset);
      const page = await client.get<AdLibraryRawItem[]>(itemsPath(datasetId), {
        offset,
        limit,
        fields: "ad_archive_id",
        skipHidden: true,
        format: "json",
      });
      const items = Array.isArray(page) ? page : [];
      items.forEach((item, i) => {
        const id = idOf(item);
        if (id && !offsets.has(id)) offsets.set(id, offset + i);
      });
      scanned += items.length;
      if (offsets.has(adArchiveId)) break;
      if (items.length < limit) {
        complete = true;
        break;
      }
    }
    const entry = { at: now(), offsets, scanned, complete };
    putCache(datasetId, entry);
    return entry;
  };

  return {
    async findDatasetItem(rawDatasetId, rawAdArchiveId, options = {}) {
      const datasetId = validateApifyId(rawDatasetId, "dataset");
      const adArchiveId = validateAdArchiveId(rawAdArchiveId);

      if (options.hintOffset !== undefined && Number.isInteger(options.hintOffset) && options.hintOffset >= 0) {
        const item = await fetchOne(datasetId, options.hintOffset);
        if (item && idOf(item) === adArchiveId) return { item, offset: options.hintOffset };
      }

      let entry = getCache(datasetId);
      let offset = entry?.offsets.get(adArchiveId);
      if (offset === undefined) {
        entry = await scan(datasetId, adArchiveId);
        offset = entry.offsets.get(adArchiveId);
      }
      if (offset === undefined) {
        throw new DatasetItemNotFoundError(adArchiveId, datasetId, entry?.scanned ?? 0);
      }

      const item = await fetchOne(datasetId, offset);
      if (item && idOf(item) === adArchiveId) return { item, offset };

      // The dataset changed under a cached map (or a stale hint): rescan once.
      cache.delete(datasetId);
      entry = await scan(datasetId, adArchiveId);
      offset = entry.offsets.get(adArchiveId);
      if (offset !== undefined) {
        const fresh = await fetchOne(datasetId, offset);
        if (fresh && idOf(fresh) === adArchiveId) return { item: fresh, offset };
      }
      throw new DatasetItemNotFoundError(adArchiveId, datasetId, entry.scanned);
    },
  };
}

let defaultLookup: DatasetLookup | undefined;

export function getDatasetLookup(): DatasetLookup {
  if (!defaultLookup) defaultLookup = createDatasetLookup();
  return defaultLookup;
}

export function configureDatasetLookupForTests(lookup: DatasetLookup | undefined): void {
  defaultLookup = lookup;
}
