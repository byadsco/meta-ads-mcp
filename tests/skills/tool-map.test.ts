import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { registerAllTools } from "../../src/tools/index.js";
import { getSkillDocuments } from "../../src/skills/loader.js";
import { createMockMcpServer } from "../setup.js";

function registeredTools(): Array<{ name: string; readOnly: boolean }> {
  const server = createMockMcpServer();
  registerAllTools(server as never);
  return server._registeredTools.map((t) => ({ name: t.name, readOnly: t.annotations?.readOnlyHint === true }));
}

const toolMap = readFileSync(new URL("../../skills/meta-ads-mcp-guide/references/tool-map.md", import.meta.url), "utf8");
const mapped = new Map<string, { warned: boolean }>();
for (const line of toolMap.split("\n")) {
  const match = /^- `([a-z_]+)`( ⚠️)? — /.exec(line);
  if (match) mapped.set(match[1], { warned: Boolean(match[2]) });
}

/**
 * The map is documentation an agent is told to trust, so it has to stay in
 * step with the code by test rather than by discipline.
 */
describe("tool map", () => {
  const tools = registeredTools();

  it("lists every registered tool", () => {
    const missing = tools.map((t) => t.name).filter((name) => !mapped.has(name));
    expect(missing, `add these to skills/meta-ads-mcp-guide/references/tool-map.md: ${missing.join(", ")}`).toEqual([]);
  });

  it("lists no tool that does not exist", () => {
    const names = new Set(tools.map((t) => t.name));
    const extra = [...mapped.keys()].filter((name) => !names.has(name));
    expect(extra, `these are in the map but not registered: ${extra.join(", ")}`).toEqual([]);
  });

  it("marks exactly the tools that change live data", () => {
    const wrong = tools.filter((t) => mapped.get(t.name)!.warned === t.readOnly);
    expect(
      wrong.map((t) => `${t.name} (${t.readOnly ? "read-only but marked ⚠️" : "a write tool but unmarked"})`),
      "the ⚠️ marks in the tool map disagree with the tools' own annotations",
    ).toEqual([]);
  });

  it("gives every tool a one-line summary", () => {
    for (const line of toolMap.split("\n")) {
      const match = /^- `([a-z_]+)`( ⚠️)? — (.*)$/.exec(line);
      if (!match) continue;
      expect(match[3].length, `${match[1]} has no useful summary`).toBeGreaterThan(20);
    }
  });

  it("reports the same total the server registers", () => {
    expect(toolMap).toContain(`${tools.length} in total`);
    expect(toolMap).toContain(`${tools.filter((t) => t.readOnly).length} are read-only`);
  });
});

describe("skill documents", () => {
  const documents = getSkillDocuments();

  it("loads the four skills with frontmatter", () => {
    const skills = documents.filter((d) => d.file === "SKILL.md");
    expect(skills.map((s) => s.skill).sort()).toEqual([
      "meta-ads-competitor-research",
      "meta-ads-creative-analysis",
      "meta-ads-mcp-guide",
      "meta-ads-video-analysis",
    ]);
    for (const skill of skills) {
      expect(skill.title, `${skill.skill} has no name in its frontmatter`).toBe(skill.skill);
      expect(skill.description.length, `${skill.skill} needs a description that says when to use it`).toBeGreaterThan(80);
      expect(skill.description).toMatch(/use when/i);
    }
  });

  it("addresses each file under its own stable URI", () => {
    const uris = documents.map((d) => d.uri);
    expect(new Set(uris).size).toBe(uris.length);
    for (const uri of uris) expect(uri.startsWith("meta-ads://skills/")).toBe(true);
    expect(uris).toContain("meta-ads://skills/meta-ads-mcp-guide");
    expect(uris).toContain("meta-ads://skills/meta-ads-mcp-guide/references/tool-map.md");
  });

  it("only mentions tools that exist", () => {
    const names = new Set(registeredTools().map((t) => t.name));
    // Meta permission scopes share the naming shape but are not tools.
    const notTools = new Set(["whatsapp_business_management"]);
    const unknown = new Set<string>();
    for (const document of documents) {
      for (const [, mention] of document.text.matchAll(/`((?:ads|whatsapp)_[a-z_]+)`/g)) {
        if (!names.has(mention) && !notTools.has(mention)) unknown.add(`${document.skill}/${document.file}: ${mention}`);
      }
    }
    expect([...unknown], "a skill names a tool this server does not register").toEqual([]);
  });
});
