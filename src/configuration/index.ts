export type AppEnv = "local" | "development" | "staging" | "production";
export type AccountingBasis = "cash" | "accrual";

export type AppConfig = {
  COMPANY: string;
  LEDGER_FILE: string;
  LEDGER_NAME: string;
  DATABASE_URL: string | undefined;
  SUPABASE_URL: string | undefined;
  NEWGL_AI_URL: string | undefined;
  INTERNAL_SERVICE_TOKEN: string | undefined;
  ACCOUNTING_BASIS: AccountingBasis;
  ACCOUNTING_CONFIG: {
    basis: AccountingBasis;
  };
};

export const APP_ENV = process.env.APP_ENV as AppEnv || "local";
export const APP_HOSTNAME = process.env.HOSTNAME || "0.0.0.0";
export const APP_PORT = process.env.PORT || 8080;
export const COMPANY = process.env.COMPANY || "company";
// LEDGER_FILE is retained for the file-based repository (tests, and as a
// fallback until DATABASE_URL is configured everywhere). The Postgres-backed
// repository used at boot (see src/index.ts) ignores it.
export const LEDGER_FILE = process.env.LEDGER_FILE || "data/company.bean";
export const LEDGER_NAME = process.env.LEDGER_NAME || "company";
export const DATABASE_URL = process.env.DATABASE_URL;
export const SUPABASE_URL = process.env.SUPABASE_URL;
// Service-role key for calling Supabase's own REST APIs directly (Storage,
// Admin) via plain fetch -- same key tests/helpers/supabase-test-auth.ts
// already uses for the Auth admin API. Never exposed to the browser.
export const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// newgl-ai (Phase 3+): internal-only service, reachable at NEWGL_AI_URL,
// authenticated with the shared INTERNAL_SERVICE_TOKEN header. Never exposed
// to the browser -- see AI_INTEGRATION_PLAN.md Part 1.
export const NEWGL_AI_URL = process.env.NEWGL_AI_URL;
export const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN;
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
    LEDGER_NAME,
    DATABASE_URL,
    SUPABASE_URL,
    NEWGL_AI_URL,
    INTERNAL_SERVICE_TOKEN,
    ACCOUNTING_BASIS,
    ACCOUNTING_CONFIG
   },
  development: {
    COMPANY,
    LEDGER_FILE,
    LEDGER_NAME,
    DATABASE_URL,
    SUPABASE_URL,
    NEWGL_AI_URL,
    INTERNAL_SERVICE_TOKEN,
    ACCOUNTING_BASIS,
    ACCOUNTING_CONFIG
   },
  staging: {
    COMPANY,
    LEDGER_FILE,
    LEDGER_NAME,
    DATABASE_URL,
    SUPABASE_URL,
    NEWGL_AI_URL,
    INTERNAL_SERVICE_TOKEN,
    ACCOUNTING_BASIS,
    ACCOUNTING_CONFIG
   },
  production: {
    COMPANY,
    LEDGER_FILE,
    LEDGER_NAME,
    DATABASE_URL,
    SUPABASE_URL,
    NEWGL_AI_URL,
    INTERNAL_SERVICE_TOKEN,
    ACCOUNTING_BASIS,
    ACCOUNTING_CONFIG
   }
};

export const APP_CONFIG = APP_ENV_CONFIG[APP_ENV];