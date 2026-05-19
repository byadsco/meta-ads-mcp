import pino from "pino";
import { isStdioTransport } from "./transport-mode.js";

const isStdio = isStdioTransport(process.argv);

export const logger = isStdio
  ? pino(
      { level: process.env.LOG_LEVEL ?? "info" },
      pino.destination({ fd: 2, sync: false }),
    )
  : pino({
      level: process.env.LOG_LEVEL ?? "info",
      transport:
        process.env.NODE_ENV !== "production"
          ? { target: "pino-pretty", options: { colorize: true } }
          : undefined,
    });
