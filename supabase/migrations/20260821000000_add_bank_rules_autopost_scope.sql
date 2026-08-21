-- Bank rule auto-post + direction/account scope (PLAINGL gap analysis,
-- Phase 3 items #7/#8): PlainGL rules can carry an auto-post flag and scope
-- by money-in/money-out direction and by a specific source account; ours
-- previously only matched on payee/memo/amount and always required manual
-- review before posting.
--
-- `scoped_account_id` is text, not a foreign key, for the same reason
-- target_account_id is (see 20260812120000): accounts live in ledger .bean
-- content, not a Postgres table. Null means "applies to every account" --
-- the common case, so no scoping row is needed for most rules.
alter table bank_rules
  add column auto_post boolean not null default false,
  add column direction text not null default 'ANY',
  add column scoped_account_id text;

alter table bank_rules
  add constraint bank_rules_direction_check check (direction in ('ANY', 'INFLOW', 'OUTFLOW'));
