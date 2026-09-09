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
 * Integration tests for the mileage trip log (Expenses & Bills ▸ Mileage).
 * Scoped to the caller's CURRENTLY ACTIVE company only, same rule as
 * vendors.ts. No update endpoint -- the UI only adds or deletes entries.
 *
 * Requires a local Supabase stack (`bunx supabase start`); skips with a
 * warning instead of failing if it isn't reachable.
 */
describe("Mileage entry routes (log scoped to the active company)", () => {
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
        "Local Supabase/Postgres not reachable at " + SUPABASE_URL + " -- skipping mileage integration tests. Run `bunx supabase start` to enable them."
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

    const res = await app.request("/api/mileage-entries", { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("create adds an entry to the active company's log", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("create");

    const createRes = await app.request("/api/mileage-entries", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        date: "2026-03-15",
        miles: 12.5,
        ratePerMile: 0.725,
        type: "BUSINESS",
        startAddress: "123 Main St",
        endAddress: "456 Client Ave",
        purpose: "Client meeting"
      })
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as { id: string; date: string; miles: number; ratePerMile: number; type: string };
    expect(created.date).toBe("2026-03-15");
    expect(created.miles).toBe(12.5);
    expect(created.ratePerMile).toBe(0.725);
    expect(created.type).toBe("BUSINESS");

    const listRes = await app.request("/api/mileage-entries", { headers });
    const list = (await listRes.json()) as Array<{ purpose?: string }>;
    expect(list.map((e) => e.purpose)).toEqual(["Client meeting"]);
  });

  test("create requires only date, miles, ratePerMile, and type", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("minimal");

    const res = await app.request("/api/mileage-entries", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ date: "2026-01-01", miles: 5, ratePerMile: 0.7, type: "PERSONAL" })
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { purpose?: string; startAddress?: string };
    expect(created.purpose).toBeUndefined();
    expect(created.startAddress).toBeUndefined();
  });

  test("list orders most recent trips first", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("ordering");

    for (const date of ["2026-01-05", "2026-01-20", "2026-01-10"]) {
      await app.request("/api/mileage-entries", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ date, miles: 1, ratePerMile: 0.7, type: "BUSINESS" })
      });
    }

    const list = (await (await app.request("/api/mileage-entries", { headers })).json()) as Array<{ date: string }>;
    expect(list.map((e) => e.date)).toEqual(["2026-01-20", "2026-01-10", "2026-01-05"]);
  });

  test("DELETE removes an entry", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("delete");

    const created = (await (
      await app.request("/api/mileage-entries", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ date: "2026-02-01", miles: 3, ratePerMile: 0.7, type: "BUSINESS" })
      })
    ).json()) as { id: string };

    const deleteRes = await app.request(`/api/mileage-entries/${created.id}`, { method: "DELETE", headers });
    expect(deleteRes.status).toBe(204);

    const list = (await (await app.request("/api/mileage-entries", { headers })).json()) as unknown[];
    expect(list).toEqual([]);
  });

  test("deleting an unknown entryId returns 404", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("unknown-id");
    const fakeId = crypto.randomUUID();

    expect((await app.request(`/api/mileage-entries/${fakeId}`, { method: "DELETE", headers })).status).toBe(404);
  });

  test("list only shows the currently active company's entries, not other companies'", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("scoping");

    await app.request("/api/mileage-entries", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ date: "2026-01-01", miles: 1, ratePerMile: 0.7, type: "BUSINESS", purpose: "Primary Co trip" })
    });

    await app.request("/api/companies", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Second Co" })
    });
    await app.request("/api/companies/Second%20Co/switch", { method: "POST", headers });
    await app.request("/api/mileage-entries", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ date: "2026-01-02", miles: 2, ratePerMile: 0.7, type: "BUSINESS", purpose: "Second Co trip" })
    });

    const secondCoList = (await (await app.request("/api/mileage-entries", { headers })).json()) as Array<{ purpose?: string }>;
    expect(secondCoList.map((e) => e.purpose)).toEqual(["Second Co trip"]);

    await app.request("/api/companies/company/switch", { method: "POST", headers });
    const primaryList = (await (await app.request("/api/mileage-entries", { headers })).json()) as Array<{ purpose?: string }>;
    expect(primaryList.map((e) => e.purpose)).toEqual(["Primary Co trip"]);
  });

  test("deleting a company cascades to its mileage entries", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("cascade");

    await app.request("/api/companies", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Disposable Co" })
    });
    await app.request("/api/companies/Disposable%20Co/switch", { method: "POST", headers });
    const created = (await (
      await app.request("/api/mileage-entries", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ date: "2026-01-01", miles: 1, ratePerMile: 0.7, type: "BUSINESS" })
      })
    ).json()) as { id: string };

    await app.request("/api/companies/company/switch", { method: "POST", headers });
    await app.request("/api/companies/Disposable%20Co", { method: "DELETE", headers });

    const res = await app.request(`/api/mileage-entries/${created.id}`, { method: "DELETE", headers });
    expect(res.status).toBe(404);
  });
});
