import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import type { ServiceContainer } from "@/application/service-container";
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
      content: { "application/json": { schema: z.array(accountSchema) } },
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
    params: z.object({ accountId: z.string().uuid() })
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
    params: z.object({ accountId: z.string().uuid() }),
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
    params: z.object({ accountId: z.string().uuid() })
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.array(registerEntrySchema) } },
      description: "Register entries"
    }
  }
});

export function accountRoutes(app: OpenAPIHono, services: ServiceContainer): void {
  app.openapi(accountListRoute, async (c) => {
    const accounts = await services.accountService.listAccounts();
    return c.json(accounts, 200);
  });

  app.openapi(accountCreateRoute, async (c) => {
    const input = c.req.valid("json");
    const account = await services.accountService.createAccount(input);
    return c.json(account, 201);
  });

  app.openapi(accountGetRoute, async (c) => {
    const { accountId } = c.req.valid("param");
    const account = await services.accountService.getAccountById(accountId);
    return c.json(account, 200);
  });

  app.openapi(accountUpdateRoute, async (c) => {
    const { accountId } = c.req.valid("param");
    const input = c.req.valid("json");
    const account = await services.accountService.updateAccount(accountId, input);
    return c.json(account, 200);
  });

  app.openapi(accountRegisterRoute, async (c) => {
    const { accountId } = c.req.valid("param");
    const entries = await services.registerService.listRegisterEntries(accountId);
    return c.json(entries, 200);
  });
}
