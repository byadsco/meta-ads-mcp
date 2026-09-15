import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DEFAULT_META_API_VERSION,
  isMetaApiVersionAtLeast,
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

  // The version is interpolated into every request path, including the OAuth
  // helpers that build URLs with `new URL(path, base)`.
  it.each([
    "v26.0/../v22.0",
    "v26.0?debug=all",
    "/evil.example/x",
    "26.0",
    "latest",
  ])("refuses META_API_VERSION=%s instead of building requests with it", (value) => {
    vi.stubEnv("META_API_VERSION", value);
    expect(() => resolveMetaApiVersion()).toThrow(/META_API_VERSION/);
  });
});

describe("isMetaApiVersionAtLeast", () => {
  it.each([
    ["v26.0", "v26.0", true],
    ["v25.0", "v26.0", false],
    ["v26.1", "v26.0", true],
    ["v100.0", "v26.0", true],
    ["v9.0", "v26.0", false],
  ])("%s is at least %s: %s", (version, minimum, expected) => {
    expect(isMetaApiVersionAtLeast(version, minimum)).toBe(expected);
  });
});

// Every value assigned to META_API_VERSION in a file, in the forms these files
// use: dotenv, docker-compose defaults, and YAML mappings.
function versionPins(content: string): string[] {
  return [
    ...content.matchAll(
      /META_API_VERSION\s*(?:=|:(?!-))\s*["']?(?:\$\{META_API_VERSION:-)?([^\s"'}]+)/g,
    ),
  ].map((match) => match[1]);
}

// Production ran every call on v22.0 while the code defaulted to v25.0: the
// deploy workflow pinned the env var and nobody bumped it. The deploy action
// merges env vars, so removing the pin would not reset it either — every pin
// has to move together with the code default.
describe("META_API_VERSION pins", () => {
  it.each([
    ["META_API_VERSION=v22.0", ["v22.0"]],
    ['META_API_VERSION="v22.0"', ["v22.0"]],
    ["META_API_VERSION = v22.0", ["v22.0"]],
    ["  META_API_VERSION: 'v22.0'", ["v22.0"]],
    ["- META_API_VERSION=${META_API_VERSION:-v22.0}", ["v22.0"]],
    ["META_API_VERSION=v26.0\nMETA_API_VERSION=v22.0", ["v26.0", "v22.0"]],
  ])("finds the pinned value in %j", (content, expected) => {
    expect(versionPins(content)).toEqual(expected);
  });

  it.each([
    ".github/workflows/deploy.yml",
    "docker-compose.yml",
    ".env.example",
    "README.md",
  ])("%s pins the version the code defaults to", (file) => {
    const pins = versionPins(readFileSync(join(ROOT, file), "utf8"));

    expect(pins.length).toBeGreaterThan(0);
    expect(new Set(pins)).toEqual(new Set([DEFAULT_META_API_VERSION]));
  });
});
