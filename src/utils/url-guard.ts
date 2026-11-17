import { promises as dns } from "node:dns";
import { BlockList, isIP } from "node:net";

const ALLOWED_PROTOCOLS = new Set(["https:"]);

// Every range that is not a public unicast destination. Checked with
// net.BlockList, which parses each address into its bits (no string
// prefixes) and also matches an IPv4-mapped IPv6 address (::ffff:a.b.c.d, in
// any spelling) against the IPv4 rules. The IPv6 forms that carry an IPv4
// address some other way (compatible, translated, NAT64, 6to4, Teredo) are
// refused whole: no public site is reached through them from Cloud Run.
const UNSAFE_RANGES: Array<[string, number, "ipv4" | "ipv6", string]> = [
  ["10.0.0.0", 8, "ipv4", "RFC1918 10.0.0.0/8"],
  ["172.16.0.0", 12, "ipv4", "RFC1918 172.16.0.0/12"],
  ["192.168.0.0", 16, "ipv4", "RFC1918 192.168.0.0/16"],
  ["127.0.0.0", 8, "ipv4", "loopback 127.0.0.0/8"],
  ["169.254.0.0", 16, "ipv4", "link-local / GCP metadata 169.254.0.0/16"],
  ["0.0.0.0", 8, "ipv4", "current-network 0.0.0.0/8"],
  ["100.64.0.0", 10, "ipv4", "CGNAT 100.64.0.0/10"],
  ["192.0.0.0", 24, "ipv4", "IETF protocol assignments 192.0.0.0/24"],
  ["198.18.0.0", 15, "ipv4", "benchmarking 198.18.0.0/15"],
  ["224.0.0.0", 4, "ipv4", "multicast 224.0.0.0/4"],
  ["240.0.0.0", 4, "ipv4", "reserved 240.0.0.0/4"],
  ["::1", 128, "ipv6", "IPv6 loopback ::1"],
  ["::", 128, "ipv6", "IPv6 unspecified ::"],
  ["::", 96, "ipv6", "IPv4-compatible IPv6 ::/96"],
  ["::ffff:0:0:0", 96, "ipv6", "IPv4-translated IPv6 ::ffff:0:0:0/96"],
  ["64:ff9b::", 96, "ipv6", "NAT64 64:ff9b::/96"],
  ["64:ff9b:1::", 48, "ipv6", "local NAT64 64:ff9b:1::/48"],
  ["100::", 64, "ipv6", "IPv6 discard 100::/64"],
  ["2001::", 32, "ipv6", "Teredo 2001::/32"],
  ["2001:db8::", 32, "ipv6", "IPv6 documentation 2001:db8::/32"],
  ["2002::", 16, "ipv6", "6to4 2002::/16"],
  ["fc00::", 7, "ipv6", "IPv6 unique-local fc00::/7"],
  ["fe80::", 10, "ipv6", "IPv6 link-local fe80::/10"],
  ["fec0::", 10, "ipv6", "IPv6 site-local fec0::/10"],
  ["ff00::", 8, "ipv6", "IPv6 multicast ff00::/8"],
];

const UNSAFE_LISTS = UNSAFE_RANGES.map(([network, prefix, type, label]) => {
  const list = new BlockList();
  list.addSubnet(network, prefix, type);
  return { list, type, label };
});

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

/** Why an address is not a safe public destination, or null when it is. */
export function unsafeIpReason(ip: string): string | null {
  const family = isIP(ip);
  if (family !== 4 && family !== 6) return "not an IP address";
  const type = family === 4 ? "ipv4" : "ipv6";
  for (const rule of UNSAFE_LISTS) {
    let hit: boolean;
    try {
      hit = rule.list.check(ip, type);
    } catch {
      return "unparseable IP address";
    }
    if (hit) return type === "ipv6" && rule.type === "ipv4" ? `IPv4-mapped → ${rule.label}` : rule.label;
  }
  return null;
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
  if (literalIpVersion === 4 || literalIpVersion === 6) {
    const reason = unsafeIpReason(bareHost);
    if (reason) throw new UnsafeUrlError(`URL points at private IP (${reason})`);
    return { url, addresses: [{ address: bareHost, family: literalIpVersion }] };
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
    const reason = unsafeIpReason(address);
    if (reason) {
      throw new UnsafeUrlError(
        `Hostname ${url.hostname} resolves to private IP ${address} (${reason})`,
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
