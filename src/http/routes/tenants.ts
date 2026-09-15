import { createRoute, z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { LEDGER_FILE, LEDGER_NAME } from "@/configuration";
import { errorResponseSchema } from "@/domain/models";
import { getTenantId, getUserEmail, getUserId } from "@/http/context";
import { defaultDocument, serializeBeancount, starterDocument } from "@/infra/beancount/parser";
import { getSql } from "@/infra/postgres/client";
import { sha256 } from "@/shared/utils/hash";

// AI_INTEGRATION_PLAN.md Part 3: "reuse whatever seeds data/company.bean
// today" for every new tenant's starter ledger -- an empty ledger leaves
// both the register and AI categorization unusable on day one. Every new
// tenant gets the same sample chart of accounts *and* sample transactions,
// not just an empty chart of accounts -- there needs to be something to
// look at. Falls back to a genuinely empty ledger (prior behavior) only if
// the seed file is ever missing, rather than failing signup outright over a
// starter-data problem.
async function buildBootstrapDocument(tenantName: string) {
  const seedFile = Bun.file(LEDGER_FILE);
  if (await seedFile.exists()) {
    return starterDocument(tenantName, await seedFile.text());
  }
  return defaultDocument(tenantName);
}

const tenantSchema = zod.object({
  id: zod.string().uuid(),
  name: zod.string(),
  planId: zod.string(),
  aiEnabled: zod.boolean(),
  industry: zod.string().nullable(),
  companySize: zod.string().nullable(),
  country: zod.string().nullable(),
  baseCurrency: zod.string(),
  // null until the onboarding wizard (issue #29) has been completed once --
  // the frontend's single source of truth for whether to redirect a
  // signed-in user into /onboarding before anything else.
  onboardingCompletedAt: zod.string().nullable()
});

const setAiEnabledInputSchema = zod.object({
  aiEnabled: zod.boolean()
});

const completeOnboardingInputSchema = zod.object({
  companyName: zod.string().min(1),
  industry: zod.string().min(1).nullable(),
  companySize: zod.string().min(1).nullable(),
  country: zod.string().min(1).nullable(),
  baseCurrency: zod.string().min(1)
});

type TenantRow = {
  id: string;
  name: string;
  plan_id: string;
  ai_enabled: boolean;
  industry: string | null;
  company_size: string | null;
  country: string | null;
  base_currency: string;
  onboarding_completed_at: string | Date | null;
};

function toTenantResponse(row: TenantRow) {
  return {
    id: row.id,
    name: row.name,
    planId: row.plan_id,
    aiEnabled: row.ai_enabled,
    industry: row.industry,
    companySize: row.company_size,
    country: row.country,
    baseCurrency: row.base_currency,
    onboardingCompletedAt: row.onboarding_completed_at ? new Date(row.onboarding_completed_at).toISOString() : null
  };
}

const bootstrapRoute = createRoute({
  method: "post",
  path: "/api/tenants/bootstrap",
  responses: {
    200: {
      content: { "application/json": { schema: tenantSchema } },
      description: "The current user's tenant (created on first call, returned unchanged after)"
    }
  }
});

const meRoute = createRoute({
  method: "get",
  path: "/api/tenants/me",
  responses: {
    200: {
      content: { "application/json": { schema: tenantSchema } },
      description: "The current user's tenant"
    },
    404: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "No tenant for this session -- should not happen after bootstrap has run"
    }
  }
});

const setAiEnabledRoute = createRoute({
  method: "patch",
  path: "/api/tenants/ai-enabled",
  request: {
    body: { content: { "application/json": { schema: setAiEnabledInputSchema } }, required: true }
  },
  responses: {
    200: {
      content: { "application/json": { schema: tenantSchema } },
      description: "The tenant with its AI-enabled flag updated"
    }
  }
});

const completeOnboardingRoute = createRoute({
  method: "patch",
  path: "/api/tenants/onboarding",
  request: {
    body: { content: { "application/json": { schema: completeOnboardingInputSchema } }, required: true }
  },
  responses: {
    200: {
      content: { "application/json": { schema: tenantSchema } },
      description: "The tenant with onboarding fields saved and onboardingCompletedAt set"
    }
  }
});

/**
 * Idempotent: safe to call on every login, not just the first one. If the
 * user already has a membership, returns their existing tenant untouched. If
 * not, creates tenant + membership + a fresh starter ledger in a single
 * transaction -- ledger content lives in Postgres alongside tenant/membership
 * now (Phase 0), so unlike a filesystem-backed ledger this can be truly
 * atomic: either all three rows exist, or none do.
 */
export function tenantRoutes(app: OpenAPIHono): void {
  app.openapi(bootstrapRoute, async (context) => {
    const userId = getUserId(context);
    const sql = getSql();

    const existing = await sql`
      select t.id, t.name, t.plan_id, t.ai_enabled, t.industry, t.company_size, t.country,
             t.base_currency, t.onboarding_completed_at
      from memberships m
      join tenants t on t.id = m.tenant_id
      where m.user_id = ${userId}
      limit 1
    `;
    if (existing.length > 0) {
      return context.json(toTenantResponse(existing[0] as TenantRow), 200);
    }

    const email = getUserEmail(context);
    const tenantName = email ? `${email.split("@")[0]}'s Company` : "My Company";
    const content = serializeBeancount(await buildBootstrapDocument(tenantName));
    const hash = await sha256(content);

    const tenant = await sql.begin(async (tx) => {
      const [createdTenant] = await tx`
        insert into tenants (name, plan_id)
        values (${tenantName}, 'free')
        returning id, name, plan_id, ai_enabled, industry, company_size, country, base_currency, onboarding_completed_at
      `;

      await tx`
        insert into memberships (user_id, tenant_id, role)
        values (${userId}, ${createdTenant.id}, 'owner')
      `;

      const [ledger] = await tx`
        insert into ledgers (tenant_id, name, is_primary, content, content_hash, version)
        values (${createdTenant.id}, ${LEDGER_NAME}, true, ${content}, ${hash}, 1)
        returning id
      `;

      await tx`
        insert into ledger_versions (ledger_id, version, content, content_hash, source)
        values (${ledger.id}, 1, ${content}, ${hash}, 'bootstrap')
      `;

      return createdTenant as TenantRow;
    });

    return context.json(toTenantResponse(tenant), 200);
  });

  // Unlike bootstrap, this goes through the normal tenantContext middleware
  // (not AUTH_ONLY_PATHS) -- by the time this handler runs, tenantId is
  // already resolved from an existing membership, so this is a plain lookup,
  // not a repeat of bootstrap's create-if-missing logic.
  app.openapi(meRoute, async (context) => {
    const tenantId = getTenantId(context);
    const sql = getSql();

    const rows = await sql`
      select id, name, plan_id, ai_enabled, industry, company_size, country, base_currency, onboarding_completed_at
      from tenants where id = ${tenantId} limit 1
    `;
    if (rows.length === 0) {
      return context.json({ error: "No tenant found for this session" }, 404);
    }
    return context.json(toTenantResponse(rows[0] as TenantRow), 200);
  });

  app.openapi(setAiEnabledRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { aiEnabled } = context.req.valid("json");
    const sql = getSql();

    const [row] = await sql`
      update tenants set ai_enabled = ${aiEnabled} where id = ${tenantId}
      returning id, name, plan_id, ai_enabled, industry, company_size, country, base_currency, onboarding_completed_at
    `;
    return context.json(toTenantResponse(row as TenantRow), 200);
  });

  // The onboarding wizard's final "Finish" step -- always a full submit of
  // every field on that step, not a partial patch, so a plain UPDATE (same
  // idiom as vendors.ts/bills.ts) is enough; no COALESCE-style optional-field
  // handling needed. Setting onboarding_completed_at here is what flips
  // TenantProvider's gate off for this tenant from now on.
  app.openapi(completeOnboardingRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { companyName, industry, companySize, country, baseCurrency } = context.req.valid("json");
    const sql = getSql();

    const [row] = await sql`
      update tenants set
        name = ${companyName},
        industry = ${industry},
        company_size = ${companySize},
        country = ${country},
        base_currency = ${baseCurrency},
        onboarding_completed_at = now(),
        updated_at = now()
      where id = ${tenantId}
      returning id, name, plan_id, ai_enabled, industry, company_size, country, base_currency, onboarding_completed_at
    `;
    return context.json(toTenantResponse(row as TenantRow), 200);
  });
}
