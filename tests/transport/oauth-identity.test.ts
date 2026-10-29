import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import expressApp from "express";
import cookieParser from "cookie-parser";
import type express from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { oauthProvider, resetOAuthProviderForTests } from "../../src/auth/oauth-provider.js";
import {
  buildMetaTokenMiddleware,
  configureMultiTenantOAuth,
  mountAuthorization,
  onlyExactAuthorizePath,
} from "../../src/transport/http.js";
import { getAccessToken, getCurrentFbUserId } from "../../src/auth/token-store.js";
import { tokenManager } from "../../src/auth/token-manager.js";
import { configureMetaTokenRepo, InMemoryMetaTokenRepo } from "../../src/store/meta-token-repo.js";
import { registerTokenTools } from "../../src/tools/tokens.js";
import { createMockMcpServer } from "../setup.js";

const SERVER_URL = new URL("https://mcp.example.com");

// Runs the middleware and reports the request context its `next` sees.
async function contextFor(req: Partial<express.Request> & { auth?: unknown }) {
  const middleware = buildMetaTokenMiddleware(SERVER_URL, true);
  return new Promise<{ accessToken: string; fbUserId?: string }>((resolve, reject) => {
    const res = { status: () => ({ json: (body: unknown) => reject(new Error(JSON.stringify(body))) }) } as unknown as express.Response;
    void middleware(req as express.Request, res, () => resolve({ accessToken: getAccessToken(), fbUserId: getCurrentFbUserId() }));
  });
}

describe("the X-Meta-Token header", () => {
  // Without the identity, the token tools fell back to the process-wide
  // token registry, which every tenant shares.
  it("keeps the OAuth user's identity next to the token it carries", async () => {
    const seen = await contextFor({ headers: { "x-meta-token": "header-token" }, auth: { extra: { fbUserId: "1001" } } });
    expect(seen).toEqual({ accessToken: "header-token", fbUserId: "1001" });
  });

  it("lists the user's own tokens, never the process-wide registry", async () => {
    configureMetaTokenRepo(new InMemoryMetaTokenRepo());
    tokenManager.registerToken("BM_GLOBAL", "global-token-value");
    const server = createMockMcpServer();
    registerTokenTools(server as never);
    const listTokens = server._registeredTools.find((t) => t.name === "ads_list_tokens")!;

    const middleware = buildMetaTokenMiddleware(SERVER_URL, true);
    const text = await new Promise<string>((resolve, reject) => {
      const req = { headers: { "x-meta-token": "header-token" }, auth: { extra: { fbUserId: "1001" } } } as unknown as express.Request;
      const res = { status: () => ({ json: (body: unknown) => reject(new Error(JSON.stringify(body))) }) } as unknown as express.Response;
      void middleware(req, res, () => {
        (listTokens.handler({}) as Promise<{ content: Array<{ text: string }> }>)
          .then((result) => resolve(result.content.map((c) => c.text).join("\n")), reject);
      });
    });

    expect(text).not.toContain("BM_GLOBAL");
    tokenManager.resetForTests();
  });

  // An OAuth bearer without a user would otherwise run on the server's own
  // token (the registry or META_ACCESS_TOKEN).
  it.each([
    ["without a header", {}],
    ["with a header", { "x-meta-token": "header-token" }],
  ])("refuses an OAuth bearer that names no user, %s", async (_label, headers) => {
    tokenManager.registerToken("BM_GLOBAL", "global-token-value");
    const outcome = await contextFor({ headers, auth: { extra: {} } }).then(() => "ran", (e: Error) => e.message);
    tokenManager.resetForTests();
    expect(outcome).toMatch(/-32001/);
  });

  it("carries no identity for an API-key caller, which has none", async () => {
    const seen = await contextFor({ headers: { "x-meta-token": "header-token" } });
    expect(seen).toEqual({ accessToken: "header-token", fbUserId: undefined });
  });
});

describe("the authorize path guard", () => {
  // The SDK answers any path under /authorize (router.use), while the session
  // check matched only /authorize and /authorize/: /authorize// reached the
  // SDK without a signed-in user.
  it.each(["//", "///", "/x"])("refuses %s under /authorize", (path) => {
    let status = 0;
    let advanced = false;
    const res = { status: (code: number) => { status = code; return { end: () => undefined }; } } as unknown as express.Response;
    onlyExactAuthorizePath({ path } as express.Request, res, () => { advanced = true; });
    expect([status, advanced]).toEqual([404, false]);
  });

  // Through Express and the SDK's own router: even a path that reached the
  // SDK unchecked gets no code once the provider requires a signed-in user.
  it("gets no code from the SDK's authorize handler without a signed-in user", async () => {
    resetOAuthProviderForTests();
    oauthProvider.configure({ requireIdentity: true });
    await oauthProvider.clientsStore.registerClient!({
      client_id: "c1", client_id_issued_at: 0, redirect_uris: ["https://client.example.com/cb"],
      grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none",
    });
    const app = expressApp();
    app.use(mcpAuthRouter({ provider: oauthProvider, issuerUrl: new URL("http://localhost") }));
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    const query = new URLSearchParams({
      client_id: "c1", redirect_uri: "https://client.example.com/cb", response_type: "code",
      code_challenge: "x".repeat(43), code_challenge_method: "S256",
    });

    const response = await fetch(`http://127.0.0.1:${port}/authorize//?${query}`, { redirect: "manual" });
    server.close();
    resetOAuthProviderForTests();

    const location = new URL(response.headers.get("location") ?? "http://none/");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.has("code")).toBe(false);
  });

  it("lets /authorize itself through", () => {
    let advanced = false;
    onlyExactAuthorizePath({ path: "/" } as express.Request, {} as express.Response, () => { advanced = true; });
    expect(advanced).toBe(true);
  });
});

// The routes exactly as the server mounts them in multi-tenant mode.
describe("the authorization routes as mounted", () => {
  const query = new URLSearchParams({
    client_id: "c1", redirect_uri: "https://client.example.com/cb", response_type: "code",
    code_challenge: "x".repeat(43), code_challenge_method: "S256",
  });
  let base = "";
  let server: ReturnType<express.Express["listen"]>;

  beforeAll(async () => {
    configureMultiTenantOAuth();
    await oauthProvider.clientsStore.registerClient!({
      client_id: "c1", client_id_issued_at: 0, redirect_uris: ["https://client.example.com/cb"],
      grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none",
    });
    const app = expressApp();
    app.use(cookieParser());
    app.use(expressApp.json());
    mountAuthorization(app, new URL("http://localhost"), true);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
    resetOAuthProviderForTests();
  });

  const send = (method: string, path: string) => method === "GET"
    ? fetch(`${base}${path}?${query}`, { redirect: "manual" })
    : fetch(`${base}${path}`, { method, redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: query.toString() });

  it.each([
    ["GET", "/authorize//"], ["POST", "/authorize//"], ["GET", "/AUTHORIZE//"], ["POST", "/Authorize//"],
    ["GET", "/authorize///"], ["GET", "/authorize/x"], ["POST", "/authorize/x"],
  ])("answers 404 to %s %s, issuing no code", async (method, path) => {
    const response = await send(method, path);
    expect(response.status).toBe(404);
    expect(response.headers.get("location") ?? "").not.toContain("code=");
  });

  it("sends a GET of /authorize without a session to Meta login", async () => {
    const response = await send("GET", "/authorize");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toMatch(/^\/auth\/meta\?/);
  });

  it("refuses a POST of /authorize without a session", async () => {
    expect((await send("POST", "/authorize")).status).toBe(401);
  });

  it("configures the provider to issue nothing without a signed-in user", async () => {
    const res = { redirect: () => undefined } as unknown as express.Response;
    await expect(oauthProvider.authorize(
      (await oauthProvider.clientsStore.getClient("c1"))!,
      { codeChallenge: "x".repeat(43), redirectUri: "https://client.example.com/cb", scopes: [] },
      res,
    )).rejects.toThrow(/Sign in with Meta/);
  });
});
