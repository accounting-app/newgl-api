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
 * Integration tests for Phase 4 (AI_INTEGRATION_PLAN.md Part 7, feature #1):
 * POST /api/ai/column-mapping. Spawns a real newgl-ai process (AI_TEST_MODE=true,
 * see tests/helpers/newgl-ai-process.ts) so the whole chain -- auth, tenant
 * resolution, plan-limit lookup, the internal proxy call, quota enforcement --
 * runs for real, without ever touching the real Anthropic API.
 */

const CSV_HEADER = ["Date", "Description", "Amount", "Check #"];
const SAMPLE_ROWS = [["2024-01-01", "Coffee Shop", "-4.50", "1001"]];

describe("Phase 4: POST /api/ai/column-mapping", () => {
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
          " -- skipping AI column-mapping integration tests. Run `bunx supabase start` to enable them."
      );
      return;
    }

    newglAi = await startNewglAiForTests();
    if (!newglAi) {
      reachable = false;
      console.warn("Could not start a newgl-ai test instance -- skipping AI column-mapping integration tests.");
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

  test("returns a suggested mapping for a fresh tenant well under quota", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("colmap-ok");

    const res = await app.request("/api/ai/column-mapping", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ csvHeader: CSV_HEADER, sampleRows: SAMPLE_ROWS })
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mapping: Record<string, number | null>; keySource: string };
    expect(body.mapping.transactionDate).toBe(0);
    expect(body.mapping.payee).toBe(1);
    expect(body.keySource).toBe("platform");
  });

  test("rejects a request with no CSV header", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("colmap-bad-input");

    const res = await app.request("/api/ai/column-mapping", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ csvHeader: [], sampleRows: SAMPLE_ROWS })
    });
    expect(res.status).toBe(400);
  });

  test("returns 402 once the tenant's plan-free-tier quota is exhausted", async () => {
    if (!reachable) return;
    const { headers, tenantId } = await bootstrapUser("colmap-quota");

    // Seed usage directly -- this tenant's free plan allows 200 actions/month.
    await getSql()`
      insert into ai_usage (tenant_id, feature, model, key_source, actions)
      values (${tenantId}, 'column-mapping', 'claude-opus-4-8', 'platform', 200)
    `;

    const res = await app.request("/api/ai/column-mapping", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ csvHeader: CSV_HEADER, sampleRows: SAMPLE_ROWS })
    });
    expect(res.status).toBe(402);
  });

  test("a BYOK tenant is never blocked by the platform quota", async () => {
    if (!reachable) return;
    const { headers, tenantId } = await bootstrapUser("colmap-byok");

    await app.request("/api/ai/key", {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-ant-test-valid-abcdef1234567890" })
    });
    await getSql()`
      insert into ai_usage (tenant_id, feature, model, key_source, actions)
      values (${tenantId}, 'column-mapping', 'claude-opus-4-8', 'byok', 100000)
    `;

    const res = await app.request("/api/ai/column-mapping", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ csvHeader: CSV_HEADER, sampleRows: SAMPLE_ROWS })
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keySource: string };
    expect(body.keySource).toBe("byok");
  });

  test("usage recorded by column-mapping shows up in GET /api/ai/usage", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("colmap-usage-reflected");

    await app.request("/api/ai/column-mapping", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ csvHeader: CSV_HEADER, sampleRows: SAMPLE_ROWS })
    });

    const usageRes = await app.request("/api/ai/usage", { headers });
    const body = (await usageRes.json()) as { summary: { totalActions: number } };
    expect(body.summary.totalActions).toBe(1);
  });
});
