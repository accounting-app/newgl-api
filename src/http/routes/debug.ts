import { createRoute, z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { APP_ENV, LEDGER_FILE } from "@/configuration";

const ledgerSourceRoute = createRoute({
  method: "get",
  path: "/api/debug/ledger-source",
  responses: {
    200: {
      content: { "text/plain": { schema: zod.string() } },
      description: "Raw company.bean contents (temporary debug endpoint)",
    },
    404: {
      description: "Ledger file not found",
    },
  },
});

export function debugRoutes(app: OpenAPIHono): void {
  app.openapi(ledgerSourceRoute, async (context) => {
    // Optional: restrict to non-production
    if (APP_ENV === "production") {
      return context.text("Not found", 404);
    }

    const file = Bun.file(LEDGER_FILE);
    if (!(await file.exists())) {
      return context.text(`Ledger file not found: ${LEDGER_FILE}`, 404);
    }

    const source = await file.text();
    return context.text(source, 200);
  });
}