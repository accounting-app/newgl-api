import { createRoute, z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { getLedgerName, getTenantId } from "@/http/context";
import { errorResponseSchema } from "@/domain/models";
import { getSql } from "@/infra/postgres/client";

const customerIdParam = zod.object({ customerId: zod.string().uuid() });

const customerSchema = zod.object({
  id: zod.string().uuid(),
  name: zod.string(),
  companyName: zod.string().optional(),
  email: zod.string().optional(),
  phone: zod.string().optional(),
  address: zod.string().optional(),
  status: zod.enum(["ACTIVE", "ARCHIVED"]),
  createdAt: zod.string()
});

const customerWritableFields = {
  name: zod.string().trim().min(1).max(200),
  companyName: zod.string().trim().min(1).max(200).optional(),
  email: zod.string().trim().min(1).max(200).optional(),
  phone: zod.string().trim().min(1).max(50).optional(),
  address: zod.string().trim().min(1).max(500).optional()
};

const createCustomerInputSchema = zod.object(customerWritableFields);
// Every field explicit and optional -- see vendors.ts's own comment on
// why this isn't a spread over Object.entries(...).map(...optional()).
const updateCustomerInputSchema = zod.object({
  name: customerWritableFields.name.optional(),
  companyName: customerWritableFields.companyName,
  email: customerWritableFields.email,
  phone: customerWritableFields.phone,
  address: customerWritableFields.address,
  status: zod.enum(["ACTIVE", "ARCHIVED"]).optional()
});

type CustomerRow = {
  id: string;
  name: string;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  status: "ACTIVE" | "ARCHIVED";
  created_at: Date;
};

function serialize(row: CustomerRow) {
  return {
    id: row.id,
    name: row.name,
    companyName: row.company_name ?? undefined,
    email: row.email ?? undefined,
    phone: row.phone ?? undefined,
    address: row.address ?? undefined,
    status: row.status,
    createdAt: row.created_at.toISOString()
  };
}

const listCustomersRoute = createRoute({
  method: "get",
  path: "/api/customers",
  responses: {
    200: {
      content: { "application/json": { schema: zod.array(customerSchema) } },
      description: "Every customer for the caller's currently active company"
    }
  }
});

const createCustomerRoute = createRoute({
  method: "post",
  path: "/api/customers",
  request: { body: { content: { "application/json": { schema: createCustomerInputSchema } }, required: true } },
  responses: {
    200: { content: { "application/json": { schema: customerSchema } }, description: "The newly created customer" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No active company for this request" }
  }
});

const updateCustomerRoute = createRoute({
  method: "patch",
  path: "/api/customers/{customerId}",
  request: { params: customerIdParam, body: { content: { "application/json": { schema: updateCustomerInputSchema } }, required: true } },
  responses: {
    200: { content: { "application/json": { schema: customerSchema } }, description: "The updated customer" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No such customer for this company" }
  }
});

const deleteCustomerRoute = createRoute({
  method: "delete",
  path: "/api/customers/{customerId}",
  request: { params: customerIdParam },
  responses: {
    204: { description: "Customer deleted" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No such customer for this company" },
    409: { content: { "application/json": { schema: errorResponseSchema } }, description: "This customer has invoices/estimates against it -- archive it instead of deleting" }
  }
});

/**
 * Customer directory, scoped to the caller's CURRENTLY ACTIVE company only
 * -- same scoping/pattern as vendors.ts, the AP mirror of this domain.
 */
export function customerRoutes(app: OpenAPIHono): void {
  app.openapi(listCustomersRoute, async (context) => {
    const tenantId = getTenantId(context);
    const ledgerName = getLedgerName(context);
    const sql = getSql();

    const rows = await sql`
      select c.id, c.name, c.company_name, c.email, c.phone, c.address, c.status, c.created_at
      from customers c
      join ledgers l on l.id = c.ledger_id
      where l.tenant_id = ${tenantId} and l.name = ${ledgerName}
      order by c.created_at asc
    `;

    return context.json(rows.map((row: unknown) => serialize(row as CustomerRow)), 200);
  });

  app.openapi(createCustomerRoute, async (context) => {
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
      insert into customers (ledger_id, name, company_name, email, phone, address)
      values (${ledgerId}, ${input.name}, ${input.companyName ?? null}, ${input.email ?? null}, ${input.phone ?? null}, ${input.address ?? null})
      returning id, name, company_name, email, phone, address, status, created_at
    `;

    return context.json(serialize(inserted as CustomerRow), 200);
  });

  app.openapi(updateCustomerRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { customerId } = context.req.valid("param");
    const patch = context.req.valid("json");
    const sql = getSql();

    const existingRows = await sql`
      select c.id, c.name, c.company_name, c.email, c.phone, c.address, c.status
      from customers c
      join ledgers l on l.id = c.ledger_id
      where l.tenant_id = ${tenantId} and c.id = ${customerId}
      limit 1
    `;
    if (existingRows.length === 0) {
      return context.json({ error: `No customer '${customerId}' for this company` }, 404);
    }
    const current = existingRows[0] as CustomerRow;

    const next = {
      name: patch.name ?? current.name,
      companyName: patch.companyName !== undefined ? patch.companyName : (current.company_name ?? undefined),
      email: patch.email !== undefined ? patch.email : (current.email ?? undefined),
      phone: patch.phone !== undefined ? patch.phone : (current.phone ?? undefined),
      address: patch.address !== undefined ? patch.address : (current.address ?? undefined),
      status: patch.status ?? current.status
    };

    const [updated] = await sql`
      update customers set
        name = ${next.name},
        company_name = ${next.companyName ?? null},
        email = ${next.email ?? null},
        phone = ${next.phone ?? null},
        address = ${next.address ?? null},
        status = ${next.status},
        updated_at = now()
      where id = ${customerId}
      returning id, name, company_name, email, phone, address, status, created_at
    `;

    return context.json(serialize(updated as CustomerRow), 200);
  });

  app.openapi(deleteCustomerRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { customerId } = context.req.valid("param");
    const sql = getSql();

    let rows: unknown[];
    try {
      rows = await sql`
        delete from customers c
        using ledgers l
        where c.ledger_id = l.id and l.tenant_id = ${tenantId} and c.id = ${customerId}
        returning c.id
      `;
    } catch (error) {
      // Postgres foreign_key_violation -- once Invoices/Estimates exist
      // (Phase 1.5, Steps 7-8) they'll reference customers with no
      // cascade, same reasoning as bills.vendor_id; this catch is future-
      // proofed for that, same pattern as vendors.ts's own delete route.
      if (error instanceof Error && "errno" in error && (error as { errno?: string }).errno === "23503") {
        return context.json({ error: "This customer has invoices/estimates against it -- archive it instead of deleting" }, 409);
      }
      throw error;
    }
    if (rows.length === 0) {
      return context.json({ error: `No customer '${customerId}' for this company` }, 404);
    }

    return context.body(null, 204);
  });
}
