-- Phase 1.5, Step 1 of newgl-specs/plans/qbo-free-features/QBO_FREE_FEATURES_PLAN.md:
-- the first real backend for the Expenses & Bills UI (previously
-- localStorage-only). A vendor is a plain directory entry -- name, contact
-- info, an optional default expense account, and whether to track it for
-- 1099 purposes -- with no accounting impact of its own (a Bill against a
-- vendor is what touches the ledger, in a later migration). Ledger-scoped
-- (one company's vendor list is invisible to another), same shape as
-- ledger_files: see 20260826000000_create_ledger_files.sql.
--
-- `is_1099_contractor` doubles as the Team ▸ Contractors and Expenses &
-- Bills ▸ 1099s source of truth -- both are just filtered/aggregated views
-- over this same table, not separate entities (see the plan doc).
create table vendors (
  id                          uuid primary key default gen_random_uuid(),
  ledger_id                   uuid not null references ledgers(id) on delete cascade,
  name                        text not null,
  company_name                text,
  email                       text,
  phone                       text,
  address                     text,
  tax_id                      text,
  default_expense_account_id text,
  is_1099_contractor          boolean not null default false,
  status                      text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create index vendors_ledger_id_idx on vendors (ledger_id);
-- Powers the Contractors filtered view and the 1099s report without a
-- table scan once a company has a real-sized vendor list.
create index vendors_ledger_1099_idx on vendors (ledger_id, is_1099_contractor) where is_1099_contractor;

alter table vendors enable row level security;
-- No policies: deny-by-default backstop, same rationale as every other
-- ledger-scoped table -- see migration 20260826000000.
