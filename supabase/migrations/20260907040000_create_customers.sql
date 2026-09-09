-- Phase 1.5, Step 6 of newgl-specs/plans/qbo-free-features/QBO_FREE_FEATURES_PLAN.md:
-- Customers, the AR mirror of Vendors -- shared between Sales & Get Paid
-- and Customer Hub, per the plan doc. Plain directory entry, no
-- accounting impact of its own (an Invoice against a customer is what
-- touches the ledger, in a later migration -- same reasoning as
-- vendors/bills). Ledger-scoped, same shape as vendors: see
-- 20260907000000_create_vendors.sql.
create table customers (
  id            uuid primary key default gen_random_uuid(),
  ledger_id     uuid not null references ledgers(id) on delete cascade,
  name          text not null,
  company_name  text,
  email         text,
  phone         text,
  address       text,
  status        text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index customers_ledger_id_idx on customers (ledger_id);

alter table customers enable row level security;
-- No policies: deny-by-default backstop, same rationale as every other
-- ledger-scoped table -- see migration 20260826000000.
