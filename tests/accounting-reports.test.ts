import { describe, expect, test } from "bun:test";

import {
  assertEntryDeletable,
  assertEntryEditable,
  computeBalanceImpact,
  validateDoubleEntry,
  validateTransactionAmounts
} from "../src/core/accounting-reports";
import { ValidationError } from "../src/core/errors";

describe("accounting-reports", () => {
  test("validateDoubleEntry rejects unbalanced postings", () => {
    expect(() =>
      validateDoubleEntry([
        { type: "DEBIT", amount: 50 },
        { type: "CREDIT", amount: 40 }
      ])
    ).toThrow(ValidationError);
  });

  test("validateDoubleEntry accepts postings within tolerance", () => {
    expect(
      validateDoubleEntry([
        { type: "DEBIT", amount: 10.003 },
        { type: "CREDIT", amount: 10 }
      ])
    ).toBe(true);
  });

  test("validateTransactionAmounts rejects negative payment", () => {
    expect(() => validateTransactionAmounts({ payment: -1 })).toThrow(ValidationError);
  });

  test("assertEntryEditable rejects reconciled entries", () => {
    expect(() => assertEntryEditable("R")).toThrow(ValidationError);
  });

  test("assertEntryDeletable rejects cleared entries", () => {
    expect(() => assertEntryDeletable("C")).toThrow(ValidationError);
  });

  test("computeBalanceImpact treats BANK as debit-normal", () => {
    expect(computeBalanceImpact("BANK", "DEBIT", 100)).toBe(100);
    expect(computeBalanceImpact("BANK", "CREDIT", 100)).toBe(-100);
  });

  test("computeBalanceImpact treats INCOME as credit-normal", () => {
    expect(computeBalanceImpact("INCOME", "CREDIT", 100)).toBe(100);
    expect(computeBalanceImpact("INCOME", "DEBIT", 100)).toBe(-100);
  });
});