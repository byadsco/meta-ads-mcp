import { requestContext } from "../auth/token-store.js";
import { validateMetaId } from "../utils/format.js";
import { scrubCredentialsDeep, scrubErrorCredentials } from "../utils/scrub-credentials.js";
import { metaApiClient } from "./client.js";

/**
 * Runs `work` with a Page access token instead of the person's. The token is
 * fetched for this one operation with the person's own token and lives only
 * in memory for its duration: it is never logged, returned or stored. Editing
 * a Page post needs it (with pages_manage_posts), and so do the Page's lead
 * forms (with pages_manage_ads).
 */
export async function withPageToken<T>(pageId: string, work: () => Promise<T>, timeoutMs?: number): Promise<T> {
  const page = await metaApiClient.get<{ access_token?: string }>(
    `/${validateMetaId(pageId, "page")}`,
    { fields: "access_token" },
    timeoutMs === undefined ? undefined : { timeoutMs },
  );
  if (!page.access_token) {
    throw new Error(`Meta returned no Page access token for page ${pageId}: the person has to manage the Page, with pages_manage_posts to edit its posts or pages_manage_ads for its lead forms.`);
  }
  let result: T;
  try {
    result = await requestContext.run({ ...requestContext.getStore(), accessToken: page.access_token }, work);
  } catch (err) {
    throw scrubErrorCredentials(err, page.access_token);
  }
  // Whatever Meta answered with the Page token (a field it echoed, an
  // expansion that reached the Page) goes back without it.
  return scrubCredentialsDeep(result, page.access_token);
}

export async function grantedPermissions(): Promise<Set<string>> {
  const res = await metaApiClient.get<{ data?: Array<{ permission?: string; status?: string }> }>("/me/permissions");
  return new Set(
    (res.data ?? [])
      .filter((p) => p.status === "granted" && typeof p.permission === "string")
      .map((p) => p.permission as string),
  );
}
