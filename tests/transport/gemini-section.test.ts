import { describe, it, expect } from "vitest";
import { CONNECTIONS_PATH, renderConnectionsPage, renderGeminiSection } from "../../src/transport/html-pages.js";
import { renderConsentPage } from "../../src/transport/http.js";
import type { ApifyTokenStatus } from "../../src/store/apify-token-repo.js";
import type { GeminiKeyStatus } from "../../src/store/gemini-key-repo.js";
import type { MetaTokenSummary } from "../../src/store/meta-token-repo.js";

const NOT_REGISTERED: GeminiKeyStatus = { registered: false, keyFingerprint: null, updatedAt: null };
const REGISTERED: GeminiKeyStatus = { registered: true, keyFingerprint: "a1a1a1a1a1a1", updatedAt: 1_786_000_000 };

const APIFY: ApifyTokenStatus = { registered: false, apifyUserId: null, apifyUsername: null, updatedAt: null };

const metaToken: MetaTokenSummary = {
  name: "byads",
  kind: "system_user",
  expiresAt: null,
  metaUserId: "m1",
  metaUserName: "ByAds",
  businessId: null,
  businessName: null,
  isDefault: true,
  isExpired: false,
};

const user = { fbUserId: "9001", email: "santiago@byads.co", name: "Santiago Bastidas" };

/** Every class a page emits must be styled by the <style> block that page itself ships. */
function assertClassesAreStyled(html: string) {
  const styleBlock = /<style>([\s\S]*?)<\/style>/.exec(html);
  expect(styleBlock, "page has no <style> block").not.toBeNull();
  const styles = styleBlock![1];
  const emitted = new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean));
  const unstyled = [...emitted].filter((c) => !new RegExp(`\\.${c}(?![\\w-])`).test(styles));
  expect(unstyled, `classes emitted but not styled by this page: ${unstyled.join(", ")}`).toEqual([]);
}

describe("renderGeminiSection", () => {
  it("offers the register form when no key is stored", () => {
    const html = renderGeminiSection({ status: NOT_REGISTERED, returnTo: CONNECTIONS_PATH, variant: "connections" });
    expect(html).toContain('action="/auth/register-gemini-key"');
    expect(html).toContain('name="gemini_api_key"');
    expect(html).toContain('type="password"');
    expect(html).toContain('autocomplete="off"');
    expect(html).toContain(`value="${CONNECTIONS_PATH}"`);
    expect(html).not.toContain("/auth/delete-gemini-key");
  });

  it("links to AI Studio and states the privacy and cost trade-offs", () => {
    const html = renderGeminiSection({ status: NOT_REGISTERED, returnTo: CONNECTIONS_PATH, variant: "connections" });
    expect(html).toContain("aistudio.google.com/apikey");
    expect(html).toMatch(/rel="noopener noreferrer"/);
    expect(html).toMatch(/48 h|48 horas/);
    expect(html).toMatch(/pago|paga/i);
  });

  it("shows the connected state and a disconnect button on the connections page", () => {
    const html = renderGeminiSection({ status: REGISTERED, returnTo: CONNECTIONS_PATH, variant: "connections" });
    expect(html).toContain("conectado");
    expect(html).toContain('action="/auth/delete-gemini-key"');
    expect(html).toContain("2026-08-06");
  });

  it("never shows the key, not even its fingerprint", () => {
    const html = renderGeminiSection({ status: REGISTERED, returnTo: CONNECTIONS_PATH, variant: "connections" });
    expect(html).not.toContain("a1a1a1a1a1a1");
  });

  it("never offers disconnect mid-OAuth on the consent page", () => {
    const html = renderGeminiSection({ status: REGISTERED, returnTo: "/authorize?client_id=x&redirect_uri=y", variant: "consent" });
    expect(html).not.toContain("/auth/delete-gemini-key");
    expect(html).toContain('action="/auth/register-gemini-key"');
  });

  it("escapes the return path into the hidden field", () => {
    const html = renderGeminiSection({ status: NOT_REGISTERED, returnTo: '/authorize?a="><script>alert(1)</script>', variant: "consent" });
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&lt;script&gt;");
  });

  it("omits the date line when updatedAt is missing", () => {
    const html = renderGeminiSection({ status: { ...REGISTERED, updatedAt: null }, returnTo: CONNECTIONS_PATH, variant: "connections" });
    expect(html).not.toContain('class="token-expiry"');
  });
});

describe("pages embedding the Gemini section", () => {
  it("renders it on the connections page with every class styled", () => {
    const html = renderConnectionsPage({ user, tokens: [metaToken], activeName: "byads", apify: APIFY, gemini: REGISTERED });
    expect(html).toContain("Gemini");
    expect(html).toContain('action="/auth/delete-gemini-key"');
    assertClassesAreStyled(html);
  });

  it("renders it on the consent page with every class styled and no disconnect", () => {
    const html = renderConsentPage({
      query: { client_id: "abc", redirect_uri: "https://claude.ai/api/mcp/auth_callback" },
      user,
      tokens: [metaToken],
      activeName: "byads",
      apify: APIFY,
      gemini: NOT_REGISTERED,
    });
    expect(html).toContain("Gemini");
    expect(html).not.toContain("/auth/delete-gemini-key");
    assertClassesAreStyled(html);
  });
});
