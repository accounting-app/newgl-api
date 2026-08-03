import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApp } from "../src/http/app";
import { getSql } from "../src/infra/postgres/client";
import { startNewglAiForTests, type NewglAiTestServer } from "./helpers/newgl-ai-process";
import {
  createConfirmedUser,
  deleteUser,
  localSupabaseStackIsReachable,
  SUPABASE_URL,
  type TestUser
} from "./helpers/supabase-test-auth";

/**
 * Integration tests for Phase 3's newgl-api proxy routes (AI_INTEGRATION_PLAN.md
 * Part 1b / Part 3): PUT/DELETE /api/ai/key, GET /api/ai/status, GET /api/ai/usage.
 *
 * Spawns a real newgl-ai process (see tests/helpers/newgl-ai-process.ts) with
 * AI_FAKE_KEY_VALIDATION=true, then points this newgl-api instance at it via
 * NEWGL_AI_URL/INTERNAL_SERVICE_TOKEN. Requires the same local Supabase stack
 * as the other tenant-* tests; skips with a warning otherwise.
 */

const VALID_KEY = "sk-ant-test-valid-abcdef1234567890";
const INVALID_KEY = "sk-ant-test-invalid-abcdef1234567890";

describe("Phase 3: /api/ai/* proxy routes", () => {
  let app: ReturnType<typeof createApp>;
  let reachable = false;
  let newglAi: NewglAiTestServer | null = null;
  const createdUserIds: string[] = [];
  const createdTenantIds: string[] = [];

  async function bootstrapUser(prefix: string): Promise<{ user: TestUser; headers: HeadersInit; tenantId: string }> {
    const user = await createConfirmedUser(`${prefix}-${crypto.randomUUID()}@example.com`, "password123!");
    createdUserIds.push(user.id);
    const headers = { Authorization: `Bearer ${user.accessToken}` };
    const res = await app.request("/api/tenants/bootstrap", { method: "POST", headers });
    const body = (await res.json()) as { id: string };
    createdTenantIds.push(body.id);
    return { user, headers, tenantId: body.id };
  }

  beforeAll(async () => {
    reachable = await localSupabaseStackIsReachable();
    if (!reachable) {
      console.warn(
        "Local Supabase/Postgres not reachable at " +
          SUPABASE_URL +
          " -- skipping AI proxy integration tests. Run `bunx supabase start` to enable them."
      );
      return;
    }

    newglAi = await startNewglAiForTests();
    if (!newglAi) {
      reachable = false;
      console.warn("Could not start a newgl-ai test instance -- skipping AI proxy integration tests.");
      return;
    }

    process.env.NEWGL_AI_URL = newglAi.baseUrl;
    process.env.INTERNAL_SERVICE_TOKEN = newglAi.internalToken;
    app = createApp();
  });

  afterAll(async () => {
    newglAi?.stop();
    if (!reachable) return;
    for (const tenantId of createdTenantIds) {
      await getSql()`delete from tenants where id = ${tenantId}`.catch(() => {});
    }
    for (const userId of createdUserIds) {
      await deleteUser(userId);
    }
  });

  test("status defaults to the platform key for a freshly-bootstrapped tenant", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("ai-status-default");

    const res = await app.request("/api/ai/status", { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keySource: string; maskedKey: string | null };
    expect(body.keySource).toBe("platform");
    expect(body.maskedKey).toBeNull();
  });

  test("PUT /api/ai/key rejects a key the validator considers invalid", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("ai-key-reject");

    const res = await app.request("/api/ai/key", {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: INVALID_KEY })
    });
    expect(res.status).toBe(400);
  });

  test("PUT /api/ai/key saves a valid key and returns only a masked version, never the plaintext", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("ai-key-set");

    const res = await app.request("/api/ai/key", {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: VALID_KEY })
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { maskedKey: string };
    expect(body.maskedKey).toBe("sk-ant-...7890");
    expect(JSON.stringify(body)).not.toContain(VALID_KEY);

    const status = await (await app.request("/api/ai/status", { headers })).json();
    expect(status).toMatchObject({ keySource: "byok", maskedKey: "sk-ant-...7890" });
  });

  test("DELETE /api/ai/key removes the key and status reverts to platform", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("ai-key-delete");

    await app.request("/api/ai/key", {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: VALID_KEY })
    });

    const del = await app.request("/api/ai/key", { method: "DELETE", headers });
    expect(del.status).toBe(204);

    const status = await (await app.request("/api/ai/status", { headers })).json();
    expect(status).toMatchObject({ keySource: "platform", maskedKey: null });
  });

  test("GET /api/ai/usage resolves this tenant's plan limits from newgl-api's own tables", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("ai-usage-limits");

    const res = await app.request("/api/ai/usage", { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      summary: { totalActions: number };
      limits: { monthlyAiActions: number; monthlyTokenCap: number } | null;
    };
    // Every tenant bootstraps onto the seeded 'free' plan (Phase 3 migration).
    expect(body.limits).toEqual({ monthlyAiActions: 200, monthlyTokenCap: 500000 });
    expect(body.summary.totalActions).toBe(0);
  });

  test("one tenant's AI key is never visible to another tenant via the proxy", async () => {
    if (!reachable) return;
    const { headers: headersA } = await bootstrapUser("ai-isolation-a");
    const { headers: headersB } = await bootstrapUser("ai-isolation-b");

    await app.request("/api/ai/key", {
      method: "PUT",
      headers: { ...headersA, "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: VALID_KEY })
    });

    const statusB = await (await app.request("/api/ai/status", { headers: headersB })).json();
    expect(statusB).toMatchObject({ keySource: "platform", maskedKey: null });
  });

  test("returns 503 rather than crashing when newgl-ai is unreachable", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("ai-unreachable");

    const originalUrl = process.env.NEWGL_AI_URL;
    process.env.NEWGL_AI_URL = "http://127.0.0.1:1"; // nothing listens here
    try {
      const res = await app.request("/api/ai/status", { headers });
      expect(res.status).toBe(503);
    } finally {
      process.env.NEWGL_AI_URL = originalUrl;
    }
  });
});
