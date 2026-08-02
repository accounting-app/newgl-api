-- Phase 2: version history + restore (AI_INTEGRATION_PLAN.md Part 6).
--
-- Restoring a previous version writes a *new* ledger_versions row rather
-- than rewinding in place, so the history stays append-only and honest --
-- "restore to v3" is itself an auditable event, not a deletion of v4..vN.
-- That needs its own `source` value distinct from 'app' | 'upload'.

alter table ledger_versions drop constraint ledger_versions_source_check;
alter table ledger_versions
  add constraint ledger_versions_source_check
  check (source in ('app', 'upload', 'bootstrap', 'restore'));
