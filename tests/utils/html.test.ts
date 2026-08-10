import { describe, it, expect } from "vitest";
import { escapeHtml } from "../../src/utils/html.js";

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml("&")).toBe("&amp;");
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml(">")).toBe("&gt;");
    expect(escapeHtml('"')).toBe("&quot;");
    expect(escapeHtml("'")).toBe("&#x27;");
  });

  it("escapes & first so the other entities are not double-escaped", () => {
    // If `<` were replaced before `&`, the resulting "&lt;" would become
    // "&amp;lt;" and render as literal text instead of a less-than sign.
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("neutralizes a script-tag injection attempt", () => {
    const escaped = escapeHtml('"><script>alert(1)</script>');
    expect(escaped).not.toContain("<script");
    expect(escaped).not.toContain('">');
    expect(escaped).toBe("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("neutralizes an attribute-breaking single quote", () => {
    expect(escapeHtml("' onmouseover='alert(1)")).toBe(
      "&#x27; onmouseover=&#x27;alert(1)",
    );
  });

  it("leaves safe text untouched", () => {
    expect(escapeHtml("ByAds_Black_GlobalCom")).toBe("ByAds_Black_GlobalCom");
    expect(escapeHtml("Agencia Ñandú — 100% ✅")).toBe("Agencia Ñandú — 100% ✅");
    expect(escapeHtml("")).toBe("");
  });
});
