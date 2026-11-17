import { isIP } from "node:net";
import { describe, expect, it } from "vitest";
import {
  assertSafePublicUrl,
  UnsafeUrlError,
  unsafeIpReason,
} from "../../src/utils/url-guard.js";

function fakeResolve(addresses: string[]) {
  return async (_hostname: string) => addresses.map((address) => ({ address }));
}

describe("assertSafePublicUrl", () => {
  it("accepts a public https URL whose host resolves to a public IP", async () => {
    const url = await assertSafePublicUrl("https://example.com/path", {
      resolve: fakeResolve(["93.184.216.34"]),
    });
    expect(url.toString()).toBe("https://example.com/path");
  });

  it("rejects http://", async () => {
    await expect(
      assertSafePublicUrl("http://example.com/x", { resolve: fakeResolve(["8.8.8.8"]) }),
    ).rejects.toThrow(UnsafeUrlError);
  });

  it("rejects file://", async () => {
    await expect(
      assertSafePublicUrl("file:///etc/passwd", { resolve: fakeResolve([]) }),
    ).rejects.toThrow(UnsafeUrlError);
  });

  it("rejects malformed URLs", async () => {
    await expect(
      assertSafePublicUrl("not-a-url", { resolve: fakeResolve([]) }),
    ).rejects.toThrow(/malformed/i);
  });

  it("rejects literal RFC1918 IPs", async () => {
    await expect(
      assertSafePublicUrl("https://10.0.0.1/", { resolve: fakeResolve([]) }),
    ).rejects.toThrow(/RFC1918 10\.0\.0\.0\/8/);
    await expect(
      assertSafePublicUrl("https://192.168.1.1/", { resolve: fakeResolve([]) }),
    ).rejects.toThrow(/RFC1918 192\.168/);
    await expect(
      assertSafePublicUrl("https://172.20.0.1/", { resolve: fakeResolve([]) }),
    ).rejects.toThrow(/RFC1918 172\.16/);
  });

  it("rejects literal loopback IPs", async () => {
    await expect(
      assertSafePublicUrl("https://127.0.0.1/", { resolve: fakeResolve([]) }),
    ).rejects.toThrow(/loopback/i);
  });

  it("rejects the GCP metadata service IP", async () => {
    await expect(
      assertSafePublicUrl("https://169.254.169.254/computeMetadata/v1/", {
        resolve: fakeResolve([]),
      }),
    ).rejects.toThrow(/link-local|GCP metadata/i);
  });

  it("rejects hostnames that resolve to a private IP (DNS rebinding defense)", async () => {
    await expect(
      assertSafePublicUrl("https://attacker-controlled.com/x", {
        resolve: fakeResolve(["10.1.2.3"]),
      }),
    ).rejects.toThrow(/resolves to private IP 10\.1\.2\.3/);
  });

  it("rejects when one of multiple resolved IPs is private (mixed A records)", async () => {
    await expect(
      assertSafePublicUrl("https://example.com/x", {
        resolve: fakeResolve(["8.8.8.8", "127.0.0.1"]),
      }),
    ).rejects.toThrow(/127\.0\.0\.1/);
  });

  it("rejects IPv6 loopback", async () => {
    await expect(
      assertSafePublicUrl("https://[::1]/", { resolve: fakeResolve([]) }),
    ).rejects.toThrow(/IPv6 loopback/i);
  });

  it("rejects IPv6 link-local", async () => {
    await expect(
      assertSafePublicUrl("https://[fe80::1]/", { resolve: fakeResolve([]) }),
    ).rejects.toThrow(/link-local/i);
  });

  it("rejects IPv6 unique-local", async () => {
    await expect(
      assertSafePublicUrl("https://[fd00::1]/", { resolve: fakeResolve([]) }),
    ).rejects.toThrow(/unique-local/i);
  });

  it("rejects IPv4-mapped IPv6 to a private v4", async () => {
    await expect(
      assertSafePublicUrl("https://[::ffff:127.0.0.1]/", {
        resolve: fakeResolve([]),
      }),
    ).rejects.toThrow(/IPv4-mapped/);
  });

  it("rejects when DNS resolution fails", async () => {
    await expect(
      assertSafePublicUrl("https://nope.invalid/", {
        resolve: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    ).rejects.toThrow(/Cannot resolve/);
  });

  it("rejects when DNS returns no addresses", async () => {
    await expect(
      assertSafePublicUrl("https://nope.invalid/", { resolve: fakeResolve([]) }),
    ).rejects.toThrow(/did not resolve/);
  });
});

// The GCP metadata address (and loopback) written in every IPv6 form that
// carries an IPv4 address, plus the IPv4 special ranges the old list missed.
const INTERNAL_FORMS = [
  "::ffff:169.254.169.254",
  "::ffff:a9fe:a9fe",
  "0:0:0:0:0:ffff:a9fe:a9fe",
  "::a9fe:a9fe", // IPv4-compatible
  "::ffff:0:a9fe:a9fe", // IPv4-translated
  "64:ff9b::a9fe:a9fe", // NAT64
  "64:ff9b:1::a9fe:a9fe", // local NAT64
  "2002:a9fe:a9fe::1", // 6to4
  "2001:0:4136:e378:8000:63bf:3fff:fdd2", // Teredo
  "::7f00:1",
  "::",
  "192.0.0.170",
  "198.18.0.1",
  "198.19.255.254",
  "100::1",
  "fec0::1",
  "ff02::1",
  "2001:db8::1",
];

describe("unsafeIpReason", () => {
  it("refuses every IPv6 form that carries an internal IPv4, and the special ranges, however they are spelled", () => {
    for (const ip of INTERNAL_FORMS) expect(unsafeIpReason(ip), ip).not.toBeNull();
  });

  it("lets public unicast addresses through", () => {
    for (const ip of ["8.8.8.8", "104.16.0.1", "203.0.113.10", "2606:4700::6810:1", "2a00:1450:4001::200e", "::ffff:8.8.8.8"]) {
      expect(unsafeIpReason(ip), ip).toBeNull();
    }
  });

  it("refuses each of them as a URL literal and as one DNS answer among public ones", async () => {
    for (const ip of INTERNAL_FORMS) {
      const literal = isIP(ip) === 6 ? `https://[${ip}]/a.jpg` : `https://${ip}/a.jpg`;
      await expect(assertSafePublicUrl(literal, { resolve: fakeResolve([]) }), ip).rejects.toThrow(/private IP/);
      await expect(
        assertSafePublicUrl("https://cdn.example.com/a.jpg", { resolve: fakeResolve(["93.184.216.34", ip]) }),
        ip,
      ).rejects.toThrow(/resolves to private IP/);
    }
  });

  it("names the range of a resolved AAAA record in NAT64 form", async () => {
    await expect(
      assertSafePublicUrl("https://cdn.example.com/a.jpg", { resolve: fakeResolve(["64:ff9b::a9fe:a9fe"]) }),
    ).rejects.toThrow(/NAT64/);
  });
});
