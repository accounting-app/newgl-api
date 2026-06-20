import type { RegisterEntry } from "@/domain/models";

export type PeriodStatus = "open" | "closed" | "locked";

export type AccountingPeriod = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: PeriodStatus;
};

const PERIOD_STATUS_OVERRIDES: Record<string, PeriodStatus> = {};

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];

function lastDayOfMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

export function findPeriodForDate(transactionDate: string): AccountingPeriod {
  const [yearText, monthText] = transactionDate.split("-");
  const year = Number.parseInt(yearText, 10);
  const monthNumber = Number.parseInt(monthText, 10);
  if (!Number.isFinite(year) || !Number.isFinite(monthNumber) || monthNumber < 1 || monthNumber > 12) {
    throw new Error(`Invalid transaction date: ${transactionDate}`);
  }
  const monthIndex = monthNumber - 1;
  const key = `${yearText}-${monthText.padStart(2, "0")}`;
  const lastDay = lastDayOfMonth(year, monthIndex);
  return {
    id: `period-${key}`,
    name: `${MONTH_NAMES[monthIndex]} ${year}`,
    startDate: `${key}-01`,
    endDate: `${key}-${String(lastDay).padStart(2, "0")}`,
    status: PERIOD_STATUS_OVERRIDES[key] ?? "open"
  };
}

export function getPeriodIdForDate(transactionDate: string): string {
  return findPeriodForDate(transactionDate).id;
}

export function validateTransactionPeriod(transactionDate: string): AccountingPeriod {
  const period = findPeriodForDate(transactionDate);
  if (period.status === "closed") {
    throw new Error(`Period ${period.name} is closed. Create a transaction in an open period instead.`);
  }
  if (period.status === "locked") {
    throw new Error(`Period ${period.name} is locked by an administrator.`);
  }
  return period;
}

export function summarizePeriod(
  period: AccountingPeriod,
  entries: RegisterEntry[]
): { openingBalance: number; closingBalance: number } {
  const within = entries
    .filter((entry) => entry.date >= period.startDate && entry.date <= period.endDate)
    .sort((a, b) => `${a.date}-${a.createdAt}`.localeCompare(`${b.date}-${b.createdAt}`));

  if (within.length === 0) {
    return { openingBalance: 0, closingBalance: 0 };
  }
  const first = within[0];
  const last = within[within.length - 1];
  const firstMovement = (first.deposit ?? 0) - (first.payment ?? 0);
  return {
    openingBalance: round2(first.runningBalance - firstMovement),
    closingBalance: round2(last.runningBalance)
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
