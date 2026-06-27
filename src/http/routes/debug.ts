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


    const ledgerFile = process.env.LEDGER_FILE ?? "data/company.bean";
     const { "x-debug-password": DEBUG_PASSWORD_HEADER } = context.req.valid("header");
   
    const ALLOW_LEDGER_READ = process.env.ALLOW_LEDGER_READ ?? "false";
    const isAllowedLedgerRead = ALLOW_LEDGER_READ === "true";
    const TEST_MODE = process.env.TEST_MODE ?? "false";
    const isTestMode = TEST_MODE === "true";
    const isTestModeOrNotAllowed =  isTestMode && isAllowedLedgerRead
   
    // Note: Uncomment this to return 404 in production.
    // const isAppEnvProduction = APP_ENV  === "production";
    // if(isAppEnvProduction) {
    //   return context.json({APP_ENV, DEBUG_PASSWORD_HEADER, ALLOW_LEDGER_READ, TEST_MODE }, 404);
    // }
    const DEBUG_LEDGER_PASSWORD = process.env.DEBUG_LEDGER_PASSWORD ?? "";
    if (!DEBUG_LEDGER_PASSWORD || !isTestModeOrNotAllowed) {
      const data = {
        APP_ENV,
        DEBUG_PASSWORD_HEADER,
        DEBUG_LEDGER_PASSWORD,
        ALLOW_LEDGER_READ,
        TEST_MODE,
        TYPESTAMP: new Date().toISOString(),
      }
      return context.json(data, 404);
    }

    const isValid = isValidPassword(DEBUG_PASSWORD_HEADER, DEBUG_LEDGER_PASSWORD)
    if (!isValid) {
      return context.json({ error: "Unauthorized" }, 401);
    }

    const file = Bun.file(ledgerFile);
    if (!(await file.exists())) {
      return context.text(`Ledger file not found: ${ledgerFile}`, 404);
    }

    return context.text(await file.text(), 200);
  });
}
