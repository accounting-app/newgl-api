import { createRoute, z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { getServices } from "@/http/context";
import { errorResponseSchema, ledgerPostingSchema } from "@/domain/models";

const ledgerPostingsRoute = createRoute({
  method: "get",
  path: "/api/ledger/postings",
  responses: {
    200: {
      content: { "application/json": { schema: zod.array(ledgerPostingSchema) } },
      description: "Ledger postings"
    }
  }
});

const ledgerPostingsByTransactionRoute = createRoute({
  method: "get",
  path: "/api/ledger/transactions/{transactionId}/postings",
  request: {
    params: zod.object({ transactionId: zod.string().uuid() })
  },
  responses: {
    200: {
      content: { "application/json": { schema: zod.array(ledgerPostingSchema) } },
      description: "Postings for transaction"
    },
    404: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "Transaction not found"
    }
  }
});

export function ledgerRoutes(app: OpenAPIHono): void {
  app.openapi(ledgerPostingsRoute, async (context) => {
    const postings = await getServices(context).ledgerService.listPostings();
    return context.json(postings, 200);
  });

  app.openapi(ledgerPostingsByTransactionRoute, async (context) => {
    const { transactionId } = context.req.valid("param");
    const postings = await getServices(context).ledgerService.getPostingsByTransactionId(transactionId);
    return context.json(postings, 200);
  });
}
