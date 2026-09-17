import { describe, expect, it } from "vitest";
import { hasCredential, scrubCredentials } from "../../src/utils/scrub-credentials.js";

describe("scrubCredentials", () => {
  it("removes the value and keeps the name, so the reader sees what was stripped", () => {
    expect(scrubCredentials("https://x.test/a?access_token=SECRET123&b=1")).toBe("https://x.test/a?access_token=[REDACTED]&b=1");
  });

  it("catches a percent-encoded or punctuated parameter name", () => {
    for (const name of ["access%5Ftoken", "access%5ftoken", "access-token", "ACCESS_TOKEN", "Access_Token"]) {
      const scrubbed = scrubCredentials(`https://x.test/a#${name}=SECRET123`);
      expect(scrubbed, name).not.toContain("SECRET123");
    }
  });

  it("works in a fragment, a query and a semicolon-separated list", () => {
    expect(scrubCredentials("https://x.test/a#access_token=SECRET123")).not.toContain("SECRET123");
    expect(scrubCredentials("https://x.test/a?x=1&client_secret=SECRET123")).not.toContain("SECRET123");
    expect(scrubCredentials("https://x.test/a;token=SECRET123")).not.toContain("SECRET123");
  });

  it("works inside prose and inside an error message", () => {
    expect(scrubCredentials("See https://x.test/a?access_token=SECRET123 for details")).not.toContain("SECRET123");
    expect(scrubCredentials("URL is malformed: https://?access_token=SECRET123")).not.toContain("SECRET123");
  });

  it("covers the other credential-shaped names", () => {
    for (const name of ["client_secret", "app_secret", "signed_request", "oauth_token", "api_key", "apikey", "password", "secret"]) {
      expect(scrubCredentials(`https://x.test/a?${name}=SECRET123`), name).not.toContain("SECRET123");
    }
  });

  it("leaves text without a credential exactly as it was", () => {
    for (const text of [
      "https://scontent.xx.fbcdn.net/v/t39.35426-6/photo.jpg?_nc_cat=1&oh=abc~def&oe=69617495",
      "https:// is a protocol, not an address",
      "Refresca tu verano con un 30% de descuento",
      "",
    ]) {
      expect(scrubCredentials(text)).toBe(text);
    }
  });

  it("reports whether a credential is present", () => {
    expect(hasCredential("https://x.test/a?access_token=SECRET123")).toBe(true);
    expect(hasCredential("https://x.test/a?oe=69617495")).toBe(false);
    // Repeated calls must not depend on a leftover regex index.
    expect(hasCredential("https://x.test/a?access_token=SECRET123")).toBe(true);
  });
});
