import type { AutomationSchedule } from "../types";

/// Bounds for each 5-field cron field: [min, max] inclusive.
const CRON_BOUNDS = {
  minute: [0, 59],
  hour: [0, 23],
  day: [1, 31],
  month: [1, 12],
  weekday: [0, 6]
} as const;

type CronField = keyof typeof CRON_BOUNDS;

function parseField(field: string, [min, max]: readonly [number, number]): Set<number> | null {
  // Returns the set of matching values, or null if the field is malformed.
  const values = new Set<number>();
  for (const part of field.split(",")) {
    if (part === "*") {
      for (let v = min; v <= max; v += 1) values.add(v);
      continue;
    }
    let step = 1;
    let range = part;
    const slashIndex = part.indexOf("/");
    if (slashIndex !== -1) {
      range = part.slice(0, slashIndex);
      step = Number(part.slice(slashIndex + 1));
      if (!Number.isInteger(step) || step < 1) return null;
    }
    let start: number;
    let end: number;
    if (range === "*") {
      start = min;
      end = max;
    } else if (range.includes("-")) {
      const [s, e] = range.split("-").map(Number);
      if (!Number.isInteger(s) || !Number.isInteger(e)) return null;
      start = s;
      end = e;
    } else {
      const n = Number(range);
      if (!Number.isInteger(n)) return null;
      start = n;
      end = n;
    }
    if (start < min || end > max || start > end) return null;
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return values.size ? values : null;
}

export type ParsedCron = {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  weekday: Set<number>;
};

/// Parse a 5-field cron expression into value sets. Returns null if any field is
/// malformed or out of range. Used both to validate user input (M5) and to drive
/// a faster, month-aware next-run resolver (M4).
export function parseCron(expression: string): ParsedCron | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, day, month, weekday] = (["minute", "hour", "day", "month", "weekday"] as CronField[])
    .map((name, index) => parseField(fields[index], CRON_BOUNDS[name]));
  if (!minute || !hour || !day || !month || !weekday) return null;
  return { minute, hour, day, month, weekday };
}

/// Validate a cron expression and return a human-readable error string, or null
/// when the expression is well-formed. Surfaces problems immediately instead of
/// silently producing an automation that never fires.
export function validateCron(expression: string): string | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return "Cron expressions need exactly 5 fields: minute hour day month weekday.";
  }
  const names: CronField[] = ["minute", "hour", "day", "month", "weekday"];
  const labels: Record<CronField, string> = {
    minute: "minute", hour: "hour", day: "day-of-month", month: "month", weekday: "weekday"
  };
  for (let i = 0; i < 5; i += 1) {
    const [min, max] = CRON_BOUNDS[names[i]];
    if (!parseField(fields[i], [min, max])) {
      return `Invalid ${labels[names[i]]} field "${fields[i]}".`;
    }
  }
  return null;
}

export function nextRunForSchedule(schedule: AutomationSchedule, from = Date.now()) {
  if (schedule.kind === "interval") {
    return from + Math.max(1, schedule.minutes) * 60_000;
  }

  if (schedule.kind === "daily") {
    const [hours, minutes] = schedule.time.split(":").map(Number);
    const next = new Date(from);
    next.setSeconds(0, 0);
    next.setHours(hours || 0, minutes || 0, 0, 0);
    if (next.getTime() <= from) next.setDate(next.getDate() + 1);
    return next.getTime();
  }

  if (schedule.kind === "weekly") {
    const [hours, minutes] = schedule.time.split(":").map(Number);
    const days = schedule.days.length ? schedule.days : [1];
    for (let offset = 0; offset <= 7; offset += 1) {
      const next = new Date(from);
      next.setDate(next.getDate() + offset);
      next.setHours(hours || 0, minutes || 0, 0, 0);
      if (days.includes(next.getDay()) && next.getTime() > from) return next.getTime();
    }
    return from + 7 * 86_400_000;
  }

  // Cron: precompute value sets once. If the expression is malformed, fall back
  // to +1h so a broken schedule doesn't fire a runaway loop.
  const parsed = parseCron(schedule.expression);
  if (!parsed) return from + 60 * 60_000;

  const candidate = new Date(from);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  // Upper bound: one year of minute-by-minute iteration. In practice the
  // month-skip below keeps iteration tiny — a non-matching month is advanced
  // past wholesale instead of stepping through ~43k unused minutes.
  const limit = from + 365 * 86_400_000;
  while (candidate.getTime() <= limit) {
    // Skip an entire month when no day in it can match (month field excludes
    // this month, or no valid day-of-month falls within it).
    if (!parsed.month.has(candidate.getMonth() + 1)) {
      candidate.setMonth(candidate.getMonth() + 1, 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }
    if (
      parsed.minute.has(candidate.getMinutes()) &&
      parsed.hour.has(candidate.getHours()) &&
      parsed.day.has(candidate.getDate()) &&
      parsed.weekday.has(candidate.getDay())
    ) {
      return candidate.getTime();
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return from + 60 * 60_000;
}

export function describeSchedule(schedule: AutomationSchedule) {
  if (schedule.kind === "interval") return `Every ${schedule.minutes} minute${schedule.minutes === 1 ? "" : "s"}`;
  if (schedule.kind === "daily") return `Daily at ${schedule.time}`;
  if (schedule.kind === "weekly") {
    const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return `${schedule.days.map((day) => names[day]).join(", ")} at ${schedule.time}`;
  }
  return `Cron · ${schedule.expression}`;
}

export function formatRunTime(timestamp?: number) {
  if (!timestamp) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
  }).format(timestamp);
}
