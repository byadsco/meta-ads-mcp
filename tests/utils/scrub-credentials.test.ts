import { describe, expect, it } from "vitest";
import { hasCredential, isCredentialName, scrubCredentials, scrubUrlCredentials } from "../../src/utils/scrub-credentials.js";

const SECRET = "SECRET123";

describe("isCredentialName", () => {
  it("recognizes a credential name however it is spelled or encoded", () => {
    for (const name of [
      "access_token",
      "ACCESS_TOKEN",
      "access-token",
      "access.token",
      "access%5Ftoken",
      "access%5ftoken",
      "access%255Ftoken",
      "%61ccess_token",
      "%63lient_secret",
      "client_secret",
      "app_secret",
      "signed_request",
      "oauth_token",
      "api_key",
      "apikey",
      "password",
      "secret",
    ]) {
      expect(isCredentialName(name), name).toBe(true);
    }
  });

  it("leaves the parameters a Meta CDN url actually carries alone", () => {
    for (const name of ["oe", "oh", "_nc_cat", "_nc_ht", "stp", "utm_source", "utm_campaign", "fbclid", "id", "locale", "width"]) {
      expect(isCredentialName(name), name).toBe(false);
    }
  });
});

describe("scrubCredentials", () => {
  it("removes the value and keeps the name", () => {
    expect(scrubCredentials(`https://x.test/a?access_token=${SECRET}&b=1`)).toBe("https://x.test/a?access_token=[REDACTED]&b=1");
  });

  it("closes every evasion the review found", () => {
    for (const text of [
      `https://x.test/a?%63lient_secret=${SECRET}`,
      `https://x.test/a#%61ccess_token=${SECRET}`,
      `https://x.test/a?access%255Ftoken=${SECRET}`,
      `https://x.test/a#/access_token=${SECRET}`,
      `https://x.test/a;token=${SECRET}`,
      `https://x.test/a,secret=${SECRET}`,
      `access_token=${SECRET}`,
      `URL is malformed: https://?access_token=${SECRET}`,
      `See https://x.test/a?access_token=${SECRET} for details`,
    ]) {
      expect(scrubCredentials(text), text).not.toContain(SECRET);
    }
  });

  it("does not swallow a legitimate parameter that follows one", () => {
    expect(scrubCredentials(`https://x.test/a?access_token=${SECRET};utm_source=facebook`)).toContain("utm_source=facebook");
    expect(scrubCredentials(`https://x.test/a?access_token=${SECRET}&utm_source=facebook`)).toContain("utm_source=facebook");
    expect(scrubCredentials(`access_token=${SECRET}, utm_source=facebook`)).toContain("utm_source=facebook");
  });

  it("leaves text without a credential exactly as it was", () => {
    for (const text of [
      "https://scontent.xx.fbcdn.net/v/t39.35426-6/photo.jpg?_nc_cat=1&oh=abc~def&oe=69617495",
      "https://shop.example.com/x?utm_source=facebook&utm_medium=paid",
      "https:// is a protocol, not an address",
      "Refresca tu verano con un 30% de descuento",
      "2 + 2 = 4",
      "",
    ]) {
      expect(scrubCredentials(text), text).toBe(text);
    }
  });

  it("reports a credential consistently across repeated calls", () => {
    const text = `https://x.test/a?access_token=${SECRET}`;
    expect(hasCredential(text)).toBe(true);
    expect(hasCredential(text)).toBe(true);
    expect(hasCredential("https://x.test/a?oe=69617495")).toBe(false);
  });
});

describe("scrubUrlCredentials", () => {
  it("drops credential parameters however they are encoded, and userinfo", () => {
    for (const url of [
      `https://x.test/a?access_token=${SECRET}`,
      `https://x.test/a?access%5Ftoken=${SECRET}`,
      `https://x.test/a?%61ccess_token=${SECRET}`,
      `https://x.test/a#access%5Ftoken=${SECRET}`,
      `https://user:${SECRET}@x.test/a`,
    ]) {
      expect(scrubUrlCredentials(url), url).not.toContain(SECRET);
    }
  });

  it("returns a clean url byte for byte", () => {
    const signed = "https://scontent.xx.fbcdn.net/v/t39.35426-6/photo.jpg?_nc_cat=1&oh=abc~def&oe=69617495";
    expect(scrubUrlCredentials(signed)).toBe(signed);
  });

  it("keeps the other parameters when it has to rewrite", () => {
    const scrubbed = scrubUrlCredentials(`https://x.test/a?oe=69617495&access_token=${SECRET}&utm_source=facebook`)!;
    expect(scrubbed).not.toContain(SECRET);
    expect(scrubbed).toContain("oe=69617495");
    expect(scrubbed).toContain("utm_source=facebook");
  });

  it("reports a value that is not a url", () => {
    expect(scrubUrlCredentials("not a url")).toBeUndefined();
    expect(scrubUrlCredentials("https:// is a protocol")).toBeUndefined();
  });
});

describe("round-5 review fixes", () => {
  it("drops a fragment that mentions a credential in any shape", () => {
    for (const hash of [
      "#access_token=SECRET123",
      "#access+token=SECRET123",
      "#access!token=SECRET123",
      "#/access_token=SECRET123",
      `#access${"_".repeat(70)}token=SECRET123`,
      "#access%252525255Ftoken=SECRET123",
    ]) {
      const scrubbed = scrubUrlCredentials(`https://x.test/a${hash}`)!;
      expect(scrubbed, hash).not.toContain("SECRET123");
      expect(scrubbed).toBe("https://x.test/a");
    }
  });

  it("keeps a fragment that is just a fragment", () => {
    const url = "https://x.test/a#section-2";
    expect(scrubUrlCredentials(url)).toBe(url);
  });

  it("rebuilds a wide query in one pass rather than deleting in a loop", () => {
    // Distinct names that all normalize to the same credential, which is what
    // makes the delete path do work on every one of them.
    const params = Array.from({ length: 4000 }, (_, i) => `${"_".repeat(i % 40)}token${"-".repeat(Math.floor(i / 40))}=SECRET123`).join("&");
    const started = Date.now();
    const scrubbed = scrubUrlCredentials(`https://x.test/a?${params}&oe=69617495`)!;
    const elapsed = Date.now() - started;
    expect(scrubbed).not.toContain("SECRET123");
    expect(scrubbed).toContain("oe=69617495");
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("round-6 review fixes", () => {
  it("keeps a fragment whose words merely contain a credential name", () => {
    for (const url of [
      "https://shop.example/#/products/password-manager?color=blue",
      "https://shop.example/#/collections/secret-sale",
      "https://shop.example/#/products/author-kit",
      "https://shop.example/#/tokenized-offers",
      "https://shop.example/#/secretariat",
      "https://shop.example/#section-2",
    ]) {
      expect(scrubUrlCredentials(url), url).toBe(url);
    }
  });

  it("still drops a fragment that names a credential across segments", () => {
    for (const url of [
      "https://x.test/a#access_token=SECRET123",
      "https://x.test/a#access+token=SECRET123",
      "https://x.test/a#/client-secret=SECRET123",
    ]) {
      expect(scrubUrlCredentials(url), url).toBe("https://x.test/a");
    }
  });

  it("accepts, by documented decision, a credential spelled as a fragment path", () => {
    // Dropping a fragment whenever a credential word appeared anywhere cost
    // ordinary shop routes their path, which is data the reader needs. A
    // fragment goes only when it carries an actual name=value pair. This is
    // the advertisers own url in their own ad, inside the scrubbers
    // documented scope.
    for (const url of ["https://x.test/a#access_token/SECRET123", "https://x.test/a#/client-secret/SECRET123"]) {
      expect(scrubUrlCredentials(url), url).toBe(url);
    }
  });

  it("leaves an ordinary warning about auth modes alone", () => {
    const warning = "Invalid auth=oauth mode; expected auth=bearer.";
    expect(scrubCredentials(warning)).toBe(warning);
  });
});
