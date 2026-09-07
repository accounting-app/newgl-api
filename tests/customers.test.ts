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
 * Integration tests for the customer directory (Sales & Get Paid /
 * Customer Hub ▸ Customers) -- the AR mirror of Vendors. Scoped to the
 * caller's CURRENTLY ACTIVE company only, same rule as vendors.ts.
 *
 * Requires a local Supabase stack (`bunx supabase start`); skips with a
 * warning instead of failing if it isn't reachable.
 */
describe("Customer routes (directory scoped to the active company)", () => {
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

  beforeAll(async () => {
    reachable = await localSupabaseStackIsReachable();
    if (!reachable) {
      console.warn(
        "Local Supabase/Postgres not reachable at " + SUPABASE_URL + " -- skipping customers integration tests. Run `bunx supabase start` to enable them."
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

    const res = await app.request("/api/customers", { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("create adds a customer to the active company's list", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("create");

    const createRes = await app.request("/api/customers", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Jane Smith", companyName: "Smith Consulting" })
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as { name: string; companyName?: string; status: string };
    expect(created.name).toBe("Jane Smith");
    expect(created.companyName).toBe("Smith Consulting");
    expect(created.status).toBe("ACTIVE");

    const list = (await (await app.request("/api/customers", { headers })).json()) as Array<{ name: string }>;
    expect(list.map((c) => c.name)).toEqual(["Jane Smith"]);
  });

  test("create requires only a name", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("minimal");

    const res = await app.request("/api/customers", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Just A Name" })
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { name: string; email?: string };
    expect(created.name).toBe("Just A Name");
    expect(created.email).toBeUndefined();
  });

  test("PATCH updates a subset of fields and can archive", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("patch");

    const created = (await (
      await app.request("/api/customers", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Original Name", email: "original@example.com" })
      })
    ).json()) as { id: string };

    const patchRes = await app.request(`/api/customers/${created.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "555-0100" })
    });
    const patched = (await patchRes.json()) as { name: string; email?: string; phone?: string };
    expect(patched.name).toBe("Original Name");
    expect(patched.email).toBe("original@example.com");
    expect(patched.phone).toBe("555-0100");

    const archiveRes = await app.request(`/api/customers/${created.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ARCHIVED" })
    });
    expect(((await archiveRes.json()) as { status: string }).status).toBe("ARCHIVED");
  });

  test("DELETE removes a customer", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("delete");

    const created = (await (
      await app.request("/api/customers", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Disposable Customer" })
      })
    ).json()) as { id: string };

    const deleteRes = await app.request(`/api/customers/${created.id}`, { method: "DELETE", headers });
    expect(deleteRes.status).toBe(204);

    const list = (await (await app.request("/api/customers", { headers })).json()) as unknown[];
    expect(list).toEqual([]);
  });

  test("operations on an unknown customerId return 404", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("unknown-id");
    const fakeId = crypto.randomUUID();

    expect(
      (
        await app.request(`/api/customers/${fakeId}`, {
          method: "PATCH",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ name: "x" })
        })
      ).status
    ).toBe(404);
    expect((await app.request(`/api/customers/${fakeId}`, { method: "DELETE", headers })).status).toBe(404);
  });

  test("list only shows the currently active company's customers, not other companies'", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("scoping");

    await app.request("/api/customers", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Primary Co Customer" })
    });

    await app.request("/api/companies", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Second Co" })
    });
    await app.request("/api/companies/Second%20Co/switch", { method: "POST", headers });
    await app.request("/api/customers", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Second Co Customer" })
    });

    const secondCoList = (await (await app.request("/api/customers", { headers })).json()) as Array<{ name: string }>;
    expect(secondCoList.map((c) => c.name)).toEqual(["Second Co Customer"]);

    await app.request("/api/companies/company/switch", { method: "POST", headers });
    const primaryList = (await (await app.request("/api/customers", { headers })).json()) as Array<{ name: string }>;
    expect(primaryList.map((c) => c.name)).toEqual(["Primary Co Customer"]);
  });

  test("deleting a company cascades to its customers", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("cascade");

    await app.request("/api/companies", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Disposable Co" })
    });
    await app.request("/api/companies/Disposable%20Co/switch", { method: "POST", headers });
    const created = (await (
      await app.request("/api/customers", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Doomed Customer" })
      })
    ).json()) as { id: string };

    await app.request("/api/companies/company/switch", { method: "POST", headers });
    await app.request("/api/companies/Disposable%20Co", { method: "DELETE", headers });

    const res = await app.request(`/api/customers/${created.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "should 404" })
    });
    expect(res.status).toBe(404);
  });
});
