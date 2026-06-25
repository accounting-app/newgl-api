import { createRoute, z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { APP_ENV, ACCOUNTING_CONFIG, COMPANY, LEDGER_FILE } from "@/configuration";



const healthResponseSchema = zod.object({
  status: zod.number(),
  timestamp: zod.string(),
  env: zod.string(),
  company: zod.string(),
  accounting: zod.object({
    basis: zod.enum(["cash", "accrual"]),
  }),
  ledger: zod.object({
    filename: zod.string(),
    updated_at_commit_hash: zod.string(),
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
  app.openapi(healthRoute, async (context) => {
    const data = {
      status: 200,
      timestamp: new Date().toISOString(),
      env: APP_ENV,
      company: COMPANY,
      accounting: ACCOUNTING_CONFIG,
      ledger: {
        filename: LEDGER_FILE,
        // updated_at_commit_hash is the hash of the last commit to the ledger file.
        updated_at_commit_hash: '37f57f4994c10a5a0b95a595f68623352c029caa'
      }
    };
    return context.json(data, 200);
  });
}