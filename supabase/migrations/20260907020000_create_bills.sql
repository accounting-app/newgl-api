-- Phase 1.5, Step 3 of newgl-specs/plans/qbo-free-features/QBO_FREE_FEATURES_PLAN.md:
-- Bills, the first domain in this phase that also becomes a real
-- beancount transaction (not metadata-only like Vendors/Mileage). Matches
-- how QuickBooks itself works: entering a bill immediately posts a real
-- liability (Dr Expense, Cr Accounts Payable), independent of when it's
-- actually paid; paying it later posts a second transaction (Dr Accounts
-- Payable, Cr Cash/Bank). `posted_transaction_id`/`payment_transaction_id`
-- are plain text, not a Postgres FK -- transactions live in the ledger's
-- .bean content (via TransactionService), not a Postgres table.
--
-- `category_account_id` is likewise a plain text reference to a
-- ledger-store account id, for the same reason.
--
-- `vendor_id` is a REAL FK (both tables live in Postgres) with no cascade
-- -- deleting a vendor with bills against it should fail loudly, not
-- silently orphan or delete accounting history.
create table bills (
  id                     uuid primary key default gen_random_uuid(),
  ledger_id              uuid not null references ledgers(id) on delete cascade,
  vendor_id              uuid not null references vendors(id),
  bill_number            text,
  bill_date              date not null,
  due_date               date not null,
  amount                 numeric(12, 2) not null check (amount > 0),
  category_account_id    text not null,
  memo                   text,
  status                 text not null default 'OPEN' check (status in ('DRAFT', 'OPEN', 'PAID')),
  posted_transaction_id  text,
  payment_transaction_id text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index bills_ledger_id_idx on bills (ledger_id);
create index bills_vendor_id_idx on bills (vendor_id);
create index bills_ledger_status_idx on bills (ledger_id, status);

alter table bills enable row level security;
-- No policies: deny-by-default backstop, same rationale as every other
-- ledger-scoped table -- see migration 20260826000000.
