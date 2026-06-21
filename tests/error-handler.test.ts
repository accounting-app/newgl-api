import { describe, expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError
} from "../src/core/errors";
import { errorHandler } from "../src/http/error-handler";

function createErrorTestApp() {
  const app = new OpenAPIHono();
  app.onError(errorHandler);

  app.get("/not-found", () => {
    throw new NotFoundError("Resource missing");
  });
  app.get("/validation", () => {
    throw new ValidationError("Invalid input");
  });
  app.get("/conflict", () => {
    throw new ConflictError("Duplicate resource");
  });
  app.get("/app-error", () => {
    throw new AppError("Custom failure", 422);
  });
  app.get("/http-exception", () => {
    throw new HTTPException(403, { message: "Forbidden" });
  });
  app.get("/unknown", () => {
    throw new Error("unexpected");
  });

  return app;
}

describe("errorHandler", () => {
  const app = createErrorTestApp();

  test("maps NotFoundError to 404", async () => {
    const res = await app.request("/not-found");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Resource missing" });
  });

  test("maps ValidationError to 400", async () => {
    const res = await app.request("/validation");
    expect(res.status).toBe(400);
  });

  test("maps ConflictError to 409", async () => {
    const res = await app.request("/conflict");
    expect(res.status).toBe(409);
  });

  test("maps AppError to custom status", async () => {
    const res = await app.request("/app-error");
    expect(res.status).toBe(422);
  });

  test("maps HTTPException to its status", async () => {
    const res = await app.request("/http-exception");
    expect(res.status).toBe(403);
  });

  test("maps unknown errors to 500", async () => {
    const res = await app.request("/unknown");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal Server Error" });
  });
});