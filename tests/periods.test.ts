import { describe, expect, test } from "bun:test";

import { ValidationError } from "../src/core/errors";
import { findPeriodForDate, getPeriodIdForDate } from "../src/core/periods";

describe("periods", () => {
  test("findPeriodForDate returns month metadata", () => {
    const period = findPeriodForDate("2024-02-15");
    expect(period.id).toBe("period-2024-02");
    expect(period.name).toBe("February 2024");
    expect(period.endDate).toBe("2024-02-29");
  });

  test("getPeriodIdForDate matches findPeriodForDate", () => {
    expect(getPeriodIdForDate("2024-03-01")).toBe("period-2024-03");
  });

  test("findPeriodForDate rejects invalid dates", () => {
    expect(() => findPeriodForDate("2024-13-01")).toThrow(ValidationError);
    expect(() => findPeriodForDate("not-a-date")).toThrow(ValidationError);
  });
});