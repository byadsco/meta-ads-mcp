import pino from "pino";

const stdioIdx = process.argv.indexOf("--transport");
const isStdio = stdioIdx !== -1 && process.argv[stdioIdx + 1] === "stdio";

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
