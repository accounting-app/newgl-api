-- Phase 3: AI usage metering (AI_INTEGRATION_PLAN.md Part 8).
--
-- Schema lives here per Part 1; only `newgl-ai` writes rows. `key_source` is
-- essential (per the plan) -- it's how platform spend is separated from
-- BYOK spend that costs this product nothing.

create table ai_usage (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references tenants (id) on delete cascade,
  feature                text not null,
  model                  text not null,
  key_source             text not null check (key_source in ('platform', 'byok')),
  actions                integer not null default 0,
  input_tokens           integer not null default 0,
  output_tokens          integer not null default 0,
  cache_read_tokens      integer not null default 0,
  cache_creation_tokens  integer not null default 0,
  cost_usd               numeric(10, 6) not null default 0,
  created_at             timestamptz not null default now()
);

create index ai_usage_tenant_created_idx on ai_usage (tenant_id, created_at desc);

alter table ai_usage enable row level security;
-- No policies: deny-by-default backstop, same rationale as every other
-- tenant-scoped table -- see migration 20260802210000.
