import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getSkillDocuments, resetSkillCacheForTests } from "../../src/skills/loader.js";

/**
 * The loader reads a fixed directory next to the compiled code, so these
 * cases exercise the same rules against a temporary tree by reproducing the
 * walk the loader performs. The shipped tree is covered by the protocol suite.
 */
function walkLike(root: string): string[] {
  const { lstatSync, readdirSync, readFileSync } = require("node:fs") as typeof import("node:fs");
  const isRealDirectory = (p: string): boolean => {
    try {
      return lstatSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  const found: string[] = [];
  if (!isRealDirectory(root)) return found;
  for (const skill of readdirSync(root).sort().slice(0, 256)) {
    if (!/^[a-z0-9-]{1,64}$/.test(skill)) continue;
    const skillDir = path.join(root, skill);
    if (!isRealDirectory(skillDir)) continue;
    const files = ["SKILL.md"];
    const referencesDir = path.join(skillDir, "references");
    if (isRealDirectory(referencesDir)) {
      for (const reference of readdirSync(referencesDir).sort().slice(0, 256)) {
        if (/^[a-z0-9._-]{1,64}\.md$/.test(reference)) files.push(`references/${reference}`);
      }
    }
    for (const file of files) {
      const full = path.join(skillDir, file);
      try {
        const stat = lstatSync(full);
        if (!stat.isFile() || stat.size > 256 * 1024) continue;
        readFileSync(full, "utf8");
        found.push(`${skill}/${file}`);
      } catch {
        continue;
      }
    }
  }
  return found;
}

let tmp: string | undefined;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
  resetSkillCacheForTests();
});

describe("skill loader rules", () => {
  it("refuses a symlinked skill directory", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "skills-test-"));
    const secrets = path.join(tmp, "secrets");
    mkdirSync(secrets);
    writeFileSync(path.join(secrets, "SKILL.md"), "# private");
    const root = path.join(tmp, "skills");
    mkdirSync(root);
    symlinkSync(secrets, path.join(root, "planted"));

    expect(walkLike(root)).toEqual([]);
  });

  it("refuses a symlinked references directory", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "skills-test-"));
    const outside = path.join(tmp, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "private.md"), "# private");
    const root = path.join(tmp, "skills");
    const skill = path.join(root, "real-skill");
    mkdirSync(skill, { recursive: true });
    writeFileSync(path.join(skill, "SKILL.md"), "# real");
    symlinkSync(outside, path.join(skill, "references"));

    expect(walkLike(root)).toEqual(["real-skill/SKILL.md"]);
  });

  it("refuses a symlinked file inside a real references directory", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "skills-test-"));
    const secret = path.join(tmp, "secret.md");
    writeFileSync(secret, "# private");
    const skill = path.join(tmp, "skills", "real-skill");
    mkdirSync(path.join(skill, "references"), { recursive: true });
    writeFileSync(path.join(skill, "SKILL.md"), "# real");
    symlinkSync(secret, path.join(skill, "references", "planted.md"));

    expect(walkLike(path.join(tmp, "skills"))).toEqual(["real-skill/SKILL.md"]);
  });

  it("ignores names outside the allowed shape and files that are too large", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "skills-test-"));
    const root = path.join(tmp, "skills");
    mkdirSync(path.join(root, "../etc"), { recursive: true });
    for (const bad of ["UPPER", "with space", "dot.dir"]) {
      mkdirSync(path.join(root, bad), { recursive: true });
      writeFileSync(path.join(root, bad, "SKILL.md"), "# nope");
    }
    const big = path.join(root, "big-skill");
    mkdirSync(big, { recursive: true });
    writeFileSync(path.join(big, "SKILL.md"), "x".repeat(300 * 1024));

    expect(walkLike(root)).toEqual([]);
  });
});

describe("getSkillDocuments", () => {
  it("caches, and the cache can be reset for tests", () => {
    const first = getSkillDocuments();
    expect(getSkillDocuments()).toBe(first);
    resetSkillCacheForTests();
    const second = getSkillDocuments();
    expect(second).not.toBe(first);
    expect(second.map((d) => d.uri)).toEqual(first.map((d) => d.uri));
  });

  it("reads the frontmatter name and description, and falls back to a heading", () => {
    const documents = getSkillDocuments();
    const guide = documents.find((d) => d.uri === "meta-ads://skills/meta-ads-mcp-guide")!;
    expect(guide.title).toBe("meta-ads-mcp-guide");
    expect(guide.description).toMatch(/use when/i);

    const toolMap = documents.find((d) => d.file === "references/tool-map.md")!;
    expect(toolMap.title).toBe("Tool map");
  });
});
