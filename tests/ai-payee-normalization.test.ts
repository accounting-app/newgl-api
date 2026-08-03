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
 * Integration tests for Phase 5 (AI_INTEGRATION_PLAN.md Part 7, feature #2):
 * POST /api/ai/payees/normalize and POST /api/ai/rules/learn. Spawns a real
 * newgl-ai process (AI_TEST_MODE=true) exactly like the Phase 4 column-
 * mapping tests, so auth, tenant resolution, plan-limit lookup, the internal
 * proxy call, and quota enforcement all run for real.
 */

describe("Phase 5: POST /api/ai/payees/normalize, POST /api/ai/rules/learn", () => {
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
          " -- skipping AI payee-normalization integration tests. Run `bunx supabase start` to enable them."
      );
      return;
    }

    newglAi = await startNewglAiForTests();
    if (!newglAi) {
      reachable = false;
      console.warn("Could not start a newgl-ai test instance -- skipping AI payee-normalization integration tests.");
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

  test("normalizes a fresh batch of payees for a platform-key tenant well under quota", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("payee-ok");

    const res = await app.request("/api/ai/payees/normalize", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ payees: ["SQ *COFFEE SHOP #4432"] })
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ canonicalPayee: string; resolvedBy: string }>; keySource: string };
    expect(body.results[0]!.canonicalPayee).toBe("Coffee Shop");
    expect(body.results[0]!.resolvedBy).toBe("ai");
    expect(body.keySource).toBe("platform");
  });

  test("a repeat import of the same merchant resolves from the learned rule with zero new actions", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("payee-cascade");

    await app.request("/api/ai/payees/normalize", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ payees: ["SQ *COFFEE SHOP #4432"] })
    });

    const res = await app.request("/api/ai/payees/normalize", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ payees: ["SQ *Coffee Shop #7781"] })
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ resolvedBy: string; canonicalPayee: string }>; usage: { actions: number } };
    expect(body.results[0]!.resolvedBy).toBe("rule");
    expect(body.results[0]!.canonicalPayee).toBe("Coffee Shop");
    expect(body.usage.actions).toBe(0);

    const usageRes = await app.request("/api/ai/usage", { headers });
    const usageBody = (await usageRes.json()) as { summary: { totalActions: number } };
    expect(usageBody.summary.totalActions).toBe(1); // only the first call counted
  });

  test("rejects a request with an empty payees array", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("payee-bad-input");

    const res = await app.request("/api/ai/payees/normalize", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ payees: [] })
    });
    expect(res.status).toBe(400);
  });

  test("returns 402 once the tenant's plan-free-tier quota is exhausted", async () => {
    if (!reachable) return;
    const { headers, tenantId } = await bootstrapUser("payee-quota");

    await getSql()`
      insert into ai_usage (tenant_id, feature, model, key_source, actions)
      values (${tenantId}, 'payee-normalization', 'claude-opus-4-8', 'platform', 200)
    `;

    const res = await app.request("/api/ai/payees/normalize", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ payees: ["A BRAND NEW PAYEE"] })
    });
    expect(res.status).toBe(402);
  });

  test("a BYOK tenant is never blocked by the platform quota", async () => {
    if (!reachable) return;
    const { headers, tenantId } = await bootstrapUser("payee-byok");

    await app.request("/api/ai/key", {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-ant-test-valid-abcdef1234567890" })
    });
    await getSql()`
      insert into ai_usage (tenant_id, feature, model, key_source, actions)
      values (${tenantId}, 'payee-normalization', 'claude-opus-4-8', 'byok', 100000)
    `;

    const res = await app.request("/api/ai/payees/normalize", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ payees: ["A BRAND NEW PAYEE"] })
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keySource: string };
    expect(body.keySource).toBe("byok");
  });

  test("POST /api/ai/rules/learn acks a confirmed (payee -> accountId) pair and it's picked up on the next import", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("payee-learn");

    const learnRes = await app.request("/api/ai/rules/learn", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        rules: [{ payee: "ACME OFFICE SUPPLY #99", accountId: "Expenses:Office:Supplies", canonicalPayee: "Acme Office Supply" }]
      })
    });
    expect(learnRes.status).toBe(200);
    const learnBody = (await learnRes.json()) as { learned: number };
    expect(learnBody.learned).toBe(1);

    const normalizeRes = await app.request("/api/ai/payees/normalize", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ payees: ["ACME OFFICE SUPPLY #12"] })
    });
    const body = (await normalizeRes.json()) as {
      results: Array<{ resolvedBy: string; canonicalPayee: string; accountId: string | null }>;
    };
    expect(body.results[0]).toMatchObject({
      resolvedBy: "rule",
      canonicalPayee: "Acme Office Supply",
      accountId: "Expenses:Office:Supplies"
    });
  });

  test("POST /api/ai/rules/learn rejects an empty rules array", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("payee-learn-bad-input");

    const res = await app.request("/api/ai/rules/learn", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ rules: [] })
    });
    expect(res.status).toBe(400);
  });
});
