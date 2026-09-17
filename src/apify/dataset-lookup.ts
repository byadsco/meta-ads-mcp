import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { apifyApiClient, resolveApifyTenantId, validateApifyId, type ApifyApiClient } from "./client.js";
import { archiveIdOf, type AdLibraryRawItem } from "./ad-library-schema.js";

const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_MAX_ITEMS = 5000;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_DATASETS = 50;
const DEFAULT_MAX_TOTAL_IDS = 100_000;
const AD_ARCHIVE_ID_PATTERN = /^\d{5,25}$/;

export class DatasetItemNotFoundError extends McpError {
  constructor(adArchiveId: string, datasetId: string, scanned: number, capped: boolean) {
    super(
      ErrorCode.InvalidParams,
      capped
        ? "Ad " + adArchiveId + " was not found in the first " + scanned + " items of dataset " + datasetId + "; the dataset may be larger than the scan cap. Pass hint_offset from ads_library_get_results."
        : "Ad " + adArchiveId + " was not found in dataset " + datasetId + " (scanned " + scanned + " items). Check the ad_archive_id, or pass hint_offset from ads_library_get_results.",
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
  maxTotalIds?: number;
  now?: () => number;
  /** Cache entries are scoped to the tenant that scanned the dataset; defaults to the Apify tenant of the request. */
  tenantId?: () => string;
}

export interface FoundDatasetItem {
  item: AdLibraryRawItem;
  offset: number;
}

export interface DatasetLookup {
  findDatasetItem(datasetId: string, adArchiveId: string, options?: { hintOffset?: number }): Promise<FoundDatasetItem>;
  stats(): { cached_datasets: number; cached_ids: number; in_flight: number };
}

interface CacheEntry {
  at: number;
  offsets: Map<string, number>;
  /** Items scanned so far (offset 0 .. scanned-1 are covered by the map). */
  scanned: number;
  /** True once a short page proved the dataset ends within the scanned range. */
  complete: boolean;
}

/**
 * Locates one scraped ad inside an Apify dataset. Reading a dataset is free on
 * Apify, so the only cost is latency and our own memory: the scan projects
 * records down to ad_archive_id (fields=) in large pages, remembers the
 * id -> offset map per tenant+dataset (well-formed ids only, bounded), resumes
 * a partial scan instead of restarting it, shares an in-flight scan between
 * concurrent callers, and only then fetches the single full record.
 *
 * skipHidden (not clean) keeps positional alignment with ads_library_get_results:
 * clean would drop items that become empty under the projection (the actor
 * error records), shifting every later offset.
 */
export function createDatasetLookup(config: DatasetLookupConfig = {}): DatasetLookup {
  const client = config.client ?? apifyApiClient;
  const pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxItems = config.maxItems ?? DEFAULT_MAX_ITEMS;
  const ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
  const maxDatasets = config.maxDatasets ?? DEFAULT_MAX_DATASETS;
  const maxTotalIds = config.maxTotalIds ?? DEFAULT_MAX_TOTAL_IDS;
  const now = config.now ?? Date.now;
  const tenantId = config.tenantId ?? resolveApifyTenantId;
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, { generation: number; promise: Promise<CacheEntry> }>();
  // Bumped on invalidation so a scan started before it can neither be reused nor published.
  const generations = new Map<string, number>();
  const generationOf = (key: string) => generations.get(key) ?? 0;
  const invalidate = (key: string) => {
    cache.delete(key);
    generations.set(key, generationOf(key) + 1);
  };

  const itemsPath = (datasetId: string) => "/v2/datasets/" + datasetId + "/items";
  const cacheKey = (datasetId: string) => tenantId() + ":" + datasetId;

  const fetchOne = async (datasetId: string, offset: number): Promise<AdLibraryRawItem | undefined> => {
    const items = await client.get<AdLibraryRawItem[]>(itemsPath(datasetId), {
      offset,
      limit: 1,
      skipHidden: true,
      format: "json",
    });
    return Array.isArray(items) ? items[0] : undefined;
  };

  const wellFormedId = (item: AdLibraryRawItem | undefined): string | null => {
    const id = archiveIdOf(item);
    return id !== null && AD_ARCHIVE_ID_PATTERN.test(id) ? id : null;
  };

  const totalIds = (): number => {
    let n = 0;
    for (const entry of cache.values()) n += entry.offsets.size;
    return n;
  };

  const purgeExpired = (): void => {
    const current = now();
    for (const [key, entry] of cache) {
      if (current - entry.at > ttlMs) cache.delete(key);
    }
  };

  const getCache = (key: string): CacheEntry | undefined => {
    purgeExpired();
    return cache.get(key);
  };

  const putCache = (key: string, entry: CacheEntry): void => {
    cache.delete(key);
    // An entry that alone exceeds the id budget is not worth keeping.
    if (entry.offsets.size > maxTotalIds) return;
    cache.set(key, entry);
    while (cache.size > maxDatasets || totalIds() > maxTotalIds) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  /** Scans from where a previous partial scan stopped, until the id shows up, the dataset ends, or the cap is hit. */
  const scanFrom = async (datasetId: string, adArchiveId: string, previous: CacheEntry | undefined): Promise<CacheEntry> => {
    const offsets = previous?.offsets ?? new Map<string, number>();
    let scanned = previous?.scanned ?? 0;
    let complete = previous?.complete ?? false;
    while (!complete && scanned < maxItems) {
      const limit = Math.min(pageSize, maxItems - scanned);
      const page = await client.get<AdLibraryRawItem[]>(itemsPath(datasetId), {
        offset: scanned,
        limit,
        fields: "ad_archive_id,adArchiveID",
        skipHidden: true,
        format: "json",
      });
      const items = Array.isArray(page) ? page : [];
      items.forEach((item, i) => {
        const id = wellFormedId(item);
        if (id && !offsets.has(id)) offsets.set(id, scanned + i);
      });
      scanned += items.length;
      if (items.length < limit) complete = true;
      if (offsets.has(adArchiveId)) break;
    }
    return { at: now(), offsets, scanned, complete };
  };

  const scan = async (key: string, datasetId: string, adArchiveId: string, previous: CacheEntry | undefined): Promise<CacheEntry> => {
    const generation = generationOf(key);
    const running = inFlight.get(key);
    if (running && running.generation === generation) return running.promise;
    const promise = scanFrom(datasetId, adArchiveId, previous)
      .then((entry) => {
        if (generationOf(key) === generation) putCache(key, entry);
        return entry;
      })
      .finally(() => {
        if (inFlight.get(key)?.promise === promise) inFlight.delete(key);
      });
    inFlight.set(key, { generation, promise });
    return promise;
  };

  const isExhausted = (entry: CacheEntry | undefined): boolean =>
    entry !== undefined && (entry.complete || entry.scanned >= maxItems);

  /** Scans (or joins a running scan) until the id shows up or the dataset is exhausted. */
  const locate = async (key: string, datasetId: string, adArchiveId: string): Promise<{ offset: number | undefined; entry: CacheEntry }> => {
    let entry = getCache(key);
    let offset = entry?.offsets.get(adArchiveId);
    // A shared scan may have stopped at another caller target; keep going from where it ended.
    for (let rounds = 0; offset === undefined && !isExhausted(entry) && rounds < 64; rounds++) {
      entry = await scan(key, datasetId, adArchiveId, entry);
      offset = entry.offsets.get(adArchiveId);
    }
    return { offset, entry: entry ?? { at: now(), offsets: new Map(), scanned: 0, complete: true } };
  };

  return {
    async findDatasetItem(rawDatasetId, rawAdArchiveId, options = {}) {
      const datasetId = validateApifyId(rawDatasetId, "dataset");
      const adArchiveId = validateAdArchiveId(rawAdArchiveId);
      const key = cacheKey(datasetId);

      if (options.hintOffset !== undefined && Number.isInteger(options.hintOffset) && options.hintOffset >= 0) {
        const item = await fetchOne(datasetId, options.hintOffset);
        if (item && archiveIdOf(item) === adArchiveId) return { item, offset: options.hintOffset };
      }

      const first = await locate(key, datasetId, adArchiveId);
      if (first.offset === undefined) {
        throw new DatasetItemNotFoundError(adArchiveId, datasetId, first.entry.scanned, !first.entry.complete);
      }
      const item = await fetchOne(datasetId, first.offset);
      if (item && archiveIdOf(item) === adArchiveId) return { item, offset: first.offset };

      // The dataset changed under a cached map: invalidate (which also retires any in-flight scan) and scan once more.
      invalidate(key);
      const second = await locate(key, datasetId, adArchiveId);
      if (second.offset !== undefined) {
        const fresh = await fetchOne(datasetId, second.offset);
        if (fresh && archiveIdOf(fresh) === adArchiveId) return { item: fresh, offset: second.offset };
      }
      throw new DatasetItemNotFoundError(adArchiveId, datasetId, second.entry.scanned, !second.entry.complete);
    },
    stats() {
      return { cached_datasets: cache.size, cached_ids: totalIds(), in_flight: inFlight.size };
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
