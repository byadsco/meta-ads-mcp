import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { registerAllTools } from "../../src/tools/index.js";
import { createMockMcpServer } from "../setup.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/official-meta-mcp-tools.json", import.meta.url), "utf8")) as {
  categories: Record<string, string[]>;
};
const official = Object.values(fixture.categories).flat();

interface Row { official: string; here: string | undefined; status: string }

/** Every table row that starts with a tool name, whatever its spacing; a row that does not read as one is returned apart. */
function parseRows(markdown: string): { rows: Row[]; unparsed: string[] } {
  const rows: Row[] = [];
  const unparsed: string[] = [];
  for (const line of markdown.split("\n")) {
    // A Markdown table row may leave out its outer pipes.
    if (!/^\s*\|?\s*`[^`]*`\s*\|/.test(line)) continue;
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    const official = /^`([a-z_]+)`$/.exec(cells[0] ?? "")?.[1];
    const here = cells[1] === "—" ? undefined : /^`([a-z_]+)`$/.exec(cells[1] ?? "")?.[1];
    if (cells.length !== 3 || !official || (cells[1] !== "—" && !here) || !cells[2]) {
      unparsed.push(line);
      continue;
    }
    rows.push({ official, here, status: cells[2] });
  }
  return { rows, unparsed };
}

const doc = readFileSync(new URL("../../docs/official-parity.md", import.meta.url), "utf8");
const { rows, unparsed } = parseRows(doc);

const registered = (() => {
  const server = createMockMcpServer();
  registerAllTools(server as never);
  return new Set(server._registeredTools.map((t) => t.name));
})();

describe("parity with Meta's official Ads MCP server", () => {
  it("the fixture holds the 86 tools Meta documents, once each", () => {
    expect(official).toHaveLength(86);
    expect(new Set(official).size).toBe(86);
  });

  it("every table row in docs/official-parity.md reads as official tool, tool here, status", () => {
    expect(unparsed).toEqual([]);
  });

  it("the parser keeps a row whatever its spacing, so a duplicate is never skipped", () => {
    const sample = [
      "| `ads_get_errors` | `ads_get_errors` | same name |",
      "|`ads_get_errors`|`ads_get_errors`|same name|   ",
      "`ads_get_errors` | `ads_get_errors` | same name |",
      "  `ads_get_errors` | `ads_get_errors` | same name",
      "| `ads_get_errors` | `ads_get_errors` |",
    ].join("\n");
    const parsed = parseRows(sample);
    expect(parsed.rows).toHaveLength(4);
    expect(parsed.unparsed).toHaveLength(1);
  });

  it("every official tool has exactly one row in docs/official-parity.md, and nothing else does", () => {
    expect(rows.map((r) => r.official).sort()).toEqual([...official].sort());
  });

  it("every status is one of the documented ones", () => {
    const bad = rows.filter((r) => !/^(same name|equivalent|partial \((?:5[a-f]|follow-up)\)|pending \(5[a-f]\))$/.test(r.status));
    expect(bad).toEqual([]);
  });

  it("a tool named in a row is registered here", () => {
    const missing = rows.filter((r) => r.here !== undefined && !registered.has(r.here)).map((r) => `${r.official} → ${r.here}`);
    expect(missing).toEqual([]);
  });

  it("only pending rows lack a tool, and pending rows name none", () => {
    const wrong = rows.filter((r) => (r.here === undefined) !== r.status.startsWith("pending")).map((r) => r.official);
    expect(wrong).toEqual([]);
  });

  it("'same name' means the official name itself is registered", () => {
    const wrong = rows.filter((r) => r.status === "same name" && r.here !== r.official).map((r) => r.official);
    expect(wrong).toEqual([]);
  });

  it("an official name registered here is marked 'same name', not as missing or done by another tool", () => {
    const wrong = rows.filter((r) => registered.has(r.official) && r.status !== "same name").map((r) => r.official);
    expect(wrong).toEqual([]);
  });
});
