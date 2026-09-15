import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DEFAULT_META_API_VERSION,
  resolveMetaApiVersion,
} from "../../src/meta/api-version.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("resolveMetaApiVersion", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("targets Graph API v26.0 when META_API_VERSION is unset", () => {
    vi.stubEnv("META_API_VERSION", undefined);
    expect(resolveMetaApiVersion()).toBe("v26.0");
  });

  it("honours a META_API_VERSION override, ignoring surrounding whitespace", () => {
    vi.stubEnv("META_API_VERSION", " v25.0 ");
    expect(resolveMetaApiVersion()).toBe("v25.0");
  });

  it("falls back to the default when META_API_VERSION is blank", () => {
    vi.stubEnv("META_API_VERSION", "  ");
    expect(resolveMetaApiVersion()).toBe("v26.0");
  });
});

// Production ran every call on v22.0 while the code defaulted to v25.0: the
// deploy workflow pinned the env var and nobody bumped it. The deploy action
// merges env vars, so removing the pin would not reset it either — every pin
// has to move together with the code default.
describe("META_API_VERSION pins", () => {
  const pinnedFiles = [
    ".github/workflows/deploy.yml",
    "docker-compose.yml",
    ".env.example",
    "README.md",
  ];

  it.each(pinnedFiles)("%s pins the version the code defaults to", (file) => {
    const content = readFileSync(join(ROOT, file), "utf8");
    const pins = [
      ...content.matchAll(/META_API_VERSION=(?:\$\{META_API_VERSION:-)?(v\d+\.\d+)/g),
    ].map((match) => match[1]);

    expect(pins.length).toBeGreaterThan(0);
    expect(new Set(pins)).toEqual(new Set([DEFAULT_META_API_VERSION]));
  });
});
