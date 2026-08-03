import { z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { getTenantId } from "@/http/context";
import { getSql } from "@/infra/postgres/client";

const setKeyInputSchema = zod.object({
  apiKey: zod.string().min(20),
  modelOverride: zod.string().min(1).optional()
});

// Read directly from process.env (rather than the frozen consts in
// @/configuration) so integration tests can point this at a freshly-spawned
// newgl-ai instance on a random port without needing to reload modules.
function requireNewglAiConfig(): { baseUrl: string; token: string } {
  const baseUrl = process.env.NEWGL_AI_URL;
  const token = process.env.INTERNAL_SERVICE_TOKEN;
  if (!baseUrl || !token) {
    throw new Error("NEWGL_AI_URL and INTERNAL_SERVICE_TOKEN must both be set to reach newgl-ai");
  }
  return { baseUrl, token };
}

async function callNewglAi(path: string, init?: RequestInit): Promise<Response> {
  const { baseUrl, token } = requireNewglAiConfig();
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      "X-Internal-Token": token
    }
  });
}

/**
 * Thin proxy over newgl-ai's /internal/ai/* endpoints -- see
 * AI_INTEGRATION_PLAN.md Part 1b. newgl-api's job here is: verify the user
 * (already done by tenantContext), resolve the tenant, forward the request
 * with the shared secret, translate the response. No prompt construction,
 * no Anthropic calls, no plaintext key ever touches this process.
 *
 * Registered as plain Hono routes rather than app.openapi(): the response
 * body and status here are an opaque passthrough of whatever newgl-ai
 * returns, which doesn't fit zod-openapi's per-status literal typing. The
 * request-side validation (setKeyInputSchema) still runs by hand below.
 */
export function aiRoutes(app: OpenAPIHono): void {
  app.put("/api/ai/key", async (context) => {
    const tenantId = getTenantId(context);
    const rawBody = await context.req.json().catch(() => null);
    const parsed = setKeyInputSchema.safeParse(rawBody);
    if (!parsed.success) {
      return context.json(
        { error: { message: parsed.error.issues.map((issue) => issue.message).join("; ") } },
        400
      );
    }

    let response: Response;
    try {
      response = await callNewglAi("/internal/ai/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId, ...parsed.data })
      });
    } catch {
      return context.json({ error: { message: "Could not reach the AI service" } }, 503);
    }

    const body = await response.json();
    return context.json(body, response.status as 200);
  });

  app.delete("/api/ai/key", async (context) => {
    const tenantId = getTenantId(context);

    let response: Response;
    try {
      response = await callNewglAi("/internal/ai/credentials", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId })
      });
    } catch {
      return context.json({ error: { message: "Could not reach the AI service" } }, 503);
    }

    if (response.status === 204) {
      return context.body(null, 204);
    }
    const body = await response.json();
    return context.json(body, response.status as 400);
  });

  app.get("/api/ai/status", async (context) => {
    const tenantId = getTenantId(context);

    let response: Response;
    try {
      response = await callNewglAi(`/internal/ai/status?tenantId=${encodeURIComponent(tenantId)}`);
    } catch {
      return context.json({ error: { message: "Could not reach the AI service" } }, 503);
    }

    const body = await response.json();
    return context.json(body, 200);
  });

  app.get("/api/ai/usage", async (context) => {
    const tenantId = getTenantId(context);
    const sql = getSql();

    // Plan limits live in newgl-api's own tables (Part 1b: "newgl-ai
    // enforces the quota but does not know what a plan is").
    const rows = await sql`
      select p.monthly_ai_actions, p.monthly_token_cap
      from tenants t
      join plans p on p.id = t.plan_id
      where t.id = ${tenantId}
      limit 1
    `;
    const limits = rows[0] as { monthly_ai_actions: number; monthly_token_cap: number } | undefined;

    const query = new URLSearchParams({ tenantId });
    if (limits) {
      query.set("monthlyAiActions", String(limits.monthly_ai_actions));
      query.set("monthlyTokenCap", String(limits.monthly_token_cap));
    }

    let response: Response;
    try {
      response = await callNewglAi(`/internal/ai/usage?${query.toString()}`);
    } catch {
      return context.json({ error: { message: "Could not reach the AI service" } }, 503);
    }

    const body = await response.json();
    return context.json(body, 200);
  });
}
