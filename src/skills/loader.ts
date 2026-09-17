import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { logger } from "../utils/logger.js";

/** A skill file, addressable over MCP as a resource. */
export interface SkillDocument {
  /** Skill directory name, e.g. "meta-ads-video-analysis". */
  skill: string;
  /** Path inside the skill: "SKILL.md" or "references/tool-map.md". */
  file: string;
  uri: string;
  title: string;
  description: string;
  text: string;
}

const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 64;
// Entries visited while walking, so a huge or hostile tree cannot be enumerated.
const MAX_ENTRIES_SCANNED = 256;
const URI_PREFIX = "meta-ads://skills/";

/**
 * Resolves from src/ in development and from dist/ in the published package.
 * path.resolve drops the trailing slash on purpose: lstat("/x/") follows a
 * symlink at /x while lstat("/x") reports the link itself.
 */
function skillsRoot(): string {
  return path.resolve(fileURLToPath(new URL("../../skills/", import.meta.url)));
}

/** Frontmatter is optional; only name and description are read, and only as plain scalars. */
function parseFrontmatter(text: string): { name?: string; description?: string } {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of text.slice(4, end).split("\n")) {
    const match = /^(name|description):\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].trim().replace(/^["']|["']$/g, "");
    if (match[1] === "name") out.name = value;
    else out.description = value;
  }
  return out;
}

function firstHeading(text: string): string | undefined {
  const match = /^#\s+(.+)$/m.exec(text);
  return match?.[1].trim();
}

function readMarkdown(fullPath: string): string | null {
  // lstat, not stat: a symlink inside skills/ could otherwise read anything the process can.
  const stat = lstatSync(fullPath);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
  return readFileSync(fullPath, "utf8");
}

/**
 * Directories are walked only when they are real directories, never symlinks.
 * The path is resolved first so a trailing slash cannot make lstat follow one.
 */
export function isRealDirectory(fullPath: string): boolean {
  try {
    return lstatSync(path.resolve(fullPath)).isDirectory();
  } catch {
    return false;
  }
}

/** Exported so the adversarial tests exercise this walk rather than a copy of it. */
export function loadSkillsFrom(rawRoot: string): SkillDocument[] {
  const root = path.resolve(rawRoot);
  const documents: SkillDocument[] = [];
  if (!isRealDirectory(root)) {
    logger.warn({ event: "skills_unavailable" }, "No skills directory found; MCP resources will be empty");
    return [];
  }
  let entries: string[];
  try {
    entries = readdirSync(root).sort().slice(0, MAX_ENTRIES_SCANNED);
  } catch {
    logger.warn({ event: "skills_unavailable" }, "No skills directory found; MCP resources will be empty");
    return [];
  }

  for (const skill of entries) {
    if (documents.length >= MAX_FILES) break;
    if (!/^[a-z0-9-]{1,64}$/.test(skill)) continue;
    const skillDir = path.join(root, skill);
    if (!isRealDirectory(skillDir)) continue;

    const files: string[] = ["SKILL.md"];
    const referencesDir = path.join(skillDir, "references");
    // lstat here too: a symlinked references/ would otherwise publish files
    // from anywhere the process can read.
    if (isRealDirectory(referencesDir)) {
      try {
        for (const reference of readdirSync(referencesDir).sort().slice(0, MAX_ENTRIES_SCANNED)) {
          if (/^[a-z0-9._-]{1,64}\.md$/.test(reference)) files.push(`references/${reference}`);
        }
      } catch {
        // A skill whose references cannot be listed still has its SKILL.md.
      }
    }

    for (const file of files) {
      if (documents.length >= MAX_FILES) break;
      const fullPath = path.join(skillDir, file);
      let text: string | null;
      try {
        text = readMarkdown(fullPath);
      } catch {
        continue;
      }
      if (text === null) continue;
      const front = parseFrontmatter(text);
      documents.push({
        skill,
        file,
        uri: `${URI_PREFIX}${skill}${file === "SKILL.md" ? "" : `/${file}`}`,
        title: front.name ?? firstHeading(text) ?? `${skill}/${file}`,
        description: front.description ?? `Reference for the ${skill} skill.`,
        text,
      });
    }
  }

  return documents;
}

function loadSkills(): SkillDocument[] {
  return loadSkillsFrom(skillsRoot());
}

let cached: SkillDocument[] | undefined;

/** Loaded once per process: the files ship with the server and never change at runtime. */
export function getSkillDocuments(): SkillDocument[] {
  if (!cached) cached = loadSkills();
  return cached;
}

export function resetSkillCacheForTests(): void {
  cached = undefined;
}
