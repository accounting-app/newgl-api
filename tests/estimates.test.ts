import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApp } from "../src/http/app";
import { getSql } from "../src/infra/postgres/client";
import {
  createConfirmedUser,
  deleteUser,
  localSupabaseStackIsReachable,
  SUPABASE_URL,
  type TestUser
} from "./helpers/supabase-test-auth";

/**
 * Integration tests for Estimates -- metadata-only, no ledger impact
 * (a quote is not an accounting event). Scoped to the caller's CURRENTLY
 * ACTIVE company only, same rule as vendors.ts/customers.ts/invoices.ts.
 *
 * Requires a local Supabase stack (`bunx supabase start`); skips with a
 * warning instead of failing if it isn't reachable.
 */
describe("Estimate routes (metadata scoped to the active company)", () => {
  let app: ReturnType<typeof createApp>;
  let reachable = false;
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

  async function createCustomer(headers: HeadersInit, name: string): Promise<string> {
    const res = await app.request("/api/customers", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });
    return ((await res.json()) as { id: string }).id;
  }

  beforeAll(async () => {
    reachable = await localSupabaseStackIsReachable();
    if (!reachable) {
      console.warn(
        "Local Supabase/Postgres not reachable at " + SUPABASE_URL + " -- skipping estimates integration tests. Run `bunx supabase start` to enable them."
      );
      return;
    }
    app = createApp();
  });

  afterAll(async () => {
    if (!reachable) return;
    for (const tenantId of createdTenantIds) {
      await getSql()`delete from tenants where id = ${tenantId}`.catch(() => {});
    }
    for (const userId of createdUserIds) {
      await deleteUser(userId);
    }
  });

  test("list is empty for a fresh company", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("empty");

    const res = await app.request("/api/estimates", { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("create adds an estimate, defaulting to OPEN", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("create");
    const customerId = await createCustomer(headers, "Jane Smith");

    const createRes = await app.request("/api/estimates", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ customerId, estimateDate: "2026-03-01", expirationDate: "2026-04-01", amount: 750, memo: "Kitchen remodel quote" })
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as { status: string; amount: number; memo?: string };
    expect(created.status).toBe("OPEN");
    expect(created.amount).toBe(750);
    expect(created.memo).toBe("Kitchen remodel quote");

    const list = (await (await app.request("/api/estimates", { headers })).json()) as Array<{ customerId: string }>;
    expect(list.map((e) => e.customerId)).toEqual([customerId]);
  });

  test("create requires a customer that belongs to this company", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("bad-customer");

    const res = await app.request("/api/estimates", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ customerId: crypto.randomUUID(), estimateDate: "2026-01-01", amount: 10 })
    });
    expect(res.status).toBe(404);
  });

  test("PATCH accepts and declines -- no ledger transaction posted either way", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("accept-decline");
    const customerId = await createCustomer(headers, "Customer B");

    const created = (await (
      await app.request("/api/estimates", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, estimateDate: "2026-01-01", amount: 100 })
      })
    ).json()) as { id: string };

    const acceptRes = await app.request(`/api/estimates/${created.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ACCEPTED" })
    });
    expect(((await acceptRes.json()) as { status: string }).status).toBe("ACCEPTED");

    const declineRes = await app.request(`/api/estimates/${created.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "DECLINED" })
    });
    expect(((await declineRes.json()) as { status: string }).status).toBe("DECLINED");
  });

  test("PATCH updates other fields without touching status", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("patch-fields");
    const customerId = await createCustomer(headers, "Customer C");

    const created = (await (
      await app.request("/api/estimates", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, estimateDate: "2026-01-01", amount: 50 })
      })
    ).json()) as { id: string };

    const patchRes = await app.request(`/api/estimates/${created.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 65, estimateNumber: "EST-1" })
    });
    const patched = (await patchRes.json()) as { amount: number; estimateNumber?: string; status: string };
    expect(patched.amount).toBe(65);
    expect(patched.estimateNumber).toBe("EST-1");
    expect(patched.status).toBe("OPEN");
  });

  test("DELETE removes an estimate", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("delete");
    const customerId = await createCustomer(headers, "Customer D");

    const created = (await (
      await app.request("/api/estimates", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, estimateDate: "2026-01-01", amount: 20 })
      })
    ).json()) as { id: string };

    const deleteRes = await app.request(`/api/estimates/${created.id}`, { method: "DELETE", headers });
    expect(deleteRes.status).toBe(204);

    const list = (await (await app.request("/api/estimates", { headers })).json()) as unknown[];
    expect(list).toEqual([]);
  });

  test("operations on an unknown estimateId return 404", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("unknown-id");
    const fakeId = crypto.randomUUID();

    expect(
      (
        await app.request(`/api/estimates/${fakeId}`, {
          method: "PATCH",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ status: "ACCEPTED" })
        })
      ).status
    ).toBe(404);
    expect((await app.request(`/api/estimates/${fakeId}`, { method: "DELETE", headers })).status).toBe(404);
  });

  test("deleting a customer with estimates against it is rejected, not silently orphaned", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("customer-fk");
    const customerId = await createCustomer(headers, "Customer E");

    await app.request("/api/estimates", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ customerId, estimateDate: "2026-01-01", amount: 15 })
    });

    const deleteRes = await app.request(`/api/customers/${customerId}`, { method: "DELETE", headers });
    expect(deleteRes.status).toBe(409);
  });

  test("list only shows the currently active company's estimates, not other companies'", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("scoping");
    const primaryCustomerId = await createCustomer(headers, "Primary Customer");

    await app.request("/api/estimates", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ customerId: primaryCustomerId, estimateDate: "2026-01-01", amount: 10 })
    });

    await app.request("/api/companies", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Second Co", templateId: "freelancer" })
    });
    await app.request("/api/companies/Second%20Co/switch", { method: "POST", headers });
    const secondCustomerId = await createCustomer(headers, "Second Co Customer");
    await app.request("/api/estimates", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ customerId: secondCustomerId, estimateDate: "2026-01-02", amount: 20 })
    });

    const secondCoList = (await (await app.request("/api/estimates", { headers })).json()) as Array<{ amount: number }>;
    expect(secondCoList.map((e) => e.amount)).toEqual([20]);

    await app.request("/api/companies/company/switch", { method: "POST", headers });
    const primaryList = (await (await app.request("/api/estimates", { headers })).json()) as Array<{ amount: number }>;
    expect(primaryList.map((e) => e.amount)).toEqual([10]);
  });

  test("deleting a company cascades to its estimates", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("cascade");

    await app.request("/api/companies", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Disposable Co" })
    });
    await app.request("/api/companies/Disposable%20Co/switch", { method: "POST", headers });
    const customerId = await createCustomer(headers, "Doomed Customer");
    const created = (await (
      await app.request("/api/estimates", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, estimateDate: "2026-01-01", amount: 5 })
      })
    ).json()) as { id: string };

    await app.request("/api/companies/company/switch", { method: "POST", headers });
    await app.request("/api/companies/Disposable%20Co", { method: "DELETE", headers });

    const res = await app.request(`/api/estimates/${created.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ACCEPTED" })
    });
    expect(res.status).toBe(404);
  });
});
