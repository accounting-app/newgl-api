-- Phase 5: payee normalization + learned rules (AI_INTEGRATION_PLAN.md Part 7, #2).
--
-- Schema lives here per Part 1's "schema ownership vs. data ownership" split,
-- but only `newgl-ai`'s service_role connection ever reads or writes rows.
--
-- This is the table that makes Phase 6 (categorization) cheap: the cascade
-- described in Part 7 ("exact match on normalized payee -> no API call")
-- checks this table before ever calling Anthropic. `account_id` starts out
-- null (pure display normalization) and gets filled in once a user confirms
-- a categorization, which is what `POST /internal/ai/rules/learn` writes.
--
-- One row per (tenant, normalized_payee) -- normalization is deterministic
-- and computed in newgl-ai (see src/shared/payee-normalization.ts), never
-- stored redundantly per raw payee string.

create table payee_rules (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants (id) on delete cascade,
  normalized_payee  text not null,
  canonical_payee   text not null,
  -- References an account in the tenant's ledger (a Beancount account name,
  -- e.g. "Expenses:Food:Coffee"), not a newgl-api table row -- accounts live
  -- in the .bean content, not in Postgres. Filled in by Phase 6 confirmations.
  account_id        text,
  source            text not null check (source in ('ai', 'user')),
  confirmed_count   integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, normalized_payee)
);

create index payee_rules_tenant_idx on payee_rules (tenant_id);

alter table payee_rules enable row level security;
-- No policies: deny-by-default backstop, same rationale as every other
-- tenant-scoped table -- see migration 20260802210000.
