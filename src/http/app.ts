import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";

import type { ServiceContainer } from "@/application/service-container";
import { AppError, NotFoundError } from "@/core/errors";
import { registerAccountRoutes } from "@/http/routes/accounts";
import { registerLedgerRoutes } from "@/http/routes/ledger";
import { registerTransactionRoutes } from "@/http/routes/transactions";

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

  app.onError((error, c) => {
    if (error instanceof NotFoundError) {
      return c.json({ error: error.message }, 404);
    }
    if (error instanceof AppError) {
      return c.json({ error: error.message }, error.statusCode);
    }
    if (error instanceof HTTPException) {
      return c.json({ error: error.message }, error.status);
    }
    console.error(error);
    return c.json({ error: "Internal Server Error" }, 500);
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

  registerAccountRoutes(app, services);
  registerTransactionRoutes(app, services);
  registerLedgerRoutes(app, services);

  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Bank Register API",
      version: "1.0.0"
    },
    servers: [{ url: "/api" }]
  });

  return app;
}
