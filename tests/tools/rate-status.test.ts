import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerRateStatusTools } from "../../src/tools/rate-status.js";
import { metaApiClient } from "../../src/meta/client.js";
import { hashToken, requestContext } from "../../src/auth/token-store.js";
import { createMockMcpServer, mockFetchResponse } from "../setup.js";

type TextResult = { content: Array<{ type: string; text: string }> };

const TOKEN_A = "token-of-tenant-a";
const TOKEN_B = "token-of-tenant-b";

// Each HTTP request carries its tenant's token in the request context.
const as = <T,>(token: string, work: () => Promise<T>) => requestContext.run({ accessToken: token }, work);

async function rateStatus(token: string): Promise<string> {
  const server = createMockMcpServer();
  registerRateStatusTools(server as never);
  const result = await as(token, () => server._registeredTools[0].handler({}) as Promise<TextResult>);
  return result.content.map((c) => c.text).join("\n");
}

async function callMeta(token: string, account: string, response: Response) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  await as(token, () => metaApiClient.postForm(`/${account}/campaigns`, { name: "x" })).catch(() => undefined);
}

// One server process holds every tenant's rate-limit, circuit and pacing
// state; a tenant sees only its own token's.
describe("ads_rate_status", () => {
  beforeEach(() => {
    metaApiClient.resetForTests();
  });

  afterEach(() => {
    metaApiClient.resetForTests();
    vi.restoreAllMocks();
  });

  it("shows only the state of the token in use", async () => {
    const usage = { "x-app-usage": JSON.stringify({ call_count: 12, total_cputime: 3, total_time: 4 }), "x-ad-account-usage": JSON.stringify({ acc_id_util_pct: 7 }) };
    await callMeta(TOKEN_A, "act_111111", mockFetchResponse({ id: "1" }, { headers: usage }));
    await callMeta(TOKEN_B, "act_999999", mockFetchResponse({ id: "2" }, { headers: usage }));
    await callMeta(TOKEN_B, "act_999999", mockFetchResponse(
      { error: { message: "Tenant B private detail", type: "OAuthException", code: 613, error_subcode: 1996 } },
      { status: 400 },
    ));

    const textA = await rateStatus(TOKEN_A);
    const textB = await rateStatus(TOKEN_B);

    expect(textA).toContain("act_111111");
    expect(textA).toContain(hashToken(TOKEN_A));
    for (const other of ["act_999999", hashToken(TOKEN_B), "Tenant B private detail"]) expect(textA).not.toContain(other);
    expect(textB).toContain("act_999999");
    expect(textB).toContain("Tenant B private detail");
    expect(textB).not.toContain("act_111111");
    expect(textB).not.toContain(hashToken(TOKEN_A));
  });

  it("says nothing was recorded for a token that has made no calls", async () => {
    await callMeta(TOKEN_B, "act_999999", mockFetchResponse({ id: "1" }, { headers: { "x-app-usage": JSON.stringify({ call_count: 5 }) } }));

    expect(await rateStatus(TOKEN_A)).toMatch(/No Meta API usage recorded yet for the token in use/);
  });
});
