import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = readFileSync(join(ROOT, ".gitleaks.toml"), "utf8");

function allowlistRegexes(): string[] {
  const block = /^regexes = \[(.*?)^\]/ms.exec(config);
  if (!block) throw new Error("no `regexes = [...]` block found in .gitleaks.toml");
  return [...block[1].matchAll(/^\s*'''(.*?)''',$/gm)].map((m) => m[1]);
}

describe(".gitleaks.toml", () => {
  /**
   * gitleaks >= ~8.30 joins the global allowlist regexes into one alternation,
   * so a bare inline (?i) leaks into every entry after it and silently widens
   * the allowlist. That regression let a real-looking `apify_api_TESTtoken…`
   * value through locally while CI (8.24.3) flagged it. Stating the flag on
   * every entry makes the list version-independent.
   */
  it("declares an explicit case flag on every allowlist regex", () => {
    const offenders = allowlistRegexes().filter((r) => !/^\(\?-?i\)/.test(r));

    expect(
      offenders,
      "each allowlist regex must start with (?i) or (?-i) so neighbouring " +
        "entries cannot change its case sensitivity",
    ).toEqual([]);
  });

  it("keeps the synthetic-fixture exemptions case-sensitive", () => {
    // An uppercase TEST/DUMMY inside an otherwise real-looking credential must
    // not buy an exemption — that is exactly how the original leak slipped by.
    const regexes = allowlistRegexes();

    for (const needle of ["dummy[-_]?", "test[-_]?", "fixture", "placeholder"]) {
      const entry = regexes.find((r) => r.includes(needle));
      expect(entry, `expected an allowlist entry containing ${needle}`).toBeDefined();
      expect(entry).toMatch(/^\(\?-i\)/);
    }
  });

  it("pins a bare semver that CI can consume", () => {
    const pinned = readFileSync(join(ROOT, ".gitleaks-version"), "utf8").trim();
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("keeps the apify token rule tight enough to catch a real token", () => {
    const rule = /id = "apify-api-token"[\s\S]*?regex = '''(.*?)'''/.exec(config);
    expect(rule, "apify-api-token rule missing from .gitleaks.toml").not.toBeNull();

    const pattern = new RegExp(rule![1]);
    // A production-shaped token must match; the repo's short fixtures must not.
    expect(pattern.test("apify_api_" + "a".repeat(36))).toBe(true);
    expect(pattern.test("apify_api_testfixture")).toBe(false);
  });
});
