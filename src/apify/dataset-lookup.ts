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
  stats(): { cached_datasets: number; cached_ids: number; in_flight: number; generations: number; generation_ids: number[] };
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
  // Scans still running per key, including ones already superseded by a newer scan.
  const activeScans = new Map<string, number>();
  // Lookups currently between scans of a key; their generation must survive until they finish.
  const activeLocates = new Map<string, number>();
  // Generation identities come from one global counter and are allocated on
  // first use, so an identity is never reused: a scan started under an older
  // (or since forgotten) identity can never match the current one.
  let generationCounter = 0;
  const generations = new Map<string, number>();
  const generationOf = (key: string): number => {
    let generation = generations.get(key);
    if (generation === undefined) {
      generation = ++generationCounter;
      generations.set(key, generation);
    }
    return generation;
  };
  // Retires in-flight work for the key. With nothing in flight there is nothing
  // to retire, so the identity is simply dropped instead of left behind.
  const invalidate = (key: string) => {
    cache.delete(key);
    if ((activeScans.get(key) ?? 0) === 0 && (activeLocates.get(key) ?? 0) === 0) generations.delete(key);
    else generations.set(key, ++generationCounter);
  };
  const MAX_RESTARTS = 5;
  const maybeForget = (key: string) => {
    if (!cache.has(key) && (activeScans.get(key) ?? 0) === 0 && (activeLocates.get(key) ?? 0) === 0) generations.delete(key);
  };

  const itemsPath = (datasetId: string) => "/v2/datasets/" + datasetId + "/items";
  const cacheKey = (datasetId: string) => tenantId() + ":" + datasetId;

  const fetchOne = async (datasetId: string, offset: number): Promise<AdLibraryRawItem | undefined> => {
    const items = asPage(await client.get<unknown>(itemsPath(datasetId), {
      offset,
      limit: 1,
      skipHidden: true,
      format: "json",
    }));
    return items[0];
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
      if (current - entry.at > ttlMs) {
        cache.delete(key);
        maybeForget(key);
      }
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
      maybeForget(oldest);
    }
  };

  const asPage = (page: unknown): AdLibraryRawItem[] => {
    if (!Array.isArray(page)) {
      throw new McpError(ErrorCode.InternalError, "Unexpected dataset response from Apify (not an array of items).");
    }
    return page as AdLibraryRawItem[];
  };

  /** Scans from where a previous partial scan stopped, until the id shows up, the dataset ends, or the cap is hit. */
  const scanFrom = async (datasetId: string, adArchiveId: string, previous: CacheEntry | undefined): Promise<CacheEntry> => {
    const offsets = previous?.offsets ?? new Map<string, number>();
    let scanned = previous?.scanned ?? 0;
    let complete = previous?.complete ?? false;
    while (!complete && scanned < maxItems) {
      const limit = Math.min(pageSize, maxItems - scanned);
      const items = asPage(await client.get<unknown>(itemsPath(datasetId), {
        offset: scanned,
        limit,
        fields: "ad_archive_id,adArchiveID",
        skipHidden: true,
        format: "json",
      }));
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
    activeScans.set(key, (activeScans.get(key) ?? 0) + 1);
    const settle = () => {
      // Publication and unregistration happen in the same synchronous step, so
      // no caller can observe the published page while still joining this scan.
      if (inFlight.get(key)?.promise === promise) inFlight.delete(key);
      const remaining = (activeScans.get(key) ?? 1) - 1;
      if (remaining <= 0) activeScans.delete(key);
      else activeScans.set(key, remaining);
    };
    const promise: Promise<CacheEntry> = scanFrom(datasetId, adArchiveId, previous).then(
      (entry) => {
        if (generations.get(key) === generation) putCache(key, entry);
        settle();
        maybeForget(key);
        return entry;
      },
      (err: unknown) => {
        settle();
        maybeForget(key);
        throw err;
      },
    );
    inFlight.set(key, { generation, promise });
    return promise;
  };

  const isExhausted = (entry: CacheEntry | undefined): boolean =>
    entry !== undefined && (entry.complete || entry.scanned >= maxItems);

  /**
   * Scans (or joins a running scan) until the id shows up or the dataset is
   * exhausted. Terminates on progress, not on a round count: a shared scan may
   * stop at another caller target, so the loop continues from where it ended,
   * and a generation change (invalidation while waiting) restarts from the
   * current cache instead of carrying a stale map forward.
   */
  const locate = async (key: string, datasetId: string, adArchiveId: string): Promise<{ offset: number | undefined; entry: CacheEntry }> => {
    activeLocates.set(key, (activeLocates.get(key) ?? 0) + 1);
    try {
      return await locateInner(key, datasetId, adArchiveId);
    } finally {
      const remaining = (activeLocates.get(key) ?? 1) - 1;
      if (remaining <= 0) activeLocates.delete(key);
      else activeLocates.set(key, remaining);
      maybeForget(key);
    }
  };

  const locateInner = async (key: string, datasetId: string, adArchiveId: string): Promise<{ offset: number | undefined; entry: CacheEntry }> => {
    let restarts = 0;
    let stalls = 0;
    for (;;) {
      const generation = generationOf(key);
      const entry = getCache(key);
      const offset = entry?.offsets.get(adArchiveId);
      if (offset !== undefined) return { offset, entry: entry as CacheEntry };
      if (isExhausted(entry)) return { offset: undefined, entry: entry as CacheEntry };
      const before = entry?.scanned ?? 0;
      const result = await scan(key, datasetId, adArchiveId, entry);
      if (generations.get(key) !== generation) {
        if (++restarts > MAX_RESTARTS) {
          throw new McpError(ErrorCode.InternalError, "Dataset " + datasetId + " is changing too fast to locate ad " + adArchiveId + "; retry later or pass hint_offset.");
        }
        continue;
      }
      const found = result.offsets.get(adArchiveId);
      if (found !== undefined) return { offset: found, entry: result };
      if (isExhausted(result)) return { offset: undefined, entry: result };
      // A joined scan may already be reflected in the cache; only two stalls in a row mean a real problem.
      if (result.scanned <= before && ++stalls >= 2) {
        throw new McpError(ErrorCode.InternalError, "Dataset scan made no progress; Apify returned an inconsistent page. Retry, or pass hint_offset.");
      }
      if (result.scanned > before) stalls = 0;
    }
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
        invalidate(key);
        throw new McpError(ErrorCode.InternalError, "Dataset " + datasetId + " is changing too fast to locate ad " + adArchiveId + "; retry later or pass hint_offset.");
      }
      throw new DatasetItemNotFoundError(adArchiveId, datasetId, second.entry.scanned, !second.entry.complete);
    },
    stats() {
      purgeExpired();
      return { cached_datasets: cache.size, cached_ids: totalIds(), in_flight: inFlight.size, generations: generations.size, generation_ids: [...generations.values()] };
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
