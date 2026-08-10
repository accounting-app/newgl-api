-- Phase A (multi-company support, see newgl-specs/INSTANCE_ARCHITECTURE_PLAN.md):
-- each user can now have more than one company (ledger) under their tenant.
-- Storing "which one is active" on the membership row -- not the tenant --
-- because it's a per-user preference: in the future multi-user-per-instance
-- world, two members of the same tenant may be looking at different
-- companies at the same time.
--
-- Null means "no explicit choice yet -- fall back to the tenant's primary
-- ledger" (ledgers.is_primary = true). Intentionally no foreign key to
-- ledgers(name) -- names aren't globally unique, only unique per tenant,
-- and the app already validates the switch target belongs to the caller's
-- tenant before writing this column.
alter table memberships
  add column active_ledger_name text;
