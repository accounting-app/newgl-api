import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApp } from "../src/http/app";
import { getSql } from "../src/infra/postgres/client";
import {
  createConfirmedUser,
  deleteUser,
  localSupabaseStackIsReachable,
  SUPABASE_URL
} from "./helpers/supabase-test-auth";

/**
 * Integration tests for Phase 1 (see AI_INTEGRATION_PLAN.md Part 3):
 *   - JWT verification against the real Supabase JWKS endpoint (no shared secret).
 *   - Per-request tenant resolution -- no boot-time singleton container.
 *   - Idempotent POST /api/tenants/bootstrap.
 *   - Tenant isolation: two users never see each other's ledger data.
 *
 * Requires a local Supabase stack (`bunx supabase start`) and DATABASE_URL /
 * SUPABASE_URL pointed at it -- both already required by .env for local dev.
 * If either isn't reachable, every test skips with a warning instead of
 * failing, mirroring tests/bean-check.test.ts's "optional" pattern.
 */

describe("Phase 1: auth + tenancy", () => {
  let app: ReturnType<typeof createApp>;
  let reachable = false;
  const createdUserIds: string[] = [];
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    reachable = await localSupabaseStackIsReachable();
    if (!reachable) {
      console.warn(
        "Local Supabase/Postgres not reachable at " +
          SUPABASE_URL +
          " -- skipping tenant-auth integration tests. Run `bunx supabase start` to enable them."
      );
      return;
    }
    // No defaultServices: exercises the real production path (tenantContext
    // building a fresh, tenant-scoped ServiceContainer per request).
    app = createApp();
  });

  afterAll(async () => {
    if (!reachable) return;
    for (const tenantId of createdTenantIds) {
      // Cascades to memberships and ledgers/ledger_versions.
      await getSql()`delete from tenants where id = ${tenantId}`.catch(() => {});
    }
    for (const userId of createdUserIds) {
      await deleteUser(userId);
    }
  });

  test("rejects requests with no bearer token", async () => {
    if (!reachable) return;
    const res = await app.request("/api/accounts");
    expect(res.status).toBe(401);
  });

  test("rejects requests with a garbage bearer token", async () => {
    if (!reachable) return;
    const res = await app.request("/api/accounts", {
      headers: { Authorization: "Bearer not-a-real-jwt" }
    });
    expect(res.status).toBe(401);
  });

  test("public paths work with no token at all", async () => {
    if (!reachable) return;
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
  });

  test("valid session but no tenant membership yet returns 403", async () => {
    if (!reachable) return;
    const user = await createConfirmedUser(`no-tenant-${crypto.randomUUID()}@example.com`, "password123!");
    createdUserIds.push(user.id);

    const res = await app.request("/api/accounts", {
      headers: { Authorization: `Bearer ${user.accessToken}` }
    });
    expect(res.status).toBe(403);
  });

  test("bootstrap creates an isolated tenant + starter ledger, and is idempotent", async () => {
    if (!reachable) return;
    const user = await createConfirmedUser(`bootstrap-${crypto.randomUUID()}@example.com`, "password123!");
    createdUserIds.push(user.id);
    const authHeaders = { Authorization: `Bearer ${user.accessToken}` };

    const first = await app.request("/api/tenants/bootstrap", { method: "POST", headers: authHeaders });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { id: string; name: string; planId: string };
    expect(firstBody.id).toBeTruthy();
    expect(firstBody.planId).toBe("free");
    createdTenantIds.push(firstBody.id);

    // Calling it again must return the same tenant, not create a second one.
    const second = await app.request("/api/tenants/bootstrap", { method: "POST", headers: authHeaders });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { id: string };
    expect(secondBody.id).toBe(firstBody.id);

    // Now that a membership exists, previously-403 routes should work.
    const accounts = await app.request("/api/accounts", { headers: authHeaders });
    expect(accounts.status).toBe(200);
  });

  test("bootstrap seeds a real starter chart of accounts, with zero balances", async () => {
    if (!reachable) return;
    const user = await createConfirmedUser(`seed-${crypto.randomUUID()}@example.com`, "password123!");
    createdUserIds.push(user.id);
    const authHeaders = { Authorization: `Bearer ${user.accessToken}` };

    const bootstrap = await app.request("/api/tenants/bootstrap", { method: "POST", headers: authHeaders });
    const bootstrapBody = (await bootstrap.json()) as { id: string };
    createdTenantIds.push(bootstrapBody.id);

    const res = await app.request("/api/accounts", { headers: authHeaders });
    expect(res.status).toBe(200);
    const accounts = (await res.json()) as Array<{ name: string; category: string; currentBalance: number }>;

    // An empty chart of accounts leaves both the register and AI
    // categorization unusable on day one (AI_INTEGRATION_PLAN.md Part 3) --
    // this is the exact gap a real signup hit before this fix.
    expect(accounts.length).toBeGreaterThan(0);
    expect(accounts.some((account) => account.category === "BANK")).toBe(true);
    expect(accounts.some((account) => account.category === "INCOME")).toBe(true);
    expect(accounts.some((account) => account.category === "EXPENSE")).toBe(true);
    // Seeded from data/company.bean's chart of accounts, never its demo
    // balances or transactions -- those belong to that file's fictitious
    // business, not to a new signup.
    expect(accounts.every((account) => account.currentBalance === 0)).toBe(true);
  });

  test("seeded account ids are stable across repeated reads (no cache, parsed fresh every time)", async () => {
    if (!reachable) return;
    const user = await createConfirmedUser(`seed-stable-${crypto.randomUUID()}@example.com`, "password123!");
    createdUserIds.push(user.id);
    const authHeaders = { Authorization: `Bearer ${user.accessToken}` };

    const bootstrap = await app.request("/api/tenants/bootstrap", { method: "POST", headers: authHeaders });
    const bootstrapBody = (await bootstrap.json()) as { id: string };
    createdTenantIds.push(bootstrapBody.id);

    const first = (await (await app.request("/api/accounts", { headers: authHeaders })).json()) as Array<{
      id: string;
    }>;
    const second = (await (await app.request("/api/accounts", { headers: authHeaders })).json()) as Array<{
      id: string;
    }>;
    expect(first.map((a) => a.id)).toEqual(second.map((a) => a.id));
  });

  test("GET /api/tenants/me returns 403 before bootstrap and the tenant after", async () => {
    if (!reachable) return;
    const user = await createConfirmedUser(`me-${crypto.randomUUID()}@example.com`, "password123!");
    createdUserIds.push(user.id);
    const authHeaders = { Authorization: `Bearer ${user.accessToken}` };

    const before = await app.request("/api/tenants/me", { headers: authHeaders });
    expect(before.status).toBe(403);

    const bootstrap = await app.request("/api/tenants/bootstrap", { method: "POST", headers: authHeaders });
    const bootstrapBody = (await bootstrap.json()) as { id: string };
    createdTenantIds.push(bootstrapBody.id);

    const after = await app.request("/api/tenants/me", { headers: authHeaders });
    expect(after.status).toBe(200);
    const afterBody = (await after.json()) as { id: string; planId: string };
    expect(afterBody.id).toBe(bootstrapBody.id);
    expect(afterBody.planId).toBe("free");
  });

  test("two tenants never see each other's ledger data", async () => {
    if (!reachable) return;
    const userA = await createConfirmedUser(`tenant-a-${crypto.randomUUID()}@example.com`, "password123!");
    const userB = await createConfirmedUser(`tenant-b-${crypto.randomUUID()}@example.com`, "password123!");
    createdUserIds.push(userA.id, userB.id);
    const headersA = { Authorization: `Bearer ${userA.accessToken}` };
    const headersB = { Authorization: `Bearer ${userB.accessToken}` };

    const bootstrapA = await app.request("/api/tenants/bootstrap", { method: "POST", headers: headersA });
    const tenantA = (await bootstrapA.json()) as { id: string };
    createdTenantIds.push(tenantA.id);

    const bootstrapB = await app.request("/api/tenants/bootstrap", { method: "POST", headers: headersB });
    const tenantB = (await bootstrapB.json()) as { id: string };
    createdTenantIds.push(tenantB.id);

    expect(tenantA.id).not.toBe(tenantB.id);

    const createRes = await app.request("/api/accounts", {
      method: "POST",
      headers: { ...headersA, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "9999", name: "Tenant A Only Cash", category: "BANK", currency: "USD" })
    });
    expect(createRes.status).toBe(201);

    const accountsForA = (await (await app.request("/api/accounts", { headers: headersA })).json()) as Array<{
      name: string;
    }>;
    expect(accountsForA.some((account) => account.name === "Tenant A Only Cash")).toBe(true);

    const accountsForB = (await (await app.request("/api/accounts", { headers: headersB })).json()) as Array<{
      name: string;
    }>;
    expect(accountsForB.some((account) => account.name === "Tenant A Only Cash")).toBe(false);
  });
});
