-- Onboarding wizard (issue #29): a handful of company-level facts we don't
-- have today -- bootstrap only ever auto-names the tenant "<email>'s
-- Company" with nothing else captured. One company = one tenant already,
-- so these live directly on `tenants` rather than a new table.
-- `onboarding_completed_at` is the single source of truth the frontend
-- gates on: null means the wizard hasn't been completed yet.
alter table tenants
  add column industry text,
  add column company_size text,
  add column country text,
  add column base_currency text not null default 'USD',
  add column onboarding_completed_at timestamptz;
