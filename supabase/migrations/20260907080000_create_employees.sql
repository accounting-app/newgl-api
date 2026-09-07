-- Phase 1.5, Step 9 (final step) of
-- newgl-specs/plans/qbo-free-features/QBO_FREE_FEATURES_PLAN.md: Employees,
-- a plain roster/directory -- name, job title, contact info, hire date.
-- No pay rate, no paychecks, nothing payroll-shaped, since there's no
-- Payroll behind this (out of scope). No ledger impact, no FKs to
-- anything else -- simplest domain in the whole phase, same shape as
-- vendors/mileage_entries minus any cross-table reference.
create table employees (
  id          uuid primary key default gen_random_uuid(),
  ledger_id   uuid not null references ledgers(id) on delete cascade,
  name        text not null,
  job_title   text,
  email       text,
  phone       text,
  hire_date   date,
  status      text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index employees_ledger_id_idx on employees (ledger_id);

alter table employees enable row level security;
-- No policies: deny-by-default backstop, same rationale as every other
-- ledger-scoped table -- see migration 20260826000000.
