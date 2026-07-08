import { createRoute, z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { isValidPassword } from "@/shared/utils/validate";

const ledgerDownloadRoute = createRoute({
  method: "get",
  path: "/api/ledger/download", // pick your own path
  request: {
    headers: zod.object({
      "x-debug-password": zod.string().min(1),
    }),
  },
  responses: {
    200: {
      content: { "application/octet-stream": { schema: zod.string() } },
      description: "Download company.bean",
    },
    401: { description: "Invalid password" },
    404: { description: "Not found" },
  },
});

function isLedgerDownloadAllowed(): boolean {
  const testMode = (process.env.TEST_MODE ?? "false") === "true";
  const allowRead = (process.env.ALLOW_LEDGER_READ ?? "false") === "true";
  return testMode && allowRead;
}

export function ledgerDownloadRoutes(app: OpenAPIHono): void {
  app.openapi(ledgerDownloadRoute, async (context) => {
    const ledgerFile = process.env.LEDGER_FILE ?? "data/company.bean";
    const { "x-debug-password": passwordHeader } = context.req.valid("header");
    const expectedPassword = process.env.DEBUG_LEDGER_PASSWORD ?? "";

    if (!expectedPassword || !isLedgerDownloadAllowed()) {
      return context.body(null, 404);
    }

    if (!isValidPassword(passwordHeader, expectedPassword)) {
      return context.json({ error: "Unauthorized" }, 401);
    }

    const file = Bun.file(ledgerFile);
    if (!(await file.exists())) {
      return context.text(`Ledger file not found: ${ledgerFile}`, 404);
    }

    const filename = ledgerFile.split("/").pop() ?? "company.bean";

    // attachment = browser download; inline = show in browser (current debug behavior)
    return context.body(await file.arrayBuffer(), 200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    });
  });
}