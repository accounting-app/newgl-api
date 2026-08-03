import { createRoute, z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { getServices } from "@/http/context";
import {
  createTransactionInputSchema,
  errorResponseSchema,
  importTransactionsInputSchema,
  importTransactionsResultSchema,
  ledgerPostingSchema,
  registerEntrySchema,
  setReconcileStatusInputSchema,
  transactionSchema,
  transactionStatusSchema,
  updateRegisterEntryInputSchema
} from "@/domain/models";

const omitType = createTransactionInputSchema.omit({ type: true });

const transactionListRoute = createRoute({
  method: "get",
  path: "/api/transactions",
  request: {
    query: zod.object({
      status: transactionStatusSchema.optional(),
      sourceAccountId: zod.string().uuid().optional()
    })
  },
  responses: {
    200: {
      content: { "application/json": { schema: zod.array(transactionSchema) } },
      description: "List transactions"
    }
  }
});

const transactionImportRoute = createRoute({
  method: "post",
  path: "/api/transactions/import",
  request: {
    body: { content: { "application/json": { schema: importTransactionsInputSchema } } }
  },
  responses: {
    200: {
      content: { "application/json": { schema: importTransactionsResultSchema } },
      description: "Import result"
    },
    400: { content: { "application/json": { schema: errorResponseSchema } }, description: "Error" }
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
  request: { params: zod.object({ transactionId: zod.string().uuid() }) },
  responses: {
    200: { content: { "application/json": { schema: transactionSchema } }, description: "Transaction" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "Not found" }
  }
});

const transactionPostRoute = createRoute({
  method: "post",
  path: "/api/transactions/{transactionId}/post",
  request: { params: zod.object({ transactionId: zod.string().uuid() }) },
  responses: {
    200: { content: { "application/json": { schema: transactionSchema } }, description: "Posted" }
  }
});

const transactionVoidRoute = createRoute({
  method: "post",
  path: "/api/transactions/{transactionId}/void",
  request: { params: zod.object({ transactionId: zod.string().uuid() }) },
  responses: {
    200: { content: { "application/json": { schema: transactionSchema } }, description: "Voided" }
  }
});

const transactionReverseRoute = createRoute({
  method: "post",
  path: "/api/transactions/{transactionId}/reverse",
  request: { params: zod.object({ transactionId: zod.string().uuid() }) },
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
          schema: omitType.extend({ type: zod.literal("EXPENSE").optional() })
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
    params: zod.object({ entryId: zod.string().uuid() }),
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
    params: zod.object({ entryId: zod.string().uuid() }),
    body: { content: { "application/json": { schema: setReconcileStatusInputSchema } } }
  },
  responses: {
    200: { content: { "application/json": { schema: registerEntrySchema } }, description: "Reconcile status" }
  }
});

const registerDeleteRoute = createRoute({
  method: "delete",
  path: "/api/register/{entryId}",
  request: { params: zod.object({ entryId: zod.string().uuid() }) },
  responses: {
    200: { content: { "application/json": { schema: registerEntrySchema } }, description: "Deleted entry" }
  }
});

const transactionDetailRoute = createRoute({
  method: "get",
  path: "/api/transactions/{transactionId}/detail",
  request: { params: zod.object({ transactionId: zod.string().uuid() }) },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: zod.object({
            transaction: transactionSchema,
            postings: zod.array(ledgerPostingSchema),
            registerEntries: zod.array(registerEntrySchema)
          })
        }
      },
      description: "Transaction detail"
    }
  }
});

export function transactionRoutes(app: OpenAPIHono): void {
  app.openapi(transactionListRoute, async (context) => {
    const { status, sourceAccountId } = context.req.valid("query");
    const transactions = await getServices(context).transactionService.listTransactions(
      status || sourceAccountId ? { status, sourceAccountId } : undefined
    );
    return context.json(transactions, 200);
  });

  app.openapi(transactionImportRoute, async (context) => {
    const input = context.req.valid("json");
    const result = await getServices(context).transactionService.importTransactions(input);
    return context.json(result, 200);
  });

  app.openapi(transactionCreateRoute, async (context) => {
    const input = context.req.valid("json");
    const transaction = await getServices(context).transactionService.createTransaction(input);
    return context.json(transaction, 201);
  });

  app.openapi(transactionGetRoute, async (context) => {
    const { transactionId } = context.req.valid("param");
    const transaction = await getServices(context).transactionService.getTransactionById(transactionId);
    return context.json(transaction, 200);
  });

  app.openapi(transactionPostRoute, async (context) => {
    const { transactionId } = context.req.valid("param");
    const transaction = await getServices(context).transactionService.postTransaction(transactionId);
    return context.json(transaction, 200);
  });

  app.openapi(transactionVoidRoute, async (context) => {
    const { transactionId } = context.req.valid("param");
    const transaction = await getServices(context).transactionService.voidTransaction(transactionId);
    return context.json(transaction, 200);
  });

  app.openapi(transactionReverseRoute, async (context) => {
    const { transactionId } = context.req.valid("param");
    const transaction = await getServices(context).transactionService.reverseTransaction(transactionId);
    return context.json(transaction, 200);
  });

  app.openapi(transferRoute, async (context) => {
    const input = context.req.valid("json");
    const transaction = await getServices(context).transactionService.createTransfer(input);
    return context.json(transaction, 201);
  });

  app.openapi(depositRoute, async (context) => {
    const input = context.req.valid("json");
    const transaction = await getServices(context).transactionService.createDeposit(input);
    return context.json(transaction, 201);
  });

  app.openapi(expenseRoute, async (context) => {
    const input = context.req.valid("json");
    const services = getServices(context);
    const transaction = await services.transactionService.createTransaction({
      ...input,
      type: "EXPENSE"
    });
    const posted = await services.transactionService.postTransaction(transaction.id);
    return context.json(posted, 201);
  });

  app.openapi(registerUpdateRoute, async (context) => {
    const { entryId } = context.req.valid("param");
    const input = context.req.valid("json");
    const entry = await getServices(context).registerService.updateRegisterEntry(entryId, input);
    return context.json(entry, 200);
  });

  app.openapi(registerReconcileRoute, async (context) => {
    const { entryId } = context.req.valid("param");
    const { status } = context.req.valid("json");
    const entry = await getServices(context).registerService.setReconcileStatus(entryId, status);
    return context.json(entry, 200);
  });

  app.openapi(registerDeleteRoute, async (context) => {
    const { entryId } = context.req.valid("param");
    const entry = await getServices(context).registerService.deleteRegisterEntry(entryId);
    return context.json(entry, 200);
  });

  app.openapi(transactionDetailRoute, async (context) => {
    const { transactionId } = context.req.valid("param");
    const detail = await getServices(context).registerService.getTransactionDetail(transactionId);
    return context.json(detail, 200);
  });
}
