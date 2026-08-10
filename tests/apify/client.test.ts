import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  ApifyApiClient,
  maskApifyToken,
  resolveApifyTenantId,
  resolveApifyToken,
  scrubApifyToken,
  validateApifyId,
} from "../../src/apify/client.js";
import {
  InMemoryApifyTokenRepo,
  configureApifyTokenRepoForTests,
} from "../../src/store/apify-token-repo.js";
import { resetKeyCacheForTests } from "../../src/auth/crypto.js";
import { mockFetchResponse } from "../setup.js";

// Kept under the 20-char suffix that .gitleaks.toml's apify-api-token rule
// matches, so this fixture never trips the secret scanner.
const TOKEN = "apify_api_testfixture";

describe("apify client", () => {
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = "b".repeat(64);
    resetKeyCacheForTests();
    configureApifyTokenRepoForTests(new InMemoryApifyTokenRepo());
    process.env.APIFY_TOKEN = TOKEN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.APIFY_TOKEN;
    delete process.env.TOKEN_ENCRYPTION_KEY;
    resetKeyCacheForTests();
    configureApifyTokenRepoForTests(undefined);
  });

  describe("token handling", () => {
    it("sends the token as a Bearer header and never in the URL", async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse({ data: { ok: true } }));
      vi.stubGlobal("fetch", fetchMock);

      await new ApifyApiClient().get("/v2/users/me");

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.apify.com/v2/users/me");
      expect(url).not.toContain(TOKEN);
      expect(url).not.toContain("token");
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    });

    it("keeps the token out of the URL even when query params are present", async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse([]));
      vi.stubGlobal("fetch", fetchMock);

      await new ApifyApiClient().get("/v2/datasets/abc12/items", { offset: 10, limit: 5 });

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toBe("https://api.apify.com/v2/datasets/abc12/items?offset=10&limit=5");
      expect(url).not.toContain("apify_api");
    });

    it("prefers a tokenOverride over the resolved token", async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse({ data: {} }));
      vi.stubGlobal("fetch", fetchMock);

      await new ApifyApiClient().get("/v2/users/me", undefined, "apify_api_candidate");

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer apify_api_candidate",
      );
    });

    it("resolves the per-tenant stored token ahead of the env fallback", async () => {
      const repo = new InMemoryApifyTokenRepo();
      await repo.saveToken("_local", "apify_api_stored", null);
      configureApifyTokenRepoForTests(repo);

      expect(await resolveApifyToken()).toBe("apify_api_stored");
    });

    it("falls back to APIFY_TOKEN when nothing is stored", async () => {
      expect(await resolveApifyToken()).toBe(TOKEN);
    });

    it("throws actionable guidance when no token is available at all", async () => {
      delete process.env.APIFY_TOKEN;

      await expect(resolveApifyToken()).rejects.toThrow(/ads_library_register_apify_token/);
    });
  });

  describe("tenant isolation", () => {
    const savedAppId = process.env.META_APP_ID;
    const savedAppSecret = process.env.META_APP_SECRET;

    function enableMultiTenant() {
      process.env.META_APP_ID = "1234567890";
      process.env.META_APP_SECRET = "f".repeat(32);
    }

    afterEach(() => {
      if (savedAppId === undefined) delete process.env.META_APP_ID;
      else process.env.META_APP_ID = savedAppId;
      if (savedAppSecret === undefined) delete process.env.META_APP_SECRET;
      else process.env.META_APP_SECRET = savedAppSecret;
    });

    it("uses the _local bucket only when no OAuth app is configured", () => {
      expect(resolveApifyTenantId()).toBe("_local");
    });

    it("refuses to resolve a tenant for an unidentified caller in multi-tenant mode", () => {
      enableMultiTenant();

      // An API-key request has no fbUserId. It must not land in the shared
      // _local bucket alongside every other unidentified caller.
      expect(() => resolveApifyTenantId()).toThrow(/authenticated user in multi-tenant mode/);
    });

    it("never falls back to the server-wide APIFY_TOKEN in multi-tenant mode", async () => {
      enableMultiTenant();
      process.env.APIFY_TOKEN = TOKEN;

      await expect(resolveApifyToken()).rejects.toThrow(/authenticated user in multi-tenant mode/);
    });

    it("scopes a stored token to its own tenant", async () => {
      const repo = new InMemoryApifyTokenRepo();
      await repo.saveToken("user-a", "apify_api_aaa", null);
      configureApifyTokenRepoForTests(repo);

      expect(await repo.getDecryptedToken("user-a")).toBe("apify_api_aaa");
      expect(await repo.getDecryptedToken("user-b")).toBeNull();
    });
  });

  describe("retries", () => {
    it("retries a GET on 500 and succeeds", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(mockFetchResponse({ error: { message: "boom" } }, { status: 500 }))
        .mockResolvedValueOnce(mockFetchResponse({ data: { ok: true } }));
      vi.stubGlobal("fetch", fetchMock);

      const result = await new ApifyApiClient({ maxRetries: 2 }).get<{ data: { ok: boolean } }>(
        "/v2/users/me",
      );

      expect(result.data.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("never retries a POST, so a run is never started twice", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(mockFetchResponse({ error: { message: "boom" } }, { status: 500 }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        new ApifyApiClient({ maxRetries: 3 }).post("/v2/acts/x/runs", { urls: [] }),
      ).rejects.toThrow(McpError);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("flags a POST body-read failure as indeterminate, not as a safe failure", async () => {
      // Apify accepted the run (201) but the body never completed. The client
      // must not let the caller read this as "nothing happened".
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 201,
          headers: new Headers(),
          json: async () => {
            throw new SyntaxError("Unexpected end of JSON input");
          },
        } as unknown as Response),
      );

      await expect(new ApifyApiClient({ maxRetries: 0 }).post("/v2/acts/x/runs")).rejects.toThrow(
        /may still have been accepted/,
      );
    });

    it("does not add the indeterminate warning to a retryable GET", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

      const error = await new ApifyApiClient({ maxRetries: 0 })
        .get("/v2/users/me")
        .catch((e: Error) => e);

      expect(error.message).not.toContain("may still have been accepted");
    });

    it("does not retry a 429", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          mockFetchResponse({ error: { type: "rate-limit-exceeded" } }, { status: 429 }),
        );
      vi.stubGlobal("fetch", fetchMock);

      await expect(new ApifyApiClient({ maxRetries: 3 }).get("/v2/users/me")).rejects.toThrow(
        /rate limit/i,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("error mapping", () => {
    it("maps 401 to guidance about re-registering", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          mockFetchResponse({ error: { type: "token-not-found", message: "bad token" } }, { status: 401 }),
        ),
      );

      await expect(new ApifyApiClient().get("/v2/users/me")).rejects.toThrow(
        /ads_library_register_apify_token/,
      );
    });

    it("maps 402 to a billing hint", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          mockFetchResponse({ error: { type: "insufficient-credit" } }, { status: 402 }),
        ),
      );

      await expect(new ApifyApiClient().post("/v2/acts/x/runs")).rejects.toThrow(/billing|credits/i);
    });

    it("maps 404 to InvalidParams", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          mockFetchResponse({ error: { type: "record-not-found" } }, { status: 404 }),
        ),
      );

      await expect(new ApifyApiClient().get("/v2/actor-runs/abc12")).rejects.toThrow(/not found/i);
    });

    it("scrubs a token echoed back inside an Apify error body", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          mockFetchResponse(
            { error: { type: "bad-request", message: `token ${TOKEN} is malformed` } },
            { status: 400 },
          ),
        ),
      );

      const error = await new ApifyApiClient().get("/v2/users/me").catch((e: Error) => e);

      expect(error.message).not.toContain(TOKEN);
      expect(error.message).toContain("[REDACTED]");
      expect(error.message).toContain("is malformed");
    });

    it("scrubs an apify_api_ token echoed back when it is not the token in play", async () => {
      const other = "apify_api_someoneelsestoken";
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          mockFetchResponse(
            { error: { type: "bad-request", message: `conflict with ${other}` } },
            { status: 400 },
          ),
        ),
      );

      const error = await new ApifyApiClient().get("/v2/users/me").catch((e: Error) => e);

      expect(error.message).not.toContain(other);
      expect(error.message).toContain("apify_api_[REDACTED]");
    });

    it("scrubs a token surfaced through a transport error", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error(`connect failed for ${TOKEN}`)),
      );

      const error = await new ApifyApiClient({ maxRetries: 0 })
        .post("/v2/acts/x/runs")
        .catch((e: Error) => e);

      expect(error.message).not.toContain(TOKEN);
      expect(error.message).toContain("[REDACTED]");
    });
  });

  describe("validateApifyId", () => {
    it("accepts a normal Apify id", () => {
      expect(validateApifyId("XtaWFhbtfxyzqrFmd", "run")).toBe("XtaWFhbtfxyzqrFmd");
    });

    it.each([
      ["../../v2/users/me", "path traversal"],
      ["", "empty"],
      ["abc12?foo=bar", "query string"],
      ["abc 12", "whitespace"],
      ["abc/def", "slash"],
      ["a".repeat(64), "too long"],
    ])("rejects %s (%s)", (id) => {
      expect(() => validateApifyId(id, "run")).toThrow(McpError);
    });
  });

  describe("helpers", () => {
    it("scrubApifyToken removes every occurrence", () => {
      const scrubbed = scrubApifyToken(`a ${TOKEN} b ${TOKEN} c`);
      expect(scrubbed).not.toContain(TOKEN);
      expect(scrubbed.match(/apify_api_\[REDACTED\]/g)).toHaveLength(2);
    });

    it("scrubApifyToken also removes an exact token that does not match the pattern", () => {
      const odd = "legacy-style-token-value";
      const scrubbed = scrubApifyToken(`failed for ${odd}`, odd);
      expect(scrubbed).not.toContain(odd);
      expect(scrubbed).toContain("[REDACTED]");
    });

    it("scrubApifyToken does not fragment a longer token that the exact value prefixes", () => {
      // Regression: replacing the exact value first split "apify_api_abcdefXYZ"
      // into "[REDACTED]defXYZ", after which the generic pattern no longer
      // recognised the remainder and the suffix leaked.
      const scrubbed = scrubApifyToken("saw apify_api_abcdefXYZ here", "apify_api_abc");
      expect(scrubbed).not.toContain("defXYZ");
      expect(scrubbed).toBe("saw apify_api_[REDACTED] here");
    });

    it("scrubApifyToken handles regex metacharacters in the exact token", () => {
      const weird = "tok+en(with)[meta].chars";
      const scrubbed = scrubApifyToken(`failed for ${weird}`, weird);
      expect(scrubbed).not.toContain(weird);
      expect(scrubbed).toContain("[REDACTED]");
    });

    it("scrubApifyToken leaves no tail when the exact token only partly matches the pattern", () => {
      // The pattern stops at the hyphen. Scrubbing the exact value must happen
      // first, or "-secret" survives.
      const hybrid = "apify_api_abc123def456-secret";
      const scrubbed = scrubApifyToken(`token ${hybrid} rejected`, hybrid);
      expect(scrubbed).not.toContain(hybrid);
      expect(scrubbed).not.toContain("-secret");
    });

    it("maskApifyToken reveals only the non-secret prefix", () => {
      const masked = maskApifyToken(TOKEN);
      expect(masked).toBe("apify_api_***");
      // Not one character of the secret body survives.
      expect(TOKEN.slice("apify_api_".length)).not.toBe("");
      expect(masked).not.toContain(TOKEN.slice("apify_api_".length));
    });

    it("maskApifyToken fully hides values with no known prefix", () => {
      expect(maskApifyToken("some-other-credential")).toBe("***");
    });
  });
});
