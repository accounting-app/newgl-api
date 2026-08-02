import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";

import { requestLogger } from "@/http/middleware";
import { tenantContext } from "@/http/middleware/auth";

import type { ServiceContainer } from "@/application/service-container";
import { errorHandler } from "@/http/error-handler";
import {
  debugRoutes,
  accountRoutes,
  ledgerRoutes,
  openApiRoutes,
  transactionRoutes,
  healthRoutes,
  ledgerDownloadRoutes,
  tenantRoutes,
  ledgerRoutesV2
} from "@/http/routes";

// `defaultServices` is a test-mode escape hatch: existing tests and scripts
// (tests/helpers/create-test-app.ts, scripts/generate-openapi.ts) predate
// multi-tenancy and build one repository directly with no auth. Passing it
// here makes every request use that fixed container, bypassing auth and
// tenant resolution entirely. Production (src/index.ts) calls createApp()
// with no argument, so every request goes through the real Supabase-JWT +
// membership-lookup path in tenantContext().
export function createApp(defaultServices?: ServiceContainer) {
  const app = new OpenAPIHono();

  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "X-Debug-Password", "Authorization"]
    })
  );
  app.use("*", requestLogger());
  app.use("*", tenantContext(defaultServices));

  app.onError(errorHandler);

  openApiRoutes(app);
  healthRoutes(app);
  debugRoutes(app);
  tenantRoutes(app);

  accountRoutes(app);
  transactionRoutes(app);
  ledgerRoutes(app);
  ledgerDownloadRoutes(app);
  ledgerRoutesV2(app);
  return app;
}
