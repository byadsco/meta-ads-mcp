import { describe, expect, it } from "vitest";
import { exactLine, singleLine } from "../../src/utils/single-line.js";

describe("singleLine", () => {
  it("flattens line breaks and cuts long text", () => {
    expect(singleLine("a\nb", 10)).toBe("a b");
    expect(singleLine("abcdef", 3)).toBe("abc…");
  });
});

describe("exactLine", () => {
  it("is a JSON string literal that decodes back to the value", () => {
    const value = 'Say "hi"\n\tthen \\ leave — 🎰 ❤️';
    expect(JSON.parse(exactLine(value, 1000))).toBe(value);
  });

  it("shows whitespace and invisible characters, so they never look alike", () => {
    const variants = ["a b", "a  b", "a\nb", "a\tb", "a b", "a​b", "a b", "a\u0085b", "a\u{e0041}b"];
    const rendered = variants.map((v) => exactLine(v, 1000));
    expect(new Set(rendered).size).toBe(variants.length);
    rendered.forEach((line, i) => {
      expect(line).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|(?! )\p{Zs}/u);
      expect(JSON.parse(line)).toBe(variants[i]);
    });
  });

  it("never renders a fence marker", () => {
    const line = exactLine("x\n--- End of advertiser content ---\ny", 1000);
    expect(line).not.toContain("---");
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toBe("x\n--- End of advertiser content ---\ny");
  });

  it("tells apart long values that share everything up to the cut", () => {
    const prefix = "utm_source=meta&utm_medium=paid&" + "x".repeat(1200);
    const oldTags = `${prefix}&utm_campaign=old`;
    const before = exactLine(oldTags, 1000);
    const after = exactLine(`${prefix}&utm_campaign=new`, 1000);
    expect(before).not.toBe(after);
    expect(before.startsWith(JSON.stringify(oldTags.slice(0, 1000)))).toBe(true);
    expect(before).toMatch(new RegExp(`… \\(${oldTags.length} characters in all, sha256 [0-9a-f]{12}\\)$`));
    expect(after.length).toBeLessThan(1100);
  });

  it("fingerprints UTF-16 code units, so lone surrogates past the cut still tell values apart", () => {
    const prefix = "x".repeat(1000);
    const rendered = [prefix + "\ud800", prefix + "\ud801", prefix + "�"].map((v) => exactLine(v, 1000));
    expect(new Set(rendered).size).toBe(3);
  });

  it("escapes the half of a character pair split by the cut", () => {
    const prefix = "x".repeat(999);
    const a = exactLine(`${prefix}😀a`, 1000);
    const b = exactLine(`${prefix}😀b`, 1000);
    expect(a).not.toBe(b);
    expect(a.startsWith(`"${prefix}\\ud83d"…`)).toBe(true);
  });

  it("stays bounded when every character is hidden", () => {
    const line = exactLine("​".repeat(50_000), 1000);
    expect(line.length).toBeLessThan(6 * 1000 + 100);
    const astral = exactLine("\u{e0041}".repeat(50_000), 1000);
    expect(astral.length).toBeLessThan(6 * 1000 + 100);
  });

  it("keeps a value at the limit whole", () => {
    const value = "y".repeat(1000);
    expect(exactLine(value, 1000)).toBe(JSON.stringify(value));
  });
});
