import { describe, expect, it } from "vitest";
import { validateAuthorizeQuery } from "../../src/transport/authorize-validation.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

const claudeClient: OAuthClientInformationFull = {
  client_id: "claude-client",
  client_name: "Claude.ai",
  redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "client_secret_post",
  client_id_issued_at: 0,
};

function makeGetClient(map: Record<string, OAuthClientInformationFull>) {
  return async (id: string) => map[id];
}

describe("validateAuthorizeQuery", () => {
  it("accepts a request with a registered client and matching redirect_uri", async () => {
    const r = await validateAuthorizeQuery(
      {
        client_id: "claude-client",
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      },
      makeGetClient({ "claude-client": claudeClient }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.redirectUri).toBe("https://claude.ai/api/mcp/auth_callback");
      expect(r.redirectOrigin).toBe("https://claude.ai");
    }
  });

  it("rejects when client_id is missing", async () => {
    const r = await validateAuthorizeQuery(
      { redirect_uri: "https://claude.ai/api/mcp/auth_callback" },
      makeGetClient({}),
    );
    expect(r).toEqual({
      ok: false,
      status: 400,
      message: expect.stringContaining("required"),
    });
  });

  it("rejects when redirect_uri is missing", async () => {
    const r = await validateAuthorizeQuery(
      { client_id: "claude-client" },
      makeGetClient({ "claude-client": claudeClient }),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects when the client is unknown", async () => {
    const r = await validateAuthorizeQuery(
      {
        client_id: "ghost-client",
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      },
      makeGetClient({}),
    );
    expect(r).toEqual({
      ok: false,
      status: 400,
      message: "Unknown client.",
    });
  });

  it("rejects redirect_uri not registered for the client (open-redirect defense)", async () => {
    const r = await validateAuthorizeQuery(
      {
        client_id: "claude-client",
        redirect_uri: "https://evil.example/steal",
      },
      makeGetClient({ "claude-client": claudeClient }),
    );
    expect(r).toEqual({
      ok: false,
      status: 400,
      message: "redirect_uri is not registered for this client.",
    });
  });

  it("rejects when redirect_uri is malformed even if it appears in the registered list", async () => {
    const weirdClient: OAuthClientInformationFull = {
      ...claudeClient,
      redirect_uris: ["not a url"],
    };
    const r = await validateAuthorizeQuery(
      { client_id: "claude-client", redirect_uri: "not a url" },
      makeGetClient({ "claude-client": weirdClient }),
    );
    expect(r).toEqual({
      ok: false,
      status: 400,
      message: "redirect_uri is malformed.",
    });
  });

  it("uses exact match (no path-prefix tricks)", async () => {
    const r = await validateAuthorizeQuery(
      {
        client_id: "claude-client",
        redirect_uri: "https://claude.ai/api/mcp/auth_callback/extra",
      },
      makeGetClient({ "claude-client": claudeClient }),
    );
    expect(r.ok).toBe(false);
  });

  it("uses exact match (no fragment tricks)", async () => {
    const r = await validateAuthorizeQuery(
      {
        client_id: "claude-client",
        redirect_uri: "https://claude.ai/api/mcp/auth_callback#extra",
      },
      makeGetClient({ "claude-client": claudeClient }),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects array values for client_id (Express duplicates) by collapsing to first then validating", async () => {
    const r = await validateAuthorizeQuery(
      {
        client_id: ["claude-client", "evil-client"],
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      },
      makeGetClient({ "claude-client": claudeClient }),
    );
    // first value used, valid client, valid redirect → accepted.
    expect(r.ok).toBe(true);
  });
});
