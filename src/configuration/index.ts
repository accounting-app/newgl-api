export type AppEnv = "local" | "development" | "staging" | "production";
export type AccountingBasis = "cash" | "accrual";

export type AppConfig = {
  COMPANY: string;
  LEDGER_FILE: string;
  ACCOUNTING_BASIS: AccountingBasis;
  ACCOUNTING_CONFIG: {
    basis: AccountingBasis;
  };
};

export const APP_ENV = process.env.APP_ENV as AppEnv || "local";
export const APP_HOSTNAME = process.env.HOSTNAME || "0.0.0.0";
export const APP_PORT = process.env.PORT || 8080;
export const COMPANY = process.env.COMPANY || "company";
export const LEDGER_FILE = process.env.LEDGER_FILE || "data/company.bean";
export const DEBUG_LEDGER_PASSWORD = process.env.DEBUG_LEDGER_PASSWORD ?? "";

// NOTE: Need to swap the accounting config, from UI -> API.
export const ACCOUNTING_BASIS = process.env.ACCOUNTING_BASIS as AccountingBasis || "cash";
export const ACCOUNTING_CONFIG = {
  basis: ACCOUNTING_BASIS,
  fiscalYearStart: "01-01",
  currency: "USD",
  currencySymbol: "$",
  roundingTolerance: 0.005
} as const;

const APP_ENV_CONFIG: Record<AppEnv, AppConfig> = {
  local: { 
    COMPANY,
    LEDGER_FILE,
    ACCOUNTING_BASIS,
    ACCOUNTING_CONFIG
   },
  development: { 
    COMPANY,
    LEDGER_FILE,
    ACCOUNTING_BASIS,
    ACCOUNTING_CONFIG
   },
  staging: { 
    COMPANY,
    LEDGER_FILE,
    ACCOUNTING_BASIS,
    ACCOUNTING_CONFIG
   },
  production: { 
    COMPANY,
    LEDGER_FILE,
    ACCOUNTING_BASIS,
    ACCOUNTING_CONFIG
   }
};

export const APP_CONFIG = APP_ENV_CONFIG[APP_ENV];