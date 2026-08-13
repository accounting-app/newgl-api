import { createRoute, z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import type { Account, LedgerStore } from "@/domain/models";
import { errorResponseSchema } from "@/domain/models";
import { COMPANY_TEMPLATES, findCompanyTemplate } from "@/domain/company-templates";
import { defaultDocument, parseBeancount, serializeBeancount } from "@/infra/beancount/parser";
import { documentToStore, storeToDocument } from "@/infra/beancount/mapper";
import { getLedgerName, getTenantId, getUserId } from "@/http/context";
import { getSql } from "@/infra/postgres/client";
import { sha256 } from "@/shared/utils/hash";
import { createId } from "@/shared/utils/id";
import { nowIso } from "@/shared/utils/date";

const companyNameParam = zod.object({ name: zod.string().min(1) });

const createCompanyInputSchema = zod.object({
  name: zod.string().trim().min(1).max(100),
  // At most one of these -- omitting both creates a blank company (the
  // existing behavior). Mutually exclusive, validated in the handler since
  // zod's object schema doesn't express "at most one of" cleanly here.
  templateId: zod.string().optional(),
  duplicateFromName: zod.string().optional()
});

const companyTemplateSchema = zod.object({
  id: zod.string(),
  label: zod.string(),
  description: zod.string()
});

const listCompanyTemplatesRoute = createRoute({
  method: "get",
  path: "/api/company-templates",
  responses: {
    200: {
      content: { "application/json": { schema: zod.array(companyTemplateSchema) } },
      description: "Starter chart-of-accounts templates available for new companies"
    }
  }
});

function preambleFor(name: string): string[] {
  return [
    ";; -*- mode: beancount; -*-",
    `option "title" "${name}"`,
    'option "operating_currency" "USD"',
    "",
    "2024-01-01 commodity USD",
    '  name: "US Dollar"'
  ];
}

function emptyStore(accounts: Account[]): LedgerStore {
  return { accounts, chartAccounts: [], transactions: [], ledgerPostings: [], registerEntries: [] };
}

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
      description: "The newly created company"
    },
    400: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "Invalid template id, or both templateId and duplicateFromName given"
    },
    404: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "No company with that name to duplicate from"
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
  app.openapi(listCompanyTemplatesRoute, async (context) => {
    return context.json(
      COMPANY_TEMPLATES.map((template) => ({ id: template.id, label: template.label, description: template.description })),
      200
    );
  });

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
    const { name, templateId, duplicateFromName } = context.req.valid("json");
    const sql = getSql();

    if (templateId && duplicateFromName) {
      return context.json({ error: "Choose either a template or a company to duplicate, not both." }, 400);
    }

    const existing = await sql`
      select id from ledgers where tenant_id = ${tenantId} and name = ${name} limit 1
    `;
    if (existing.length > 0) {
      return context.json({ error: `A company named '${name}' already exists` }, 409);
    }

    let content: string;
    if (templateId) {
      const template = findCompanyTemplate(templateId);
      if (!template) {
        return context.json({ error: `Unknown template '${templateId}'` }, 400);
      }
      const createdAt = nowIso();
      const accounts: Account[] = template.accounts.map((preset) => ({
        id: createId(),
        code: preset.code,
        name: preset.name,
        category: preset.category,
        currency: "USD",
        openingBalance: 0,
        currentBalance: 0,
        allowManualEntries: true,
        status: "ACTIVE",
        createdAt
      }));
      content = serializeBeancount({ ...storeToDocument(emptyStore(accounts)), preamble: preambleFor(name) });
    } else if (duplicateFromName) {
      const sourceRows = await sql`
        select content from ledgers where tenant_id = ${tenantId} and name = ${duplicateFromName} limit 1
      `;
      if (sourceRows.length === 0) {
        return context.json({ error: `No company named '${duplicateFromName}' to duplicate from` }, 404);
      }
      const sourceStore = documentToStore(parseBeancount((sourceRows[0] as { content: string }).content));
      const createdAt = nowIso();
      // Structure only -- fresh ids and zeroed balances, no transactions
      // carried over (PLAINGL_FEATURES_TO_IMPLEMENT.md #13: "duplicate
      // chart of accounts, not transactions/balances").
      const accounts: Account[] = sourceStore.accounts
        .filter((account) => account.status !== "CLOSED")
        .map((account) => ({
          ...account,
          id: createId(),
          openingBalance: 0,
          currentBalance: 0,
          status: "ACTIVE",
          createdAt,
          updatedAt: undefined,
          archivedAt: undefined
        }));
      content = serializeBeancount({ ...storeToDocument(emptyStore(accounts)), preamble: preambleFor(name) });
    } else {
      content = serializeBeancount(defaultDocument(name));
    }

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
