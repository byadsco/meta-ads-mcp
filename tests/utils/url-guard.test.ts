import { describe, expect, it } from "vitest";
import {
  assertSafePublicUrl,
  UnsafeUrlError,
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
