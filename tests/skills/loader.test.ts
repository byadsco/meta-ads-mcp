import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getSkillDocuments, isRealDirectory, loadSkillsFrom, resetSkillCacheForTests } from "../../src/skills/loader.js";

/** Every case runs the real walk against a temporary tree. */
function walkLike(root: string): string[] {
  return loadSkillsFrom(root).map((d) => `${d.skill}/${d.file}`);
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

describe("skillsRoot containment", () => {
  it("does not follow a symlinked skills root", () => {
    // lstat("/x/") follows the link while lstat("/x") does not, so the loader
    // must resolve the trailing slash away before checking.
    tmp = mkdtempSync(path.join(os.tmpdir(), "skills-test-"));
    const outside = path.join(tmp, "outside");
    mkdirSync(path.join(outside, "planted"), { recursive: true });
    writeFileSync(path.join(outside, "planted", "SKILL.md"), "# private");
    const link = path.join(tmp, "skills");
    symlinkSync(outside, link);

    expect(isRealDirectory(link)).toBe(false);
    expect(isRealDirectory(`${link}/`)).toBe(false);
    expect(walkLike(link)).toEqual([]);
    expect(walkLike(`${link}/`)).toEqual([]);
  });

  it("accepts a real directory given with a trailing slash", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "skills-test-"));
    const skill = path.join(tmp, "skills", "real-skill");
    mkdirSync(skill, { recursive: true });
    writeFileSync(path.join(skill, "SKILL.md"), "# real");
    expect(walkLike(`${path.join(tmp, "skills")}/`)).toEqual(["real-skill/SKILL.md"]);
  });
});
