import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import type { ServiceContainer } from "@/application/service-container";
import { ledgerPostingSchema } from "@/domain/models";

const ledgerPostingsRoute = createRoute({
  method: "get",
  path: "/api/ledger/postings",
  responses: {
    200: {
      content: { "application/json": { schema: z.array(ledgerPostingSchema) } },
      description: "Ledger postings"
    }
  }
});

const ledgerPostingsByTransactionRoute = createRoute({
  method: "get",
  path: "/api/ledger/transactions/{transactionId}/postings",
  request: {
    params: z.object({ transactionId: z.string().uuid() })
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.array(ledgerPostingSchema) } },
      description: "Postings for transaction"
    }
  }
});

export function ledgerRoutes(app: OpenAPIHono, services: ServiceContainer): void {
  app.openapi(ledgerPostingsRoute, async (c) => {
    const postings = await services.ledgerService.listPostings();
    return c.json(postings, 200);
  });

  app.openapi(ledgerPostingsByTransactionRoute, async (c) => {
    const { transactionId } = c.req.valid("param");
    const postings = await services.ledgerService.getPostingsByTransactionId(transactionId);
    return c.json(postings, 200);
  });
}
