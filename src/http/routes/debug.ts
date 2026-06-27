import { createRoute, z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { isValidPassword } from "@/shared/utils/validate";
import { APP_ENV } from "@/configuration";

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


export function debugRoutes(app: OpenAPIHono): void {
  app.openapi(ledgerSourceRoute, async (context) => {
    const appEnv = APP_ENV ?? "local";
    const expectedDebugLedgerPassword = process.env.DEBUG_LEDGER_PASSWORD ?? "";
    const ledgerFile = process.env.LEDGER_FILE ?? "data/company.bean";
    console.log('appEnv: ', appEnv)
    console.log('debugLedgerPassword: ', expectedDebugLedgerPassword)
    console.log('ledgerFile: ', ledgerFile)
    console.log('Object.keys(context): ', Object.keys(context))
    console.log('context.req.header("x-debug-password"): ', context.req.header("x-debug-password"))

    const isAppEnvProduction = appEnv === "production";
    const isTestMode = process.env.TEST_MODE === "true";
    console.log('isAppEnvProduction: ', isAppEnvProduction)
    const { "x-debug-password": password } = context.req.valid("header");
    const isValid = isValidPassword(password, expectedDebugLedgerPassword)
    console.log('password: ', password)
    console.log('isValid: ', isValid)
    console.log('!isValid: ', !isValid)

    if (!expectedDebugLedgerPassword || !isTestMode) {
      return context.json({ expectedDebugLedgerPassword, isAppEnvProduction, isTestMode }, 404);
    }

    if (!isValid) {
      return context.text("Unauthorized", 401);
    }

    const file = Bun.file(ledgerFile);
    if (!(await file.exists())) {
      return context.text(`Ledger file not found: ${ledgerFile}`, 404);
    }

    return context.text(await file.text(), 200);
  });
}
