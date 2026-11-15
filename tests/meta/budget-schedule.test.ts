import { describe, it, expect } from "vitest";
import {
  checkConflicts,
  checkIncrease,
  checkWindow,
  describeSchedule,
  formatWindow,
  increaseAmount,
  nextUsableStart,
  parseIncrease,
  parseSchedule,
  scheduleStatus,
  type Schedule,
} from "../../src/meta/budget-schedule.js";
import { instantSeconds } from "../../src/utils/time.js";

const H = 3600;
// 2026-11-16T15:00:00Z, 10:00 in Bogota.
const T = 1794841200;
const NOW = T - 24 * H;

const schedule = (overrides: Partial<Schedule> = {}): Schedule => ({
  id: "1000000000000001",
  objectId: "23800000000000101",
  value: 30000,
  type: "ABSOLUTE",
  start: T,
  end: T + 3 * H,
  ...overrides,
});

describe("parseSchedule (what Meta returns, measured 2026-11-15)", () => {
  it("reads a period as Meta answers it", () => {
    expect(parseSchedule({
      id: "1000000000000001",
      ad_object_id: "23800000000000101",
      budget_value: 7001,
      budget_value_type: "ABSOLUTE",
      recurrence_type: "ONE_TIME",
      time_start: "2026-11-16T15:00:00+0000",
      time_end: "2026-11-16T18:00:00+0000",
    })).toEqual(schedule({ value: 7001 }));
  });

  it("is undefined for a period that repeats, which these tools do not handle", () => {
    expect(parseSchedule({ id: "1", budget_value: 1, budget_value_type: "ABSOLUTE", recurrence_type: "WEEKLY", time_start: "2026-11-16T15:00:00+0000", time_end: "2026-11-16T18:00:00+0000" })).toBeUndefined();
    expect(parseSchedule({ id: "1", budget_value: 1, budget_value_type: "ABSOLUTE", time_start: "2026-11-16T15:00:00+0000", time_end: "2026-11-16T18:00:00+0000" })).toBeUndefined();
  });

  it("is undefined for anything it cannot read whole", () => {
    expect(parseSchedule({ id: "1", budget_value: 1, budget_value_type: "OTHER", time_start: "2026-11-16T15:00:00+0000", time_end: "2026-11-16T18:00:00+0000" })).toBeUndefined();
    expect(parseSchedule({ id: "1", budget_value: "x", budget_value_type: "ABSOLUTE", time_start: "2026-11-16T15:00:00+0000", time_end: "2026-11-16T18:00:00+0000" })).toBeUndefined();
    expect(parseSchedule({ id: "1", budget_value: 1, budget_value_type: "ABSOLUTE", time_start: "soon", time_end: "2026-11-16T18:00:00+0000" })).toBeUndefined();
    expect(parseSchedule({ id: "abc", budget_value: 1, budget_value_type: "ABSOLUTE", time_start: "2026-11-16T15:00:00+0000", time_end: "2026-11-16T18:00:00+0000" })).toBeUndefined();
    expect(parseSchedule(null)).toBeUndefined();
  });
});

describe("parseIncrease", () => {
  it("takes a positive whole number or its digits", () => {
    expect(parseIncrease(30000, "budget_value")).toBe(30000);
    expect(parseIncrease("30000", "budget_value")).toBe(30000);
  });

  it("refuses zero, negatives, fractions and text", () => {
    for (const bad of [0, -5, 1.5, "1.5", "30,000", "", "abc", undefined]) {
      expect(() => parseIncrease(bad, "budget_value"), String(bad)).toThrow(/budget_value/);
    }
  });
});

describe("checkWindow (Meta's rules, measured 2026-11-15)", () => {
  it("accepts a window on quarter hours, three hours long, in the future", () => {
    expect(() => checkWindow(T, T + 3 * H, NOW)).not.toThrow();
  });

  it("refuses a time off the quarter hour (Meta error 3858205)", () => {
    expect(() => checkWindow(T + 7 * 60, T + 3 * H + 7 * 60, NOW)).toThrow(/quarter hour/);
    expect(() => checkWindow(T, T + 3 * H + 30, NOW)).toThrow(/quarter hour/);
  });

  it("works on quarter hours whatever the offset the time was written in", () => {
    // 20:45 at +05:45 is 15:00 UTC; 10:30 at -05:00 is 15:30 UTC.
    expect(() => checkWindow(instantSeconds("2026-11-16T20:45:00+05:45", "time_start"), T + 3 * H, NOW)).not.toThrow();
    expect(() => checkWindow(instantSeconds("2026-11-16T10:30:00-05:00", "time_start"), T + 4 * H, NOW)).not.toThrow();
    expect(() => checkWindow(instantSeconds("2026-11-16T20:40:00+05:45", "time_start"), T + 3 * H, NOW)).toThrow(/quarter hour/);
  });

  it("refuses a window under three hours (Meta error 3858094)", () => {
    expect(() => checkWindow(T, T + 2 * H + 45 * 60, NOW)).toThrow(/3 hours/);
  });

  it("refuses an end before the start", () => {
    expect(() => checkWindow(T, T - 3 * H, NOW)).toThrow(/after time_start/);
  });

  it("refuses a start in the past or too close to now to arrive in time (Meta error 3858085)", () => {
    expect(() => checkWindow(T, T + 3 * H, T + 60)).toThrow(/future/);
    expect(() => checkWindow(T, T + 3 * H, T - 30)).toThrow(/future/);
    expect(() => checkWindow(T, T + 3 * H, T - 6 * 60)).not.toThrow();
  });

  it("names the next start that can be used", () => {
    expect(() => checkWindow(T, T + 3 * H, T + 60)).toThrow(new RegExp(`${new Date(nextUsableStart(T + 60) * 1000).toISOString().slice(11, 16)} UTC`));
  });
});

describe("nextUsableStart", () => {
  it("is the next quarter hour at least two minutes away", () => {
    expect(nextUsableStart(T - 10 * 60)).toBe(T);
    expect(nextUsableStart(T - 60)).toBe(T + 900);
    expect(nextUsableStart(T)).toBe(T + 900);
  });
});

describe("checkIncrease (cap measured 2026-11-15: the increase is at most 8 × the daily budget)", () => {
  it("accepts an ABSOLUTE increase up to 8 × the daily budget and refuses one unit more (Meta error 3858092)", () => {
    expect(() => checkIncrease(1000, "ABSOLUTE", 8000, "USD")).not.toThrow();
    expect(() => checkIncrease(1000, "ABSOLUTE", 8001, "USD")).toThrow(/USD 80\.00/);
  });

  it("states the cap in the account currency, whole units for COP", () => {
    expect(() => checkIncrease(50000, "ABSOLUTE", 400001, "COP")).toThrow(/COP 400,000/);
  });

  it("accepts a MULTIPLIER up to 800 (+800 %) and refuses 801", () => {
    expect(() => checkIncrease(1000, "MULTIPLIER", 800, "USD")).not.toThrow();
    expect(() => checkIncrease(1000, "MULTIPLIER", 801, "USD")).toThrow(/800/);
  });
});

describe("increaseAmount", () => {
  it("is the amount itself for ABSOLUTE and the percentage of the daily budget for MULTIPLIER", () => {
    expect(increaseAmount(10000, "ABSOLUTE", 30000)).toBe(30000);
    expect(increaseAmount(10000, "MULTIPLIER", 50)).toBe(5000);
    expect(increaseAmount(999, "MULTIPLIER", 50)).toBe(499);
  });
});

describe("checkConflicts", () => {
  const candidate = { start: T + 24 * H, end: T + 27 * H, type: "ABSOLUTE" as const };

  it("accepts a period that touches another without overlapping it", () => {
    expect(() => checkConflicts([schedule({ start: T + 21 * H, end: T + 24 * H })], candidate, NOW)).not.toThrow();
  });

  it("refuses an overlap (Meta error 3858167)", () => {
    expect(() => checkConflicts([schedule({ start: T + 25 * H, end: T + 28 * H })], candidate, NOW)).toThrow(/overlaps period 1000000000000001/);
  });

  it("refuses mixing ABSOLUTE and MULTIPLIER on one campaign or ad set (Meta error 3858093)", () => {
    expect(() => checkConflicts([schedule({ type: "MULTIPLIER", value: 50 })], candidate, NOW)).toThrow(/MULTIPLIER/);
  });

  // Whether Meta counts an ended period is not known, and a replace that Meta
  // then refuses deletes a period in progress for nothing.
  it("counts a period of the other kind even when it has ended", () => {
    const ended = schedule({ type: "MULTIPLIER", start: NOW - 6 * H, end: NOW - 3 * H });
    expect(() => checkConflicts([ended], candidate, NOW)).toThrow(/ended.*MULTIPLIER/);
  });

  it("refuses a 51st period", () => {
    const fifty = Array.from({ length: 50 }, (_, i) => schedule({ id: String(1000 + i), start: T + (100 + 4 * i) * H, end: T + (103 + 4 * i) * H }));
    expect(() => checkConflicts(fifty, candidate, NOW)).toThrow(/50/);
  });

  it("leaves out the period being replaced", () => {
    const same = schedule({ start: candidate.start, end: candidate.end });
    expect(() => checkConflicts([same], candidate, NOW, same.id)).not.toThrow();
    expect(() => checkConflicts([same], candidate, NOW)).toThrow(/overlaps/);
  });
});

describe("scheduleStatus", () => {
  it("is upcoming, in progress or ended by the server's clock", () => {
    const s = schedule();
    expect(scheduleStatus(s, T - 1)).toBe("upcoming");
    expect(scheduleStatus(s, T)).toBe("in progress");
    expect(scheduleStatus(s, T + 3 * H - 1)).toBe("in progress");
    expect(scheduleStatus(s, T + 3 * H)).toBe("ended");
  });
});

describe("formatWindow", () => {
  it("shows the window in the account's time zone and in UTC", () => {
    expect(formatWindow(T, T + 3 * H, "America/Bogota")).toBe("2026-11-16 10:00 → 13:00 America/Bogota (2026-11-16 15:00 → 18:00 UTC)");
  });

  it("repeats the date when the window crosses midnight", () => {
    expect(formatWindow(T + 9 * H, T + 12 * H, "America/Bogota")).toBe("2026-11-16 19:00 → 22:00 America/Bogota (2026-11-17 00:00 → 03:00 UTC)");
    expect(formatWindow(T + 12 * H, T + 15 * H, "America/Bogota")).toBe("2026-11-16 22:00 → 2026-11-17 01:00 America/Bogota (2026-11-17 03:00 → 06:00 UTC)");
  });

  it("shows UTC alone when the time zone is unknown or not one", () => {
    expect(formatWindow(T, T + 3 * H, undefined)).toBe("2026-11-16 15:00 → 18:00 UTC");
    expect(formatWindow(T, T + 3 * H, "Mars/Olympus")).toBe("2026-11-16 15:00 → 18:00 UTC");
  });
});

describe("describeSchedule", () => {
  const context = { daily: 10000, currency: "USD", timezone: "America/Bogota", now: NOW };

  it("says that an ABSOLUTE amount is added to the daily budget and states the total (today's incident: 30000 on USD 100.00)", () => {
    const text = describeSchedule(schedule(), context).join("\n");
    expect(text).toContain("+USD 300.00");
    expect(text).toMatch(/on top of the daily budget/);
    expect(text).toContain("USD 400.00");
    expect(text).toContain("2026-11-16 10:00 → 13:00 America/Bogota");
    expect(text).toMatch(/upcoming/);
  });

  it("states a MULTIPLIER as a percentage with its approximate amount", () => {
    const text = describeSchedule(schedule({ type: "MULTIPLIER", value: 50 }), context).join("\n");
    expect(text).toContain("+50%");
    expect(text).toContain("USD 50.00");
    expect(text).toContain("USD 150.00");
  });

  it("marks a period in progress", () => {
    expect(describeSchedule(schedule(), { ...context, now: T + H }).join("\n")).toMatch(/IN PROGRESS/);
  });

  it("works in whole-unit currencies", () => {
    const text = describeSchedule(schedule({ value: 100000 }), { ...context, daily: 50000, currency: "COP" }).join("\n");
    expect(text).toContain("+COP 100,000");
    expect(text).toContain("COP 150,000");
  });

  it("gives the raw amount with its unit when the currency is not known, and no total without a daily budget", () => {
    const text = describeSchedule(schedule(), { now: NOW }).join("\n");
    expect(text).toContain("30000 (in the account currency's minor unit)");
    expect(text).not.toMatch(/during the window: /);
  });
});
