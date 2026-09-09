import { createRoute, z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { getLedgerName, getTenantId } from "@/http/context";
import { errorResponseSchema } from "@/domain/models";
import { getSql } from "@/infra/postgres/client";

const vendorIdParam = zod.object({ vendorId: zod.string().uuid() });

const vendorSchema = zod.object({
  id: zod.string().uuid(),
  name: zod.string(),
  companyName: zod.string().optional(),
  email: zod.string().optional(),
  phone: zod.string().optional(),
  address: zod.string().optional(),
  taxId: zod.string().optional(),
  defaultExpenseAccountId: zod.string().optional(),
  is1099Contractor: zod.boolean(),
  w9Received: zod.boolean(),
  status: zod.enum(["ACTIVE", "ARCHIVED"]),
  createdAt: zod.string()
});

const vendorWritableFields = {
  name: zod.string().trim().min(1).max(200),
  companyName: zod.string().trim().min(1).max(200).optional(),
  email: zod.string().trim().min(1).max(200).optional(),
  phone: zod.string().trim().min(1).max(50).optional(),
  address: zod.string().trim().min(1).max(500).optional(),
  taxId: zod.string().trim().min(1).max(50).optional(),
  defaultExpenseAccountId: zod.string().trim().min(1).optional(),
  is1099Contractor: zod.boolean().optional(),
  w9Received: zod.boolean().optional()
};

const createVendorInputSchema = zod.object(vendorWritableFields);
// Every field explicit and optional -- NOT a spread over
// Object.entries(vendorWritableFields) mapped to .optional(): that loses
// the literal key names to TS (Object.entries widens keys to `string`),
// so the inferred type collapses to just `{ status?: ... }` and every
// other field access below fails to typecheck, even though it works fine
// at runtime (zod itself doesn't care how the shape object was built).
const updateVendorInputSchema = zod.object({
  name: vendorWritableFields.name.optional(),
  companyName: vendorWritableFields.companyName,
  email: vendorWritableFields.email,
  phone: vendorWritableFields.phone,
  address: vendorWritableFields.address,
  taxId: vendorWritableFields.taxId,
  defaultExpenseAccountId: vendorWritableFields.defaultExpenseAccountId,
  is1099Contractor: vendorWritableFields.is1099Contractor,
  w9Received: vendorWritableFields.w9Received,
  status: zod.enum(["ACTIVE", "ARCHIVED"]).optional()
});

type VendorRow = {
  id: string;
  name: string;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  tax_id: string | null;
  default_expense_account_id: string | null;
  is_1099_contractor: boolean;
  w9_received: boolean;
  status: "ACTIVE" | "ARCHIVED";
  created_at: Date;
};

function serialize(row: VendorRow) {
  return {
    id: row.id,
    name: row.name,
    companyName: row.company_name ?? undefined,
    email: row.email ?? undefined,
    phone: row.phone ?? undefined,
    address: row.address ?? undefined,
    taxId: row.tax_id ?? undefined,
    defaultExpenseAccountId: row.default_expense_account_id ?? undefined,
    is1099Contractor: row.is_1099_contractor,
    w9Received: row.w9_received,
    status: row.status,
    createdAt: row.created_at.toISOString()
  };
}

const listVendorsRoute = createRoute({
  method: "get",
  path: "/api/vendors",
  responses: {
    200: {
      content: { "application/json": { schema: zod.array(vendorSchema) } },
      description: "Every vendor for the caller's currently active company"
    }
  }
});

const createVendorRoute = createRoute({
  method: "post",
  path: "/api/vendors",
  request: { body: { content: { "application/json": { schema: createVendorInputSchema } }, required: true } },
  responses: {
    200: { content: { "application/json": { schema: vendorSchema } }, description: "The newly created vendor" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No active company for this request" }
  }
});

const updateVendorRoute = createRoute({
  method: "patch",
  path: "/api/vendors/{vendorId}",
  request: { params: vendorIdParam, body: { content: { "application/json": { schema: updateVendorInputSchema } }, required: true } },
  responses: {
    200: { content: { "application/json": { schema: vendorSchema } }, description: "The updated vendor" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No such vendor for this company" }
  }
});

const deleteVendorRoute = createRoute({
  method: "delete",
  path: "/api/vendors/{vendorId}",
  request: { params: vendorIdParam },
  responses: {
    204: { description: "Vendor deleted" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No such vendor for this company" },
    409: { content: { "application/json": { schema: errorResponseSchema } }, description: "This vendor has bills against it -- archive it instead of deleting" }
  }
});

/**
 * Vendor directory, scoped to the caller's CURRENTLY ACTIVE company only --
 * same scoping rule as ledger-files.ts. `is1099Contractor` is what the
 * Team ▸ Contractors and Expenses & Bills ▸ 1099s screens filter/aggregate
 * on; there's no separate contractor table.
 */
export function vendorRoutes(app: OpenAPIHono): void {
  app.openapi(listVendorsRoute, async (context) => {
    const tenantId = getTenantId(context);
    const ledgerName = getLedgerName(context);
    const sql = getSql();

    const rows = await sql`
      select v.id, v.name, v.company_name, v.email, v.phone, v.address, v.tax_id,
             v.default_expense_account_id, v.is_1099_contractor, v.w9_received, v.status, v.created_at
      from vendors v
      join ledgers l on l.id = v.ledger_id
      where l.tenant_id = ${tenantId} and l.name = ${ledgerName}
      order by v.created_at asc
    `;

    return context.json(rows.map((row: unknown) => serialize(row as VendorRow)), 200);
  });

  app.openapi(createVendorRoute, async (context) => {
    const tenantId = getTenantId(context);
    const ledgerName = getLedgerName(context);
    const input = context.req.valid("json");
    const sql = getSql();

    const ledgerRows = await sql`
      select id from ledgers where tenant_id = ${tenantId} and name = ${ledgerName} limit 1
    `;
    if (ledgerRows.length === 0) {
      return context.json({ error: "No active company for this request" }, 404);
    }
    const ledgerId = (ledgerRows[0] as { id: string }).id;

    const [inserted] = await sql`
      insert into vendors (
        ledger_id, name, company_name, email, phone, address, tax_id,
        default_expense_account_id, is_1099_contractor, w9_received
      )
      values (
        ${ledgerId}, ${input.name}, ${input.companyName ?? null}, ${input.email ?? null},
        ${input.phone ?? null}, ${input.address ?? null}, ${input.taxId ?? null},
        ${input.defaultExpenseAccountId ?? null}, ${input.is1099Contractor ?? false}, ${input.w9Received ?? false}
      )
      returning id, name, company_name, email, phone, address, tax_id,
                default_expense_account_id, is_1099_contractor, w9_received, status, created_at
    `;

    return context.json(serialize(inserted as VendorRow), 200);
  });

  app.openapi(updateVendorRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { vendorId } = context.req.valid("param");
    const patch = context.req.valid("json");
    const sql = getSql();

    const existingRows = await sql`
      select v.id, v.name, v.company_name, v.email, v.phone, v.address, v.tax_id,
             v.default_expense_account_id, v.is_1099_contractor, v.w9_received, v.status
      from vendors v
      join ledgers l on l.id = v.ledger_id
      where l.tenant_id = ${tenantId} and v.id = ${vendorId}
      limit 1
    `;
    if (existingRows.length === 0) {
      return context.json({ error: `No vendor '${vendorId}' for this company` }, 404);
    }
    const current = existingRows[0] as VendorRow;

    const next = {
      name: patch.name ?? current.name,
      companyName: patch.companyName !== undefined ? patch.companyName : (current.company_name ?? undefined),
      email: patch.email !== undefined ? patch.email : (current.email ?? undefined),
      phone: patch.phone !== undefined ? patch.phone : (current.phone ?? undefined),
      address: patch.address !== undefined ? patch.address : (current.address ?? undefined),
      taxId: patch.taxId !== undefined ? patch.taxId : (current.tax_id ?? undefined),
      defaultExpenseAccountId:
        patch.defaultExpenseAccountId !== undefined ? patch.defaultExpenseAccountId : (current.default_expense_account_id ?? undefined),
      is1099Contractor: patch.is1099Contractor ?? current.is_1099_contractor,
      w9Received: patch.w9Received ?? current.w9_received,
      status: patch.status ?? current.status
    };

    const [updated] = await sql`
      update vendors set
        name = ${next.name},
        company_name = ${next.companyName ?? null},
        email = ${next.email ?? null},
        phone = ${next.phone ?? null},
        address = ${next.address ?? null},
        tax_id = ${next.taxId ?? null},
        default_expense_account_id = ${next.defaultExpenseAccountId ?? null},
        is_1099_contractor = ${next.is1099Contractor},
        w9_received = ${next.w9Received},
        status = ${next.status},
        updated_at = now()
      where id = ${vendorId}
      returning id, name, company_name, email, phone, address, tax_id,
                default_expense_account_id, is_1099_contractor, w9_received, status, created_at
    `;

    return context.json(serialize(updated as VendorRow), 200);
  });

  app.openapi(deleteVendorRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { vendorId } = context.req.valid("param");
    const sql = getSql();

    let rows: unknown[];
    try {
      rows = await sql`
        delete from vendors v
        using ledgers l
        where v.ledger_id = l.id and l.tenant_id = ${tenantId} and v.id = ${vendorId}
        returning v.id
      `;
    } catch (error) {
      // Postgres foreign_key_violation -- this vendor has bills against it
      // (bills.vendor_id has no cascade, on purpose: see
      // 20260907020000_create_bills.sql). Archive instead of delete.
      if (error instanceof Error && "errno" in error && (error as { errno?: string }).errno === "23503") {
        return context.json({ error: "This vendor has bills against it -- archive it instead of deleting" }, 409);
      }
      throw error;
    }
    if (rows.length === 0) {
      return context.json({ error: `No vendor '${vendorId}' for this company` }, 404);
    }

    return context.body(null, 204);
  });
}
