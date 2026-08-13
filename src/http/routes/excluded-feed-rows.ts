import { createRoute, z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { createExcludedFeedRowInputSchema, errorResponseSchema, excludedFeedRowSchema } from "@/domain/models";
import { getTenantId } from "@/http/context";
import { getSql } from "@/infra/postgres/client";

const excludedFeedRowIdParam = zod.object({ id: zod.string().uuid() });

type ExcludedFeedRowRow = {
  id: string;
  main_account_id: string;
  payee: string;
  amount: string;
  created_at: Date;
};

function serializeRow(row: ExcludedFeedRowRow) {
  return {
    id: row.id,
    mainAccountId: row.main_account_id,
    payee: row.payee,
    amount: Number(row.amount),
    createdAt: row.created_at.toISOString()
  };
}

const listExcludedFeedRowsRoute = createRoute({
  method: "get",
  path: "/api/excluded-feed-rows",
  request: {
    query: zod.object({ mainAccountId: zod.string().min(1).optional() })
  },
  responses: {
    200: {
      content: { "application/json": { schema: zod.array(excludedFeedRowSchema) } },
      description: "Excluded feed row patterns for the caller's tenant, optionally scoped to one account"
    }
  }
});

const createExcludedFeedRowRoute = createRoute({
  method: "post",
  path: "/api/excluded-feed-rows",
  request: {
    body: { content: { "application/json": { schema: createExcludedFeedRowInputSchema } }, required: true }
  },
  responses: {
    200: { content: { "application/json": { schema: excludedFeedRowSchema } }, description: "The newly excluded row pattern" }
  }
});

const deleteExcludedFeedRowRoute = createRoute({
  method: "delete",
  path: "/api/excluded-feed-rows/{id}",
  request: { params: excludedFeedRowIdParam },
  responses: {
    204: { description: "Excluded row pattern deleted" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No excluded row with that id" }
  }
});

export function excludedFeedRowRoutes(app: OpenAPIHono): void {
  app.openapi(listExcludedFeedRowsRoute, async (context) => {
    const { mainAccountId } = context.req.valid("query");
    const tenantId = getTenantId(context);
    const sql = getSql();
    const rows = (
      mainAccountId
        ? await sql`
            select id, main_account_id, payee, amount, created_at
            from excluded_feed_rows
            where tenant_id = ${tenantId} and main_account_id = ${mainAccountId}
            order by created_at desc
          `
        : await sql`
            select id, main_account_id, payee, amount, created_at
            from excluded_feed_rows
            where tenant_id = ${tenantId}
            order by created_at desc
          `
    ) as unknown as ExcludedFeedRowRow[];

    return context.json(rows.map(serializeRow), 200);
  });

  app.openapi(createExcludedFeedRowRoute, async (context) => {
    const tenantId = getTenantId(context);
    const input = context.req.valid("json");
    const sql = getSql();

    const rows = (await sql`
      insert into excluded_feed_rows (tenant_id, main_account_id, payee, amount)
      values (${tenantId}, ${input.mainAccountId}, ${input.payee}, ${input.amount})
      returning id, main_account_id, payee, amount, created_at
    `) as unknown as ExcludedFeedRowRow[];

    return context.json(serializeRow(rows[0]), 200);
  });

  app.openapi(deleteExcludedFeedRowRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { id } = context.req.valid("param");
    const sql = getSql();

    const rows = (await sql`
      delete from excluded_feed_rows where id = ${id} and tenant_id = ${tenantId} returning id
    `) as unknown as { id: string }[];
    if (rows.length === 0) {
      return context.json({ error: `No excluded row '${id}' for this tenant` }, 404);
    }

    return context.body(null, 204);
  });
}
