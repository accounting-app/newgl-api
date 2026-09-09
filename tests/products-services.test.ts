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
 * Integration tests for the Products & Services catalog, shared between
 * Sales & Get Paid and Customer Hub. Scoped to the caller's CURRENTLY
 * ACTIVE company only, same rule as vendors.ts/customers.ts.
 *
 * Requires a local Supabase stack (`bunx supabase start`); skips with a
 * warning instead of failing if it isn't reachable.
 */
describe("Product/service routes (catalog scoped to the active company)", () => {
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
        "Local Supabase/Postgres not reachable at " + SUPABASE_URL + " -- skipping products-services integration tests. Run `bunx supabase start` to enable them."
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

    const res = await app.request("/api/products-services", { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("create adds an item, requiring only name and type", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("create");

    const res = await app.request("/api/products-services", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Consulting hour", type: "SERVICE", salesPrice: 125.5 })
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { name: string; type: string; salesPrice?: number; status: string };
    expect(created.name).toBe("Consulting hour");
    expect(created.type).toBe("SERVICE");
    expect(created.salesPrice).toBe(125.5);
    expect(created.status).toBe("ACTIVE");

    const list = (await (await app.request("/api/products-services", { headers })).json()) as Array<{ name: string }>;
    expect(list.map((p) => p.name)).toEqual(["Consulting hour"]);
  });

  test("PATCH updates fields and can archive", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("patch");

    const created = (await (
      await app.request("/api/products-services", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Widget", type: "PRODUCT" })
      })
    ).json()) as { id: string };

    const patchRes = await app.request(`/api/products-services/${created.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ salesPrice: 9.99, description: "A widget" })
    });
    const patched = (await patchRes.json()) as { name: string; salesPrice?: number; description?: string };
    expect(patched.name).toBe("Widget");
    expect(patched.salesPrice).toBe(9.99);
    expect(patched.description).toBe("A widget");

    const archiveRes = await app.request(`/api/products-services/${created.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ARCHIVED" })
    });
    expect(((await archiveRes.json()) as { status: string }).status).toBe("ARCHIVED");
  });

  test("DELETE removes an item", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("delete");

    const created = (await (
      await app.request("/api/products-services", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Disposable Item", type: "PRODUCT" })
      })
    ).json()) as { id: string };

    const deleteRes = await app.request(`/api/products-services/${created.id}`, { method: "DELETE", headers });
    expect(deleteRes.status).toBe(204);

    const list = (await (await app.request("/api/products-services", { headers })).json()) as unknown[];
    expect(list).toEqual([]);
  });

  test("operations on an unknown productId return 404", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("unknown-id");
    const fakeId = crypto.randomUUID();

    expect(
      (
        await app.request(`/api/products-services/${fakeId}`, {
          method: "PATCH",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ name: "x" })
        })
      ).status
    ).toBe(404);
    expect((await app.request(`/api/products-services/${fakeId}`, { method: "DELETE", headers })).status).toBe(404);
  });

  test("list only shows the currently active company's items, not other companies'", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("scoping");

    await app.request("/api/products-services", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Primary Co Item", type: "SERVICE" })
    });

    await app.request("/api/companies", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Second Co" })
    });
    await app.request("/api/companies/Second%20Co/switch", { method: "POST", headers });
    await app.request("/api/products-services", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Second Co Item", type: "SERVICE" })
    });

    const secondCoList = (await (await app.request("/api/products-services", { headers })).json()) as Array<{ name: string }>;
    expect(secondCoList.map((p) => p.name)).toEqual(["Second Co Item"]);

    await app.request("/api/companies/company/switch", { method: "POST", headers });
    const primaryList = (await (await app.request("/api/products-services", { headers })).json()) as Array<{ name: string }>;
    expect(primaryList.map((p) => p.name)).toEqual(["Primary Co Item"]);
  });

  test("deleting a company cascades to its products/services", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("cascade");

    await app.request("/api/companies", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Disposable Co" })
    });
    await app.request("/api/companies/Disposable%20Co/switch", { method: "POST", headers });
    const created = (await (
      await app.request("/api/products-services", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Doomed Item", type: "SERVICE" })
      })
    ).json()) as { id: string };

    await app.request("/api/companies/company/switch", { method: "POST", headers });
    await app.request("/api/companies/Disposable%20Co", { method: "DELETE", headers });

    const res = await app.request(`/api/products-services/${created.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "should 404" })
    });
    expect(res.status).toBe(404);
  });
});
