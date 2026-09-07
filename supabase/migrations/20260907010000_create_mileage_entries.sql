-- Phase 1.5, Step 2 of newgl-specs/plans/qbo-free-features/QBO_FREE_FEATURES_PLAN.md:
-- mileage trip log. No ledger impact -- "no beancount posting required
-- unless the user wants reimbursement to hit the ledger" per the plan doc,
-- deferred as its own future decision if ever wanted. Ledger-scoped, same
-- shape as vendors: see 20260907000000_create_vendors.sql.
create table mileage_entries (
  id             uuid primary key default gen_random_uuid(),
  ledger_id      uuid not null references ledgers(id) on delete cascade,
  date           date not null,
  miles          numeric(10, 1) not null check (miles > 0),
  rate_per_mile  numeric(10, 3) not null check (rate_per_mile >= 0),
  type           text not null check (type in ('BUSINESS', 'PERSONAL')),
  start_address  text,
  end_address    text,
  purpose        text,
  created_at     timestamptz not null default now()
);

create index mileage_entries_ledger_id_idx on mileage_entries (ledger_id);
-- The dashboard filters/aggregates by tax year, i.e. by the year portion
-- of `date`, for every request -- index that access pattern directly.
create index mileage_entries_ledger_date_idx on mileage_entries (ledger_id, date desc);

alter table mileage_entries enable row level security;
-- No policies: deny-by-default backstop, same rationale as every other
-- ledger-scoped table -- see migration 20260826000000.
