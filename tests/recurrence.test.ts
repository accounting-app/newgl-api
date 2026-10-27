import { describe, expect, test } from "bun:test";

import { addDays, firstOccurrence, isPastEnd, nextOccurrence } from "@/shared/utils/recurrence";

describe("recurrence date math", () => {
  test("daily steps by N days", () => {
    expect(firstOccurrence({ unit: "DAY", every: 3 }, "2026-10-26")).toBe("2026-10-26");
    expect(nextOccurrence({ unit: "DAY", every: 3 }, "2026-10-26")).toBe("2026-10-29");
  });

  test("weekly lands on the chosen weekday, then steps by N weeks", () => {
    // 2026-10-26 is a Monday; ask for Friday (5).
    expect(firstOccurrence({ unit: "WEEK", every: 2, onWeekday: 5 }, "2026-10-26")).toBe("2026-10-30");
    expect(nextOccurrence({ unit: "WEEK", every: 2, onWeekday: 5 }, "2026-10-30")).toBe("2026-11-13");
  });

  test("monthly on a day: this month if it is still ahead, else the next one", () => {
    expect(firstOccurrence({ unit: "MONTH", every: 1, onDay: 28 }, "2026-10-26")).toBe("2026-10-28");
    expect(firstOccurrence({ unit: "MONTH", every: 1, onDay: 1 }, "2026-10-26")).toBe("2026-11-01");
  });

  test("monthly on the 31st clamps to short months and recovers", () => {
    const rule = { unit: "MONTH" as const, every: 1, onDay: 31 };
    expect(nextOccurrence(rule, "2026-01-31")).toBe("2026-02-28");
    expect(nextOccurrence(rule, "2026-02-28")).toBe("2026-03-31");
  });

  test("monthly on the last day, every 2 months, across a year end", () => {
    const rule = { unit: "MONTH" as const, every: 2, onDay: -1 };
    expect(nextOccurrence(rule, "2026-10-31")).toBe("2026-12-31");
    expect(nextOccurrence(rule, "2026-12-31")).toBe("2027-02-28");
  });

  test("yearly keeps its month and day", () => {
    const rule = { unit: "YEAR" as const, every: 1, onMonth: 2, onDay: 29 };
    expect(firstOccurrence(rule, "2027-01-01")).toBe("2027-02-28");
    expect(nextOccurrence(rule, "2027-02-28")).toBe("2028-02-29");
  });

  test("addDays crosses month boundaries", () => {
    expect(addDays("2026-12-30", 5)).toBe("2027-01-04");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  test("end rules", () => {
    expect(isPastEnd({ type: "NONE" }, "2099-01-01", 999)).toBe(false);
    expect(isPastEnd({ type: "BY", date: "2026-12-31" }, "2027-01-01", 0)).toBe(true);
    expect(isPastEnd({ type: "BY", date: "2026-12-31" }, "2026-12-31", 0)).toBe(false);
    expect(isPastEnd({ type: "AFTER", count: 3 }, "2026-12-31", 3)).toBe(true);
    expect(isPastEnd({ type: "AFTER", count: 3 }, "2026-12-31", 2)).toBe(false);
  });
});
