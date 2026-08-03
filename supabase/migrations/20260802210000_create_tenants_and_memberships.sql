-- Phase 1: tenants and memberships, plus the FK on ledgers.tenant_id that
-- Phase 0 deliberately left off (tenants didn't exist yet).
--
-- Scope note: this does NOT backfill tenant_id on the existing tenant-less
-- 'company' ledger row seeded in Phase 0 -- that row is local dev data.
-- Real tenants get their own fresh ledger via POST /api/tenants/bootstrap.

create table tenants (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  auth_provider_org_id  text,
  plan_id               text not null default 'free',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

alter table tenants enable row level security;

create table memberships (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  tenant_id   uuid not null references tenants (id) on delete cascade,
  role        text not null default 'owner' check (role in ('owner', 'member')),
  created_at  timestamptz not null default now(),
  unique (user_id, tenant_id)
);

create index memberships_user_id_idx on memberships (user_id);
create index memberships_tenant_id_idx on memberships (tenant_id);

alter table memberships enable row level security;

-- Now that tenants exists, close the gap Phase 0 left open.
alter table ledgers
  add constraint ledgers_tenant_id_fkey
  foreign key (tenant_id) references tenants (id) on delete cascade;

-- No RLS policies yet: newgl-api connects with the service_role key, which
-- bypasses RLS by design. Enabled here as a deny-by-default backstop -- see
-- AI_INTEGRATION_PLAN.md Part 3 -- so a leaked anon key exposes nothing
-- until policies are deliberately added.
