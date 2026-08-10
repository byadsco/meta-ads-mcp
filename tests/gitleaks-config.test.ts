import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = readFileSync(join(ROOT, ".gitleaks.toml"), "utf8");

/**
 * gitleaks joins allowlist patterns into a single alternation (an optimization
 * promoted in 8.28.0), so a bare inline (?i) leaks into every pattern after it
 * and silently widens the allowlist. It affects `paths` as well as `regexes`,
 * and per-rule allowlists as well as the global one.
 *
 * Empirically, on 8.30.1: a leading (?i) entry made a following case-sensitive
 * `secrets\.notes$` path exclude `SECRETS.NOTES` too, so a file that should
 * have been scanned was skipped entirely.
 */

interface PatternList {
  key: string;
  section: string;
  entries: string[];
  /** Raw lines inside the list that we could not parse as an entry. */
  unparsed: string[];
}

/**
 * Collects every `regexes = [...]` / `paths = [...]` list in the file, tagged
 * with the section it belongs to. Deliberately strict: any line inside a list
 * that is not a recognized triple-quoted entry (or a comment / blank) is
 * reported via `unparsed`, so a future entry written with double quotes cannot
 * slip past this suite unnoticed.
 */
function patternLists(): PatternList[] {
  const lists: PatternList[] = [];
  let section = "(root)";

  const lines = config.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const header = /^\s*(\[\[?[^\]]+\]\]?)\s*$/.exec(line);
    if (header) {
      section = header[1];
      continue;
    }

    const listStart = /^\s*(regexes|paths)\s*=\s*\[\s*$/.exec(line);
    if (!listStart) continue;

    const entries: string[] = [];
    const unparsed: string[] = [];
    for (i++; i < lines.length && !/^\s*\]\s*$/.test(lines[i]); i++) {
      const body = lines[i];
      if (/^\s*(#.*)?$/.test(body)) continue;
      const entry = /^\s*'''(.*)''',?\s*(#.*)?$/.exec(body);
      if (entry) entries.push(entry[1]);
      else unparsed.push(body.trim());
    }
    lists.push({ key: listStart[1], section, entries, unparsed });
  }

  return lists;
}

describe(".gitleaks.toml", () => {
  it("finds the allowlist pattern lists it means to check", () => {
    const lists = patternLists();

    // Guards against the parser silently matching nothing and every other
    // assertion in this file passing vacuously.
    expect(lists.map((l) => `${l.section}:${l.key}`)).toEqual([
      "[allowlist]:paths",
      "[allowlist]:regexes",
    ]);
    for (const list of lists) {
      expect(list.entries.length).toBeGreaterThan(0);
    }
  });

  it("parses every line inside each pattern list", () => {
    for (const list of patternLists()) {
      expect(
        list.unparsed,
        `unrecognized entry format in ${list.section} ${list.key} — this suite ` +
          "only understands triple-quoted entries, so anything else would go unchecked",
      ).toEqual([]);
    }
  });

  it("declares an explicit case flag on every allowlist pattern", () => {
    const offenders = patternLists().flatMap((list) =>
      list.entries
        .filter((e) => !/^\(\?-?i\)/.test(e))
        .map((e) => `${list.section} ${list.key}: ${e}`),
    );

    expect(
      offenders,
      "each allowlist pattern must start with (?i) or (?-i) so a neighbouring " +
        "entry cannot change its case sensitivity when gitleaks joins them",
    ).toEqual([]);
  });

  it("keeps the synthetic-fixture exemptions case-sensitive", () => {
    // An uppercase TEST/DUMMY inside an otherwise real-looking credential must
    // not buy an exemption — that is exactly how the original leak slipped by.
    const regexes = patternLists().filter((l) => l.key === "regexes").flatMap((l) => l.entries);

    for (const needle of ["dummy[-_]?", "test[-_]?", "fixture", "placeholder"]) {
      const entry = regexes.find((r) => r.includes(needle));
      expect(entry, `expected an allowlist entry containing ${needle}`).toBeDefined();
      expect(entry).toMatch(/^\(\?-i\)/);
    }
  });

  it("keeps lockfile and env path exemptions case-sensitive", () => {
    const paths = patternLists().filter((l) => l.key === "paths").flatMap((l) => l.entries);

    for (const needle of ["package-lock", "yarn\\.lock", "\\.env"]) {
      const entry = paths.find((p) => p.includes(needle));
      expect(entry, `expected a path exemption containing ${needle}`).toBeDefined();
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
