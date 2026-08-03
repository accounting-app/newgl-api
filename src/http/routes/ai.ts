import { z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { getTenantId } from "@/http/context";
import { getSql } from "@/infra/postgres/client";

const setKeyInputSchema = zod.object({
  apiKey: zod.string().min(20),
  modelOverride: zod.string().min(1).optional()
});

const columnMappingInputSchema = zod.object({
  csvHeader: zod.array(zod.string()).min(1).max(100),
  // "header + 3 sample rows" per AI_INTEGRATION_PLAN.md Part 1b -- capped
  // here too so a caller can't blow up the request forwarded to newgl-ai.
  sampleRows: zod.array(zod.array(zod.string())).min(1).max(3)
});

const normalizePayeesInputSchema = zod.object({
  payees: zod.array(zod.string().min(1)).min(1).max(200)
});

const learnPayeeRulesInputSchema = zod.object({
  rules: zod
    .array(
      zod.object({
        payee: zod.string().min(1),
        accountId: zod.string().min(1),
        canonicalPayee: zod.string().min(1).optional()
      })
    )
    .min(1)
    .max(500)
});

type PlanLimits = { monthlyAiActions: number; monthlyTokenCap: number };

async function getPlanLimits(tenantId: string): Promise<PlanLimits | null> {
  const sql = getSql();
  const rows = await sql`
    select p.monthly_ai_actions, p.monthly_token_cap
    from tenants t
    join plans p on p.id = t.plan_id
    where t.id = ${tenantId}
    limit 1
  `;
  const row = rows[0] as { monthly_ai_actions: number; monthly_token_cap: number } | undefined;
  return row ? { monthlyAiActions: row.monthly_ai_actions, monthlyTokenCap: row.monthly_token_cap } : null;
}

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

    // Plan limits live in newgl-api's own tables (Part 1b: "newgl-ai
    // enforces the quota but does not know what a plan is").
    const limits = await getPlanLimits(tenantId);

    const query = new URLSearchParams({ tenantId });
    if (limits) {
      query.set("monthlyAiActions", String(limits.monthlyAiActions));
      query.set("monthlyTokenCap", String(limits.monthlyTokenCap));
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

  // AI_INTEGRATION_PLAN.md Part 7, feature #1: the first real AI feature.
  // Proves key resolution, metering, quota, and 402 handling end-to-end on
  // a low-risk feature -- being wrong here costs one dropdown click, not a
  // bad accounting entry.
  app.post("/api/ai/column-mapping", async (context) => {
    const tenantId = getTenantId(context);
    const rawBody = await context.req.json().catch(() => null);
    const parsed = columnMappingInputSchema.safeParse(rawBody);
    if (!parsed.success) {
      return context.json(
        { error: { message: parsed.error.issues.map((issue) => issue.message).join("; ") } },
        400
      );
    }

    const limits = await getPlanLimits(tenantId);
    const payload: Record<string, unknown> = { tenantId, ...parsed.data };
    if (limits) {
      payload.monthlyAiActions = limits.monthlyAiActions;
      payload.monthlyTokenCap = limits.monthlyTokenCap;
    }

    let response: Response;
    try {
      response = await callNewglAi("/internal/ai/column-mapping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    } catch {
      return context.json({ error: { message: "Could not reach the AI service" } }, 503);
    }

    const body = await response.json();
    // 200 success, 400 invalid input, 402 quota exceeded -- all opaque
    // passthrough of newgl-ai's own response.
    return context.json(body, response.status as 200 | 400 | 402);
  });

  // AI_INTEGRATION_PLAN.md Part 7, feature #2: payee normalization. Feeds
  // the learned-rules cascade that's what makes Phase 6 (categorization)
  // cheap -- most rows never reach Anthropic once a tenant's payees have
  // been seen once.
  app.post("/api/ai/payees/normalize", async (context) => {
    const tenantId = getTenantId(context);
    const rawBody = await context.req.json().catch(() => null);
    const parsed = normalizePayeesInputSchema.safeParse(rawBody);
    if (!parsed.success) {
      return context.json(
        { error: { message: parsed.error.issues.map((issue) => issue.message).join("; ") } },
        400
      );
    }

    const limits = await getPlanLimits(tenantId);
    const payload: Record<string, unknown> = { tenantId, ...parsed.data };
    if (limits) {
      payload.monthlyAiActions = limits.monthlyAiActions;
      payload.monthlyTokenCap = limits.monthlyTokenCap;
    }

    let response: Response;
    try {
      response = await callNewglAi("/internal/ai/payees/normalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    } catch {
      return context.json({ error: { message: "Could not reach the AI service" } }, 503);
    }

    const body = await response.json();
    return context.json(body, response.status as 200 | 400 | 402);
  });

  // Confirmed (payee -> accountId) pairs from a completed import -- Part 1b:
  // "feeds the cascade". No prompt construction, no Anthropic call; this
  // just forwards to newgl-ai's payee_rules writer.
  app.post("/api/ai/rules/learn", async (context) => {
    const tenantId = getTenantId(context);
    const rawBody = await context.req.json().catch(() => null);
    const parsed = learnPayeeRulesInputSchema.safeParse(rawBody);
    if (!parsed.success) {
      return context.json(
        { error: { message: parsed.error.issues.map((issue) => issue.message).join("; ") } },
        400
      );
    }

    let response: Response;
    try {
      response = await callNewglAi("/internal/ai/rules/learn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId, ...parsed.data })
      });
    } catch {
      return context.json({ error: { message: "Could not reach the AI service" } }, 503);
    }

    const body = await response.json();
    return context.json(body, response.status as 200 | 400);
  });
}
