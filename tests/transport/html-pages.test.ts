import { describe, it, expect } from "vitest";
import {
  CONNECTIONS_PATH,
  renderApifySection,
  renderConnectionsPage,
} from "../../src/transport/html-pages.js";
import { renderConsentPage } from "../../src/transport/http.js";
import type { ApifyTokenStatus } from "../../src/store/apify-token-repo.js";
import type { MetaTokenSummary } from "../../src/store/meta-token-repo.js";

const NOT_REGISTERED: ApifyTokenStatus = {
  registered: false,
  apifyUserId: null,
  apifyUsername: null,
  updatedAt: null,
};

const REGISTERED: ApifyTokenStatus = {
  registered: true,
  apifyUserId: "u1",
  apifyUsername: "byads",
  updatedAt: 1_786_000_000,
};

const metaToken = (over: Partial<MetaTokenSummary> = {}): MetaTokenSummary => ({
  name: "byads",
  kind: "system_user",
  expiresAt: null,
  metaUserId: "m1",
  metaUserName: "ByAds",
  businessId: null,
  businessName: null,
  isDefault: true,
  isExpired: false,
  ...over,
});

const user = { fbUserId: "9001", email: "santiago@byads.co", name: "Santiago Bastidas" };

/**
 * Every class a page emits must be styled by the <style> block that page
 * actually ships. Reading the styles out of the rendered HTML (rather than
 * being handed a block) is the point: an earlier version passed
 * PAGE_STYLES + PAGE_EXTRA_STYLES by hand and so happily passed while the
 * consent page, which embeds only PAGE_STYLES, shipped three unstyled classes.
 */
function assertClassesAreStyled(html: string) {
  const styleBlock = /<style>([\s\S]*?)<\/style>/.exec(html);
  expect(styleBlock, "page has no <style> block").not.toBeNull();
  const styles = styleBlock![1];

  const emitted = new Set(
    [...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean),
  );
  const unstyled = [...emitted].filter(
    (c) => !new RegExp(`\\.${c}(?![\\w-])`).test(styles),
  );
  expect(unstyled, `classes emitted but not styled by this page: ${unstyled.join(", ")}`).toEqual([]);
}

describe("renderApifySection", () => {
  it("offers the register form when no token is stored", () => {
    const html = renderApifySection({
      status: NOT_REGISTERED,
      returnTo: CONNECTIONS_PATH,
      variant: "connections",
    });

    expect(html).toContain('action="/auth/register-apify-token"');
    expect(html).toContain('name="apify_token"');
    expect(html).toContain('type="password"');
    expect(html).toContain(`value="${CONNECTIONS_PATH}"`);
    expect(html).not.toContain("/auth/delete-apify-token");
  });

  it("uses a password field so the token is not shoulder-readable or autofilled", () => {
    const html = renderApifySection({
      status: NOT_REGISTERED,
      returnTo: CONNECTIONS_PATH,
      variant: "connections",
    });
    expect(html).toContain('autocomplete="off"');
    expect(html).not.toContain('type="text" name="apify_token"');
  });

  it("shows the connected account and a disconnect button on the connections page", () => {
    const html = renderApifySection({
      status: REGISTERED,
      returnTo: CONNECTIONS_PATH,
      variant: "connections",
    });

    expect(html).toContain("byads");
    expect(html).toContain("conectado");
    expect(html).toContain('action="/auth/delete-apify-token"');
    expect(html).toContain("2026-08-06");
  });

  it("never offers disconnect mid-OAuth on the consent page", () => {
    const html = renderApifySection({
      status: REGISTERED,
      returnTo: "/authorize?client_id=x&redirect_uri=y",
      variant: "consent",
    });

    expect(html).toContain("byads");
    expect(html).not.toContain("/auth/delete-apify-token");
    expect(html).toContain('action="/auth/register-apify-token"');
  });

  it("escapes the return path into the hidden field", () => {
    const html = renderApifySection({
      status: NOT_REGISTERED,
      returnTo: '/authorize?a="><script>alert(1)</script>',
      variant: "consent",
    });

    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes a hostile Apify username", () => {
    const html = renderApifySection({
      status: { ...REGISTERED, apifyUsername: '"><script>alert(1)</script>' },
      returnTo: CONNECTIONS_PATH,
      variant: "connections",
    });

    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });

  it("falls back to the Apify user id, then a generic label", () => {
    const noName = renderApifySection({
      status: { ...REGISTERED, apifyUsername: null },
      returnTo: CONNECTIONS_PATH,
      variant: "connections",
    });
    expect(noName).toContain("u1");

    const nothing = renderApifySection({
      status: { ...REGISTERED, apifyUsername: null, apifyUserId: null },
      returnTo: CONNECTIONS_PATH,
      variant: "connections",
    });
    expect(nothing).toContain("cuenta Apify");
  });

  it("omits the date line when updatedAt is missing", () => {
    const html = renderApifySection({
      status: { ...REGISTERED, updatedAt: null },
      returnTo: CONNECTIONS_PATH,
      variant: "connections",
    });
    expect(html).not.toContain('class="token-expiry"');
  });
});

describe("renderConnectionsPage", () => {
  const base = { user, tokens: [metaToken()], activeName: "byads", apify: NOT_REGISTERED };

  it("lists Meta tokens and marks the active one", () => {
    const html = renderConnectionsPage({
      ...base,
      tokens: [
        metaToken({ name: "byads" }),
        metaToken({ name: "personal", kind: "user", expiresAt: null, isDefault: false }),
      ],
    });

    expect(html).toContain("byads");
    expect(html).toContain("personal");
    expect(html).toContain("activo");
    // The non-active row gets a switch button instead.
    expect(html).toContain('action="/auth/select-token"');
  });

  it("sends select-token back to the connections page", () => {
    const html = renderConnectionsPage({
      ...base,
      tokens: [metaToken({ name: "other", isDefault: false })],
      activeName: "byads",
    });
    expect(html).toContain(`<input type="hidden" name="return" value="${CONNECTIONS_PATH}" />`);
  });

  it("renders system vs personal expiry correctly", () => {
    const html = renderConnectionsPage({
      ...base,
      tokens: [
        metaToken({ name: "sys", kind: "system_user" }),
        metaToken({
          name: "usr",
          kind: "user",
          expiresAt: Math.floor(Date.now() / 1000) + 5 * 86400,
          isDefault: false,
        }),
      ],
    });
    expect(html).toContain("no expira");
    expect(html).toMatch(/[45] días/);
  });

  it("flags an expired token", () => {
    const html = renderConnectionsPage({
      ...base,
      tokens: [metaToken({ kind: "user", isExpired: true, expiresAt: 1 })],
    });
    expect(html).toContain("badge-warn");
    expect(html).toContain("expirado");
  });

  it("does not throw with zero Meta tokens", () => {
    const html = renderConnectionsPage({ ...base, tokens: [], activeName: null });
    expect(html).toContain("no-tokens");
    expect(html).toContain("No hay tokens de Meta");
  });

  it("embeds the Apify section", () => {
    const html = renderConnectionsPage({ ...base, apify: REGISTERED });
    expect(html).toContain("/auth/delete-apify-token");
  });

  it("never offers Meta token deletion", () => {
    // Deliberately out of scope: destructive, and this page exists for Apify
    // plus visibility.
    const html = renderConnectionsPage(base);
    expect(html).not.toContain("/auth/delete-token");
  });

  it.each([
    ["user name", { user: { ...user, name: '"><script>alert(1)</script>' } }],
    ["user email", { user: { ...user, name: null, email: '"><img src=x onerror=1>' } }],
    ["token name", { tokens: [metaToken({ name: '"><script>x</script>' })] }],
    ["business name", { tokens: [metaToken({ businessName: '"><script>x</script>' })] }],
  ])("escapes a hostile %s", (_label, over) => {
    const html = renderConnectionsPage({ ...base, ...over } as never);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror=1>");
  });

  it("only emits classes that are styled", () => {
    const html = renderConnectionsPage({ ...base, apify: REGISTERED });
    assertClassesAreStyled(html);
  });
});

describe("renderConsentPage", () => {
  const query = { client_id: "claude", redirect_uri: "https://claude.ai/cb", state: "s1" };
  const base = {
    query,
    user,
    tokens: [metaToken()],
    activeName: "byads",
    apify: NOT_REGISTERED,
  };

  it("includes the Apify section and a link to the connections page", () => {
    const html = renderConsentPage(base);
    expect(html).toContain("/auth/register-apify-token");
    expect(html).toContain(`href="${CONNECTIONS_PATH}"`);
  });

  it("keeps the Apify section free of destructive actions", () => {
    const html = renderConsentPage({ ...base, apify: REGISTERED });
    expect(html).not.toContain("/auth/delete-apify-token");
  });

  // The whole point: Apify is a paid optional add-on and must never gate OAuth.
  it.each([
    [1, false],
    [1, true],
    [0, false],
    [0, true],
  ])("approve disabled depends only on token count (%i tokens, apify=%s)", (count, registered) => {
    const html = renderConsentPage({
      ...base,
      tokens: count > 0 ? [metaToken()] : [],
      activeName: count > 0 ? "byads" : null,
      apify: registered ? REGISTERED : NOT_REGISTERED,
    });

    const approveDisabled = /class="approve"\s+disabled/.test(html);
    expect(approveDisabled).toBe(count === 0);
  });

  it("routes the Apify form back to the same consent URL", () => {
    const html = renderConsentPage(base);
    // Round-trips the whole OAuth request so approval can continue afterwards.
    expect(html).toContain("/authorize?client_id=claude");
  });

  it("only emits classes that are styled", () => {
    const html = renderConsentPage({ ...base, apify: REGISTERED });
    assertClassesAreStyled(html);
  });
});
