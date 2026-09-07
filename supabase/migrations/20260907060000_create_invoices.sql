-- Phase 1.5, Step 7 of newgl-specs/plans/qbo-free-features/QBO_FREE_FEATURES_PLAN.md:
-- Invoices, the AR mirror of Bills. Matches how QuickBooks itself works:
-- entering an invoice immediately posts a real asset (Dr Accounts
-- Receivable, Cr Income), independent of when it's actually collected;
-- receiving payment later posts a second transaction (Dr Cash/Bank, Cr
-- Accounts Receivable). `posted_transaction_id`/`payment_transaction_id`
-- are plain text, same reasoning as bills -- transactions live in the
-- ledger's .bean content, not a Postgres table.
--
-- `customer_id` is a real FK (no cascade, same reasoning as
-- bills.vendor_id). `product_service_id` is ALSO a real FK, unlike
-- bills.category_account_id -- Products & Services is a Postgres table
-- now (see 20260907050000_create_products_services.sql), not a
-- ledger-store reference, and it's genuinely optional (an invoice line
-- doesn't have to point at a catalog item).
create table invoices (
  id                     uuid primary key default gen_random_uuid(),
  ledger_id              uuid not null references ledgers(id) on delete cascade,
  customer_id            uuid not null references customers(id),
  product_service_id     uuid references products_services(id),
  invoice_number         text,
  invoice_date           date not null,
  due_date               date not null,
  amount                 numeric(12, 2) not null check (amount > 0),
  memo                   text,
  status                 text not null default 'OPEN' check (status in ('DRAFT', 'OPEN', 'PAID')),
  posted_transaction_id  text,
  payment_transaction_id text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index invoices_ledger_id_idx on invoices (ledger_id);
create index invoices_customer_id_idx on invoices (customer_id);
create index invoices_ledger_status_idx on invoices (ledger_id, status);

alter table invoices enable row level security;
-- No policies: deny-by-default backstop, same rationale as every other
-- ledger-scoped table -- see migration 20260826000000.
