import { requestContext } from "../auth/token-store.js";
import { validateMetaId } from "../utils/format.js";
import { metaApiClient } from "./client.js";

/**
 * Runs `work` with a Page access token instead of the person's. The token is
 * fetched for this one operation with the person's own token and lives only
 * in memory for its duration: it is never logged, returned or stored. Editing
 * a Page post needs it, and the person needs pages_manage_posts on the Page.
 */
export async function withPageToken<T>(pageId: string, work: () => Promise<T>): Promise<T> {
  const page = await metaApiClient.get<{ access_token?: string }>(`/${validateMetaId(pageId, "page")}`, {
    fields: "access_token",
  });
  if (!page.access_token) {
    throw new Error(`Meta returned no Page access token for page ${pageId}: the person has to manage the Page and grant pages_manage_posts.`);
  }
  return requestContext.run({ ...requestContext.getStore(), accessToken: page.access_token }, work);
}

export async function grantedPermissions(): Promise<Set<string>> {
  const res = await metaApiClient.get<{ data?: Array<{ permission?: string; status?: string }> }>("/me/permissions");
  return new Set(
    (res.data ?? [])
      .filter((p) => p.status === "granted" && typeof p.permission === "string")
      .map((p) => p.permission as string),
  );
}
