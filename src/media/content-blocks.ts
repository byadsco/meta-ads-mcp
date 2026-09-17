import { scrubUrlCredentials } from "../utils/scrub-credentials.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";

export type { ContentBlock };

export function textBlock(text: string): ContentBlock {
  return { type: "text", text };
}

export function imageBlock(buffer: Buffer, mimeType: string): ContentBlock {
  return { type: "image", data: buffer.toString("base64"), mimeType };
}

export function audioBlock(buffer: Buffer, mimeType: string): ContentBlock {
  return { type: "audio", data: buffer.toString("base64"), mimeType };
}

/** Embeds binary media (e.g. an MP4) for clients whose model ingests it natively. */
export function blobResourceBlock(uri: string, buffer: Buffer, mimeType: string): ContentBlock {
  return { type: "resource", resource: { uri, mimeType, blob: buffer.toString("base64") } };
}

export function resourceLinkBlock(uri: string, name: string, options: { mimeType?: string; description?: string } = {}): ContentBlock {
  return { type: "resource_link", uri, name, mimeType: options.mimeType, description: options.description };
}

// URLs echoed back in tool metadata must never carry credentials, even if a
// Meta response ever embeds them. Clean URLs are returned byte-identical —
// re-serializing would re-encode the query and could invalidate CDN
// signatures. CDN signing params (oh/oe) always stay.
export function sanitizeMetadataUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  // Credential-shaped parameters, userinfo and credential-carrying fragments
  // are removed by the shared scrubber, which normalizes encoded parameter
  // names; a url with nothing to strip comes back unchanged.
  return scrubUrlCredentials(url);
}

export function safeHostname(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}
