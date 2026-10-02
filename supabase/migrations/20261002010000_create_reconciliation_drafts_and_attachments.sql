-- QBO's "Save for later" keeps an in-progress reconciliation (statement
-- info plus which transactions are checked) so "Resume reconciling" can
-- pick it up. One draft per account: starting over replaces it, Finish
-- deletes it. Checked transactions are stored by transaction id (stable)
-- rather than register-entry id (not stable across requests).
create table if not exists reconciliation_drafts (
  id                       uuid primary key default gen_random_uuid(),
  ledger_id                uuid not null references ledgers(id) on delete cascade,
  account_id               text not null,
  statement_start_date     date not null,
  statement_ending_date    date not null,
  statement_ending_balance numeric(12, 2) not null,
  service_charge           jsonb,
  interest_earned          jsonb,
  cleared_transaction_ids  jsonb not null default '[]'::jsonb,
  saved_by                 text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (ledger_id, account_id)
);

alter table reconciliation_drafts enable row level security;

-- QBO's History by account lets you "Attach" the bank statement file to a
-- reconciliation. Stored in Postgres (small PDFs/images) so no separate
-- file storage has to be wired up; capped at 10 MB per file by the route.
create table if not exists reconciliation_attachments (
  id                uuid primary key default gen_random_uuid(),
  reconciliation_id uuid not null references reconciliations(id) on delete cascade,
  file_name         text not null,
  content_type      text not null,
  size_bytes        integer not null,
  content           bytea not null,
  created_by        text,
  created_at        timestamptz not null default now()
);

create index if not exists reconciliation_attachments_reconciliation_id_idx on reconciliation_attachments (reconciliation_id);

alter table reconciliation_attachments enable row level security;
