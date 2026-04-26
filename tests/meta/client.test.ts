import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MetaApiClient } from "../../src/meta/client.js";
import { setupTestToken, cleanupTestToken, mockFetchResponse } from "../setup.js";
import { tokenManager } from "../../src/auth/token-manager.js";

describe("MetaApiClient", () => {
  let client: MetaApiClient;

  beforeEach(() => {
    setupTestToken();
    tokenManager.resetForTests();
    client = new MetaApiClient({
      apiVersion: "v22.0",
      baseUrl: "https://graph.facebook.com",
      timeout: 5000,
      maxRetries: 0,
    });
  });

  afterEach(() => {
    cleanupTestToken();
    tokenManager.resetForTests();
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("uses default config when none provided", () => {
      const defaultClient = new MetaApiClient();
      // Just verify it constructs without error
      expect(defaultClient).toBeDefined();
    });

    it("respects custom API version", async () => {
      const customClient = new MetaApiClient({
        apiVersion: "v21.0",
        maxRetries: 0,
      });

      const mockResponse = mockFetchResponse({ data: [] });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

      await customClient.get("/me/adaccounts");
      const fetchCall = vi.mocked(fetch).mock.calls[0];
      expect(fetchCall[0]).toContain("v21.0");
    });
  });

  describe("get", () => {
    it("makes GET request with correct URL", async () => {
      const mockResponse = mockFetchResponse({ id: "123", name: "Test" });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

      const result = await client.get<{ id: string; name: string }>("/123", {
        fields: "id,name",
      });

      expect(result).toEqual({ id: "123", name: "Test" });
      const url = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
      expect(url.pathname).toBe("/v22.0/123");
      expect(url.searchParams.get("fields")).toBe("id,name");
      expect(url.searchParams.get("access_token")).toBe("test-access-token");
    });

    it("omits undefined params", async () => {
      const mockResponse = mockFetchResponse({ data: [] });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

      await client.get("/me/adaccounts", {
        fields: "id",
        limit: undefined,
      });

      const url = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
      expect(url.searchParams.has("limit")).toBe(false);
    });
  });

  describe("post", () => {
    it("makes POST request with JSON body", async () => {
      const mockResponse = mockFetchResponse({ id: "new_123" });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

      const result = await client.post<{ id: string }>("/act_123/campaigns", {
        name: "Test Campaign",
        objective: "OUTCOME_TRAFFIC",
      });

      expect(result).toEqual({ id: "new_123" });
      const call = vi.mocked(fetch).mock.calls[0];
      expect(call[1]?.method).toBe("POST");
      expect(call[1]?.headers).toEqual(
        expect.objectContaining({ "Content-Type": "application/json" }),
      );
    });
  });

  describe("postForm", () => {
    it("makes POST request with form-encoded body", async () => {
      const mockResponse = mockFetchResponse({ success: true });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

      await client.postForm("/123", { status: "PAUSED" });

      const call = vi.mocked(fetch).mock.calls[0];
      expect(call[1]?.method).toBe("POST");
      expect(call[1]?.headers).toEqual(
        expect.objectContaining({
          "Content-Type": "application/x-www-form-urlencoded",
        }),
      );
      expect(call[1]?.body).toContain("status=PAUSED");
    });
  });

  describe("delete", () => {
    it("makes DELETE request", async () => {
      const mockResponse = mockFetchResponse({ success: true });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

      await client.delete("/123");

      const call = vi.mocked(fetch).mock.calls[0];
      expect(call[1]?.method).toBe("DELETE");
    });
  });

  describe("error handling", () => {
    it("throws McpError on Meta API auth errors", async () => {
      const mockResponse = mockFetchResponse({
        error: {
          message: "Invalid OAuth 2.0 Access Token",
          type: "OAuthException",
          code: 190,
        },
      });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

      await expect(client.get("/me")).rejects.toThrow(
        /Invalid or expired access token/,
      );
    });

    it("throws McpError on invalid parameter errors", async () => {
      const mockResponse = mockFetchResponse({
        error: {
          message: "Invalid parameter",
          type: "GraphMethodException",
          code: 100,
        },
      });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

      await expect(client.get("/me")).rejects.toThrow(/Invalid parameter/);
    });

    it("throws on HTTP 400 errors", async () => {
      const mockResponse = mockFetchResponse(
        { error: "Bad request" },
        { status: 400 },
      );
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

      await expect(client.get("/me")).rejects.toThrow("HTTP 400");
    });

    it("throws on missing access token", async () => {
      cleanupTestToken();
      const mockResponse = mockFetchResponse({ data: [] });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

      await expect(client.get("/me")).rejects.toThrow(
        /No Meta access token available/,
      );
    });
  });

  describe("retry behavior", () => {
    it("retries on server errors when retries are configured", async () => {
      const retryClient = new MetaApiClient({
        maxRetries: 1,
        timeout: 5000,
      });

      const serverErrorResponse = mockFetchResponse(
        {
          error: {
            message: "Server error",
            type: "API_ERROR",
            code: 1,
          },
        },
      );
      const successResponse = mockFetchResponse({ data: [] });

      vi.stubGlobal(
        "fetch",
        vi.fn()
          .mockResolvedValueOnce(serverErrorResponse)
          .mockResolvedValueOnce(successResponse),
      );

      const result = await retryClient.get("/me");
      expect(result).toEqual({ data: [] });
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    });

    it("does NOT retry on rate-limit errors (per Meta's 'stop calling' rule)", async () => {
      const retryClient = new MetaApiClient({
        maxRetries: 3,
        timeout: 5000,
      });

      const rateLimitResponse = mockFetchResponse({
        error: {
          message: "Rate limit hit",
          type: "OAuthException",
          code: 4,
        },
      });

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rateLimitResponse));

      await expect(retryClient.get("/me")).rejects.toThrow();
      // Must be called exactly once — no backoff-and-retry inside the same request.
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });

    it("opens a circuit immediately on abuse signal (subcode 1996)", async () => {
      const retryClient = new MetaApiClient({
        maxRetries: 0,
        timeout: 5000,
      });

      const abuseResponse = mockFetchResponse({
        error: {
          message: "Inconsistent request volume detected",
          type: "OAuthException",
          code: 613,
          error_subcode: 1996,
        },
      });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(abuseResponse));

      await expect(retryClient.get("/act_123/insights")).rejects.toThrow();
      // Subsequent call should short-circuit without hitting fetch.
      await expect(retryClient.get("/act_123/insights")).rejects.toThrow(
        /Circuit open/,
      );
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });

    it("does not open a circuit across different ad accounts on a per-account throttle", async () => {
      const retryClient = new MetaApiClient({
        maxRetries: 0,
        timeout: 5000,
      });

      const bucResponse = mockFetchResponse({
        error: {
          message: "Ads Management throttled",
          type: "OAuthException",
          code: 80004,
        },
      });
      const okResponse = mockFetchResponse({ data: [] });

      vi.stubGlobal(
        "fetch",
        vi.fn()
          .mockResolvedValueOnce(bucResponse)
          .mockResolvedValueOnce(okResponse),
      );

      await expect(retryClient.get("/act_111/campaigns")).rejects.toThrow();
      // Different account — circuit for act_111 must not block act_222.
      const result = await retryClient.get("/act_222/campaigns");
      expect(result).toEqual({ data: [] });
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    });

    it("does not retry auth errors", async () => {
      const retryClient = new MetaApiClient({
        maxRetries: 2,
        timeout: 5000,
      });

      const authErrorResponse = mockFetchResponse({
        error: {
          message: "Invalid token",
          type: "OAuthException",
          code: 190,
        },
      });

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(authErrorResponse));

      await expect(retryClient.get("/me")).rejects.toThrow();
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });
  });

  describe("getPaginated", () => {
    it("returns empty array when data is missing", async () => {
      const mockResponse = mockFetchResponse({});
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

      const result = await client.getPaginated("/act_123/campaigns");
      expect(result).toEqual([]);
    });

    it("returns data from single page", async () => {
      const mockResponse = mockFetchResponse({
        data: [{ id: "1" }, { id: "2" }],
      });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

      const result = await client.getPaginated<{ id: string }>(
        "/act_123/campaigns",
      );
      expect(result).toEqual([{ id: "1" }, { id: "2" }]);
    });
  });
});
