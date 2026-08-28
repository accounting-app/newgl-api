-- Ledger settings page redesign v2: a company can have multiple .bean
-- files, not just its own single primary content. ledgers.content stays
-- exactly as-is -- still the one thing register/reports/accounts read --
-- these are EXTRA files scoped to one company (payroll notes, draft
-- imports, reference documents), listed alongside the company's own file
-- in the Ledger settings page but never fed into the live accounting
-- engine. Mirrors ledgers/ledger_versions' shape closely on purpose, since
-- the API surface (download/upload/versions/restore) is the same idea one
-- level down.
create table ledger_files (
  id            uuid primary key default gen_random_uuid(),
  ledger_id     uuid not null references ledgers(id) on delete cascade,
  name          text not null,
  label         text,
  content       text not null,
  content_hash  text not null,
  version       integer not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- One file per (ledger, name) -- same per-scope uniqueness ledgers itself
-- enforces per (tenant, name).
create unique index ledger_files_ledger_name_key on ledger_files (ledger_id, name);
create index ledger_files_ledger_id_idx on ledger_files (ledger_id);

create table ledger_file_versions (
  id              uuid primary key default gen_random_uuid(),
  ledger_file_id  uuid not null references ledger_files(id) on delete cascade,
  version         integer not null,
  content         text not null,
  content_hash    text not null,
  source          text not null check (source in ('upload', 'bootstrap', 'restore')),
  created_by      uuid,
  created_at      timestamptz not null default now(),
  unique (ledger_file_id, version)
);

create index ledger_file_versions_file_id_idx on ledger_file_versions (ledger_file_id, version desc);

alter table ledger_files enable row level security;
alter table ledger_file_versions enable row level security;
-- No policies: deny-by-default backstop, same rationale as every other
-- tenant-scoped table -- see migration 20260802210000.
