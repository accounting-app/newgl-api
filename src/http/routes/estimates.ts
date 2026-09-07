import { createRoute, z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { getLedgerName, getTenantId } from "@/http/context";
import { errorResponseSchema } from "@/domain/models";
import { getSql } from "@/infra/postgres/client";

const estimateIdParam = zod.object({ estimateId: zod.string().uuid() });

const estimateSchema = zod.object({
  id: zod.string().uuid(),
  customerId: zod.string().uuid(),
  productServiceId: zod.string().uuid().optional(),
  estimateNumber: zod.string().optional(),
  estimateDate: zod.string(),
  expirationDate: zod.string().optional(),
  amount: zod.number(),
  memo: zod.string().optional(),
  status: zod.enum(["OPEN", "ACCEPTED", "DECLINED"]),
  createdAt: zod.string()
});

const createEstimateInputSchema = zod.object({
  customerId: zod.string().uuid(),
  productServiceId: zod.string().uuid().optional(),
  estimateNumber: zod.string().trim().min(1).max(100).optional(),
  estimateDate: zod.string().min(1),
  expirationDate: zod.string().min(1).optional(),
  amount: zod.number().positive(),
  memo: zod.string().trim().min(1).max(1000).optional()
});

const updateEstimateInputSchema = zod.object({
  customerId: zod.string().uuid().optional(),
  productServiceId: zod.string().uuid().optional(),
  estimateNumber: zod.string().trim().min(1).max(100).optional(),
  estimateDate: zod.string().min(1).optional(),
  expirationDate: zod.string().min(1).optional(),
  amount: zod.number().positive().optional(),
  memo: zod.string().trim().min(1).max(1000).optional(),
  status: zod.enum(["OPEN", "ACCEPTED", "DECLINED"]).optional()
});

type EstimateRow = {
  id: string;
  customer_id: string;
  product_service_id: string | null;
  estimate_number: string | null;
  estimate_date: Date;
  expiration_date: Date | null;
  amount: string;
  memo: string | null;
  status: "OPEN" | "ACCEPTED" | "DECLINED";
  created_at: Date;
};

function serialize(row: EstimateRow) {
  return {
    id: row.id,
    customerId: row.customer_id,
    productServiceId: row.product_service_id ?? undefined,
    estimateNumber: row.estimate_number ?? undefined,
    estimateDate: row.estimate_date.toISOString().slice(0, 10),
    expirationDate: row.expiration_date ? row.expiration_date.toISOString().slice(0, 10) : undefined,
    amount: Number(row.amount),
    memo: row.memo ?? undefined,
    status: row.status,
    createdAt: row.created_at.toISOString()
  };
}

const listEstimatesRoute = createRoute({
  method: "get",
  path: "/api/estimates",
  responses: {
    200: { content: { "application/json": { schema: zod.array(estimateSchema) } }, description: "Every estimate for the caller's currently active company" }
  }
});

const createEstimateRoute = createRoute({
  method: "post",
  path: "/api/estimates",
  request: { body: { content: { "application/json": { schema: createEstimateInputSchema } }, required: true } },
  responses: {
    200: { content: { "application/json": { schema: estimateSchema } }, description: "The newly created estimate" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No active company, or no such customer/product for this company" }
  }
});

const updateEstimateRoute = createRoute({
  method: "patch",
  path: "/api/estimates/{estimateId}",
  request: { params: estimateIdParam, body: { content: { "application/json": { schema: updateEstimateInputSchema } }, required: true } },
  responses: {
    200: { content: { "application/json": { schema: estimateSchema } }, description: "The updated estimate" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No such estimate for this company" }
  }
});

const deleteEstimateRoute = createRoute({
  method: "delete",
  path: "/api/estimates/{estimateId}",
  request: { params: estimateIdParam },
  responses: {
    204: { description: "Estimate deleted" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No such estimate for this company" }
  }
});

/**
 * Estimates, scoped to the caller's CURRENTLY ACTIVE company only -- same
 * scoping/pattern as vendors.ts/customers.ts/invoices.ts. Metadata-only,
 * no ledger impact -- a quote is not an accounting event, matching QBO
 * itself (accept/decline is just a status here, not something a customer
 * confirms online, since that needs a real e-signature integration).
 */
export function estimateRoutes(app: OpenAPIHono): void {
  app.openapi(listEstimatesRoute, async (context) => {
    const tenantId = getTenantId(context);
    const ledgerName = getLedgerName(context);
    const sql = getSql();

    const rows = await sql`
      select e.id, e.customer_id, e.product_service_id, e.estimate_number, e.estimate_date, e.expiration_date,
             e.amount, e.memo, e.status, e.created_at
      from estimates e
      join ledgers l on l.id = e.ledger_id
      where l.tenant_id = ${tenantId} and l.name = ${ledgerName}
      order by e.estimate_date desc, e.created_at desc
    `;

    return context.json(rows.map((row: unknown) => serialize(row as EstimateRow)), 200);
  });

  app.openapi(createEstimateRoute, async (context) => {
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

    const customerRows = await sql`select id from customers where id = ${input.customerId} and ledger_id = ${ledgerId} limit 1`;
    if (customerRows.length === 0) {
      return context.json({ error: `No customer '${input.customerId}' for this company` }, 404);
    }

    if (input.productServiceId) {
      const productRows = await sql`select id from products_services where id = ${input.productServiceId} and ledger_id = ${ledgerId} limit 1`;
      if (productRows.length === 0) {
        return context.json({ error: `No product/service '${input.productServiceId}' for this company` }, 404);
      }
    }

    const [inserted] = await sql`
      insert into estimates (ledger_id, customer_id, product_service_id, estimate_number, estimate_date, expiration_date, amount, memo)
      values (
        ${ledgerId}, ${input.customerId}, ${input.productServiceId ?? null}, ${input.estimateNumber ?? null},
        ${input.estimateDate}, ${input.expirationDate ?? null}, ${input.amount}, ${input.memo ?? null}
      )
      returning id, customer_id, product_service_id, estimate_number, estimate_date, expiration_date, amount, memo, status, created_at
    `;

    return context.json(serialize(inserted as EstimateRow), 200);
  });

  app.openapi(updateEstimateRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { estimateId } = context.req.valid("param");
    const patch = context.req.valid("json");
    const sql = getSql();

    const existingRows = await sql`
      select e.id, e.customer_id, e.product_service_id, e.estimate_number, e.estimate_date, e.expiration_date,
             e.amount, e.memo, e.status
      from estimates e
      join ledgers l on l.id = e.ledger_id
      where l.tenant_id = ${tenantId} and e.id = ${estimateId}
      limit 1
    `;
    if (existingRows.length === 0) {
      return context.json({ error: `No estimate '${estimateId}' for this company` }, 404);
    }
    const current = existingRows[0] as EstimateRow;

    const next = {
      customerId: patch.customerId ?? current.customer_id,
      productServiceId: patch.productServiceId !== undefined ? patch.productServiceId : (current.product_service_id ?? undefined),
      estimateNumber: patch.estimateNumber !== undefined ? patch.estimateNumber : (current.estimate_number ?? undefined),
      estimateDate: patch.estimateDate ?? current.estimate_date.toISOString().slice(0, 10),
      expirationDate:
        patch.expirationDate !== undefined ? patch.expirationDate : current.expiration_date ? current.expiration_date.toISOString().slice(0, 10) : undefined,
      amount: patch.amount ?? Number(current.amount),
      memo: patch.memo !== undefined ? patch.memo : (current.memo ?? undefined),
      status: patch.status ?? current.status
    };

    const [updated] = await sql`
      update estimates set
        customer_id = ${next.customerId},
        product_service_id = ${next.productServiceId ?? null},
        estimate_number = ${next.estimateNumber ?? null},
        estimate_date = ${next.estimateDate},
        expiration_date = ${next.expirationDate ?? null},
        amount = ${next.amount},
        memo = ${next.memo ?? null},
        status = ${next.status},
        updated_at = now()
      where id = ${estimateId}
      returning id, customer_id, product_service_id, estimate_number, estimate_date, expiration_date, amount, memo, status, created_at
    `;

    return context.json(serialize(updated as EstimateRow), 200);
  });

  app.openapi(deleteEstimateRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { estimateId } = context.req.valid("param");
    const sql = getSql();

    const rows = await sql`
      delete from estimates e
      using ledgers l
      where e.ledger_id = l.id and l.tenant_id = ${tenantId} and e.id = ${estimateId}
      returning e.id
    `;
    if (rows.length === 0) {
      return context.json({ error: `No estimate '${estimateId}' for this company` }, 404);
    }

    return context.body(null, 204);
  });
}
