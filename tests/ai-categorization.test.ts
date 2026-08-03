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
 * Integration tests for Phase 6 (AI_INTEGRATION_PLAN.md Part 7, feature #3):
 * POST /api/ai/categorize. Spawns a real newgl-ai process (AI_TEST_MODE=true)
 * exactly like the Phase 4/5 tests -- auth, tenant resolution, chart-of-
 * accounts loading, the internal proxy call, and quota enforcement all run
 * for real, without ever touching the real Anthropic API.
 *
 * A freshly-bootstrapped tenant currently starts with an empty chart of
 * accounts (AI_INTEGRATION_PLAN.md Part 3's starter-seed step isn't wired up
 * yet -- a separate, pre-existing gap), so each test creates the couple of
 * accounts it needs via POST /api/accounts first. The fake Anthropic
 * client's amount-sign fallback needs at least one INCOME and one EXPENSE
 * account to have something to match against.
 */

describe("Phase 6: POST /api/ai/categorize", () => {
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

  async function seedAccounts(headers: HeadersInit): Promise<void> {
    for (const account of [
      { code: "1000", name: "Cash", category: "BANK" },
      { code: "5000", name: "Office Supplies", category: "EXPENSE" },
      { code: "4000", name: "Consulting Income", category: "INCOME" }
    ]) {
      await app.request("/api/accounts", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(account)
      });
    }
  }

  beforeAll(async () => {
    reachable = await localSupabaseStackIsReachable();
    if (!reachable) {
      console.warn(
        "Local Supabase/Postgres not reachable at " +
          SUPABASE_URL +
          " -- skipping AI categorization integration tests. Run `bunx supabase start` to enable them."
      );
      return;
    }

    newglAi = await startNewglAiForTests();
    if (!newglAi) {
      reachable = false;
      console.warn("Could not start a newgl-ai test instance -- skipping AI categorization integration tests.");
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

  test("suggests an account for each transaction using the tenant's real chart of accounts", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("categorize-ok");
    await seedAccounts(headers);

    const res = await app.request("/api/ai/categorize", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ transactions: [{ payee: "Client Payment", amount: 1000 }] })
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ accountId: string | null; resolvedBy: string }>;
      keySource: string;
    };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]!.accountId).not.toBeNull(); // amount-sign fallback should find an INCOME account
    expect(body.results[0]!.resolvedBy).toBe("ai");
    expect(body.keySource).toBe("platform");
  });

  test("a payee confirmed via /api/ai/rules/learn resolves from the rule on the next call", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("categorize-cascade");
    await seedAccounts(headers);

    const first = await app.request("/api/ai/categorize", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ transactions: [{ payee: "ACME OFFICE SUPPLY #99", amount: -20 }] })
    });
    const firstBody = (await first.json()) as { results: Array<{ accountId: string | null }> };
    const learnedAccountId = firstBody.results[0]!.accountId;
    expect(learnedAccountId).not.toBeNull();

    await app.request("/api/ai/rules/learn", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ rules: [{ payee: "ACME OFFICE SUPPLY #99", accountId: learnedAccountId }] })
    });

    const second = await app.request("/api/ai/categorize", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ transactions: [{ payee: "ACME OFFICE SUPPLY #12", amount: -20 }] }) // different store number
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      results: Array<{ accountId: string | null; resolvedBy: string }>;
      usage: { actions: number };
    };
    expect(secondBody.results[0]).toMatchObject({ accountId: learnedAccountId, resolvedBy: "rule" });
    expect(secondBody.usage.actions).toBe(0);
  });

  test("rejects a request with an empty transactions array", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("categorize-bad-input");

    const res = await app.request("/api/ai/categorize", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ transactions: [] })
    });
    expect(res.status).toBe(400);
  });

  test("returns 402 once the tenant's plan-free-tier quota is exhausted", async () => {
    if (!reachable) return;
    const { headers, tenantId } = await bootstrapUser("categorize-quota");
    await seedAccounts(headers);

    await getSql()`
      insert into ai_usage (tenant_id, feature, model, key_source, actions)
      values (${tenantId}, 'categorization', 'claude-opus-4-8', 'platform', 200)
    `;

    const res = await app.request("/api/ai/categorize", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ transactions: [{ payee: "A Brand New Payee", amount: -1 }] })
    });
    expect(res.status).toBe(402);
  });

  test("a BYOK tenant is never blocked by the platform quota", async () => {
    if (!reachable) return;
    const { headers, tenantId } = await bootstrapUser("categorize-byok");
    await seedAccounts(headers);

    await app.request("/api/ai/key", {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-ant-test-valid-abcdef1234567890" })
    });
    await getSql()`
      insert into ai_usage (tenant_id, feature, model, key_source, actions)
      values (${tenantId}, 'categorization', 'claude-opus-4-8', 'byok', 100000)
    `;

    const res = await app.request("/api/ai/categorize", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ transactions: [{ payee: "A Brand New Payee", amount: -1 }] })
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keySource: string };
    expect(body.keySource).toBe("byok");
  });

  test("usage recorded by categorization is metered per AI-resolved row, and shows up in GET /api/ai/usage", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("categorize-usage-reflected");
    await seedAccounts(headers);

    await app.request("/api/ai/categorize", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        transactions: [
          { payee: "Brand New Payee One", amount: -1 },
          { payee: "Brand New Payee Two", amount: -2 }
        ]
      })
    });

    const usageRes = await app.request("/api/ai/usage", { headers });
    const body = (await usageRes.json()) as { summary: { totalActions: number } };
    expect(body.summary.totalActions).toBe(2); // 2 rows sent to the model, not 1 batch call
  });
});
