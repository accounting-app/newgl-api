-- Bank feed exclude memory (PLAINGL_FEATURES_TO_IMPLEMENT.md #11): lets a user
-- permanently exclude a recurring row pattern (e.g. a bank fee they never
-- want imported) so it stops showing up pre-checked on every future CSV
-- import. Matched on payee + amount only (no date), since the whole point is
-- catching the *same* recurring row across different statement periods --
-- unlike duplicate-import detection (date + payee + amount), which is
-- computed on the fly from existing POSTED transactions and needs no table.
--
-- `main_account_id` is text, not a foreign key, for the same reason
-- bank_rules.target_account_id is: accounts live in ledger .bean content,
-- not a Postgres table.
create table excluded_feed_rows (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants (id) on delete cascade,
  main_account_id  text not null,
  payee            text not null,
  amount           numeric not null,
  created_at       timestamptz not null default now()
);

create index excluded_feed_rows_tenant_idx on excluded_feed_rows (tenant_id, main_account_id);

alter table excluded_feed_rows enable row level security;
-- No policies: deny-by-default backstop, same rationale as every other
-- tenant-scoped table -- see migration 20260802210000.
