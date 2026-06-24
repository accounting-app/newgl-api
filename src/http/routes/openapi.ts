import { swaggerUI } from "@hono/swagger-ui";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { APP_ENV } from "@/configuration";

const openApiDocument = {
  openapi: "3.1.0" as const,
  info: {
    title: "New GL API",
    version: "1.0.0"
  },
  servers: [{ url: "/api" }]
};

export function openApiRoutes(app: OpenAPIHono): void {
  app.doc("/openapi.json", openApiDocument);

  if (APP_ENV === "local" || APP_ENV === "development") {
    app.get("/docs", swaggerUI({ url: "/openapi.json" }));
  }
}
