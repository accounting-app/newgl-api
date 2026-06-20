import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import type { ServiceContainer } from "@/application/service-container";
import {
  createTransactionInputSchema,
  errorResponseSchema,
  ledgerPostingSchema,
  registerEntrySchema,
  setReconcileStatusInputSchema,
  transactionSchema,
  updateRegisterEntryInputSchema
} from "@/domain/models";

const omitType = createTransactionInputSchema.omit({ type: true });

const transactionListRoute = createRoute({
  method: "get",
  path: "/api/transactions",
  responses: {
    200: {
      content: { "application/json": { schema: z.array(transactionSchema) } },
      description: "List transactions"
    }
  }
});

const transactionCreateRoute = createRoute({
  method: "post",
  path: "/api/transactions",
  request: {
    body: { content: { "application/json": { schema: createTransactionInputSchema } } }
  },
  responses: {
    201: {
      content: { "application/json": { schema: transactionSchema } },
      description: "Created transaction"
    },
    400: { content: { "application/json": { schema: errorResponseSchema } }, description: "Error" }
  }
});

const transactionGetRoute = createRoute({
  method: "get",
  path: "/api/transactions/{transactionId}",
  request: { params: z.object({ transactionId: z.string().uuid() }) },
  responses: {
    200: { content: { "application/json": { schema: transactionSchema } }, description: "Transaction" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "Not found" }
  }
});

const transactionPostRoute = createRoute({
  method: "post",
  path: "/api/transactions/{transactionId}/post",
  request: { params: z.object({ transactionId: z.string().uuid() }) },
  responses: {
    200: { content: { "application/json": { schema: transactionSchema } }, description: "Posted" }
  }
});

const transactionVoidRoute = createRoute({
  method: "post",
  path: "/api/transactions/{transactionId}/void",
  request: { params: z.object({ transactionId: z.string().uuid() }) },
  responses: {
    200: { content: { "application/json": { schema: transactionSchema } }, description: "Voided" }
  }
});

const transactionReverseRoute = createRoute({
  method: "post",
  path: "/api/transactions/{transactionId}/reverse",
  request: { params: z.object({ transactionId: z.string().uuid() }) },
  responses: {
    200: { content: { "application/json": { schema: transactionSchema } }, description: "Reversed" }
  }
});

const transferRoute = createRoute({
  method: "post",
  path: "/api/transfers",
  request: { body: { content: { "application/json": { schema: omitType } } } },
  responses: {
    201: { content: { "application/json": { schema: transactionSchema } }, description: "Transfer" }
  }
});

const depositRoute = createRoute({
  method: "post",
  path: "/api/deposits",
  request: { body: { content: { "application/json": { schema: omitType } } } },
  responses: {
    201: { content: { "application/json": { schema: transactionSchema } }, description: "Deposit" }
  }
});

const expenseRoute = createRoute({
  method: "post",
  path: "/api/expenses",
  request: {
    body: {
      content: {
        "application/json": {
          schema: omitType.extend({ type: z.literal("EXPENSE").optional() })
        }
      }
    }
  },
  responses: {
    201: { content: { "application/json": { schema: transactionSchema } }, description: "Expense" }
  }
});

const registerUpdateRoute = createRoute({
  method: "patch",
  path: "/api/register/{entryId}",
  request: {
    params: z.object({ entryId: z.string().uuid() }),
    body: { content: { "application/json": { schema: updateRegisterEntryInputSchema } } }
  },
  responses: {
    200: { content: { "application/json": { schema: registerEntrySchema } }, description: "Updated entry" }
  }
});

const registerReconcileRoute = createRoute({
  method: "post",
  path: "/api/register/{entryId}/reconcile",
  request: {
    params: z.object({ entryId: z.string().uuid() }),
    body: { content: { "application/json": { schema: setReconcileStatusInputSchema } } }
  },
  responses: {
    200: { content: { "application/json": { schema: registerEntrySchema } }, description: "Reconcile status" }
  }
});

const registerDeleteRoute = createRoute({
  method: "delete",
  path: "/api/register/{entryId}",
  request: { params: z.object({ entryId: z.string().uuid() }) },
  responses: {
    200: { content: { "application/json": { schema: registerEntrySchema } }, description: "Deleted entry" }
  }
});

const transactionDetailRoute = createRoute({
  method: "get",
  path: "/api/transactions/{transactionId}/detail",
  request: { params: z.object({ transactionId: z.string().uuid() }) },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            transaction: transactionSchema,
            postings: z.array(ledgerPostingSchema),
            registerEntries: z.array(registerEntrySchema)
          })
        }
      },
      description: "Transaction detail"
    }
  }
});

export function registerTransactionRoutes(app: OpenAPIHono, services: ServiceContainer): void {
  app.openapi(transactionListRoute, async (c) => {
    const transactions = await services.transactionService.listTransactions();
    return c.json(transactions, 200);
  });

  app.openapi(transactionCreateRoute, async (c) => {
    const input = c.req.valid("json");
    const transaction = await services.transactionService.createTransaction(input);
    return c.json(transaction, 201);
  });

  app.openapi(transactionGetRoute, async (c) => {
    const { transactionId } = c.req.valid("param");
    const transaction = await services.transactionService.getTransactionById(transactionId);
    return c.json(transaction, 200);
  });

  app.openapi(transactionPostRoute, async (c) => {
    const { transactionId } = c.req.valid("param");
    const transaction = await services.transactionService.postTransaction(transactionId);
    return c.json(transaction, 200);
  });

  app.openapi(transactionVoidRoute, async (c) => {
    const { transactionId } = c.req.valid("param");
    const transaction = await services.transactionService.voidTransaction(transactionId);
    return c.json(transaction, 200);
  });

  app.openapi(transactionReverseRoute, async (c) => {
    const { transactionId } = c.req.valid("param");
    const transaction = await services.transactionService.reverseTransaction(transactionId);
    return c.json(transaction, 200);
  });

  app.openapi(transferRoute, async (c) => {
    const input = c.req.valid("json");
    const transaction = await services.transactionService.createTransfer(input);
    return c.json(transaction, 201);
  });

  app.openapi(depositRoute, async (c) => {
    const input = c.req.valid("json");
    const transaction = await services.transactionService.createDeposit(input);
    return c.json(transaction, 201);
  });

  app.openapi(expenseRoute, async (c) => {
    const input = c.req.valid("json");
    const transaction = await services.transactionService.createTransaction({
      ...input,
      type: "EXPENSE"
    });
    const posted = await services.transactionService.postTransaction(transaction.id);
    return c.json(posted, 201);
  });

  app.openapi(registerUpdateRoute, async (c) => {
    const { entryId } = c.req.valid("param");
    const input = c.req.valid("json");
    const entry = await services.registerService.updateRegisterEntry(entryId, input);
    return c.json(entry, 200);
  });

  app.openapi(registerReconcileRoute, async (c) => {
    const { entryId } = c.req.valid("param");
    const { status } = c.req.valid("json");
    const entry = await services.registerService.setReconcileStatus(entryId, status);
    return c.json(entry, 200);
  });

  app.openapi(registerDeleteRoute, async (c) => {
    const { entryId } = c.req.valid("param");
    const entry = await services.registerService.deleteRegisterEntry(entryId);
    return c.json(entry, 200);
  });

  app.openapi(transactionDetailRoute, async (c) => {
    const { transactionId } = c.req.valid("param");
    const detail = await services.registerService.getTransactionDetail(transactionId);
    return c.json(detail, 200);
  });
}
