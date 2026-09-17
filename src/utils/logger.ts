import pino from "pino";
import { isStdioTransport } from "./transport-mode.js";

const isStdio = isStdioTransport(process.argv);

/**
 * Defense in depth only. Secret hygiene is enforced at the call sites (log
 * hashToken()/maskToken() output, never the raw value); this catches a future
 * `logger.info({ apify_token })` slipping through code review.
 */
const redact = {
  paths: [
    "apify_token",
    "*.apify_token",
    "apifyToken",
    "*.apifyToken",
    "gemini_api_key",
    "*.gemini_api_key",
    "geminiApiKey",
    "*.geminiApiKey",
    "gemini_key",
    "*.gemini_key",
    // Bracket syntax: pino paths cannot carry a hyphen unquoted.
    'headers["x-goog-api-key"]',
    '*["x-goog-api-key"]',
    "access_token",
    "*.access_token",
    "accessToken",
    "*.accessToken",
    "authorization",
    "*.authorization",
    "headers.Authorization",
  ],
  censor: "[REDACTED]",
};

export const logger = isStdio
  ? pino(
      { level: process.env.LOG_LEVEL ?? "info", redact },
      pino.destination({ fd: 2, sync: false }),
    )
  : pino({
      level: process.env.LOG_LEVEL ?? "info",
      redact,
      transport:
        process.env.NODE_ENV !== "production"
          ? { target: "pino-pretty", options: { colorize: true } }
          : undefined,
    });
