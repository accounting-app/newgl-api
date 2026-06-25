import { timingSafeEqual } from "node:crypto";
import { createRoute, z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

const ledgerSourceRoute = createRoute({
  method: "get",
  path: "/api/debug/ledger-source",
  request: {
    headers: zod.object({
      "x-debug-password": zod.string().min(1),
    }),
  },
  responses: {
    200: {
      content: { "text/plain": { schema: zod.string() } },
      description: "Raw company.bean contents (temporary debug endpoint)",
    },
    401: {
      description: "Invalid password",
    },
    404: {
      description: "Not found",
    },
  },
});

function isValidPassword(provided: string, expected: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function debugRoutes(app: OpenAPIHono): void {
  app.openapi(ledgerSourceRoute, async (context) => {
    const appEnv = process.env.APP_ENV ?? "local";
    const expectedPassword = process.env.DEBUG_LEDGER_PASSWORD ?? "";
    const ledgerFile = process.env.LEDGER_FILE ?? "data/company.bean";

    if (appEnv === "production" || !expectedPassword) {
      return context.text("Not found", 404);
    }

    const { "x-debug-password": password } = context.req.valid("header");

    if (!isValidPassword(password, expectedPassword)) {
      return context.text("Unauthorized", 401);
    }

    const file = Bun.file(ledgerFile);
    if (!(await file.exists())) {
      return context.text(`Ledger file not found: ${ledgerFile}`, 404);
    }

    return context.text(await file.text(), 200);
  });
}
