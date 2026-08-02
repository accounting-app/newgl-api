-- Phase 0: store .bean ledger content in Postgres instead of on the filesystem.
--
-- tenant_id is nullable and carries no foreign key yet -- the `tenants` table
-- doesn't exist until Phase 1. A single row with tenant_id = null represents
-- today's single-company deployment. Phase 1 adds:
--   alter table ledgers add constraint ledgers_tenant_id_fkey
--     foreign key (tenant_id) references tenants(id);
-- and back-fills tenant_id for this row.

create table ledgers (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid,
  name          text not null default 'company',
  is_primary    boolean not null default true,
  content       text not null,
  content_hash  text not null,
  version       integer not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- One ledger per (tenant, name). Coalesce so the single tenant-less row
-- (tenant_id is null, pre-Phase-1) still enforces uniqueness on `name`.
create unique index ledgers_tenant_name_key
  on ledgers (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), name);

create table ledger_versions (
  id            uuid primary key default gen_random_uuid(),
  ledger_id     uuid not null references ledgers(id) on delete cascade,
  version       integer not null,
  content       text not null,
  content_hash  text not null,
  source        text not null check (source in ('app', 'upload', 'bootstrap')),
  created_by    uuid,
  created_at    timestamptz not null default now(),
  unique (ledger_id, version)
);

create index ledger_versions_ledger_id_idx on ledger_versions (ledger_id, version desc);

alter table ledgers enable row level security;
alter table ledger_versions enable row level security;

-- No policies yet: newgl-api connects with the service_role key, which
-- bypasses RLS by design. RLS is enabled now as a deny-by-default backstop --
-- see AI_INTEGRATION_PLAN.md Part 3 -- so a future leaked anon key exposes
-- nothing until policies are deliberately added.
