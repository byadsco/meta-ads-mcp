import { logger } from "../utils/logger.js";

export interface SecurityConfig {
  metaAppConfigured: boolean;
  allowlistConfigured: boolean;
  multiTenantEnabled: boolean;
}

function readEnvVar(env: NodeJS.ProcessEnv, key: string): string {
  return env[key]?.trim() ?? "";
}

function hasAllowlist(env: NodeJS.ProcessEnv): boolean {
  return (
    readEnvVar(env, "AUTH_ALLOWED_EMAILS").length > 0 ||
    readEnvVar(env, "AUTH_ALLOWED_DOMAINS").length > 0 ||
    readEnvVar(env, "AUTH_ALLOWED_FB_USER_IDS").length > 0
  );
}

function looksUnset(value: string): boolean {
  if (!value) return true;
  const lower = value.toLowerCase();
  if (
    lower === "-" ||
    lower === "--" ||
    lower === "x" ||
    lower === "xx" ||
    lower === "xxx" ||
    lower === "todo" ||
    lower === "none" ||
    lower === "placeholder" ||
    lower === "change-me" ||
    lower === "change_me" ||
    lower === "changeme" ||
    lower === "<value>" ||
    lower === "<unset>"
  ) {
    return true;
  }
  return (
    lower.includes("placeholder") ||
    lower.includes("change-me") ||
    lower.includes("changeme") ||
    lower.startsWith("your_") ||
    lower.startsWith("your-")
  );
}

function requireSecret(value: string, name: string, minLength: number): void {
  if (looksUnset(value)) {
    throw new Error(`${name} environment variable is required`);
  }
  if (value.length < minLength) {
    throw new Error(`${name} must be at least ${minLength} characters`);
  }
}

/**
 * Resolve and validate security-sensitive runtime configuration.
 *
 * Multi-tenant Meta OAuth + Firestore is enabled when META_APP_ID/SECRET
 * are present. Production is fail-closed on the secrets that matter:
 * encryption key, session secret, OAuth secret, and at least one allowlist
 * source so the deployment never accepts arbitrary Meta logins.
 */
export function resolveSecurityConfig(
  env: NodeJS.ProcessEnv = process.env,
): SecurityConfig {
  const isProduction = env.NODE_ENV === "production";

  if (env.OAUTH_APPROVAL_PIN) {
    logger.warn(
      "OAUTH_APPROVAL_PIN is deprecated and ignored. Configure META_APP_ID/SECRET + AUTH_ALLOWED_* instead.",
    );
  }

  const metaAppId = readEnvVar(env, "META_APP_ID");
  const metaAppSecret = readEnvVar(env, "META_APP_SECRET");
  const metaAppConfigured = metaAppId.length > 0 && metaAppSecret.length > 0;

  const tokenEncryptionKey = readEnvVar(env, "TOKEN_ENCRYPTION_KEY");
  const sessionCookieSecret = readEnvVar(env, "SESSION_COOKIE_SECRET");
  const oauthSecret = readEnvVar(env, "OAUTH_SECRET");

  const allowlistConfigured = hasAllowlist(env);
  const multiTenantEnabled = metaAppConfigured;

  if (multiTenantEnabled) {
    if (!tokenEncryptionKey) {
      throw new Error(
        "TOKEN_ENCRYPTION_KEY is required when META_APP_ID/SECRET are set",
      );
    }
    if (!/^[0-9a-fA-F]{64}$/.test(tokenEncryptionKey)) {
      throw new Error(
        "TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes)",
      );
    }
    requireSecret(sessionCookieSecret, "SESSION_COOKIE_SECRET", 32);
    if (!allowlistConfigured) {
      throw new Error(
        "Allowlist required: set AUTH_ALLOWED_EMAILS, AUTH_ALLOWED_DOMAINS, or AUTH_ALLOWED_FB_USER_IDS",
      );
    }
  }

  if (isProduction) {
    requireSecret(oauthSecret, "OAUTH_SECRET", 32);
  }

  return {
    metaAppConfigured,
    allowlistConfigured,
    multiTenantEnabled,
  };
}
