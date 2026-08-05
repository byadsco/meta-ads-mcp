import { describe, it, expect } from "vitest";
import { requireOneOf, buildFieldsParam, normalizeUrlTags } from "../../src/utils/validation.js";

describe("requireOneOf", () => {
  it("does not throw when at least one field is present", () => {
    expect(() =>
      requireOneOf({ name: "test", age: undefined }, ["name", "age"]),
    ).not.toThrow();
  });

  it("does not throw when multiple fields are present", () => {
    expect(() =>
      requireOneOf({ name: "test", age: 25 }, ["name", "age"]),
    ).not.toThrow();
  });

  it("throws when no fields are present", () => {
    expect(() =>
      requireOneOf({ other: "value" }, ["name", "age"]),
    ).toThrow("At least one of [name, age] is required.");
  });

  it("throws when fields are undefined", () => {
    expect(() =>
      requireOneOf({ name: undefined, age: null }, ["name", "age"]),
    ).toThrow();
  });

  it("uses custom error message when provided", () => {
    expect(() =>
      requireOneOf({}, ["a", "b"], "Custom error"),
    ).toThrow("Custom error");
  });

  it("treats 0 and empty string as present", () => {
    expect(() =>
      requireOneOf({ count: 0, name: "" }, ["count", "name"]),
    ).not.toThrow();
  });
});

describe("buildFieldsParam", () => {
  it("uses provided fields when available", () => {
    expect(buildFieldsParam(["id", "name"], ["id", "name", "status"])).toBe(
      "id,name",
    );
  });

  it("uses defaults when fields is undefined", () => {
    expect(buildFieldsParam(undefined, ["id", "name", "status"])).toBe(
      "id,name,status",
    );
  });

  it("uses defaults when fields is empty array", () => {
    expect(buildFieldsParam([], ["id", "name"])).toBe("id,name");
  });

  it("joins multiple fields with commas", () => {
    expect(buildFieldsParam(["a", "b", "c"], [])).toBe("a,b,c");
  });

  it("handles single field", () => {
    expect(buildFieldsParam(["id"], ["id", "name"])).toBe("id");
  });
});

describe("normalizeUrlTags", () => {
  it("leaves a plain query string untouched", () => {
    expect(normalizeUrlTags("utm_source=meta&utm_medium=paid")).toBe(
      "utm_source=meta&utm_medium=paid",
    );
  });

  it("strips a single leading question mark", () => {
    expect(normalizeUrlTags("?utm_source=meta")).toBe("utm_source=meta");
  });

  it("strips only one question mark", () => {
    expect(normalizeUrlTags("??utm_source=meta")).toBe("?utm_source=meta");
  });

  it("trims surrounding whitespace before stripping", () => {
    expect(normalizeUrlTags("  ?utm_source=meta  ")).toBe("utm_source=meta");
  });

  it("returns an empty string unchanged", () => {
    expect(normalizeUrlTags("")).toBe("");
  });

  it("returns an empty string for whitespace only", () => {
    expect(normalizeUrlTags("   ")).toBe("");
  });
});
