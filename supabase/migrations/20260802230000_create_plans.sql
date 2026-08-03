-- Phase 3: subscription plans (AI_INTEGRATION_PLAN.md Part 5 / Part 8).
--
-- `newgl-api` owns this table (schema AND data -- plans are app data, not
-- AI-domain data). `newgl-ai` reads limits from the request, never from this
-- table directly (Part 1b: "newgl-ai enforces the quota but does not know
-- what a plan is").
--
-- v1 is free-plan-only, so this seeds exactly one row. `tenants.plan_id`
-- has been a bare text column with no referential integrity since Phase 1;
-- this closes that gap now that there's something to point at.

create table plans (
  id                    text primary key,
  name                  text not null,
  monthly_ai_actions    integer not null,
  monthly_token_cap     integer not null,
  signup_bonus_actions  integer not null default 0,
  created_at            timestamptz not null default now()
);

insert into plans (id, name, monthly_ai_actions, monthly_token_cap, signup_bonus_actions)
values ('free', 'Free', 200, 500000, 500);

alter table tenants
  add constraint tenants_plan_id_fkey
  foreign key (plan_id) references plans (id);

alter table plans enable row level security;
-- No policies: plans are not tenant-scoped and are only ever read by
-- newgl-api's service_role connection.
