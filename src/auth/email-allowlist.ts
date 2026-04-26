function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

export interface AllowlistInput {
  email?: string | null;
  fbUserId?: string | null;
}

export function isAllowed(input: AllowlistInput): boolean {
  const emails = parseList(process.env.AUTH_ALLOWED_EMAILS);
  const domains = parseList(process.env.AUTH_ALLOWED_DOMAINS);
  const fbIds = parseList(process.env.AUTH_ALLOWED_FB_USER_IDS);

  if (emails.length === 0 && domains.length === 0 && fbIds.length === 0) {
    // Fail-closed when multi-tenant Meta OAuth is configured (CODE-M6).
    // The deploy gate enforces this in production, but staging or local
    // environments with META_APP_ID/SECRET set must not silently accept
    // every login: an empty allowlist means "no one".
    const multiTenantOn =
      !!process.env.META_APP_ID?.trim() &&
      !!process.env.META_APP_SECRET?.trim();
    if (multiTenantOn) return false;
    return process.env.NODE_ENV !== "production";
  }

  const email = input.email?.toLowerCase() ?? null;
  const fbUserId = input.fbUserId ?? null;

  if (email && emails.includes(email)) return true;
  if (email) {
    const domain = email.split("@")[1];
    if (domain && domains.includes(domain)) return true;
  }
  if (fbUserId && fbIds.includes(fbUserId)) return true;

  return false;
}

export function isAllowlistConfigured(): boolean {
  return (
    parseList(process.env.AUTH_ALLOWED_EMAILS).length > 0 ||
    parseList(process.env.AUTH_ALLOWED_DOMAINS).length > 0 ||
    parseList(process.env.AUTH_ALLOWED_FB_USER_IDS).length > 0
  );
}
