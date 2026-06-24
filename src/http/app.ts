import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";

import type { ServiceContainer } from "@/application/service-container";
import { errorHandler } from "@/http/error-handler";
import { debugRoutes, accountRoutes, ledgerRoutes, openApiRoutes, transactionRoutes, healthRoutes } from "@/http/routes";

export function createApp(services: ServiceContainer) {
  const app = new OpenAPIHono();

  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type"]
    })
  );

  app.onError(errorHandler);
  
  openApiRoutes(app);
  healthRoutes(app);
  debugRoutes(app);

  accountRoutes(app, services);
  transactionRoutes(app, services);
  ledgerRoutes(app, services);

  return app;
}
