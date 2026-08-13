-- Deterministic bank rules (PLAINGL_FEATURES_TO_IMPLEMENT.md #7): user-authored
-- conditional rules ("anything from Amazon over $500 -> Equipment"), independent
-- of and complementary to AI-suggested categorization and the learned payee_rules
-- memory (20260802260000). Precedence: AI (and the learned-payee memory it
-- checks first) wins when both suggest an account for a row; a matching bank
-- rule is always surfaced in the UI so the user can override to it instead.
--
-- `conditions` is jsonb rather than a child table -- every condition shares
-- the same {field, operator, value, valueTo?} shape, and a fixed variable-arity
-- list serializes more simply than joining/ordering a child table for what's
-- always read and written as one unit (there's no per-condition querying need).
--
-- `target_account_id` is text, not a foreign key, for the same reason
-- payee_rules.account_id is: accounts live in ledger .bean content, not a
-- Postgres table. Callers must validate against the live chart of accounts
-- at match time (a renamed/archived account should fail open, same pattern
-- as the payee_rules cascade).
create table bank_rules (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants (id) on delete cascade,
  name               text not null,
  target_account_id  text not null,
  conditions         jsonb not null,
  enabled            boolean not null default true,
  priority           integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index bank_rules_tenant_idx on bank_rules (tenant_id);

alter table bank_rules enable row level security;
-- No policies: deny-by-default backstop, same rationale as every other
-- tenant-scoped table -- see migration 20260802210000.
