import { promises as dns } from "node:dns";
import { isIP } from "node:net";

const ALLOWED_PROTOCOLS = new Set(["https:"]);

const PRIVATE_V4_RANGES: Array<[bigint, bigint, string]> = [
  [bn("10.0.0.0"), bn("10.255.255.255"), "RFC1918 10.0.0.0/8"],
  [bn("172.16.0.0"), bn("172.31.255.255"), "RFC1918 172.16.0.0/12"],
  [bn("192.168.0.0"), bn("192.168.255.255"), "RFC1918 192.168.0.0/16"],
  [bn("127.0.0.0"), bn("127.255.255.255"), "loopback 127.0.0.0/8"],
  [bn("169.254.0.0"), bn("169.254.255.255"), "link-local / GCP metadata 169.254.0.0/16"],
  [bn("0.0.0.0"), bn("0.255.255.255"), "current-network 0.0.0.0/8"],
  [bn("100.64.0.0"), bn("100.127.255.255"), "CGNAT 100.64.0.0/10"],
  [bn("224.0.0.0"), bn("239.255.255.255"), "multicast 224.0.0.0/4"],
  [bn("240.0.0.0"), bn("255.255.255.255"), "reserved 240.0.0.0/4"],
];

function bn(ipv4: string): bigint {
  return ipv4
    .split(".")
    .reduce<bigint>((acc, oct) => (acc << 8n) | BigInt(parseInt(oct, 10)), 0n);
}

function ipv4ToBigInt(ip: string): bigint | null {
  if (isIP(ip) !== 4) return null;
  return bn(ip);
}

function isPrivateV4(ip: string): { reason: string } | null {
  const value = ipv4ToBigInt(ip);
  if (value === null) return null;
  for (const [lo, hi, label] of PRIVATE_V4_RANGES) {
    if (value >= lo && value <= hi) return { reason: label };
  }
  return null;
}

function isPrivateV6(ip: string): { reason: string } | null {
  if (isIP(ip) !== 6) return null;
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return { reason: "IPv6 loopback/unspecified" };
  if (lower.startsWith("fe80:") || lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
    // fe80::/10 covers fe80–febf
    return { reason: "IPv6 link-local fe80::/10" };
  }
  if (/^f[cd]/.test(lower)) return { reason: "IPv6 unique-local fc00::/7" };
  // IPv4-mapped IPv6 (::ffff:a.b.c.d). Node may render it as
  // "::ffff:7f00:1" instead of "::ffff:127.0.0.1", so parse both forms.
  if (lower.startsWith("::ffff:")) {
    const tail = lower.slice("::ffff:".length);
    let v4: string | null = null;
    if (/^[0-9.]+$/.test(tail)) {
      v4 = tail;
    } else {
      // hex form like "7f00:1" or "7f00:0001"
      const segs = tail.split(":");
      if (segs.length === 2) {
        const hi = parseInt(segs[0], 16);
        const lo = parseInt(segs[1], 16);
        if (Number.isFinite(hi) && Number.isFinite(lo)) {
          v4 = [
            (hi >> 8) & 0xff,
            hi & 0xff,
            (lo >> 8) & 0xff,
            lo & 0xff,
          ].join(".");
        }
      }
    }
    if (v4) {
      const block = isPrivateV4(v4);
      if (block) return { reason: `IPv4-mapped → ${block.reason}` };
    }
  }
  return null;
}

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

export interface AssertSafeUrlOptions {
  /**
   * Inject a DNS resolver. Defaults to node:dns/promises lookup.
   * Tests can stub this to avoid real network calls.
   */
  resolve?: (hostname: string) => Promise<Array<{ address: string }>>;
}

export interface ResolvedSafePublicUrl {
  url: URL;
  addresses: Array<{ address: string; family: 4 | 6 }>;
}

export function unsafeIpReason(ip: string): string | null {
  return isPrivateV4(ip)?.reason ?? isPrivateV6(ip)?.reason ?? null;
}

/**
 * Throws UnsafeUrlError if the URL is not a safe public destination for an
 * outbound fetch. Used by tools that accept user-supplied URLs (image/video
 * upload) to prevent SSRF against the GCP metadata service, container
 * loopback, RFC1918, link-local and other internal addresses.
 *
 * Validation:
 *   1. Parses as a URL.
 *   2. Protocol must be https:
 *   3. If the host is a literal IP, it must not be in any private range.
 *   4. Otherwise, resolves the hostname (A + AAAA) and rejects if any
 *      resolved address falls in a private range. (Catches DNS rebinding
 *      and host names that point at internal addresses.)
 */
export async function assertSafePublicUrl(
  raw: string,
  options: AssertSafeUrlOptions = {},
): Promise<URL> {
  return (await resolveSafePublicUrl(raw, options)).url;
}

export async function resolveSafePublicUrl(
  raw: string,
  options: AssertSafeUrlOptions = {},
): Promise<ResolvedSafePublicUrl> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError(`URL is malformed: ${raw}`);
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new UnsafeUrlError(
      `URL protocol "${url.protocol}" is not allowed; only https:`,
    );
  }
  if (!url.hostname) {
    throw new UnsafeUrlError("URL is missing a hostname");
  }

  // url.hostname wraps IPv6 literals in [...]; strip them for isIP.
  const bareHost = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const literalIpVersion = isIP(bareHost);
  if (literalIpVersion === 4) {
    const block = isPrivateV4(bareHost);
    if (block) throw new UnsafeUrlError(`URL points at private IP (${block.reason})`);
    return { url, addresses: [{ address: bareHost, family: 4 }] };
  }
  if (literalIpVersion === 6) {
    const block = isPrivateV6(bareHost);
    if (block) throw new UnsafeUrlError(`URL points at private IP (${block.reason})`);
    return { url, addresses: [{ address: bareHost, family: 6 }] };
  }

  // Hostname → resolve and reject if any address is private.
  const resolver =
    options.resolve ??
    (async (hostname: string) => {
      const records = await dns.lookup(hostname, { all: true, verbatim: true });
      return records;
    });
  let addresses: Array<{ address: string }>;
  try {
    addresses = await resolver(url.hostname);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new UnsafeUrlError(`Cannot resolve hostname ${url.hostname}: ${msg}`);
  }
  if (addresses.length === 0) {
    throw new UnsafeUrlError(`Hostname ${url.hostname} did not resolve to any address`);
  }
  for (const { address } of addresses) {
    const family = isIP(address);
    if (family !== 4 && family !== 6) {
      throw new UnsafeUrlError(
        `Hostname ${url.hostname} resolved to non-IP address ${address}`,
      );
    }
    const v4 = isPrivateV4(address);
    if (v4) {
      throw new UnsafeUrlError(
        `Hostname ${url.hostname} resolves to private IP ${address} (${v4.reason})`,
      );
    }
    const v6 = isPrivateV6(address);
    if (v6) {
      throw new UnsafeUrlError(
        `Hostname ${url.hostname} resolves to private IP ${address} (${v6.reason})`,
      );
    }
  }
  return {
    url,
    addresses: addresses.map(({ address }) => ({
      address,
      family: isIP(address) as 4 | 6,
    })),
  };
}
