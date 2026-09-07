import { createRoute, z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { getLedgerName, getTenantId } from "@/http/context";
import { errorResponseSchema } from "@/domain/models";
import { getSql } from "@/infra/postgres/client";

const productIdParam = zod.object({ productId: zod.string().uuid() });

const productSchema = zod.object({
  id: zod.string().uuid(),
  name: zod.string(),
  type: zod.enum(["SERVICE", "PRODUCT"]),
  description: zod.string().optional(),
  salesPrice: zod.number().optional(),
  incomeAccountId: zod.string().optional(),
  status: zod.enum(["ACTIVE", "ARCHIVED"]),
  createdAt: zod.string()
});

const productWritableFields = {
  name: zod.string().trim().min(1).max(200),
  type: zod.enum(["SERVICE", "PRODUCT"]),
  description: zod.string().trim().min(1).max(1000).optional(),
  salesPrice: zod.number().min(0).optional(),
  incomeAccountId: zod.string().trim().min(1).optional()
};

const createProductInputSchema = zod.object(productWritableFields);
// Every field explicit and optional -- see vendors.ts's own comment on
// why this isn't a spread over Object.entries(...).map(...optional()).
const updateProductInputSchema = zod.object({
  name: productWritableFields.name.optional(),
  type: productWritableFields.type.optional(),
  description: productWritableFields.description,
  salesPrice: productWritableFields.salesPrice,
  incomeAccountId: productWritableFields.incomeAccountId,
  status: zod.enum(["ACTIVE", "ARCHIVED"]).optional()
});

type ProductRow = {
  id: string;
  name: string;
  type: "SERVICE" | "PRODUCT";
  description: string | null;
  sales_price: string | null;
  income_account_id: string | null;
  status: "ACTIVE" | "ARCHIVED";
  created_at: Date;
};

function serialize(row: ProductRow) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    description: row.description ?? undefined,
    salesPrice: row.sales_price != null ? Number(row.sales_price) : undefined,
    incomeAccountId: row.income_account_id ?? undefined,
    status: row.status,
    createdAt: row.created_at.toISOString()
  };
}

const listProductsRoute = createRoute({
  method: "get",
  path: "/api/products-services",
  responses: {
    200: {
      content: { "application/json": { schema: zod.array(productSchema) } },
      description: "Every product/service item for the caller's currently active company"
    }
  }
});

const createProductRoute = createRoute({
  method: "post",
  path: "/api/products-services",
  request: { body: { content: { "application/json": { schema: createProductInputSchema } }, required: true } },
  responses: {
    200: { content: { "application/json": { schema: productSchema } }, description: "The newly created item" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No active company for this request" }
  }
});

const updateProductRoute = createRoute({
  method: "patch",
  path: "/api/products-services/{productId}",
  request: { params: productIdParam, body: { content: { "application/json": { schema: updateProductInputSchema } }, required: true } },
  responses: {
    200: { content: { "application/json": { schema: productSchema } }, description: "The updated item" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No such item for this company" }
  }
});

const deleteProductRoute = createRoute({
  method: "delete",
  path: "/api/products-services/{productId}",
  request: { params: productIdParam },
  responses: {
    204: { description: "Item deleted" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No such item for this company" }
  }
});

/**
 * Products & Services catalog, scoped to the caller's CURRENTLY ACTIVE
 * company only -- shared between Sales & Get Paid and Customer Hub, same
 * scoping/pattern as vendors.ts/customers.ts.
 */
export function productServiceRoutes(app: OpenAPIHono): void {
  app.openapi(listProductsRoute, async (context) => {
    const tenantId = getTenantId(context);
    const ledgerName = getLedgerName(context);
    const sql = getSql();

    const rows = await sql`
      select p.id, p.name, p.type, p.description, p.sales_price, p.income_account_id, p.status, p.created_at
      from products_services p
      join ledgers l on l.id = p.ledger_id
      where l.tenant_id = ${tenantId} and l.name = ${ledgerName}
      order by p.created_at asc
    `;

    return context.json(rows.map((row: unknown) => serialize(row as ProductRow)), 200);
  });

  app.openapi(createProductRoute, async (context) => {
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
      insert into products_services (ledger_id, name, type, description, sales_price, income_account_id)
      values (${ledgerId}, ${input.name}, ${input.type}, ${input.description ?? null}, ${input.salesPrice ?? null}, ${input.incomeAccountId ?? null})
      returning id, name, type, description, sales_price, income_account_id, status, created_at
    `;

    return context.json(serialize(inserted as ProductRow), 200);
  });

  app.openapi(updateProductRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { productId } = context.req.valid("param");
    const patch = context.req.valid("json");
    const sql = getSql();

    const existingRows = await sql`
      select p.id, p.name, p.type, p.description, p.sales_price, p.income_account_id, p.status
      from products_services p
      join ledgers l on l.id = p.ledger_id
      where l.tenant_id = ${tenantId} and p.id = ${productId}
      limit 1
    `;
    if (existingRows.length === 0) {
      return context.json({ error: `No item '${productId}' for this company` }, 404);
    }
    const current = existingRows[0] as ProductRow;

    const next = {
      name: patch.name ?? current.name,
      type: patch.type ?? current.type,
      description: patch.description !== undefined ? patch.description : (current.description ?? undefined),
      salesPrice: patch.salesPrice !== undefined ? patch.salesPrice : current.sales_price != null ? Number(current.sales_price) : undefined,
      incomeAccountId: patch.incomeAccountId !== undefined ? patch.incomeAccountId : (current.income_account_id ?? undefined),
      status: patch.status ?? current.status
    };

    const [updated] = await sql`
      update products_services set
        name = ${next.name},
        type = ${next.type},
        description = ${next.description ?? null},
        sales_price = ${next.salesPrice ?? null},
        income_account_id = ${next.incomeAccountId ?? null},
        status = ${next.status},
        updated_at = now()
      where id = ${productId}
      returning id, name, type, description, sales_price, income_account_id, status, created_at
    `;

    return context.json(serialize(updated as ProductRow), 200);
  });

  app.openapi(deleteProductRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { productId } = context.req.valid("param");
    const sql = getSql();

    const rows = await sql`
      delete from products_services p
      using ledgers l
      where p.ledger_id = l.id and l.tenant_id = ${tenantId} and p.id = ${productId}
      returning p.id
    `;
    if (rows.length === 0) {
      return context.json({ error: `No item '${productId}' for this company` }, 404);
    }

    return context.body(null, 204);
  });
}
