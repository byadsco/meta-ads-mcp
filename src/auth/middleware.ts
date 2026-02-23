import type { Request, Response, NextFunction } from "express";
import { requestContext } from "./token-store.js";
import { logger } from "../utils/logger.js";

/**
 * Express middleware that extracts the Meta access token from the
 * Authorization header and stores it in AsyncLocalStorage.
 *
 * Token resolution order:
 * 1. Authorization: Bearer <token>
 * 2. META_ACCESS_TOKEN environment variable
 *
 * If neither is available, returns 401.
 */
export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  let token: string | undefined;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7).trim();
  }

  if (!token) {
    token = process.env.META_ACCESS_TOKEN;
  }

  if (!token) {
    logger.warn("Request rejected: no access token");
    res.status(401).json({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message:
          "Missing Meta access token. Provide via Authorization: Bearer <token> header or META_ACCESS_TOKEN env var.",
      },
      id: null,
    });
    return;
  }

  requestContext.run({ accessToken: token }, () => {
    next();
  });
}
