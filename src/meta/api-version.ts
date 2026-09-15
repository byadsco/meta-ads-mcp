export const DEFAULT_META_API_VERSION = "v26.0";

export function resolveMetaApiVersion(): string {
  return process.env.META_API_VERSION?.trim() || DEFAULT_META_API_VERSION;
}
