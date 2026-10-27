// Date math for recurring transactions. Dates are "YYYY-MM-DD" strings and
// every calculation is done in UTC so a server's time zone can't shift a day.

export type RecurrenceUnit = "DAY" | "WEEK" | "MONTH" | "YEAR";

export type Recurrence = {
  unit: RecurrenceUnit;
  /** Every N days / weeks / months / years. */
  every: number;
  /** MONTH and YEAR: day of the month, 1-31, or -1 for the last day. Defaults to the start date's day. */
  onDay?: number;
  /** WEEK: 0 (Sunday) - 6. Defaults to the start date's weekday. */
  onWeekday?: number;
  /** YEAR: 1-12. Defaults to the start date's month. */
  onMonth?: number;
};

export type RecurrenceEnd = { type: "NONE" } | { type: "BY"; date: string } | { type: "AFTER"; count: number };

const parse = (iso: string): Date => new Date(`${iso}T00:00:00Z`);
const format = (date: Date): string => date.toISOString().slice(0, 10);
const daysInMonth = (year: number, month0: number): number => new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();

export function addDays(iso: string, days: number): string {
  const date = parse(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return format(date);
}

/** A day of a month, clamped so "the 31st" lands on the 30th/28th in shorter months. */
function dayIn(year: number, month0: number, onDay: number): string {
  const last = daysInMonth(year, month0);
  const day = onDay === -1 ? last : Math.min(onDay, last);
  return format(new Date(Date.UTC(year, month0, day)));
}

function monthShift(year: number, month0: number, by: number): { year: number; month0: number } {
  const total = year * 12 + month0 + by;
  return { year: Math.floor(total / 12), month0: ((total % 12) + 12) % 12 };
}

/** The first occurrence on or after `start`. */
export function firstOccurrence(rule: Recurrence, start: string): string {
  const s = parse(start);
  switch (rule.unit) {
    case "DAY":
      return start;
    case "WEEK": {
      const weekday = rule.onWeekday ?? s.getUTCDay();
      return addDays(start, (weekday - s.getUTCDay() + 7) % 7);
    }
    case "MONTH": {
      const onDay = rule.onDay ?? s.getUTCDate();
      const here = dayIn(s.getUTCFullYear(), s.getUTCMonth(), onDay);
      if (here >= start) return here;
      const next = monthShift(s.getUTCFullYear(), s.getUTCMonth(), rule.every);
      return dayIn(next.year, next.month0, onDay);
    }
    case "YEAR": {
      const month0 = (rule.onMonth ?? s.getUTCMonth() + 1) - 1;
      const onDay = rule.onDay ?? s.getUTCDate();
      const here = dayIn(s.getUTCFullYear(), month0, onDay);
      return here >= start ? here : dayIn(s.getUTCFullYear() + rule.every, month0, onDay);
    }
  }
}

/** The occurrence strictly after `after` (which is itself an occurrence). */
export function nextOccurrence(rule: Recurrence, after: string): string {
  const a = parse(after);
  switch (rule.unit) {
    case "DAY":
      return addDays(after, rule.every);
    case "WEEK":
      return addDays(after, 7 * rule.every);
    case "MONTH": {
      const next = monthShift(a.getUTCFullYear(), a.getUTCMonth(), rule.every);
      return dayIn(next.year, next.month0, rule.onDay ?? a.getUTCDate());
    }
    case "YEAR":
      return dayIn(a.getUTCFullYear() + rule.every, (rule.onMonth ?? a.getUTCMonth() + 1) - 1, rule.onDay ?? a.getUTCDate());
  }
}

/** True once the series has produced its last occurrence: `date` is past the end, or `occurrencesDone` reached the count. */
export function isPastEnd(end: RecurrenceEnd, date: string, occurrencesDone: number): boolean {
  if (end.type === "BY") return date > end.date;
  if (end.type === "AFTER") return occurrencesDone >= end.count;
  return false;
}
