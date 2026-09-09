-- Phase 1.5, Step 6 of newgl-specs/plans/qbo-free-features/QBO_FREE_FEATURES_PLAN.md:
-- Products & Services catalog, shared between Sales & Get Paid and
-- Customer Hub (an Invoice/Estimate line item points at one). No
-- accounting impact of its own -- income_account_id is a plain text
-- reference to a ledger-store account id (same reasoning as
-- bills.category_account_id), not a Postgres FK. Ledger-scoped, same
-- shape as vendors.
create table products_services (
  id                 uuid primary key default gen_random_uuid(),
  ledger_id          uuid not null references ledgers(id) on delete cascade,
  name               text not null,
  type               text not null check (type in ('SERVICE', 'PRODUCT')),
  description        text,
  sales_price        numeric(12, 2),
  income_account_id  text,
  status             text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index products_services_ledger_id_idx on products_services (ledger_id);

alter table products_services enable row level security;
-- No policies: deny-by-default backstop, same rationale as every other
-- ledger-scoped table -- see migration 20260826000000.
