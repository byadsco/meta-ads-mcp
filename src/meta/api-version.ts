export const DEFAULT_META_API_VERSION = "v26.0";

const VERSION_PATTERN = /^v(\d+)\.(\d+)$/;

function parseVersion(version: string): [number, number] {
  const match = VERSION_PATTERN.exec(version);
  if (!match) {
    throw new Error(`Invalid Meta API version "${version}": expected the form v26.0.`);
  }
  return [Number(match[1]), Number(match[2])];
}

export function assertMetaApiVersion(version: string): string {
  parseVersion(version);
  return version;
}

export function resolveMetaApiVersion(): string {
  const configured = process.env.META_API_VERSION?.trim();
  if (!configured) return DEFAULT_META_API_VERSION;
  if (!VERSION_PATTERN.test(configured)) {
    throw new Error(`META_API_VERSION must look like v26.0, got "${configured}".`);
  }
  return configured;
}

export function isMetaApiVersionAtLeast(version: string, minimum: string): boolean {
  const [major, minor] = parseVersion(version);
  const [minimumMajor, minimumMinor] = parseVersion(minimum);
  return major === minimumMajor ? minor >= minimumMinor : major > minimumMajor;
}
