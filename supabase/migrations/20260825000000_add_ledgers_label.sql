-- Ledger settings page redesign: the page becomes a file manager listing
-- every ledger (company) the tenant has, and users want a friendly display
-- name distinct from `name` (the internal/unique identifier used in every
-- URL and the company-switcher). Null means "no label set yet" -- callers
-- fall back to displaying `name` in that case, same null-fallback pattern
-- memberships.active_ledger_name already uses.
alter table ledgers
  add column label text;
