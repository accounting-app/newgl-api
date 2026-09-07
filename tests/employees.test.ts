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
 * Integration tests for the employee roster/directory (Team ▸ Employees)
 * -- metadata-only, no ledger impact, no pay rate/paychecks (no Payroll
 * behind it). Scoped to the caller's CURRENTLY ACTIVE company only, same
 * rule as vendors.ts. This is the final Phase 1.5 domain.
 *
 * Requires a local Supabase stack (`bunx supabase start`); skips with a
 * warning instead of failing if it isn't reachable.
 */
describe("Employee routes (roster scoped to the active company)", () => {
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
        "Local Supabase/Postgres not reachable at " + SUPABASE_URL + " -- skipping employees integration tests. Run `bunx supabase start` to enable them."
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

    const res = await app.request("/api/employees", { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("create adds an employee to the active company's roster", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("create");

    const createRes = await app.request("/api/employees", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Jordan Lee", jobTitle: "Office Manager", hireDate: "2026-01-15" })
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as { name: string; jobTitle?: string; hireDate?: string; status: string };
    expect(created.name).toBe("Jordan Lee");
    expect(created.jobTitle).toBe("Office Manager");
    expect(created.hireDate).toBe("2026-01-15");
    expect(created.status).toBe("ACTIVE");

    const list = (await (await app.request("/api/employees", { headers })).json()) as Array<{ name: string }>;
    expect(list.map((e) => e.name)).toEqual(["Jordan Lee"]);
  });

  test("create requires only a name", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("minimal");

    const res = await app.request("/api/employees", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Just A Name" })
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { name: string; jobTitle?: string };
    expect(created.name).toBe("Just A Name");
    expect(created.jobTitle).toBeUndefined();
  });

  test("PATCH updates a subset of fields and can archive (make inactive)", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("patch");

    const created = (await (
      await app.request("/api/employees", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Original Name", email: "original@example.com" })
      })
    ).json()) as { id: string };

    const patchRes = await app.request(`/api/employees/${created.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "555-0100" })
    });
    const patched = (await patchRes.json()) as { name: string; email?: string; phone?: string };
    expect(patched.name).toBe("Original Name");
    expect(patched.email).toBe("original@example.com");
    expect(patched.phone).toBe("555-0100");

    const archiveRes = await app.request(`/api/employees/${created.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ARCHIVED" })
    });
    expect(((await archiveRes.json()) as { status: string }).status).toBe("ARCHIVED");
  });

  test("DELETE removes an employee", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("delete");

    const created = (await (
      await app.request("/api/employees", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Disposable Employee" })
      })
    ).json()) as { id: string };

    const deleteRes = await app.request(`/api/employees/${created.id}`, { method: "DELETE", headers });
    expect(deleteRes.status).toBe(204);

    const list = (await (await app.request("/api/employees", { headers })).json()) as unknown[];
    expect(list).toEqual([]);
  });

  test("operations on an unknown employeeId return 404", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("unknown-id");
    const fakeId = crypto.randomUUID();

    expect(
      (
        await app.request(`/api/employees/${fakeId}`, {
          method: "PATCH",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ name: "x" })
        })
      ).status
    ).toBe(404);
    expect((await app.request(`/api/employees/${fakeId}`, { method: "DELETE", headers })).status).toBe(404);
  });

  test("list only shows the currently active company's employees, not other companies'", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("scoping");

    await app.request("/api/employees", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Primary Co Employee" })
    });

    await app.request("/api/companies", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Second Co" })
    });
    await app.request("/api/companies/Second%20Co/switch", { method: "POST", headers });
    await app.request("/api/employees", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Second Co Employee" })
    });

    const secondCoList = (await (await app.request("/api/employees", { headers })).json()) as Array<{ name: string }>;
    expect(secondCoList.map((e) => e.name)).toEqual(["Second Co Employee"]);

    await app.request("/api/companies/company/switch", { method: "POST", headers });
    const primaryList = (await (await app.request("/api/employees", { headers })).json()) as Array<{ name: string }>;
    expect(primaryList.map((e) => e.name)).toEqual(["Primary Co Employee"]);
  });

  test("deleting a company cascades to its employees", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("cascade");

    await app.request("/api/companies", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Disposable Co" })
    });
    await app.request("/api/companies/Disposable%20Co/switch", { method: "POST", headers });
    const created = (await (
      await app.request("/api/employees", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Doomed Employee" })
      })
    ).json()) as { id: string };

    await app.request("/api/companies/company/switch", { method: "POST", headers });
    await app.request("/api/companies/Disposable%20Co", { method: "DELETE", headers });

    const res = await app.request(`/api/employees/${created.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "should 404" })
    });
    expect(res.status).toBe(404);
  });
});
