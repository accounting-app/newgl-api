-- Reconcile (issue #30): brings the "Reconcile" screen up to real QBO
-- parity -- a proper statement-matching session, not the localStorage-only
-- "Phase 1" stub it started as. Deliberately does NOT touch how
-- clearing/reconciling a single transaction works: that already round-trips
-- through the ledger's own beancount metadata via RegisterService.
-- setReconcileStatus (see register-service.ts), and stays the single
-- source of truth for a register entry's "" | "C" | "R" status. These two
-- tables only record SESSION-level facts -- the statement info, any
-- service-charge/interest-earned adjustment, and which transactions were
-- swept into "R" by that specific session -- for the History/Summary tabs
-- and the printable reconciliation report.
--
-- `account_id`/`*_account_id` are plain text, not FKs -- same reasoning as
-- bills.category_account_id: accounts live in the ledger's .bean content
-- (via AccountService), not a Postgres table.
--
-- `reconciliation_entries.transaction_id` is likewise plain text, and is
-- keyed by (transaction_id, account_id) rather than a register-entry id --
-- a register entry's id is regenerated every time the ledger document is
-- re-parsed (ledger-engine.ts's createRegisterEntries), so it does not
-- survive a server restart. A transaction's id DOES round-trip through
-- beancount metadata (mapper.ts) and is stable, so it's the only safe
-- durable reference here.
create table reconciliations (
  id                                 uuid primary key default gen_random_uuid(),
  ledger_id                          uuid not null references ledgers(id) on delete cascade,
  account_id                         text not null,
  statement_start_date               date not null,
  statement_ending_date              date not null,
  statement_beginning_balance         numeric(12, 2) not null,
  statement_ending_balance            numeric(12, 2) not null,
  cleared_balance                     numeric(12, 2) not null,
  service_charge_amount               numeric(12, 2),
  service_charge_date                 date,
  service_charge_expense_account_id   text,
  service_charge_transaction_id       text,
  interest_earned_amount              numeric(12, 2),
  interest_earned_date                date,
  interest_earned_income_account_id   text,
  interest_earned_transaction_id      text,
  completed_at                        timestamptz not null default now(),
  created_by                          text,
  created_at                          timestamptz not null default now()
);

create index reconciliations_ledger_account_idx on reconciliations (ledger_id, account_id, statement_ending_date desc);

create table reconciliation_entries (
  id                    uuid primary key default gen_random_uuid(),
  reconciliation_id     uuid not null references reconciliations(id) on delete cascade,
  transaction_id        text not null,
  account_id            text not null,
  cleared_amount_snapshot numeric(12, 2),
  created_at            timestamptz not null default now(),
  unique (reconciliation_id, transaction_id, account_id)
);

create index reconciliation_entries_reconciliation_id_idx on reconciliation_entries (reconciliation_id);

alter table reconciliations enable row level security;
alter table reconciliation_entries enable row level security;
-- No policies: deny-by-default backstop, same rationale as every other
-- ledger-scoped table -- see migration 20260826000000.
