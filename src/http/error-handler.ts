import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";

import { AppError, NotFoundError } from "@/core/errors";

export const errorHandler: ErrorHandler = (error, context) => {
  if (error instanceof NotFoundError) {
    return context.json({ error: error.message }, 404);
  }
  if (error instanceof AppError) {
    return context.json({ error: error.message }, error.statusCode as any);
  }
  if (error instanceof HTTPException) {
    return context.json({ error: error.message }, error.status);
  }
  console.error(error);
  return context.json({ error: "Internal Server Error" }, 500);
};
