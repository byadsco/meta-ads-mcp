import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerGeminiKeyTools, type GeminiKeyToolDeps } from "../../src/tools/gemini-keys.js";
import { InMemoryGeminiKeyRepo, configureGeminiKeyRepoForTests, type GeminiKeyRepo } from "../../src/store/gemini-key-repo.js";
import { GeminiApiError } from "../../src/gemini/client.js";
import { resetKeyCacheForTests } from "../../src/auth/crypto.js";
import { createMockMcpServer } from "../setup.js";

const KEY = "AQ.test_gemini_fixture_key_000";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

function setup(overrides: Partial<GeminiKeyToolDeps> = {}) {
  const repo: GeminiKeyRepo = overrides.repo ?? new InMemoryGeminiKeyRepo();
  const validateKey = vi.fn(async () => undefined);
  const server = createMockMcpServer();
  const deps: GeminiKeyToolDeps = {
    repo,
    client: { validateKey } as never,
    resolveTenantId: () => "tenant-1",
    ...overrides,
  };
  registerGeminiKeyTools(server as never, deps);
  const byName = (name: string) => server._registeredTools.find((t) => t.name === name)!;
  return { server, repo, validateKey, byName, call: (name: string, args: Record<string, unknown> = {}) => byName(name).handler(args) as Promise<ToolResult> };
}

describe("gemini key tools", () => {
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = "a".repeat(64);
    resetKeyCacheForTests();
    delete process.env.GEMINI_API_KEY;
    delete process.env.META_APP_ID;
    delete process.env.META_APP_SECRET;
  });

  afterEach(() => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    delete process.env.GEMINI_API_KEY;
    resetKeyCacheForTests();
    configureGeminiKeyRepoForTests(undefined);
    vi.restoreAllMocks();
  });

  it("registers three tools with the right annotations and warnings", () => {
    const { server, byName } = setup();
    expect(server.registerTool).toHaveBeenCalledTimes(3);
    expect(server._registeredTools.map((t) => t.name).sort()).toEqual(["ads_delete_gemini_key", "ads_get_gemini_key_status", "ads_register_gemini_key"]);

    expect(byName("ads_get_gemini_key_status").annotations?.readOnlyHint).toBe(true);
    expect(byName("ads_get_gemini_key_status").description).not.toContain("⚠️");
    for (const name of ["ads_register_gemini_key", "ads_delete_gemini_key"]) {
      expect(byName(name).annotations?.readOnlyHint).not.toBe(true);
      expect(byName(name).description).toContain("⚠️");
    }
    expect(byName("ads_register_gemini_key").description).toMatch(/aistudio\.google\.com\/apikey/);
    expect(byName("ads_register_gemini_key").description).toMatch(/paid|free tier/i);
  });

  it("validates against Gemini, then stores the key encrypted and never echoes it", async () => {
    const { call, repo, validateKey } = setup();

    const result = await call("ads_register_gemini_key", { gemini_api_key: ` ${KEY} ` });

    expect(validateKey).toHaveBeenCalledWith(KEY);
    expect(await repo.getDecryptedKey("tenant-1")).toBe(KEY);
    const text = JSON.stringify(result.content);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("fixture");
    expect(text).toContain("AQ.***");
  });

  it("does not store the key when Gemini rejects it, and says why", async () => {
    const { call, repo } = setup({
      client: { validateKey: vi.fn(async () => { throw new GeminiApiError(`Gemini rejected the API key — bad (${KEY})`, 400, "API_KEY_INVALID"); }) } as never,
    });

    const result = await call("ads_register_gemini_key", { gemini_api_key: KEY });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/NOT stored/);
    expect(JSON.stringify(result.content)).not.toContain(KEY);
    expect(await repo.getDecryptedKey("tenant-1")).toBeNull();
  });

  it("rejects a malformed key before calling Gemini", async () => {
    const { call, validateKey } = setup();
    const result = await call("ads_register_gemini_key", { gemini_api_key: "AQ.short" });
    expect(result.isError).toBe(true);
    expect(validateKey).not.toHaveBeenCalled();
  });

  it("reports the encrypted source, the env fallback and none", async () => {
    const { call, repo } = setup();
    let status = await call("ads_get_gemini_key_status");
    expect(JSON.parse(status.content[1].text)).toMatchObject({ source: "none", envFallbackAvailable: false, registered: false });
    expect(status.content[0].text).toMatch(/ads_register_gemini_key/);

    process.env.GEMINI_API_KEY = "AQ.env_fixture_key_0000000000";
    status = await call("ads_get_gemini_key_status");
    expect(JSON.parse(status.content[1].text)).toMatchObject({ source: "env" });

    await repo.saveKey("tenant-1", KEY);
    status = await call("ads_get_gemini_key_status");
    const json = JSON.parse(status.content[1].text) as Record<string, unknown>;
    expect(json).toMatchObject({ source: "encrypted_user_storage", registered: true });
    expect(JSON.stringify(json)).not.toContain(KEY);
    expect(json.keyFingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  it("does not advertise the env fallback in multi-tenant mode, where it is unreachable", async () => {
    process.env.GEMINI_API_KEY = "AQ.env_fixture_key_0000000000";
    process.env.META_APP_ID = "1234567890";
    process.env.META_APP_SECRET = "s".repeat(32);
    const { call } = setup();
    const status = await call("ads_get_gemini_key_status");
    expect(JSON.parse(status.content[1].text)).toMatchObject({ source: "none", envFallbackAvailable: false });
  });

  it("optionally verifies the stored key without leaking it", async () => {
    const { call, repo, validateKey } = setup();
    await repo.saveKey("tenant-1", KEY);
    const status = await call("ads_get_gemini_key_status", { verify: true });
    expect(validateKey).toHaveBeenCalledWith(KEY);
    expect(JSON.parse(status.content[1].text)).toMatchObject({ verification: "valid" });

    const failing = setup({ client: { validateKey: vi.fn(async () => { throw new GeminiApiError("Gemini rejected the API key", 400, "API_KEY_INVALID"); }) } as never });
    await failing.repo.saveKey("tenant-1", KEY);
    const bad = await failing.call("ads_get_gemini_key_status", { verify: true });
    expect(JSON.parse(bad.content[1].text).verification).toMatch(/^invalid/);
  });

  it("deletes a stored key and reports when there was nothing to delete", async () => {
    const { call, repo } = setup();
    await repo.saveKey("tenant-1", KEY);
    const deleted = await call("ads_delete_gemini_key");
    expect(deleted.isError).toBeUndefined();
    expect(await repo.getDecryptedKey("tenant-1")).toBeNull();

    const missing = await call("ads_delete_gemini_key");
    expect(missing.isError).toBe(true);
  });

  it("warns that the env fallback stays active after a delete", async () => {
    process.env.GEMINI_API_KEY = "AQ.env_fixture_key_0000000000";
    const { call, repo } = setup();
    await repo.saveKey("tenant-1", KEY);
    const result = await call("ads_delete_gemini_key");
    expect(result.content[0].text).toMatch(/GEMINI_API_KEY environment fallback is still active/);
  });

  it("fails closed for an unidentified multi-tenant caller", async () => {
    const { call } = setup({ resolveTenantId: () => { throw new Error("need an authenticated user in multi-tenant mode"); } });
    await expect(call("ads_get_gemini_key_status")).rejects.toThrow(/authenticated user/);
    await expect(call("ads_register_gemini_key", { gemini_api_key: KEY })).rejects.toThrow(/authenticated user/);
  });
});
