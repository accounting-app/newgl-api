export type AccountingBasis = "cash" | "accrual";

export const ACCOUNTING_CONFIG = {
  basis: "cash" as AccountingBasis,
  fiscalYearStart: "01-01",
  currency: "USD",
  currencySymbol: "$",
  roundingTolerance: 0.005
} as const;

export type AppConfig = {
  company: string;
  ledgerFile: string;
  port: number;
  host: string;
};

export function loadConfig(): AppConfig {
  return {
    company: process.env.COMPANY ?? "Company",
    ledgerFile: process.env.LEDGER_FILE ?? "data/company.bean",
    port: Number.parseInt(process.env.PORT ?? "3001", 10),
    host: process.env.HOST ?? "0.0.0.0"
  };
}
