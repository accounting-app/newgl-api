import { ACCOUNTING_CONFIG } from "@/configuration";
import { ValidationError } from "@/core/errors";
import type {
  Account,
  LedgerPosting,
  PostingEntryType,
  ReconcileStatus,
  RegisterEntry
} from "@/domain/models";

export const DEBIT_NORMAL_CATEGORIES = new Set<Account["category"]>([
  "ACCOUNTS_RECEIVABLE",
  "BANK",
  "EXPENSE",
  "FIXED_ASSET",
  "OTHER_CURRENT_ASSET",
  "OTHER_EXPENSE"
]);

export type PostingLike = { type: PostingEntryType; amount: number };

const TOLERANCE = ACCOUNTING_CONFIG.roundingTolerance;

function sumBySide(postings: PostingLike[], side: PostingEntryType): number {
  return postings
    .filter((posting) => posting.type === side)
    .reduce((total, posting) => total + posting.amount, 0);
}

export function validateDoubleEntry(postings: PostingLike[]): true {
  if (postings.length < 2) {
    throw new ValidationError("A transaction must have at least two postings (double-entry).");
  }
  const totalDebits = sumBySide(postings, "DEBIT");
  const totalCredits = sumBySide(postings, "CREDIT");
  if (Math.abs(totalDebits - totalCredits) > TOLERANCE) {
    throw new ValidationError(
      `Unbalanced transaction: debits ${totalDebits} do not equal credits ${totalCredits}.`
    );
  }
  return true;
}

export function isDoubleEntryBalanced(postings: PostingLike[]): boolean {
  try {
    return validateDoubleEntry(postings);
  } catch {
    return false;
  }
}

export function calculateTrialBalance(postings: LedgerPosting[]): {
  totalDebits: number;
  totalCredits: number;
  balanced: boolean;
} {
  const posted: PostingLike[] = postings
    .filter((posting) => posting.status === "POSTED")
    .map((posting) => ({ type: posting.entryType, amount: posting.amount }));
  const totalDebits = sumBySide(posted, "DEBIT");
  const totalCredits = sumBySide(posted, "CREDIT");
  return {
    totalDebits: round2(totalDebits),
    totalCredits: round2(totalCredits),
    balanced: Math.abs(totalDebits - totalCredits) < TOLERANCE
  };
}

export function generateBalanceSheet(accounts: Account[]): {
  assets: number;
  liabilitiesAndEquity: number;
  balanced: boolean;
} {
  let assets = 0;
  let liabilitiesAndEquity = 0;
  accounts.forEach((account) => {
    if (DEBIT_NORMAL_CATEGORIES.has(account.category)) {
      assets += account.currentBalance;
    } else {
      liabilitiesAndEquity += account.currentBalance;
    }
  });
  return {
    assets: round2(assets),
    liabilitiesAndEquity: round2(liabilitiesAndEquity),
    balanced: Math.abs(assets - liabilitiesAndEquity) < 0.01
  };
}

export function getBankReconciliationSummary(entries: RegisterEntry[]): {
  clearedBalance: number;
  unclearedBalance: number;
  totalBalance: number;
} {
  const movement = (entry: RegisterEntry) => (entry.deposit ?? 0) - (entry.payment ?? 0);
  const clearedBalance = entries
    .filter((entry) => entry.reconcileStatus === "C" || entry.reconcileStatus === "R")
    .reduce((sum, entry) => sum + movement(entry), 0);
  const unclearedBalance = entries
    .filter((entry) => entry.reconcileStatus === "")
    .reduce((sum, entry) => sum + movement(entry), 0);
  return {
    clearedBalance: round2(clearedBalance),
    unclearedBalance: round2(unclearedBalance),
    totalBalance: round2(clearedBalance + unclearedBalance)
  };
}

export function validateTransactionAmounts(input: { payment?: number; deposit?: number }): true {
  if (input.payment !== undefined && input.payment < 0) {
    throw new ValidationError(`Payment amount must be positive (got ${input.payment}).`);
  }
  if (input.deposit !== undefined && input.deposit < 0) {
    throw new ValidationError(`Deposit amount must be positive (got ${input.deposit}).`);
  }
  return true;
}

export function generateNextRefNumber(existingRefNumbers: Array<string | undefined>): string {
  const maxNum = existingRefNumbers.reduce((max, ref) => {
    if (!ref) return max;
    const match = /^TX-(\d+)$/.exec(ref.trim());
    if (!match) return max;
    const num = Number.parseInt(match[1], 10);
    return Number.isFinite(num) && num > max ? num : max;
  }, 1000);
  return `TX-${maxNum + 1}`;
}

export function isEntryLocked(status: ReconcileStatus): boolean {
  return status === "C" || status === "R";
}

export function assertEntryEditable(status: ReconcileStatus): void {
  if (isEntryLocked(status)) {
    const label = status === "R" ? "reconciled" : "cleared";
    throw new ValidationError(
      `This transaction is ${label} and cannot be edited. Create a reversal entry instead.`
    );
  }
}

export function assertEntryDeletable(status: ReconcileStatus): void {
  if (status !== "") {
    const label = status === "R" ? "reconciled" : "cleared";
    throw new ValidationError(`Only pending transactions can be deleted (this one is ${label}).`);
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function computeBalanceImpact(
  category: Account["category"],
  side: PostingEntryType,
  amount: number
): number {
  if (DEBIT_NORMAL_CATEGORIES.has(category)) {
    return side === "DEBIT" ? amount : -amount;
  }
  return side === "CREDIT" ? amount : -amount;
}

export function postingFiscalPeriod(date: string): string {
  return date.slice(0, 7);
}
