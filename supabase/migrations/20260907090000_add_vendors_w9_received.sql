-- W-9 status tracking (Expenses & Bills ▸ 1099s ▸ Recipients & W-9s):
-- whether a 1099 contractor's W-9 has actually been collected, matching
-- QBO's own "W-9 status" column on that screen. Real tracking data, not
-- e-filing -- this app still doesn't submit anything to the IRS, see
-- QBO_FREE_FEATURES_PLAN.md's explicit 1099s scope.
alter table vendors add column w9_received boolean not null default false;
