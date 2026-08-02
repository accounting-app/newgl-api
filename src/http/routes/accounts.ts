import { createRoute, z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { getServices } from "@/http/context";
import {
  accountSchema,
  createAccountInputSchema,
  errorResponseSchema,
  registerEntrySchema,
  updateAccountInputSchema
} from "@/domain/models";

const accountListRoute = createRoute({
  method: "get",
  path: "/api/accounts",
  responses: {
    200: {
      content: { "application/json": { schema: zod.array(accountSchema) } },
      description: "List accounts"
    }
  }
});

const accountCreateRoute = createRoute({
  method: "post",
  path: "/api/accounts",
  request: {
    body: {
      content: { "application/json": { schema: createAccountInputSchema } }
    }
  },
  responses: {
    201: {
      content: { "application/json": { schema: accountSchema } },
      description: "Created account"
    },
    400: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "Validation error"
    }
  }
});

const accountGetRoute = createRoute({
  method: "get",
  path: "/api/accounts/{accountId}",
  request: {
    params: zod.object({ accountId: zod.string().uuid() })
  },
  responses: {
    200: {
      content: { "application/json": { schema: accountSchema } },
      description: "Account details"
    },
    404: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "Not found"
    }
  }
});

const accountUpdateRoute = createRoute({
  method: "patch",
  path: "/api/accounts/{accountId}",
  request: {
    params: zod.object({ accountId: zod.string().uuid() }),
    body: {
      content: { "application/json": { schema: updateAccountInputSchema } }
    }
  },
  responses: {
    200: {
      content: { "application/json": { schema: accountSchema } },
      description: "Updated account"
    }
  }
});

const accountRegisterRoute = createRoute({
  method: "get",
  path: "/api/accounts/{accountId}/register",
  request: {
    params: zod.object({ accountId: zod.string().uuid() })
  },
  responses: {
    200: {
      content: { "application/json": { schema: zod.array(registerEntrySchema) } },
      description: "Register entries"
    }
  }
});

export function accountRoutes(app: OpenAPIHono): void {
  app.openapi(accountListRoute, async (context) => {
    const accounts = await getServices(context).accountService.listAccounts();
    return context.json(accounts, 200);
  });

  app.openapi(accountCreateRoute, async (context) => {
    const input = context.req.valid("json");
    const account = await getServices(context).accountService.createAccount(input);
    return context.json(account, 201);
  });

  app.openapi(accountGetRoute, async (context) => {
    const { accountId } = context.req.valid("param");
    const account = await getServices(context).accountService.getAccountById(accountId);
    return context.json(account, 200);
  });

  app.openapi(accountUpdateRoute, async (context) => {
    const { accountId } = context.req.valid("param");
    const input = context.req.valid("json");
    const account = await getServices(context).accountService.updateAccount(accountId, input);
    return context.json(account, 200);
  });

  app.openapi(accountRegisterRoute, async (context) => {
    const { accountId } = context.req.valid("param");
    const entries = await getServices(context).registerService.listRegisterEntries(accountId);
    return context.json(entries, 200);
  });
}
