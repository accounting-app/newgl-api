-- Completing the onboarding wizard now also sets the primary ledger's
-- `label` to the company name entered there (see tenants.ts). Backfill the
-- same for tenants that finished onboarding before that change, so their
-- primary ledger stops displaying the internal name ("company"). Only
-- touches ledgers without a label, so a label a user already chose on the
-- Ledger settings page is kept.
update ledgers l
set label = t.name, updated_at = now()
from tenants t
where l.tenant_id = t.id
  and l.is_primary
  and l.label is null
  and t.onboarding_completed_at is not null;
