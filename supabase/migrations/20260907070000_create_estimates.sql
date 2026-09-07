-- Phase 1.5, Step 8 of newgl-specs/plans/qbo-free-features/QBO_FREE_FEATURES_PLAN.md:
-- Estimates -- metadata-only, no ledger impact, matching QBO itself
-- (a quote is not an accounting event; only converting it to a real
-- invoice would ever touch the books, and that's a distinct action this
-- app doesn't model automatically). Same shape as invoices, minus the
-- posted/payment transaction columns -- customer_id and
-- product_service_id are both real FKs (no cascade), same reasoning as
-- invoices.customer_id/product_service_id.
create table estimates (
  id                  uuid primary key default gen_random_uuid(),
  ledger_id           uuid not null references ledgers(id) on delete cascade,
  customer_id         uuid not null references customers(id),
  product_service_id  uuid references products_services(id),
  estimate_number     text,
  estimate_date       date not null,
  expiration_date     date,
  amount              numeric(12, 2) not null check (amount > 0),
  memo                text,
  status              text not null default 'OPEN' check (status in ('OPEN', 'ACCEPTED', 'DECLINED')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index estimates_ledger_id_idx on estimates (ledger_id);
create index estimates_customer_id_idx on estimates (customer_id);

alter table estimates enable row level security;
-- No policies: deny-by-default backstop, same rationale as every other
-- ledger-scoped table -- see migration 20260826000000.
