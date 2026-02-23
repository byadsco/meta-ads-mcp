#!/usr/bin/env node

import { parseArgs } from "node:util";
import { createServer } from "./server.js";
import { startHttpTransport } from "./transport/http.js";
import { startStdioTransport } from "./transport/stdio.js";
import { logger } from "./utils/logger.js";

const { values } = parseArgs({
  options: {
    transport: {
      type: "string",
      short: "t",
      default: "http",
    },
    port: {
      type: "string",
      short: "p",
      default: process.env.PORT ?? "3000",
    },
  },
  strict: false,
});

const transport = values.transport ?? "http";
const port = parseInt(String(values.port ?? "3000"), 10);

async function main(): Promise<void> {
  logger.info(
    { transport, port: transport === "http" ? port : undefined },
    "Starting Meta Ads MCP server",
  );

  if (transport === "stdio") {
    const server = createServer();
    await startStdioTransport(server);
  } else {
    await startHttpTransport(createServer, port);
  }
}

main().catch((error) => {
  logger.fatal({ error }, "Failed to start server");
  process.exit(1);
});
