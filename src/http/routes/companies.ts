import { createRoute, z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { errorResponseSchema } from "@/domain/models";
import { defaultDocument, serializeBeancount } from "@/infra/beancount/parser";
import { getLedgerName, getTenantId, getUserId } from "@/http/context";
import { getSql } from "@/infra/postgres/client";
import { sha256 } from "@/shared/utils/hash";

const companyNameParam = zod.object({ name: zod.string().min(1) });

const createCompanyInputSchema = zod.object({
  name: zod.string().trim().min(1).max(100)
});

const companySchema = zod.object({
  name: zod.string(),
  isPrimary: zod.boolean(),
  isActive: zod.boolean(),
  updatedAt: zod.string()
});

const listCompaniesRoute = createRoute({
  method: "get",
  path: "/api/companies",
  responses: {
    200: {
      content: { "application/json": { schema: zod.array(companySchema) } },
      description: "Every company (ledger) under the caller's tenant, primary first"
    }
  }
});

const createCompanyRoute = createRoute({
  method: "post",
  path: "/api/companies",
  request: {
    body: { content: { "application/json": { schema: createCompanyInputSchema } }, required: true }
  },
  responses: {
    200: {
      content: { "application/json": { schema: companySchema } },
      description: "The newly created blank company"
    },
    409: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "A company with that name already exists for this tenant"
    }
  }
});

const switchCompanyRoute = createRoute({
  method: "post",
  path: "/api/companies/{name}/switch",
  request: { params: companyNameParam },
  responses: {
    200: {
      content: { "application/json": { schema: companySchema } },
      description: "The now-active company"
    },
    404: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "No company with that name for this tenant"
    }
  }
});

/**
 * Phase A (multi-company support) -- see newgl-specs/INSTANCE_ARCHITECTURE_PLAN.md.
 * "Active company" is a per-user preference stored on the membership row,
 * not a request parameter -- every other route (accounts, transactions,
 * register, reports) is unchanged and keeps reading whatever
 * tenantContext resolved onto context.ledgerName. Only these three routes
 * know about switching.
 */
export function companyRoutes(app: OpenAPIHono): void {
  app.openapi(listCompaniesRoute, async (context) => {
    const tenantId = getTenantId(context);
    const activeLedgerName = getLedgerName(context);
    const sql = getSql();

    const rows = await sql`
      select name, is_primary, updated_at
      from ledgers
      where tenant_id = ${tenantId}
      order by is_primary desc, name asc
    `;

    return context.json(
      rows.map((row: unknown) => {
        const typedRow = row as { name: string; is_primary: boolean; updated_at: Date };
        return {
          name: typedRow.name,
          isPrimary: typedRow.is_primary,
          isActive: typedRow.name === activeLedgerName,
          updatedAt: typedRow.updated_at.toISOString()
        };
      }),
      200
    );
  });

  app.openapi(createCompanyRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { name } = context.req.valid("json");
    const sql = getSql();

    const existing = await sql`
      select id from ledgers where tenant_id = ${tenantId} and name = ${name} limit 1
    `;
    if (existing.length > 0) {
      return context.json({ error: `A company named '${name}' already exists` }, 409);
    }

    const content = serializeBeancount(defaultDocument(name));
    const hash = await sha256(content);

    await sql.begin(async (tx) => {
      const [ledger] = await tx`
        insert into ledgers (tenant_id, name, is_primary, content, content_hash, version)
        values (${tenantId}, ${name}, false, ${content}, ${hash}, 1)
        returning id
      `;
      await tx`
        insert into ledger_versions (ledger_id, version, content, content_hash, source)
        values (${ledger.id}, 1, ${content}, ${hash}, 'bootstrap')
      `;
    });

    return context.json({ name, isPrimary: false, isActive: false, updatedAt: new Date().toISOString() }, 200);
  });

  app.openapi(switchCompanyRoute, async (context) => {
    const tenantId = getTenantId(context);
    const userId = getUserId(context);
    const { name } = context.req.valid("param");
    const sql = getSql();

    const rows = await sql`
      select name, is_primary, updated_at from ledgers
      where tenant_id = ${tenantId} and name = ${name}
      limit 1
    `;
    if (rows.length === 0) {
      return context.json({ error: `No company named '${name}' for this tenant` }, 404);
    }
    const row = rows[0] as { name: string; is_primary: boolean; updated_at: Date };

    await sql`
      update memberships set active_ledger_name = ${name}
      where user_id = ${userId} and tenant_id = ${tenantId}
    `;

    return context.json(
      { name: row.name, isPrimary: row.is_primary, isActive: true, updatedAt: row.updated_at.toISOString() },
      200
    );
  });
}
