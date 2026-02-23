import type { MetaApiResponse, Paging } from "./types/common.js";

/**
 * Helper to handle cursor-based pagination from the Meta Graph API.
 */
export function hasNextPage(paging?: Paging): boolean {
  return !!paging?.next || !!paging?.cursors?.after;
}

export function getAfterCursor(paging?: Paging): string | undefined {
  return paging?.cursors?.after;
}

/**
 * Collect all pages from a paginated Meta API response.
 * Uses a callback to fetch subsequent pages.
 *
 * @param firstPage - The initial API response
 * @param fetchPage - Function to fetch the next page given an "after" cursor
 * @param maxItems - Maximum total items to collect (default: 1000)
 */
export async function collectAllPages<T>(
  firstPage: MetaApiResponse<T>,
  fetchPage: (after: string) => Promise<MetaApiResponse<T>>,
  maxItems = 1000,
): Promise<T[]> {
  const items: T[] = [...firstPage.data];

  let paging = firstPage.paging;
  while (items.length < maxItems && hasNextPage(paging)) {
    const after = getAfterCursor(paging);
    if (!after) break;

    const nextPage = await fetchPage(after);
    items.push(...nextPage.data);
    paging = nextPage.paging;
  }

  return items.slice(0, maxItems);
}
