import { createRoute, z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { LEDGER_NAME } from "@/configuration";
import { errorResponseSchema } from "@/domain/models";
import { getTenantId, getUserEmail, getUserId } from "@/http/context";
import { defaultDocument, serializeBeancount } from "@/infra/beancount/parser";
import { getSql } from "@/infra/postgres/client";
import { sha256 } from "@/shared/utils/hash";

const tenantSchema = zod.object({
  id: zod.string().uuid(),
  name: zod.string(),
  planId: zod.string()
});

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
      select t.id, t.name, t.plan_id
      from memberships m
      join tenants t on t.id = m.tenant_id
      where m.user_id = ${userId}
      limit 1
    `;
    if (existing.length > 0) {
      const row = existing[0] as { id: string; name: string; plan_id: string };
      return context.json({ id: row.id, name: row.name, planId: row.plan_id }, 200);
    }

    const email = getUserEmail(context);
    const tenantName = email ? `${email.split("@")[0]}'s Company` : "My Company";
    const content = serializeBeancount(defaultDocument(tenantName));
    const hash = await sha256(content);

    const tenant = await sql.begin(async (tx) => {
      const [createdTenant] = await tx`
        insert into tenants (name, plan_id)
        values (${tenantName}, 'free')
        returning id, name, plan_id
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

      return createdTenant as { id: string; name: string; plan_id: string };
    });

    return context.json({ id: tenant.id, name: tenant.name, planId: tenant.plan_id }, 200);
  });

  // Unlike bootstrap, this goes through the normal tenantContext middleware
  // (not AUTH_ONLY_PATHS) -- by the time this handler runs, tenantId is
  // already resolved from an existing membership, so this is a plain lookup,
  // not a repeat of bootstrap's create-if-missing logic.
  app.openapi(meRoute, async (context) => {
    const tenantId = getTenantId(context);
    const sql = getSql();

    const rows = await sql`
      select id, name, plan_id from tenants where id = ${tenantId} limit 1
    `;
    if (rows.length === 0) {
      return context.json({ error: "No tenant found for this session" }, 404);
    }
    const row = rows[0] as { id: string; name: string; plan_id: string };
    return context.json({ id: row.id, name: row.name, planId: row.plan_id }, 200);
  });
}
