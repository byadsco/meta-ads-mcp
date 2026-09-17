import { randomUUID } from "node:crypto";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { isSingleTenantMode, LOCAL_TENANT_ID, resolveTenantId } from "../auth/tenant.js";
import { hashToken } from "../auth/token-store.js";
import { getGeminiKeyRepo } from "../store/gemini-key-repo.js";
import { BodyTooLargeError, readBodyWithLimit } from "../utils/bounded-body.js";
import { logger } from "../utils/logger.js";

/**
 * Fixed on purpose: an env-overridable base URL would let a config change
 * redirect every tenant's Gemini key (and their ad videos) to another host.
 */
export const GEMINI_HOST = "generativelanguage.googleapis.com";
const GEMINI_BASE_URL = `https://${GEMINI_HOST}`;

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
const MODEL_PATTERN = /^gemini-[A-Za-z0-9._-]{1,60}$/;
const FILE_NAME_PATTERN = /^files\/[a-z0-9-]{1,64}$/;
const FILE_URI_PATH_PATTERN = /^\/v1(?:alpha|beta)?\/files\/[a-z0-9-]{1,64}$/;

const VALIDATE_TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const POLL_TIMEOUT_MS = 10_000;
const GENERATE_TIMEOUT_MS = 180_000;
const DELETE_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 3_000;
const MAX_TRANSIENT_POLL_FAILURES = 2;

const SMALL_RESPONSE_BYTES = 256 * 1024;
const GENERATE_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_DETAIL_CHARS = 300;
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

export type GeminiMediaResolution = "MEDIA_RESOLUTION_LOW" | "MEDIA_RESOLUTION_MEDIUM" | "MEDIA_RESOLUTION_HIGH";
export type GeminiKeySource = "encrypted_user_storage" | "env";

export function resolveGeminiModel(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.GEMINI_MODEL?.trim();
  return configured && MODEL_PATTERN.test(configured) ? configured : DEFAULT_GEMINI_MODEL;
}

const KEY_SHAPES = /AQ\.[A-Za-z0-9_.-]{10,}|AIza[0-9A-Za-z_-]{10,}/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Google does not echo keys in error bodies today, but these strings travel
 * back to the MCP client and into logs. The exact key is matched as well as
 * the known shapes because the format has already changed once (AIza → AQ.).
 */
export function scrubGeminiKey(text: string, exactKey?: string): string {
  if (!exactKey || exactKey.length < 8) return text.replace(KEY_SHAPES, "[REDACTED]");
  // One left-to-right pass: trailing key characters are folded into the exact
  // alternative so a longer credential sharing this prefix is removed whole.
  const combined = new RegExp(`${escapeRegExp(exactKey)}[A-Za-z0-9_.-]*|${KEY_SHAPES.source}`, "g");
  return text.replace(combined, "[REDACTED]");
}

/** Shows only the public prefix; no character of the secret body, not even a suffix. */
export function maskGeminiKey(key: string): string {
  if (key.startsWith("AQ.")) return "AQ.***";
  if (key.startsWith("AIza")) return "AIza***";
  return "***";
}

export type GeminiKeyInputResult =
  | { ok: true; key: string }
  | { ok: false; reason: "empty" | "too-short" | "too-long" | "illegal-chars" };

/**
 * The key is sent as an HTTP header value, so anything outside printable
 * ASCII — CR/LF above all — is refused here rather than left to the HTTP
 * client. No prefix is required: Google moved from AIza… to AQ.… keys once
 * already, and the live check against the API is the real authority.
 */
export function validateGeminiKeyInput(input: unknown): GeminiKeyInputResult {
  if (typeof input !== "string") return { ok: false, reason: "empty" };
  const key = input.trim();
  if (key.length === 0) return { ok: false, reason: "empty" };
  if (key.length < 20) return { ok: false, reason: "too-short" };
  if (key.length > 512) return { ok: false, reason: "too-long" };
  if (!/^[\x21-\x7e]+$/.test(key)) return { ok: false, reason: "illegal-chars" };
  return { ok: true, key };
}

/**
 * Which encrypted-key bucket this request may read. Fails closed in
 * multi-tenant mode without an OAuth identity (see src/auth/tenant.ts).
 */
export function resolveGeminiTenantId(): string {
  return resolveTenantId({ feature: "Gemini video analysis" });
}

/** Whether the server-wide GEMINI_API_KEY would actually be used for this request. */
export function isGeminiEnvFallbackUsable(): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim()) && isSingleTenantMode();
}

export interface ResolvedGeminiKey {
  key: string;
  source: GeminiKeySource;
  tenantId: string;
}

/**
 * Per-tenant encrypted key first. The server-wide GEMINI_API_KEY is only
 * honoured in single-tenant mode: sharing it across OAuth tenants would bill
 * every advertiser's analyses to the operator and mix their videos in one
 * Google project.
 */
export async function resolveGeminiKey(): Promise<ResolvedGeminiKey> {
  const tenantId = resolveGeminiTenantId();
  const stored = await getGeminiKeyRepo().getDecryptedKey(tenantId);
  if (stored) return { key: stored, source: "encrypted_user_storage", tenantId };

  if (tenantId === LOCAL_TENANT_ID) {
    const envKey = process.env.GEMINI_API_KEY?.trim();
    if (envKey) return { key: envKey, source: "env", tenantId };
  }

  throw new McpError(
    ErrorCode.InvalidRequest,
    "No Gemini API key registered for this user. Register one on the /auth/connections page or with ads_register_gemini_key (create it at aistudio.google.com/apikey). Without a key, ads_get_video_media delivery=frames still lets an image-capable model look at the video.",
  );
}

export class GeminiApiError extends Error {
  /**
   * Set when the failure happened after upload bytes were sent, so the caller
   * can still delete a file Google may have created (an accepted finalize
   * whose response was lost would otherwise sit there for 48 hours).
   */
  fileName?: string;

  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string,
  ) {
    super(message);
    this.name = "GeminiApiError";
  }
}

interface GoogleErrorBody {
  error?: { code?: number; message?: string; status?: string; details?: Array<{ reason?: string }> };
}

function describeFailure(status: number, body: GoogleErrorBody | null, key: string): GeminiApiError {
  const googleStatus = typeof body?.error?.status === "string" ? body.error.status : undefined;
  const details = Array.isArray(body?.error?.details) ? body.error.details : [];
  const detailReason = details.map((d) => d?.reason).find((r): r is string => typeof r === "string");
  const reason = (detailReason ?? googleStatus)?.slice(0, 60);
  const rawMessage = typeof body?.error?.message === "string" ? body.error.message : "";
  const detail = scrubGeminiKey(rawMessage.slice(0, MAX_ERROR_DETAIL_CHARS * 4), key)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ERROR_DETAIL_CHARS);
  const suffix = detail ? ` — ${detail}` : "";

  const invalidKey = reason === "API_KEY_INVALID" || /api key not valid/i.test(rawMessage.slice(0, 2000));
  if (invalidKey || status === 401) {
    return new GeminiApiError(
      `Gemini rejected the API key${suffix}. Re-register it on the /auth/connections page or with ads_register_gemini_key.`,
      status,
      reason ?? "API_KEY_INVALID",
    );
  }
  if (status === 403) {
    return new GeminiApiError(`Gemini denied access${suffix}. The key may be restricted or lack access to the Generative Language API or to this model.`, status, reason);
  }
  if (status === 404) {
    return new GeminiApiError(`Gemini resource not found${suffix}. Check the GEMINI_MODEL setting.`, status, reason);
  }
  if (status === 429) {
    return new GeminiApiError(`Gemini quota or rate limit reached${suffix}. Free-tier keys have low video quotas; retry later or use a paid-tier key.`, status, reason);
  }
  if (status >= 500) {
    return new GeminiApiError(`Gemini is temporarily unavailable (HTTP ${status})${suffix}.`, status, reason);
  }
  return new GeminiApiError(`Gemini rejected the request (HTTP ${status})${suffix}`, status, reason);
}

export type GeminiVideoPart =
  | { kind: "file"; fileUri: string; mimeType: string }
  | { kind: "inline"; data: Buffer; mimeType: string };

export interface GenerateBodyInput {
  video: GeminiVideoPart;
  prompt: string;
  systemInstruction: string;
  schema: unknown;
  mediaResolution: GeminiMediaResolution;
  maxOutputTokens?: number;
}

/**
 * The whole generateContent request shape lives here, under a unit test, so a
 * change in the API touches one function. The text part goes after the video,
 * as Google recommends for single-media prompts.
 */
export function buildGenerateBody(input: GenerateBodyInput, options: { withSchema?: boolean } = {}): Record<string, unknown> {
  const videoPart =
    input.video.kind === "file"
      ? { fileData: { fileUri: input.video.fileUri, mimeType: input.video.mimeType } }
      : { inlineData: { mimeType: input.video.mimeType, data: input.video.data.toString("base64") } };
  return {
    systemInstruction: { parts: [{ text: input.systemInstruction }] },
    contents: [{ role: "user", parts: [videoPart, { text: input.prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      ...(options.withSchema === false ? {} : { responseJsonSchema: input.schema }),
      mediaResolution: input.mediaResolution,
      maxOutputTokens: input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      temperature: 0.2,
    },
  };
}

export interface GeminiFile {
  name: string;
  uri: string;
  state: string;
}

export interface GeminiUsage {
  prompt_tokens?: number;
  output_tokens?: number;
  thoughts_tokens?: number;
  total_tokens?: number;
}

export interface GenerateJsonInput extends GenerateBodyInput {
  key: string;
  model: string;
  signal?: AbortSignal;
}

export interface GenerateJsonResult {
  json: unknown;
  usage: GeminiUsage;
  model: string;
  finish_reason?: string;
  /** False when the API refused the schema field and the answer came from the prompt-only retry. */
  schema_enforced: boolean;
}

export interface GeminiClient {
  validateKey(key: string, signal?: AbortSignal): Promise<void>;
  uploadFile(input: { key: string; data: Buffer; mimeType: string; displayName: string; signal?: AbortSignal }): Promise<GeminiFile>;
  waitForFileActive(input: { key: string; name: string; budgetMs: number; signal?: AbortSignal }): Promise<GeminiFile>;
  generateJson(input: GenerateJsonInput): Promise<GenerateJsonResult>;
  /** Best effort: resolves false instead of throwing, and never uses the caller's (possibly aborted) signal. */
  deleteFile(input: { key: string; name: string }): Promise<boolean>;
}

export interface GeminiClientConfig {
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new GeminiApiError("Gemini request aborted by the caller.", 0, "ABORTED"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new GeminiApiError("Gemini request aborted by the caller.", 0, "ABORTED"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function assertFileName(name: string): string {
  if (!FILE_NAME_PATTERN.test(name)) {
    throw new GeminiApiError("Refusing to use a malformed Gemini file name.", 0);
  }
  return name;
}

/** The upload session url comes from a response header; the video only goes to the Gemini upload endpoint. */
function assertUploadUrl(raw: string | null): URL {
  let url: URL | undefined;
  try {
    url = raw && raw.length <= 2048 ? new URL(raw) : undefined;
  } catch {
    url = undefined;
  }
  const valid =
    url !== undefined &&
    url.protocol === "https:" &&
    url.hostname === GEMINI_HOST &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.pathname.startsWith("/upload/");
  if (!url || !valid) {
    throw new GeminiApiError("Gemini returned an unexpected upload url; the video was not sent.", 0);
  }
  return url;
}

function fileFrom(body: unknown): GeminiFile {
  const record = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : "";
  if (!FILE_NAME_PATTERN.test(name)) {
    throw new GeminiApiError("Gemini returned an unexpected file record.", 0);
  }
  // The uri is only trusted when it points at this very file on the Gemini host; otherwise it is rebuilt.
  let uri = `${GEMINI_BASE_URL}/v1beta/${name}`;
  if (typeof record.uri === "string" && record.uri.length <= 300) {
    try {
      const parsed = new URL(record.uri);
      const sameFile = parsed.pathname.endsWith(`/${name}`) && FILE_URI_PATH_PATTERN.test(parsed.pathname);
      const onHost = parsed.protocol === "https:" && parsed.hostname === GEMINI_HOST && parsed.port === "" && parsed.username === "" && parsed.password === "";
      if (onHost && parsed.search === "" && parsed.hash === "" && sameFile) uri = parsed.toString();
    } catch {
      // keep the rebuilt uri
    }
  }
  return { name, uri, state: typeof record.state === "string" ? record.state.slice(0, 40) : "STATE_UNSPECIFIED" };
}

function stripFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const firstBreak = trimmed.indexOf("\n");
  const lastFence = trimmed.lastIndexOf("```");
  if (firstBreak < 0 || lastFence <= firstBreak) return trimmed;
  return trimmed.slice(firstBreak + 1, lastFence).trim();
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Only a schema-shaped 400 earns the free retry; anything else is reported as is. */
function isSchemaRejection(error: GeminiApiError, rawMessage: string): boolean {
  return error.status === 400 && error.reason !== "API_KEY_INVALID" && /schema|response_?json|unknown name/i.test(rawMessage.slice(0, 2000));
}

const rawErrors = new WeakMap<GeminiApiError, string>();

export function createGeminiClient(config: GeminiClientConfig = {}): GeminiClient {
  const doFetch = config.fetch ?? fetch;
  const sleep = config.sleep ?? defaultSleep;
  const now = config.now ?? Date.now;

  async function request(
    url: string | URL,
    init: RequestInit,
    options: { key: string; timeoutMs: number; signal?: AbortSignal; maxBytes: number; what: string },
  ): Promise<{ response: Response; text: string }> {
    const transportFailure = (err: unknown, stage: string, status: number): GeminiApiError => {
      if (options.signal?.aborted) return new GeminiApiError("Gemini request aborted by the caller.", 0, "ABORTED");
      const message = scrubGeminiKey(err instanceof Error ? err.message : String(err), options.key).slice(0, MAX_ERROR_DETAIL_CHARS);
      return new GeminiApiError(`Gemini ${options.what} failed${stage}: ${message}`, status, "TRANSPORT");
    };

    let response: Response;
    try {
      // Redirects are refused: the key travels in a header and must not follow one to another host.
      response = await doFetch(url, { ...init, signal: withTimeout(options.signal, options.timeoutMs), redirect: "error" });
    } catch (err) {
      throw transportFailure(err, "", 0);
    }

    let text: string;
    try {
      text = await readBodyWithLimit(response, response.ok ? options.maxBytes : SMALL_RESPONSE_BYTES);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        throw new GeminiApiError(`Gemini ${options.what} response too large (${err.detail}).`, response.status, "RESPONSE_TOO_LARGE");
      }
      throw transportFailure(err, " while reading the response", response.status);
    }

    if (!response.ok) {
      let body: GoogleErrorBody | null = null;
      try {
        body = JSON.parse(text) as GoogleErrorBody;
      } catch {
        body = null;
      }
      const failure = describeFailure(response.status, body, options.key);
      logger.warn(
        { event: "gemini_error", what: options.what, status: response.status, reason: failure.reason, keyHash: hashToken(options.key) },
        "Gemini request failed",
      );
      rawErrors.set(failure, typeof body?.error?.message === "string" ? body.error.message : "");
      throw failure;
    }
    return { response, text };
  }

  function parseJson(text: string, what: string): unknown {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new GeminiApiError(`Gemini ${what} returned a body that is not JSON.`, 0, "BAD_RESPONSE");
    }
  }

  async function generateOnce(input: GenerateJsonInput, withSchema: boolean): Promise<GenerateJsonResult> {
    const { text } = await request(
      `${GEMINI_BASE_URL}/v1beta/models/${input.model}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": input.key, "content-type": "application/json" },
        body: JSON.stringify(buildGenerateBody(input, { withSchema })),
      },
      { key: input.key, timeoutMs: GENERATE_TIMEOUT_MS, signal: input.signal, maxBytes: GENERATE_RESPONSE_BYTES, what: "generateContent" },
    );
    const body = parseJson(text, "generateContent") as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: unknown; thought?: unknown }> }; finishReason?: unknown }>;
      promptFeedback?: { blockReason?: unknown };
      usageMetadata?: Record<string, unknown>;
      modelVersion?: unknown;
    } | null;

    const blockReason = body?.promptFeedback?.blockReason;
    if (typeof blockReason === "string" && blockReason.length > 0) {
      throw new GeminiApiError(`Gemini blocked the request (${blockReason.slice(0, 60)}); the video was not analyzed.`, 200, "BLOCKED");
    }
    const candidate = Array.isArray(body?.candidates) ? body.candidates[0] : undefined;
    const finishReason = typeof candidate?.finishReason === "string" ? candidate.finishReason.slice(0, 60) : undefined;
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    const answer = parts
      .filter((p) => p && p.thought !== true && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("");

    let json: unknown;
    try {
      json = JSON.parse(stripFence(answer));
    } catch {
      throw new GeminiApiError(
        `Gemini did not return parseable JSON (finish reason: ${finishReason ?? "unknown"}).` +
          (finishReason === "MAX_TOKENS" ? " The answer was cut at the output limit; retry with detail=standard or a narrower focus." : ""),
        200,
        "BAD_RESPONSE",
      );
    }
    const usage = body?.usageMetadata ?? {};
    return {
      json,
      usage: {
        prompt_tokens: num(usage.promptTokenCount),
        output_tokens: num(usage.candidatesTokenCount),
        thoughts_tokens: num(usage.thoughtsTokenCount),
        total_tokens: num(usage.totalTokenCount),
      },
      model: typeof body?.modelVersion === "string" && MODEL_PATTERN.test(body.modelVersion) ? body.modelVersion : input.model,
      finish_reason: finishReason,
      schema_enforced: withSchema,
    };
  }

  return {
    async validateKey(key, signal) {
      await request(
        `${GEMINI_BASE_URL}/v1beta/models?pageSize=1`,
        { method: "GET", headers: { "x-goog-api-key": key } },
        { key, timeoutMs: VALIDATE_TIMEOUT_MS, signal, maxBytes: SMALL_RESPONSE_BYTES, what: "key validation" },
      );
    },

    async uploadFile({ key, data, mimeType, displayName, signal }) {
      // The name is chosen here rather than left to Google (the API accepts a
      // supplied one) so that a finalize whose response never arrives still
      // leaves the caller something to delete.
      const requestedName = `files/mcp-${randomUUID()}`;
      const start = await request(
        `${GEMINI_BASE_URL}/upload/v1beta/files`,
        {
          method: "POST",
          headers: {
            "x-goog-api-key": key,
            "x-goog-upload-protocol": "resumable",
            "x-goog-upload-command": "start",
            "x-goog-upload-header-content-length": String(data.length),
            "x-goog-upload-header-content-type": mimeType,
            "content-type": "application/json",
          },
          body: JSON.stringify({ file: { name: requestedName, display_name: displayName } }),
        },
        { key, timeoutMs: VALIDATE_TIMEOUT_MS, signal, maxBytes: SMALL_RESPONSE_BYTES, what: "upload start" },
      );
      const uploadUrl = assertUploadUrl(start.response.headers.get("x-goog-upload-url"));

      // The session url authenticates itself: the API key is deliberately not sent again.
      let finalize;
      try {
        finalize = await request(
          uploadUrl,
          {
            method: "POST",
            headers: { "x-goog-upload-offset": "0", "x-goog-upload-command": "upload, finalize", "content-type": mimeType },
            // A Buffer is a valid fetch body at runtime; the DOM typings only know ArrayBuffer-backed views.
            body: data as unknown as BodyInit,
          },
          { key, timeoutMs: UPLOAD_TIMEOUT_MS, signal, maxBytes: SMALL_RESPONSE_BYTES, what: "upload" },
        );
      } catch (err) {
        // Google may have accepted the upload before the response was lost.
        if (err instanceof GeminiApiError) err.fileName = requestedName;
        throw err;
      }
      // Parsing is inside the post-send handling too: an accepted upload whose
      // 200 came back empty or truncated must still leave a name to delete.
      try {
        const body = parseJson(finalize.text, "upload") as { file?: unknown } | null;
        return fileFrom(body?.file);
      } catch (err) {
        if (err instanceof GeminiApiError) err.fileName = requestedName;
        throw err;
      }
    },

    async waitForFileActive({ key, name, budgetMs, signal }) {
      const fileName = assertFileName(name);
      const deadline = now() + budgetMs;
      let transientFailures = 0;
      for (;;) {
        let file: GeminiFile | undefined;
        try {
          const { text } = await request(
            `${GEMINI_BASE_URL}/v1beta/${fileName}`,
            { method: "GET", headers: { "x-goog-api-key": key } },
            { key, timeoutMs: POLL_TIMEOUT_MS, signal, maxBytes: SMALL_RESPONSE_BYTES, what: "file status" },
          );
          file = fileFrom(parseJson(text, "file status"));
          transientFailures = 0;
        } catch (err) {
          const transient = err instanceof GeminiApiError && (err.status >= 500 || err.reason === "TRANSPORT");
          if (!transient || ++transientFailures > MAX_TRANSIENT_POLL_FAILURES) throw err;
        }
        if (file?.state === "ACTIVE") return file;
        if (file?.state === "FAILED") {
          throw new GeminiApiError("Gemini could not process the uploaded video (file state FAILED).", 200, "FILE_FAILED");
        }
        if (now() + POLL_INTERVAL_MS > deadline) {
          throw new GeminiApiError("Gemini is still processing the uploaded video; try again in a minute.", 200, "FILE_PROCESSING");
        }
        await sleep(POLL_INTERVAL_MS, signal);
      }
    },

    async generateJson(input) {
      if (!MODEL_PATTERN.test(input.model)) {
        throw new GeminiApiError("Refusing to call Gemini with a malformed model id.", 0);
      }
      try {
        return await generateOnce(input, true);
      } catch (err) {
        if (err instanceof GeminiApiError && isSchemaRejection(err, rawErrors.get(err) ?? "")) {
          // A rejected request is not billed, so one prompt-only retry is free.
          logger.warn({ event: "gemini_schema_rejected", keyHash: hashToken(input.key) }, "Gemini refused the response schema; retrying once without it");
          return generateOnce(input, false);
        }
        throw err;
      }
    },

    async deleteFile({ key, name }) {
      if (!FILE_NAME_PATTERN.test(name)) return false;
      try {
        await request(
          `${GEMINI_BASE_URL}/v1beta/${name}`,
          { method: "DELETE", headers: { "x-goog-api-key": key } },
          { key, timeoutMs: DELETE_TIMEOUT_MS, maxBytes: SMALL_RESPONSE_BYTES, what: "file delete" },
        );
        return true;
      } catch {
        return false;
      }
    },
  };
}

let defaultClient: GeminiClient | undefined;

export function getGeminiClient(): GeminiClient {
  if (!defaultClient) defaultClient = createGeminiClient();
  return defaultClient;
}

export function configureGeminiClientForTests(client: GeminiClient | undefined): void {
  defaultClient = client;
}
