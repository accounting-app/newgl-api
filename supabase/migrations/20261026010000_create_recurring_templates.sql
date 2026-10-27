-- Recurring transactions (QBO's "Make recurring"). A template is a saved
-- transaction form plus a schedule. Modes: SCHEDULED posts itself on the
-- due date (catch-up run, see src/http/routes/recurring-templates.ts),
-- REMINDER only shows as due, UNSCHEDULED is a saved template with no dates.
--
-- `payload` is what the ledger needs to post the transaction (the same
-- shape as createTransaction's input minus the date); `form_state` is the
-- front end's own copy of the form, so "Use"/"Edit" can refill it. Both are
-- opaque jsonb here -- accounts live in the ledger store, not Postgres, so
-- there are no foreign keys inside them.
create table recurring_templates (
  id               uuid primary key default gen_random_uuid(),
  ledger_id        uuid not null references ledgers(id) on delete cascade,
  name             text not null,
  kind             text not null check (kind in ('EXPENSE', 'CHECK', 'DEPOSIT', 'SALES_RECEIPT', 'JOURNAL_ENTRY')),
  mode             text not null check (mode in ('SCHEDULED', 'REMINDER', 'UNSCHEDULED')),
  days_in_advance  integer not null default 0 check (days_in_advance >= 0),
  interval_unit    text check (interval_unit in ('DAY', 'WEEK', 'MONTH', 'YEAR')),
  interval_every   integer check (interval_every >= 1),
  on_day           integer check (on_day between -1 and 31),
  on_weekday       integer check (on_weekday between 0 and 6),
  on_month         integer check (on_month between 1 and 12),
  start_date       date,
  end_type         text not null default 'NONE' check (end_type in ('NONE', 'BY', 'AFTER')),
  end_date         date,
  end_after        integer check (end_after >= 1),
  occurrences      integer not null default 0,
  next_date        date,
  last_run         date,
  last_error       text,
  enabled          boolean not null default true,
  payload          jsonb not null,
  form_state       jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index recurring_templates_ledger_id_idx on recurring_templates (ledger_id);
create index recurring_templates_due_idx on recurring_templates (ledger_id, next_date) where enabled;

alter table recurring_templates enable row level security;
-- No policies: deny-by-default backstop, same rationale as every other
-- ledger-scoped table -- see migration 20260826000000.
