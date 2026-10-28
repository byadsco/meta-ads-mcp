import { getAccessToken } from "../auth/token-store.js";
import { scrubCredentialsDeep } from "../utils/scrub-credentials.js";
import { metaApiClient } from "./client.js";
import type { MetaApiResponse } from "./types/index.js";

/**
 * A Meta answer with every credential removed: credential-named fields and
 * name=value pairs, and the caller's own token wherever it appears. The
 * client cleans errors; successful answers carry third-party text (names,
 * URLs, old and new values) that can hold one too.
 */
export function scrubbed<T>(value: T): T {
  let token: string | undefined;
  try {
    token = getAccessToken();
  } catch {
    token = undefined;
  }
  return scrubCredentialsDeep(value, token);
}

// Meta can send empty pages that still go on, so pages are bounded apart from items.
const MAX_PAGES = 20;

export interface ListRead<T> {
  items: T[];
  /** True only when Meta ended the list itself: anything else proves nobody's absence. */
  complete: boolean;
  total?: number;
}

/**
 * Every page of a Graph list, up to `max` items. Meta ends a list only by
 * leaving `next` out (a page can be empty and still have one), so a list is
 * complete only then. A next page without a cursor, a cursor seen before, or
 * running into a limit all leave it incomplete.
 */
export async function readList<T>(
  path: string,
  params: Record<string, string | number>,
  max: number,
  maxPages = MAX_PAGES,
): Promise<ListRead<T>> {
  const items: T[] = [];
  const cursors = new Set<string>();
  let total: number | undefined;
  let after: string | undefined;
  for (let page = 0; page < maxPages && items.length < max; page++) {
    const res = await metaApiClient.get<MetaApiResponse<T> & { summary?: { total_count?: number } }>(
      path,
      after === undefined ? params : { ...params, after },
    );
    total ??= res.summary?.total_count;
    items.push(...scrubbed(res.data ?? []));
    if (!res.paging?.next) return { items, complete: true, total };
    after = res.paging.cursors?.after;
    if (!after || cursors.has(after)) break;
    cursors.add(after);
  }
  return { items, complete: false, total };
}
