import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSkillDocuments, type SkillDocument } from "./loader.js";

/**
 * One static resource per skill file. Static URIs on purpose: a template
 * without a list callback never shows up in resources/list, and a path
 * variable would be one more place a traversal could hide.
 */
export function registerSkillResources(server: McpServer, documents: SkillDocument[] = getSkillDocuments()): void {
  for (const document of documents) {
    server.registerResource(
      `${document.skill}${document.file === "SKILL.md" ? "" : `/${document.file}`}`,
      document.uri,
      {
        title: document.title,
        description: document.description,
        mimeType: "text/markdown",
      },
      async (uri: URL) => ({
        contents: [{ uri: uri.href, mimeType: "text/markdown", text: document.text }],
      }),
    );
  }
}
