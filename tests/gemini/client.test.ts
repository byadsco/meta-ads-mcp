import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GEMINI_MODEL,
  GeminiApiError,
  buildGenerateBody,
  createGeminiClient,
  isGeminiEnvFallbackUsable,
  maskGeminiKey,
  resolveGeminiKey,
  resolveGeminiModel,
  scrubGeminiKey,
  validateGeminiKeyInput,
} from "../../src/gemini/client.js";
import { configureGeminiKeyRepoForTests, InMemoryGeminiKeyRepo } from "../../src/store/gemini-key-repo.js";
import { resetKeyCacheForTests } from "../../src/auth/crypto.js";
import { requestContext } from "../../src/auth/token-store.js";

// Fixture marker keeps the secret scanner quiet; never placed after a GEMINI_API_KEY assignment.
const KEY = "AQ.test_gemini_fixture_key_000";

type FetchArgs = [string | URL, RequestInit | undefined];

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function headersOf(call: FetchArgs): Headers {
  return new Headers(call[1]?.headers as HeadersInit);
}

describe("validateGeminiKeyInput", () => {
  it("accepts AQ. and legacy AIza keys without requiring a prefix", () => {
    expect(validateGeminiKeyInput(`  ${KEY}  `)).toEqual({ ok: true, key: KEY });
    expect(validateGeminiKeyInput("AIza_fixture_legacy_key_00000")).toMatchObject({ ok: true });
    expect(validateGeminiKeyInput("some-future-format-fixture-0000")).toMatchObject({ ok: true });
  });

  it("rejects empty, short, long and header-injecting values", () => {
    expect(validateGeminiKeyInput(undefined)).toEqual({ ok: false, reason: "empty" });
    expect(validateGeminiKeyInput("   ")).toEqual({ ok: false, reason: "empty" });
    expect(validateGeminiKeyInput("short")).toEqual({ ok: false, reason: "too-short" });
    expect(validateGeminiKeyInput("k".repeat(513))).toEqual({ ok: false, reason: "too-long" });
    expect(validateGeminiKeyInput("AQ.fixture_key_with\r\nX-Evil: 1")).toEqual({ ok: false, reason: "illegal-chars" });
    expect(validateGeminiKeyInput("AQ.fixture key with spaces 00")).toEqual({ ok: false, reason: "illegal-chars" });
    expect(validateGeminiKeyInput("AQ.fixture_clé_non_ascii_0000")).toEqual({ ok: false, reason: "illegal-chars" });
  });
});

describe("scrubGeminiKey / maskGeminiKey", () => {
  it("removes the exact key and anything key-shaped from a message", () => {
    const message = `API key not valid: ${KEY}. Also AIza${"B".repeat(35)} and AQ.${"c".repeat(30)}`;
    const scrubbed = scrubGeminiKey(message, KEY);
    expect(scrubbed).not.toContain(KEY);
    expect(scrubbed).not.toContain("B".repeat(20));
    expect(scrubbed).not.toContain("c".repeat(20));
    expect(scrubbed).toContain("[REDACTED]");
  });

  it("scrubs an exact key of an unknown shape", () => {
    const odd = "weird-format-fixture-0000000";
    expect(scrubGeminiKey(`failed for ${odd}!`, odd)).toBe("failed for [REDACTED]!");
  });

  it("masks without revealing any character of the secret body", () => {
    expect(maskGeminiKey(KEY)).toBe("AQ.***");
    expect(maskGeminiKey("AIza_fixture_legacy_key_00000")).toBe("AIza***");
    expect(maskGeminiKey("other-fixture-key-000000000")).toBe("***");
  });
});

describe("resolveGeminiModel", () => {
  it("defaults, accepts a well-formed override and ignores anything else", () => {
    expect(resolveGeminiModel({})).toBe(DEFAULT_GEMINI_MODEL);
    expect(resolveGeminiModel({ GEMINI_MODEL: "gemini-3.1-pro-preview" })).toBe("gemini-3.1-pro-preview");
    expect(resolveGeminiModel({ GEMINI_MODEL: "../../files/evil" })).toBe(DEFAULT_GEMINI_MODEL);
    expect(resolveGeminiModel({ GEMINI_MODEL: "gpt-4" })).toBe(DEFAULT_GEMINI_MODEL);
  });
});

describe("buildGenerateBody", () => {
  const base = {
    prompt: "Analyze this ad.",
    systemInstruction: "You are an ad analyst.",
    schema: { type: "object", properties: { summary: { type: "string" } } },
    mediaResolution: "MEDIA_RESOLUTION_LOW" as const,
    maxOutputTokens: 4096,
  };

  it("references an uploaded file, puts the text after the video and asks for schema-bound JSON", () => {
    const body = buildGenerateBody({ ...base, video: { kind: "file", fileUri: "https://generativelanguage.googleapis.com/v1beta/files/abc-123", mimeType: "video/mp4" } });
    expect(body).toEqual({
      systemInstruction: { parts: [{ text: "You are an ad analyst." }] },
      contents: [
        {
          role: "user",
          parts: [
            { fileData: { fileUri: "https://generativelanguage.googleapis.com/v1beta/files/abc-123", mimeType: "video/mp4" } },
            { text: "Analyze this ad." },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: base.schema,
        mediaResolution: "MEDIA_RESOLUTION_LOW",
        maxOutputTokens: 4096,
        temperature: 0.2,
      },
    });
  });

  it("embeds a small video as inlineData", () => {
    const body = buildGenerateBody({ ...base, video: { kind: "inline", data: Buffer.from("mp4bytes"), mimeType: "video/mp4" } }) as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    expect(body.contents[0].parts[0]).toEqual({ inlineData: { mimeType: "video/mp4", data: Buffer.from("mp4bytes").toString("base64") } });
  });

  it("can drop the schema for the one-shot fallback while still asking for JSON", () => {
    const body = buildGenerateBody({ ...base, video: { kind: "inline", data: Buffer.from("x"), mimeType: "video/mp4" } }, { withSchema: false }) as {
      generationConfig: Record<string, unknown>;
    };
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig).not.toHaveProperty("responseJsonSchema");
  });
});

describe("GeminiClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("validates a key with the header only — never in the url", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ models: [{ name: "models/gemini-3.8-flash" }] }));
    const client = createGeminiClient({ fetch: fetchMock as never });

    await client.validateKey(KEY);

    const call = fetchMock.mock.calls[0] as unknown as FetchArgs;
    expect(String(call[0])).toBe("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1");
    expect(String(call[0])).not.toContain(KEY);
    expect(headersOf(call).get("x-goog-api-key")).toBe(KEY);
  });

  it("turns an invalid key into a scrubbed, actionable error", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { error: { code: 400, message: `API key not valid. Please pass a valid API key. (${KEY})`, status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } },
        { status: 400 },
      ),
    );
    const client = createGeminiClient({ fetch: fetchMock as never });

    const error = (await client.validateKey(KEY).catch((e: unknown) => e)) as GeminiApiError;
    expect(error).toBeInstanceOf(GeminiApiError);
    expect(error.status).toBe(400);
    expect(error.reason).toBe("API_KEY_INVALID");
    expect(error.message).toMatch(/rejected the API key/i);
    expect(error.message).not.toContain(KEY);
  });

  it("uploads through the resumable protocol and never sends the key to the upload url", async () => {
    const data = Buffer.from("0123456789");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 200, headers: { "x-goog-upload-url": "https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=abc&upload_protocol=resumable" } }))
      .mockResolvedValueOnce(jsonResponse({ file: { name: "files/abc-123", uri: "https://generativelanguage.googleapis.com/v1beta/files/abc-123", state: "PROCESSING", mimeType: "video/mp4" } }));
    const client = createGeminiClient({ fetch: fetchMock as never });

    const file = await client.uploadFile({ key: KEY, data, mimeType: "video/mp4", displayName: "ad-video" });

    expect(file).toEqual({ name: "files/abc-123", uri: "https://generativelanguage.googleapis.com/v1beta/files/abc-123", state: "PROCESSING" });
    const [start, upload] = fetchMock.mock.calls as unknown as FetchArgs[];
    expect(String(start[0])).toBe("https://generativelanguage.googleapis.com/upload/v1beta/files");
    const startHeaders = headersOf(start);
    expect(startHeaders.get("x-goog-api-key")).toBe(KEY);
    expect(startHeaders.get("x-goog-upload-protocol")).toBe("resumable");
    expect(startHeaders.get("x-goog-upload-command")).toBe("start");
    expect(startHeaders.get("x-goog-upload-header-content-length")).toBe("10");
    expect(startHeaders.get("x-goog-upload-header-content-type")).toBe("video/mp4");
    expect(JSON.parse(String(start[1]?.body))).toEqual({ file: { name: expect.stringMatching(/^files\/[a-z0-9-]{1,64}$/), display_name: "ad-video" } });

    const uploadHeaders = headersOf(upload);
    expect(uploadHeaders.get("x-goog-api-key")).toBeNull();
    expect(uploadHeaders.get("x-goog-upload-offset")).toBe("0");
    expect(uploadHeaders.get("x-goog-upload-command")).toBe("upload, finalize");
    expect(Buffer.from(upload[1]?.body as Uint8Array).toString()).toBe("0123456789");
  });

  it("refuses to send the video to an upload url outside the Gemini host", async () => {
    for (const evil of [
      "https://evil.example.com/upload/v1beta/files?upload_id=abc",
      "http://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=abc",
      "https://generativelanguage.googleapis.com.evil.example/upload/v1beta/files",
      "https://user:pw@generativelanguage.googleapis.com/upload/v1beta/files",
      "https://generativelanguage.googleapis.com:8443/upload/v1beta/files",
      "https://generativelanguage.googleapis.com/v1beta/models",
      "not a url",
    ]) {
      const fetchMock = vi.fn().mockResolvedValueOnce(new Response("", { status: 200, headers: { "x-goog-upload-url": evil } }));
      const client = createGeminiClient({ fetch: fetchMock as never });
      await expect(client.uploadFile({ key: KEY, data: Buffer.from("x"), mimeType: "video/mp4", displayName: "ad-video" })).rejects.toThrow(/upload url/i);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects a file name or uri that does not look like a Gemini file", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 200, headers: { "x-goog-upload-url": "https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=abc" } }))
      .mockResolvedValueOnce(jsonResponse({ file: { name: "files/../models/x", uri: "https://evil.example.com/f", state: "ACTIVE" } }));
    const client = createGeminiClient({ fetch: fetchMock as never });
    await expect(client.uploadFile({ key: KEY, data: Buffer.from("x"), mimeType: "video/mp4", displayName: "ad-video" })).rejects.toThrow(/unexpected file/i);
  });

  it("rebuilds the file uri from the validated name when the returned uri is off-host", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 200, headers: { "x-goog-upload-url": "https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=abc" } }))
      .mockResolvedValueOnce(jsonResponse({ file: { name: "files/abc-123", uri: "https://evil.example.com/v1beta/files/abc-123", state: "ACTIVE" } }));
    const client = createGeminiClient({ fetch: fetchMock as never });
    const file = await client.uploadFile({ key: KEY, data: Buffer.from("x"), mimeType: "video/mp4", displayName: "ad-video" });
    expect(file.uri).toBe("https://generativelanguage.googleapis.com/v1beta/files/abc-123");
  });

  it("polls until the file is ACTIVE and fails fast on FAILED", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ name: "files/abc-123", uri: "https://generativelanguage.googleapis.com/v1beta/files/abc-123", state: "PROCESSING" }))
      .mockResolvedValueOnce(jsonResponse({ name: "files/abc-123", uri: "https://generativelanguage.googleapis.com/v1beta/files/abc-123", state: "ACTIVE" }));
    const client = createGeminiClient({ fetch: fetchMock as never, sleep });
    const file = await client.waitForFileActive({ key: KEY, name: "files/abc-123", budgetMs: 60_000 });
    expect(file.state).toBe("ACTIVE");
    expect(String((fetchMock.mock.calls[0] as unknown as FetchArgs)[0])).toBe("https://generativelanguage.googleapis.com/v1beta/files/abc-123");
    expect(sleep).toHaveBeenCalledTimes(1);

    const failing = createGeminiClient({ fetch: vi.fn(async () => jsonResponse({ name: "files/abc-123", state: "FAILED", error: { message: "bad container" } })) as never, sleep });
    await expect(failing.waitForFileActive({ key: KEY, name: "files/abc-123", budgetMs: 60_000 })).rejects.toThrow(/could not process/i);
  });

  it("gives up when the processing budget runs out", async () => {
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const fetchMock = vi.fn(async () => jsonResponse({ name: "files/abc-123", state: "PROCESSING" }));
    const client = createGeminiClient({ fetch: fetchMock as never, sleep, now: () => now });
    await expect(client.waitForFileActive({ key: KEY, name: "files/abc-123", budgetMs: 10_000 })).rejects.toThrow(/still processing/i);
    expect(fetchMock.mock.calls.length).toBeLessThan(10);
  });

  it("refuses to interpolate a malformed file name into a url", async () => {
    const fetchMock = vi.fn();
    const client = createGeminiClient({ fetch: fetchMock as never });
    await expect(client.waitForFileActive({ key: KEY, name: "files/../../models", budgetMs: 1000 })).rejects.toThrow(/file name/i);
    expect(await client.deleteFile({ key: KEY, name: "files/x?key=1" })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("generates JSON, reports usage and keeps the key out of the url", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "{\"summary\":" }, { text: "\"A hook-first ad\"}" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 200, thoughtsTokenCount: 50, totalTokenCount: 1750 },
        modelVersion: "gemini-3.8-flash-001",
      }),
    );
    const client = createGeminiClient({ fetch: fetchMock as never });

    const result = await client.generateJson({
      key: KEY,
      model: "gemini-3.8-flash",
      video: { kind: "file", fileUri: "https://generativelanguage.googleapis.com/v1beta/files/abc-123", mimeType: "video/mp4" },
      prompt: "p",
      systemInstruction: "s",
      schema: { type: "object" },
      mediaResolution: "MEDIA_RESOLUTION_LOW",
    });

    expect(result.json).toEqual({ summary: "A hook-first ad" });
    expect(result.usage).toEqual({ prompt_tokens: 1500, output_tokens: 200, thoughts_tokens: 50, total_tokens: 1750 });
    expect(result.model).toBe("gemini-3.8-flash-001");
    expect(result.schema_enforced).toBe(true);
    const call = fetchMock.mock.calls[0] as unknown as FetchArgs;
    expect(String(call[0])).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    expect(headersOf(call).get("x-goog-api-key")).toBe(KEY);
  });

  it("ignores thought parts and unwraps a fenced JSON answer", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ candidates: [{ content: { parts: [{ text: "thinking…", thought: true }, { text: "```json\n{\"summary\":\"ok\"}\n```" }] }, finishReason: "STOP" }] }),
    );
    const client = createGeminiClient({ fetch: fetchMock as never });
    const result = await client.generateJson({ key: KEY, model: "gemini-3.8-flash", video: { kind: "inline", data: Buffer.from("x"), mimeType: "video/mp4" }, prompt: "p", systemInstruction: "s", schema: {}, mediaResolution: "MEDIA_RESOLUTION_LOW" });
    expect(result.json).toEqual({ summary: "ok" });
  });

  it("retries exactly once without the schema when Gemini rejects the schema field", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { code: 400, message: "Invalid JSON payload received. Unknown name \"responseJsonSchema\" at 'generation_config'", status: "INVALID_ARGUMENT" } }, { status: 400 }))
      .mockResolvedValueOnce(jsonResponse({ candidates: [{ content: { parts: [{ text: "{\"summary\":\"ok\"}" }] }, finishReason: "STOP" }] }));
    const client = createGeminiClient({ fetch: fetchMock as never });
    const result = await client.generateJson({ key: KEY, model: "gemini-3.8-flash", video: { kind: "inline", data: Buffer.from("x"), mimeType: "video/mp4" }, prompt: "p", systemInstruction: "s", schema: { type: "object" }, mediaResolution: "MEDIA_RESOLUTION_LOW" });
    expect(result.schema_enforced).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = JSON.parse(String((fetchMock.mock.calls[1] as unknown as FetchArgs)[1]?.body)) as { generationConfig: Record<string, unknown> };
    expect(second.generationConfig).not.toHaveProperty("responseJsonSchema");
  });

  it("does not retry a billable failure", async () => {
    for (const status of [429, 500, 503]) {
      const fetchMock = vi.fn(async () => jsonResponse({ error: { code: status, message: "nope", status: "RESOURCE_EXHAUSTED" } }, { status }));
      const client = createGeminiClient({ fetch: fetchMock as never });
      await expect(client.generateJson({ key: KEY, model: "gemini-3.8-flash", video: { kind: "inline", data: Buffer.from("x"), mimeType: "video/mp4" }, prompt: "p", systemInstruction: "s", schema: {}, mediaResolution: "MEDIA_RESOLUTION_LOW" })).rejects.toBeInstanceOf(GeminiApiError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("reports a blocked prompt and an unparsable answer as errors", async () => {
    const blocked = createGeminiClient({ fetch: vi.fn(async () => jsonResponse({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } })) as never });
    await expect(blocked.generateJson({ key: KEY, model: "gemini-3.8-flash", video: { kind: "inline", data: Buffer.from("x"), mimeType: "video/mp4" }, prompt: "p", systemInstruction: "s", schema: {}, mediaResolution: "MEDIA_RESOLUTION_LOW" })).rejects.toThrow(/blocked.*PROHIBITED_CONTENT/i);

    const truncated = createGeminiClient({ fetch: vi.fn(async () => jsonResponse({ candidates: [{ content: { parts: [{ text: "{\"summary\":\"cut" }] }, finishReason: "MAX_TOKENS" }] })) as never });
    await expect(truncated.generateJson({ key: KEY, model: "gemini-3.8-flash", video: { kind: "inline", data: Buffer.from("x"), mimeType: "video/mp4" }, prompt: "p", systemInstruction: "s", schema: {}, mediaResolution: "MEDIA_RESOLUTION_LOW" })).rejects.toThrow(/MAX_TOKENS/);
  });

  it("refuses a model id that could escape the url path", async () => {
    const fetchMock = vi.fn();
    const client = createGeminiClient({ fetch: fetchMock as never });
    await expect(client.generateJson({ key: KEY, model: "gemini-x/../../files", video: { kind: "inline", data: Buffer.from("x"), mimeType: "video/mp4" }, prompt: "p", systemInstruction: "s", schema: {}, mediaResolution: "MEDIA_RESOLUTION_LOW" })).rejects.toThrow(/model/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds the response it is willing to buffer", async () => {
    const huge = new Response("x".repeat(64), { status: 200, headers: { "content-length": String(64 * 1024 * 1024) } });
    const client = createGeminiClient({ fetch: vi.fn(async () => huge) as never });
    await expect(client.generateJson({ key: KEY, model: "gemini-3.8-flash", video: { kind: "inline", data: Buffer.from("x"), mimeType: "video/mp4" }, prompt: "p", systemInstruction: "s", schema: {}, mediaResolution: "MEDIA_RESOLUTION_LOW" })).rejects.toThrow(/too large/i);
  });

  it("scrubs the key out of transport errors", async () => {
    const client = createGeminiClient({ fetch: vi.fn(async () => { throw new Error(`connect failed for key ${KEY}`); }) as never });
    const error = (await client.validateKey(KEY).catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain(KEY);
  });

  it("deletes a file best-effort and never throws", async () => {
    const ok = createGeminiClient({ fetch: vi.fn(async () => jsonResponse({})) as never });
    expect(await ok.deleteFile({ key: KEY, name: "files/abc-123" })).toBe(true);
    const failing = createGeminiClient({ fetch: vi.fn(async () => { throw new Error("offline"); }) as never });
    expect(await failing.deleteFile({ key: KEY, name: "files/abc-123" })).toBe(false);
  });

  it("propagates a caller abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return jsonResponse({});
    });
    const client = createGeminiClient({ fetch: fetchMock as never });
    await expect(client.validateKey(KEY, controller.signal)).rejects.toThrow(/abort/i);
  });
});

describe("resolveGeminiKey", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = "a".repeat(64);
    resetKeyCacheForTests();
    configureGeminiKeyRepoForTests(new InMemoryGeminiKeyRepo());
    delete process.env.GEMINI_API_KEY;
    delete process.env.META_APP_ID;
    delete process.env.META_APP_SECRET;
  });

  afterEach(() => {
    process.env = { ...saved };
    resetKeyCacheForTests();
    configureGeminiKeyRepoForTests(undefined);
  });

  it("prefers the tenant's encrypted key", async () => {
    const repo = new InMemoryGeminiKeyRepo();
    configureGeminiKeyRepoForTests(repo);
    await repo.saveKey("1234567890", KEY);
    process.env.GEMINI_API_KEY = "AQ.env_fixture_key_000000000";
    await requestContext.run({ accessToken: "t", fbUserId: "1234567890" }, async () => {
      expect(await resolveGeminiKey()).toMatchObject({ key: KEY, source: "encrypted_user_storage", tenantId: "1234567890" });
    });
  });

  it("uses the env fallback only in single-tenant mode", async () => {
    process.env.GEMINI_API_KEY = "AQ.env_fixture_key_000000000";
    expect(isGeminiEnvFallbackUsable()).toBe(true);
    expect(await resolveGeminiKey()).toMatchObject({ source: "env", tenantId: "_local" });

    process.env.META_APP_ID = "1";
    process.env.META_APP_SECRET = "fixture";
    expect(isGeminiEnvFallbackUsable()).toBe(false);
    await requestContext.run({ accessToken: "t", fbUserId: "1234567890" }, async () => {
      await expect(resolveGeminiKey()).rejects.toThrow(/No Gemini API key/i);
    });
  });

  it("fails closed for an unidentified caller in multi-tenant mode", async () => {
    process.env.META_APP_ID = "1";
    process.env.META_APP_SECRET = "fixture";
    process.env.GEMINI_API_KEY = "AQ.env_fixture_key_000000000";
    await expect(resolveGeminiKey()).rejects.toThrow(/authenticated user/i);
  });
});

describe("round-1 review fixes (client)", () => {
  it("names the file itself, so an ambiguous finalize can still be cleaned up", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 200, headers: { "x-goog-upload-url": "https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=abc" } }))
      .mockResolvedValueOnce(jsonResponse({ file: { name: "files/abc-123", uri: "https://generativelanguage.googleapis.com/v1beta/files/abc-123", state: "ACTIVE" } }));
    const client = createGeminiClient({ fetch: fetchMock as never });

    const file = await client.uploadFile({ key: KEY, data: Buffer.from("x"), mimeType: "video/mp4", displayName: "ad-video" });

    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as FetchArgs)[1]?.body)) as { file: { name: string; display_name: string } };
    expect(body.file.display_name).toBe("ad-video");
    expect(body.file.name).toMatch(/^files\/[a-z0-9-]{1,64}$/);
    // Google is free to ignore the requested name; the returned one wins.
    expect(file.name).toBe("files/abc-123");
  });

  it("reports the name it asked for when the finalize response is lost, so the caller can delete it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 200, headers: { "x-goog-upload-url": "https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=abc" } }))
      .mockRejectedValueOnce(new Error("socket hang up"));
    const client = createGeminiClient({ fetch: fetchMock as never });

    const error = (await client.uploadFile({ key: KEY, data: Buffer.from("x"), mimeType: "video/mp4", displayName: "ad-video" }).catch((e: unknown) => e)) as GeminiApiError & { fileName?: string };
    expect(error).toBeInstanceOf(GeminiApiError);
    expect(error.fileName).toMatch(/^files\/[a-z0-9-]{1,64}$/);
    const requested = JSON.parse(String((fetchMock.mock.calls[0] as unknown as FetchArgs)[1]?.body)) as { file: { name: string } };
    expect(error.fileName).toBe(requested.file.name);
  });

  it("carries no file name when the failure happened before any byte was sent", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("offline"));
    const client = createGeminiClient({ fetch: fetchMock as never });
    const error = (await client.uploadFile({ key: KEY, data: Buffer.from("x"), mimeType: "video/mp4", displayName: "ad-video" }).catch((e: unknown) => e)) as GeminiApiError & { fileName?: string };
    expect(error.fileName).toBeUndefined();
  });
});
