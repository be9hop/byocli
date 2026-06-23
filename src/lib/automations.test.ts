import { describe, expect, it } from "vitest";
import type { AutomationSchedule } from "../types";
import {
  describeSchedule, formatRunTime, nextRunForSchedule, parseCron, validateCron
} from "./automations";

/// Build a local-midnight anchor so daily/weekly/cron assertions (which use
/// local time internally) don't depend on the host machine's timezone offset.
/// 2025-06-15 00:00:00 local.
const LOCAL_MIDNIGHT = new Date(2025, 5, 15, 0, 0, 0, 0).getTime();

describe("validateCron", () => {
  it("accepts a well-formed 5-field expression", () => {
    expect(validateCron("0 9 * * 1-5")).toBeNull();
    expect(validateCron("*/15 0 * * *")).toBeNull();
    expect(validateCron("30 4 1 1,7 0")).toBeNull();
  });

  it("rejects wrong field count", () => {
    expect(validateCron("0 9 * *")).toMatch(/exactly 5 fields/);
    expect(validateCron("0 9 * * 1 2")).toMatch(/exactly 5 fields/);
    expect(validateCron("")).toMatch(/exactly 5 fields/);
  });

  it("rejects out-of-range values", () => {
    expect(validateCron("60 9 * * *")).toMatch(/minute/);
    expect(validateCron("0 24 * * *")).toMatch(/hour/);
    expect(validateCron("0 9 0 * *")).toMatch(/day-of-month/);
    expect(validateCron("0 9 * 13 *")).toMatch(/month/);
    expect(validateCron("0 9 * * 7")).toMatch(/weekday/);
  });

  it("rejects malformed tokens (no silent 'never fires')", () => {
    expect(validateCron("abc 9 * * *")).toMatch(/minute/);
    expect(validateCron("0 9 * * mon")).toMatch(/weekday/); // names not supported
    expect(validateCron("0-99 9 * * *")).toMatch(/minute/);
    expect(validateCron("*/0 9 * * *")).toMatch(/minute/); // step must be >= 1
  });
});

describe("parseCron", () => {
  it("expands `*` into the full valid range for each field", () => {
    const parsed = parseCron("* * * * *");
    expect(parsed).not.toBeNull();
    expect(parsed!.minute.size).toBe(60);
    expect(parsed!.hour.size).toBe(24);
    expect(parsed!.day.size).toBe(31);
    expect(parsed!.month.size).toBe(12);
    expect(parsed!.weekday.size).toBe(7);
  });

  it("handles ranges, lists, and steps", () => {
    const parsed = parseCron("0,30 0-23 */6 * *");
    expect(parsed).not.toBeNull();
    expect(parsed!.minute).toEqual(new Set([0, 30]));
    expect(parsed!.hour.size).toBe(24);
    // `*/6` over day-of-month [1,31] steps from the field minimum (1), so the
    // matches are 1,7,13,19,25,31 — standard cron semantics.
    expect([...parsed!.day]).toEqual([1, 7, 13, 19, 25, 31]);
  });

  it("returns null for malformed input (parity with validateCron)", () => {
    expect(parseCron("not cron")).toBeNull();
    expect(parseCron("99 9 * * *")).toBeNull();
    expect(parseCron("* * * *")).toBeNull();
  });
});

describe("nextRunForSchedule — interval", () => {
  it("adds N minutes to `from`", () => {
    const schedule: AutomationSchedule = { kind: "interval", minutes: 5 };
    expect(nextRunForSchedule(schedule, LOCAL_MIDNIGHT)).toBe(LOCAL_MIDNIGHT + 5 * 60_000);
  });

  it("treats zero/negative minutes as 1 minute minimum", () => {
    expect(nextRunForSchedule({ kind: "interval", minutes: 0 }, LOCAL_MIDNIGHT)).toBe(LOCAL_MIDNIGHT + 60_000);
    expect(nextRunForSchedule({ kind: "interval", minutes: -3 }, LOCAL_MIDNIGHT)).toBe(LOCAL_MIDNIGHT + 60_000);
  });
});

describe("nextRunForSchedule — daily", () => {
  it("rolls to the next day when today's slot has passed", () => {
    // nextRunForSchedule operates in local time; a 09:00 daily run starting from
    // local midnight lands later the same day.
    const schedule: AutomationSchedule = { kind: "daily", time: "09:00" };
    const next = nextRunForSchedule(schedule, LOCAL_MIDNIGHT);
    const d = new Date(next);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
    expect(next).toBeGreaterThan(LOCAL_MIDNIGHT);
  });

  it("jumps to tomorrow when the time is already past", () => {
    const past = new Date(2025, 5, 15, 10, 0, 0, 0).getTime(); // 10:00 same day, local
    const schedule: AutomationSchedule = { kind: "daily", time: "09:00" };
    const next = nextRunForSchedule(schedule, past);
    const d = new Date(next);
    expect(d.getDate()).toBe(16);
    expect(d.getHours()).toBe(9);
  });
});

describe("nextRunForSchedule — weekly", () => {
  it("finds the next matching weekday", () => {
    // 2025-06-15 was a Sunday in local time. Looking for Monday (1) at 09:00.
    const schedule: AutomationSchedule = { kind: "weekly", days: [1], time: "09:00" };
    const next = nextRunForSchedule(schedule, LOCAL_MIDNIGHT);
    const d = new Date(next);
    expect(d.getDay()).toBe(1);
    expect(d.getHours()).toBe(9);
  });

  it("defaults to [1] when no days given", () => {
    const schedule: AutomationSchedule = { kind: "weekly", days: [], time: "09:00" };
    expect(new Date(nextRunForSchedule(schedule, LOCAL_MIDNIGHT)).getDay()).toBe(1);
  });
});

describe("nextRunForSchedule — cron", () => {
  it("resolves a simple daily weekday expression", () => {
    const schedule: AutomationSchedule = { kind: "cron", expression: "0 9 * * 1" };
    const next = nextRunForSchedule(schedule, LOCAL_MIDNIGHT);
    const d = new Date(next);
    expect(d.getDay()).toBe(1);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
  });

  it("skips non-matching months wholesale (Feb-30 style impossible date)", () => {
    // `0 0 30 2 *` — 30th of February. This can never match; the resolver must
    // terminate quickly (the old code looped up to 525,600 times) and fall back
    // to +1h rather than hang.
    const start = Date.now();
    const schedule: AutomationSchedule = { kind: "cron", expression: "0 0 30 2 *" };
    const next = nextRunForSchedule(schedule, LOCAL_MIDNIGHT);
    expect(next).toBe(LOCAL_MIDNIGHT + 60 * 60_000);
    expect(Date.now() - start).toBeLessThan(500); // month-skip keeps it fast
  });

  it("falls back to +1h for a malformed expression", () => {
    const schedule: AutomationSchedule = { kind: "cron", expression: "garbage" };
    expect(nextRunForSchedule(schedule, LOCAL_MIDNIGHT)).toBe(LOCAL_MIDNIGHT + 60 * 60_000);
  });

  it("honours a step expression within the same hour", () => {
    // `*/15 0 * * *` matches minutes 0,15,30,45 at hour 0. nextRunForSchedule
    // starts searching one minute after `from`, so from local midnight the first
    // match is 00:15 (00:00 itself is excluded as "not strictly after from").
    const schedule: AutomationSchedule = { kind: "cron", expression: "*/15 0 * * *" };
    const next = nextRunForSchedule(schedule, LOCAL_MIDNIGHT); // midnight local
    const d = new Date(next);
    expect(d.getHours()).toBe(0);
    expect([0, 15, 30, 45]).toContain(d.getMinutes());
    expect(d.getMinutes()).toBe(15); // 00:00 excluded; first hit is 00:15
  });
});

describe("describeSchedule", () => {
  it("humanizes each schedule kind", () => {
    expect(describeSchedule({ kind: "interval", minutes: 1 })).toBe("Every 1 minute");
    expect(describeSchedule({ kind: "interval", minutes: 30 })).toBe("Every 30 minutes");
    expect(describeSchedule({ kind: "daily", time: "09:00" })).toBe("Daily at 09:00");
    expect(describeSchedule({ kind: "weekly", days: [1, 3], time: "09:00" })).toBe("Mon, Wed at 09:00");
    expect(describeSchedule({ kind: "cron", expression: "0 9 * * *" })).toBe("Cron · 0 9 * * *");
  });
});

describe("formatRunTime", () => {
  it("renders 'Never' for missing timestamps", () => {
    expect(formatRunTime(undefined)).toBe("Never");
  });

  it("renders a real timestamp", () => {
    // formatRunTime uses Intl.DateTimeFormat without a year field; assert the
    // month/day/time appear and it isn't the "Never" sentinel.
    const out = formatRunTime(new Date(2025, 5, 15, 9, 0, 0).getTime());
    expect(out).not.toBe("Never");
    expect(out).toMatch(/Jun/);
    expect(out).toMatch(/15/);
  });
});
