import { describe, it, expect } from "vitest";
import { instantSeconds } from "../../src/utils/time.js";

describe("instantSeconds", () => {
  it("reads a time with its offset", () => {
    expect(instantSeconds("2026-11-16T10:00:00-05:00", "time_start")).toBe(1794841200);
    expect(instantSeconds("2026-11-16T15:00:00Z", "time_start")).toBe(1794841200);
    expect(instantSeconds("2026-11-16T15:00Z", "time_start")).toBe(1794841200);
    expect(instantSeconds("2026-11-16T20:45:00+05:45", "time_start")).toBe(1794841200);
  });

  it("reads Unix seconds, as a number or as digits", () => {
    expect(instantSeconds(1794841200, "time_start")).toBe(1794841200);
    expect(instantSeconds("1794841200", "time_start")).toBe(1794841200);
  });

  it("refuses a date alone, since reading it as UTC would move the window", () => {
    expect(() => instantSeconds("2026-11-16", "time_start")).toThrow(/time_start.*offset/);
  });

  it("refuses a time without an offset", () => {
    expect(() => instantSeconds("2026-11-16T10:00:00", "time_end")).toThrow(/time_end/);
  });

  it("refuses milliseconds where seconds are expected", () => {
    expect(() => instantSeconds(1794841200000, "time_start")).toThrow(/milliseconds/);
    expect(() => instantSeconds("1794841200000", "time_start")).toThrow(/milliseconds/);
  });

  it("refuses a day or an hour that does not exist instead of rolling it over", () => {
    expect(() => instantSeconds("2026-02-30T10:00:00Z", "time_start")).toThrow(/time_start/);
    expect(() => instantSeconds("2026-11-16T24:00:00Z", "time_start")).toThrow(/time_start/);
  });

  it("refuses fractions of a second, zero, negatives and other shapes", () => {
    expect(() => instantSeconds("2026-11-16T15:00:00.500Z", "time_start")).toThrow(/whole second/);
    expect(() => instantSeconds(0, "time_start")).toThrow(/time_start/);
    expect(() => instantSeconds(-1794841200, "time_start")).toThrow(/time_start/);
    expect(() => instantSeconds(1794841200.5, "time_start")).toThrow(/time_start/);
    expect(() => instantSeconds("next friday", "time_start")).toThrow(/time_start/);
    expect(() => instantSeconds(undefined as unknown as string, "time_start")).toThrow(/time_start/);
  });
});
