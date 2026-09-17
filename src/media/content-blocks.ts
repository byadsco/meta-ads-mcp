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
  try {
    const parsed = new URL(url);
    const hasUserinfo = parsed.username !== "" || parsed.password !== "";
    const hasTokenParam = parsed.searchParams.has("access_token");
    const hasTokenFragment = parsed.hash.toLowerCase().includes("access_token");
    if (!hasUserinfo && !hasTokenParam && !hasTokenFragment) return url;
    parsed.username = "";
    parsed.password = "";
    parsed.searchParams.delete("access_token");
    if (hasTokenFragment) parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function safeHostname(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}
