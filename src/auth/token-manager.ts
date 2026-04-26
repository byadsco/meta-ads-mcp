import { logger } from "../utils/logger.js";

export class TokenManager {
  private tokens = new Map<string, string>();
  private activeTokenName: string | null = null;
  private envLoaded = false;

  /**
   * Lazy initialization (CODE-B6): we used to read META_TOKENS in the
   * constructor, which fired at module-import time. That made the
   * tokens visible on the import-side stack of any uncaught error and
   * hard to reset deterministically in tests. Now load on first access.
   */
  private ensureEnvLoaded(): void {
    if (this.envLoaded) return;
    this.envLoaded = true;
    this.loadFromEnv();
  }

  private loadFromEnv(): void {
    const metaTokensJson = process.env.META_TOKENS;
    if (metaTokensJson) {
      try {
        const parsed: unknown = JSON.parse(metaTokensJson);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed)
        ) {
          for (const [name, token] of Object.entries(parsed)) {
            if (typeof token === "string" && token.length > 0) {
              this.tokens.set(name, token);
            }
          }
          const firstKey = Object.keys(parsed)[0];
          if (firstKey && this.tokens.has(firstKey)) {
            this.activeTokenName = firstKey;
          }
          logger.info(
            { count: this.tokens.size },
            "Loaded tokens from META_TOKENS",
          );
        }
      } catch (err) {
        logger.error({ error: err }, "Failed to parse META_TOKENS JSON");
      }
    }

    // Fallback: register META_ACCESS_TOKEN as "default" if not already present
    const singleToken = process.env.META_ACCESS_TOKEN;
    if (singleToken && !this.tokens.has("default")) {
      this.tokens.set("default", singleToken);
      if (!this.activeTokenName) {
        this.activeTokenName = "default";
      }
    }
  }

  getActiveToken(): string | null {
    this.ensureEnvLoaded();
    if (!this.activeTokenName) return null;
    return this.tokens.get(this.activeTokenName) ?? null;
  }

  getActiveTokenName(): string | null {
    this.ensureEnvLoaded();
    return this.activeTokenName;
  }

  setActiveToken(name: string): boolean {
    this.ensureEnvLoaded();
    if (!this.tokens.has(name)) return false;
    this.activeTokenName = name;
    logger.info({ tokenName: name }, "Active token changed");
    return true;
  }

  listTokens(): { active: string | null; available: string[] } {
    this.ensureEnvLoaded();
    return {
      active: this.activeTokenName,
      available: Array.from(this.tokens.keys()),
    };
  }

  registerToken(name: string, token: string): void {
    this.ensureEnvLoaded();
    this.tokens.set(name, token);
    if (!this.activeTokenName) {
      this.activeTokenName = name;
    }
    logger.info({ tokenName: name }, "Token registered");
  }

  hasTokens(): boolean {
    this.ensureEnvLoaded();
    return this.tokens.size > 0;
  }

  /** Test-only: reset and re-read env on next access. */
  resetForTests(): void {
    this.tokens.clear();
    this.activeTokenName = null;
    this.envLoaded = false;
  }
}

/** Mask a token for safe display: first 10 chars + "..." */
export function maskToken(token: string): string {
  if (token.length <= 10) return token.slice(0, 3) + "***";
  return token.slice(0, 10) + "...";
}

export const tokenManager = new TokenManager();
