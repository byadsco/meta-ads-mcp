import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

export type AuthorizeValidationResult =
  | { ok: true; redirectUri: string; redirectOrigin: string }
  | { ok: false; status: number; message: string };

export interface AuthorizeQuery {
  client_id?: string | string[];
  redirect_uri?: string | string[];
  [key: string]: unknown;
}

function single(value: string | string[] | undefined): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string")
    return value[0];
  return "";
}

/**
 * Validate the OAuth authorization request before rendering the consent
 * page or kicking off the upstream login flow.
 *
 * This protects against an open redirect / phishing vector where the
 * "Deny" form on the consent page submits to query.redirect_uri: without
 * this check, an attacker could craft a /authorize URL with
 * redirect_uri=https://evil.example/ pointing at any registered client
 * and ride the user's session into an arbitrary host. mcp-sdk validates
 * these in POST /authorize but the GET handler used to reflect the
 * value verbatim.
 */
export async function validateAuthorizeQuery(
  query: AuthorizeQuery,
  getClient: (
    clientId: string,
  ) => Promise<OAuthClientInformationFull | undefined>,
): Promise<AuthorizeValidationResult> {
  const clientId = single(query.client_id);
  const redirectUri = single(query.redirect_uri);

  if (!clientId || !redirectUri) {
    return {
      ok: false,
      status: 400,
      message: "client_id and redirect_uri are required.",
    };
  }

  const client = await getClient(clientId);
  if (!client) {
    return { ok: false, status: 400, message: "Unknown client." };
  }

  const registered = client.redirect_uris ?? [];
  if (!registered.includes(redirectUri)) {
    return {
      ok: false,
      status: 400,
      message: "redirect_uri is not registered for this client.",
    };
  }

  let redirectOrigin: string;
  try {
    redirectOrigin = new URL(redirectUri).origin;
  } catch {
    return {
      ok: false,
      status: 400,
      message: "redirect_uri is malformed.",
    };
  }

  return { ok: true, redirectUri, redirectOrigin };
}
