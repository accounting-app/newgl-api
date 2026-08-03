-- Phase 3: BYOK Anthropic credentials (AI_INTEGRATION_PLAN.md Part 4).
--
-- Schema lives here per Part 1's "schema ownership vs. data ownership" split,
-- but only `newgl-ai`'s service_role connection ever reads or writes rows --
-- `newgl-api` never sees a plaintext key, only masked status via `newgl-ai`.
--
-- One BYOK key per tenant in v1 (unique tenant_id). The key itself is never
-- stored in plaintext: `ciphertext`/`iv`/`auth_tag` are the AES-256-GCM
-- output, decrypted only in-process inside newgl-ai when a request needs it.

create table ai_credentials (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null unique references tenants (id) on delete cascade,
  ciphertext      text not null,
  iv              text not null,
  auth_tag        text not null,
  key_version     integer not null default 1,
  last_four       text not null,
  model_override  text,
  validated_at    timestamptz not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table ai_credentials enable row level security;
-- No policies: deny-by-default backstop, same rationale as every other
-- tenant-scoped table -- see migration 20260802210000.
