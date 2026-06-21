import { createRoute, z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { APP_ENV, ACCOUNTING_CONFIG, COMPANY } from "@/configuration";

const healthResponseSchema = zod.object({
  status: zod.number(),
  timestamp: zod.string(),
  env: zod.string(),
  company: zod.string(),
  accounting: zod.object({
    basis: zod.enum(["cash", "accrual"]),
  }),
});

const healthRoute = createRoute({
  method: "get",
  path: "/api/health",
  responses: {
    200: {
      content: { "application/json": { schema: healthResponseSchema } },
      description: "Health check",
    },
  },
});

export function healthRoutes(app: OpenAPIHono): void {
  app.openapi(healthRoute, (response) => {
    const data = {
        status: 200,
        timestamp: new Date().toISOString(),
        env: APP_ENV,
        company: COMPANY,
        accounting: ACCOUNTING_CONFIG,
    }
    return response.json(data, 200);
  });
}