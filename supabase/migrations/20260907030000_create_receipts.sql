-- Phase 1.5, Step 5 of newgl-specs/plans/qbo-free-features/QBO_FREE_FEATURES_PLAN.md:
-- Receipts. Manual "upload, then optionally link to a transaction/vendor"
-- only for v1, per the plan doc's own resolved open question -- no OCR/
-- auto-matching (a real AI/OCR feature, out of scope here). The actual
-- file bytes live in Supabase Storage's `receipts` bucket (created
-- on-demand by src/infra/supabase-storage/client.ts, not by this
-- migration -- storage buckets aren't plain Postgres rows to migrate);
-- this table is just the metadata + the review fields the Receipts screen
-- already collects (payment/category account, amount, tax, note).
--
-- Like Bills, `vendor_id` is a real FK with no cascade -- a vendor with
-- receipts against it can't be deleted out from under them. Unlike Bills,
-- it's nullable: a receipt can exist before it's matched to a vendor.
-- `payment_account_id`/`category_account_id`/`linked_transaction_id` are
-- plain text, same reasoning as bills.category_account_id -- they
-- reference ledger-store ids, which live in the ledger's .bean content,
-- not a Postgres table.
create table receipts (
  id                     uuid primary key default gen_random_uuid(),
  ledger_id              uuid not null references ledgers(id) on delete cascade,
  storage_path           text not null,
  file_name              text not null,
  file_size_bytes        bigint not null check (file_size_bytes > 0),
  content_type           text not null,
  vendor_id              uuid references vendors(id),
  payment_account_id     text,
  category_account_id    text,
  amount                 numeric(12, 2),
  tax_amount             numeric(12, 2),
  note                   text,
  linked_transaction_id  text,
  uploaded_at            timestamptz not null default now()
);

create index receipts_ledger_id_idx on receipts (ledger_id);
create index receipts_vendor_id_idx on receipts (vendor_id);

alter table receipts enable row level security;
-- No policies: deny-by-default backstop, same rationale as every other
-- ledger-scoped table -- see migration 20260826000000.
