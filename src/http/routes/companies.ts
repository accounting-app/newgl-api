import { createRoute, z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import type { Account, LedgerStore } from "@/domain/models";
import { errorResponseSchema } from "@/domain/models";
import { COMPANY_TEMPLATES, findCompanyTemplate } from "@/domain/company-templates";
import {
  defaultDocument,
  isPlausibleBeancountDocument,
  parseBeancount,
  serializeBeancount
} from "@/infra/beancount/parser";
import { documentToStore, storeToDocument } from "@/infra/beancount/mapper";
import { getLedgerName, getTenantId, getUserId } from "@/http/context";
import { getSql } from "@/infra/postgres/client";
import { sha256 } from "@/shared/utils/hash";
import { createId } from "@/shared/utils/id";
import { nowIso } from "@/shared/utils/date";

const companyNameParam = zod.object({ name: zod.string().min(1) });

const createCompanyInputSchema = zod.object({
  name: zod.string().trim().min(1).max(100),
  // Optional friendly display name, distinct from `name` -- shown in the
  // Ledger settings page's file list. Null/omitted falls back to `name`.
  label: zod.string().trim().min(1).max(200).optional(),
  // At most one of these three -- omitting all three creates a blank
  // company (the existing behavior). Mutually exclusive, validated in the
  // handler since zod's object schema doesn't express "at most one of"
  // cleanly here. `content` is the "upload a .bean file as a new file"
  // path -- raw text, validated the same way ledger upload validates it.
  templateId: zod.string().optional(),
  duplicateFromName: zod.string().optional(),
  content: zod.string().optional()
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
  label: zod.string().optional(),
  isPrimary: zod.boolean(),
  isActive: zod.boolean(),
  updatedAt: zod.string()
});

const updateCompanyInputSchema = zod.object({
  label: zod.string().trim().min(1).max(200).nullable()
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
      description: "Invalid template id, more than one of templateId/duplicateFromName/content given, or content that doesn't parse as valid Beancount"
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

const updateCompanyRoute = createRoute({
  method: "patch",
  path: "/api/companies/{name}",
  request: {
    params: companyNameParam,
    body: { content: { "application/json": { schema: updateCompanyInputSchema } }, required: true }
  },
  responses: {
    200: { content: { "application/json": { schema: companySchema } }, description: "The updated company" },
    404: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "No company with that name for this tenant"
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

const deleteCompanyRoute = createRoute({
  method: "delete",
  path: "/api/companies/{name}",
  request: { params: companyNameParam },
  responses: {
    204: { description: "Company deleted" },
    404: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "No company with that name for this tenant"
    },
    409: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "Cannot delete the tenant's primary company"
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
      select name, label, is_primary, updated_at
      from ledgers
      where tenant_id = ${tenantId}
      order by is_primary desc, name asc
    `;

    return context.json(
      rows.map((row: unknown) => {
        const typedRow = row as { name: string; label: string | null; is_primary: boolean; updated_at: Date };
        return {
          name: typedRow.name,
          label: typedRow.label ?? undefined,
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
    const { name, label, templateId, duplicateFromName, content: uploadedContent } = context.req.valid("json");
    const sql = getSql();

    const modesGiven = [templateId, duplicateFromName, uploadedContent].filter((v) => v !== undefined).length;
    if (modesGiven > 1) {
      return context.json(
        { error: "Choose at most one of a template, a company to duplicate, or uploaded content." },
        400
      );
    }

    const existing = await sql`
      select id from ledgers where tenant_id = ${tenantId} and name = ${name} limit 1
    `;
    if (existing.length > 0) {
      return context.json({ error: `A company named '${name}' already exists` }, 409);
    }

    let content: string;
    if (uploadedContent !== undefined) {
      // Same validation the ledger upload endpoint runs -- a malformed
      // upload must never become a new company's source of truth. See
      // ledgers.ts's own comment on parseBeancount's leniency for why
      // isPlausibleBeancountDocument is a required second check.
      const parsed = parseBeancount(uploadedContent);
      if (!isPlausibleBeancountDocument(uploadedContent, parsed)) {
        return context.json({ error: "That file doesn't look like a valid Beancount ledger." }, 400);
      }
      content = uploadedContent;
    } else if (templateId) {
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
        insert into ledgers (tenant_id, name, label, is_primary, content, content_hash, version)
        values (${tenantId}, ${name}, ${label ?? null}, false, ${content}, ${hash}, 1)
        returning id
      `;
      await tx`
        insert into ledger_versions (ledger_id, version, content, content_hash, source)
        values (${ledger.id}, 1, ${content}, ${hash}, ${uploadedContent !== undefined ? "upload" : "bootstrap"})
      `;
    });

    return context.json({ name, label, isPrimary: false, isActive: false, updatedAt: new Date().toISOString() }, 200);
  });

  app.openapi(updateCompanyRoute, async (context) => {
    const tenantId = getTenantId(context);
    const activeLedgerName = getLedgerName(context);
    const { name } = context.req.valid("param");
    const { label } = context.req.valid("json");
    const sql = getSql();

    const rows = await sql`
      update ledgers set label = ${label}, updated_at = now()
      where tenant_id = ${tenantId} and name = ${name}
      returning name, label, is_primary, updated_at
    `;
    if (rows.length === 0) {
      return context.json({ error: `No company named '${name}' for this tenant` }, 404);
    }
    const row = rows[0] as { name: string; label: string | null; is_primary: boolean; updated_at: Date };

    return context.json(
      {
        name: row.name,
        label: row.label ?? undefined,
        isPrimary: row.is_primary,
        isActive: row.name === activeLedgerName,
        updatedAt: row.updated_at.toISOString()
      },
      200
    );
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

  app.openapi(deleteCompanyRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { name } = context.req.valid("param");
    const sql = getSql();

    const rows = await sql`
      select id, is_primary from ledgers where tenant_id = ${tenantId} and name = ${name} limit 1
    `;
    if (rows.length === 0) {
      return context.json({ error: `No company named '${name}' for this tenant` }, 404);
    }
    const row = rows[0] as { id: string; is_primary: boolean };
    if (row.is_primary) {
      return context.json({ error: "Cannot delete the primary company." }, 409);
    }

    await sql.begin(async (tx) => {
      // Any member whose explicit choice pointed at this company falls back
      // to the tenant's primary ledger, the same as if they'd never switched --
      // see the null-fallback comment on memberships.active_ledger_name.
      await tx`
        update memberships set active_ledger_name = null
        where tenant_id = ${tenantId} and active_ledger_name = ${name}
      `;
      await tx`delete from ledgers where id = ${row.id}`;
    });

    return context.body(null, 204);
  });
}
