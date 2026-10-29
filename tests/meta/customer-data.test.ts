import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildCustomerPayload } from "../../src/meta/customer-data.js";

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

// Rules from Meta's customer-file guide and its SDK's normalizer: trim and
// lowercase everything; a value already a SHA-256 hash is kept as it is.
describe("buildCustomerPayload", () => {
  it("hashes each field after Meta's normalization, in a fixed schema order", () => {
    const { schema, data, rejected } = buildCustomerPayload([
      {
        email: "  Ana.Perez@Example.COM ", phone: "+57 (300) 555-0101", first_name: "  Ána-María ", last_name: "Pérez O'Neil",
        city: "Bogotá D.C.", state: "Cundinamarca", zip: "11001 1", country: "CO", gender: "Female",
        birth_year: "1990", birth_month: "3", birth_day: "7",
      },
    ]);

    expect(rejected).toEqual([]);
    expect(schema).toEqual(["EMAIL", "PHONE", "FN", "LN", "GEN", "DOBY", "DOBM", "DOBD", "CT", "ST", "ZIP", "COUNTRY"]);
    expect(data).toEqual([[
      sha("ana.perez@example.com"),
      sha("573005550101"),
      sha("ánamaría"),
      sha("pérezoneil"),
      sha("f"),
      sha("1990"),
      sha("03"),
      sha("07"),
      sha("bogotadc"),
      sha("cundinamarca"),
      sha("110011"),
      sha("co"),
    ]]);
  });

  it("leaves a column empty for a row that lacks that field", () => {
    const { schema, data } = buildCustomerPayload([{ email: "a@example.com" }, { phone: "15555550100" }]);
    expect(schema).toEqual(["EMAIL", "PHONE"]);
    expect(data).toEqual([[sha("a@example.com"), ""], ["", sha("15555550100")]]);
  });

  it("keeps a value that is already a SHA-256 hash", () => {
    const hashed = sha("someone@example.com");
    expect(buildCustomerPayload([{ email: hashed.toUpperCase() }]).data).toEqual([[hashed]]);
  });

  it("sends an external id and a mobile advertiser id unhashed, as Meta asks", () => {
    const { schema, data } = buildCustomerPayload([{ external_id: " CRM-001 ", mobile_advertiser_id: " AB12CD34-0000-1111-2222-333344445555 " }]);
    expect(schema).toEqual(["EXTERN_ID", "MADID"]);
    expect(data).toEqual([["CRM-001", "ab12cd34-0000-1111-2222-333344445555"]]);
  });

  it.each([
    ["an email without a domain", { email: "nobody" }, "email"],
    ["a phone with a leading zero after the prefix", { phone: "0300 555 0101" }, "phone"],
    ["a phone too short to carry a country code", { phone: "5550101" }, "phone"],
    ["a country that is not two letters", { country: "Colombia" }, "country"],
    ["a birth month out of range", { birth_month: "13" }, "birth_month"],
    ["a birth year that is not a year", { birth_year: "77" }, "birth_year"],
    ["a gender Meta does not take", { gender: "x" }, "gender"],
    ["a name with no letters", { first_name: "1234" }, "first_name"],
  ])("rejects a row with %s, naming the row and field but never the value", (_label, row, field) => {
    const { data, rejected } = buildCustomerPayload([{ email: "ok@example.com" }, row]);

    expect(data).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].row).toBe(2);
    expect(rejected[0].field).toBe(field);
    for (const value of Object.values(row)) expect(JSON.stringify(rejected)).not.toContain(value);
  });

  // Meta: the first 5 digits of a US ZIP code, and a US state as its
  // two-letter code.
  it.each([
    ["a nine-digit ZIP", { country: "US", zip: "941071234" }, ["ZIP", "COUNTRY"], [sha("94107"), sha("us")]],
    ["a ZIP+4 with a dash", { country: "US", zip: "94107-1234" }, ["ZIP", "COUNTRY"], [sha("94107"), sha("us")]],
    ["a state name", { country: "US", state: "California" }, ["ST", "COUNTRY"], [sha("ca"), sha("us")]],
    ["a state name of two words", { country: "us", state: "New York" }, ["ST", "COUNTRY"], [sha("ny"), sha("us")]],
    ["a state code", { country: "US", state: "TX" }, ["ST", "COUNTRY"], [sha("tx"), sha("us")]],
    ["a hashed country", { country: sha("us"), state: "California" }, ["ST", "COUNTRY"], [sha("ca"), sha("us")]],
  ])("normalizes %s in the United States", (_label, row, schema, cells) => {
    const result = buildCustomerPayload([row]);
    expect(result.rejected).toEqual([]);
    expect(result.schema).toEqual(schema);
    expect(result.data).toEqual([cells]);
  });

  it("keeps the letters of any script, with their marks", () => {
    const { data, rejected } = buildCustomerPayload([{ first_name: "विजय", last_name: "Иванов", first_initial: "विजय" }]);
    expect(rejected).toEqual([]);
    expect(data).toEqual([[sha("विजय"), sha("иванов"), sha("वि")]]);
  });

  it.each([
    ["a US state that does not exist", { country: "US", state: "Narnia" }, "state"],
    ["a US state named like an object's own property", { country: "US", state: "constructor" }, "state"],
    ["a US ZIP that is not five digits", { country: "US", zip: "ab12" }, "zip"],
    ["a mobile advertiser id of hyphens only", { mobile_advertiser_id: "--------" }, "mobile_advertiser_id"],
    ["a truncated mobile advertiser id", { mobile_advertiser_id: "ab12cd34-0000" }, "mobile_advertiser_id"],
    ["a country code ISO does not assign", { country: "ZZ" }, "country"],
    ["UK, which is GB in ISO", { country: "UK" }, "country"],
  ])("rejects %s", (_label, row, field) => {
    const { data, rejected } = buildCustomerPayload([{ email: "ok@example.com" }, row]);
    expect(data).toHaveLength(1);
    expect(rejected.map((r) => [r.row, r.field])).toEqual([[2, field]]);
  });

  it("rejects a row with no values at all", () => {
    const { data, rejected } = buildCustomerPayload([{}, { email: "  " }]);
    expect(data).toEqual([]);
    expect(rejected.map((r) => r.row)).toEqual([1, 2]);
  });

  it("never puts a raw value in what it returns", () => {
    const result = buildCustomerPayload([{ email: "private.person@example.com", phone: "+1 555 555 0199", first_name: "Secretname" }]);
    const text = JSON.stringify(result);
    expect(text).not.toContain("private.person");
    expect(text).not.toContain("5550199");
    expect(text.toLowerCase()).not.toContain("secretname");
  });
});
