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
 * Integration tests for Phase A (multi-company support, see
 * INSTANCE_ARCHITECTURE_PLAN.md) company management routes:
 *   - GET /api/companies, POST /api/companies, POST /api/companies/:name/switch
 *   - DELETE /api/companies/:name (PlainGL parity #9)
 *
 * Requires a local Supabase stack (`bunx supabase start`); skips with a
 * warning instead of failing if it isn't reachable, same as
 * tenant-ledgers.test.ts.
 */
describe("Company management routes", () => {
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
        "Local Supabase/Postgres not reachable at " +
          SUPABASE_URL +
          " -- skipping companies integration tests. Run `bunx supabase start` to enable them."
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

  test("list returns the bootstrap primary company, active", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("list");

    const res = await app.request("/api/companies", { headers });
    expect(res.status).toBe(200);
    const companies = (await res.json()) as Array<{ name: string; isPrimary: boolean; isActive: boolean }>;
    expect(companies).toHaveLength(1);
    expect(companies[0]).toMatchObject({ name: "company", isPrimary: true, isActive: true });
  });

  test("create adds a second, non-primary, non-active company", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("create");

    const res = await app.request("/api/companies", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Side Business" })
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { name: string; isPrimary: boolean; isActive: boolean };
    expect(created).toMatchObject({ name: "Side Business", isPrimary: false, isActive: false });

    const companies = (await (await app.request("/api/companies", { headers })).json()) as Array<{ name: string }>;
    expect(companies.map((c) => c.name).sort()).toEqual(["Side Business", "company"]);
  });

  test("create rejects a duplicate name with 409", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("dup");

    const res = await app.request("/api/companies", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "company" })
    });
    expect(res.status).toBe(409);
  });

  test("create rejects both templateId and duplicateFromName with 400", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("both-opts");

    const res = await app.request("/api/companies", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Bad Combo", templateId: "freelancer", duplicateFromName: "company" })
    });
    expect(res.status).toBe(400);
  });

  test("switch changes which company subsequent requests resolve to", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("switch");

    await app.request("/api/companies", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Second Co" })
    });

    const switchRes = await app.request("/api/companies/Second%20Co/switch", { method: "POST", headers });
    expect(switchRes.status).toBe(200);
    const switched = (await switchRes.json()) as { name: string; isActive: boolean };
    expect(switched).toMatchObject({ name: "Second Co", isActive: true });

    const companies = (await (await app.request("/api/companies", { headers })).json()) as Array<{
      name: string;
      isActive: boolean;
    }>;
    expect(companies.find((c) => c.name === "Second Co")?.isActive).toBe(true);
    expect(companies.find((c) => c.name === "company")?.isActive).toBe(false);
  });

  test("switch to an unknown company returns 404", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("switch-404");

    const res = await app.request("/api/companies/Nope/switch", { method: "POST", headers });
    expect(res.status).toBe(404);
  });

  test("delete removes a non-primary company", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("delete");

    await app.request("/api/companies", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Disposable" })
    });

    const deleteRes = await app.request("/api/companies/Disposable", { method: "DELETE", headers });
    expect(deleteRes.status).toBe(204);

    const companies = (await (await app.request("/api/companies", { headers })).json()) as Array<{ name: string }>;
    expect(companies.map((c) => c.name)).toEqual(["company"]);
  });

  test("delete of an unknown company returns 404", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("delete-404");

    const res = await app.request("/api/companies/Nope", { method: "DELETE", headers });
    expect(res.status).toBe(404);
  });

  test("delete refuses to remove the primary company with 409", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("delete-primary");

    const res = await app.request("/api/companies/company", { method: "DELETE", headers });
    expect(res.status).toBe(409);

    const companies = (await (await app.request("/api/companies", { headers })).json()) as Array<{ name: string }>;
    expect(companies).toHaveLength(1);
  });

  test("deleting the active company falls the caller back to primary", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("delete-active");

    await app.request("/api/companies", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Active Then Gone" })
    });
    await app.request("/api/companies/Active%20Then%20Gone/switch", { method: "POST", headers });

    const deleteRes = await app.request("/api/companies/Active%20Then%20Gone", { method: "DELETE", headers });
    expect(deleteRes.status).toBe(204);

    const companies = (await (await app.request("/api/companies", { headers })).json()) as Array<{
      name: string;
      isPrimary: boolean;
      isActive: boolean;
      updatedAt: string;
    }>;
    expect(companies).toEqual([{ name: "company", isPrimary: true, isActive: true, updatedAt: companies[0].updatedAt }]);
  });

  test("create accepts an optional label, returned by both create and list", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("label");

    const createRes = await app.request("/api/companies", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Payroll Co", label: "Payroll ledger" })
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as { name: string; label?: string };
    expect(created.label).toBe("Payroll ledger");

    const companies = (await (await app.request("/api/companies", { headers })).json()) as Array<{
      name: string;
      label?: string;
    }>;
    expect(companies.find((c) => c.name === "Payroll Co")?.label).toBe("Payroll ledger");
  });

  test("create from uploaded content creates a new company with that content", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("from-content");

    const bean = [
      'option "title" "Uploaded Co"',
      'option "operating_currency" "USD"',
      "",
      "2024-01-01 open Assets:Cash USD",
      '  id: "acct-cash"'
    ].join("\n");

    const res = await app.request("/api/companies", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Uploaded Co", content: bean })
    });
    expect(res.status).toBe(200);

    const downloadRes = await app.request("/api/ledgers/Uploaded%20Co/download", { headers });
    expect(downloadRes.status).toBe(200);
    expect(await downloadRes.text()).toBe(bean);
  });

  test("create rejects content that doesn't look like a valid Beancount ledger", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("bad-content");

    const res = await app.request("/api/companies", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Garbage Co", content: "this is not a ledger at all" })
    });
    expect(res.status).toBe(400);
  });

  test("create rejects more than one of templateId/duplicateFromName/content", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("multi-mode");

    const res = await app.request("/api/companies", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Bad Co", templateId: "freelancer", content: "whatever" })
    });
    expect(res.status).toBe(400);
  });

  test("PATCH updates a company's label", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("patch-label");

    const patchRes = await app.request("/api/companies/company", {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "My main books" })
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { label?: string };
    expect(patched.label).toBe("My main books");

    const companies = (await (await app.request("/api/companies", { headers })).json()) as Array<{
      name: string;
      label?: string;
    }>;
    expect(companies.find((c) => c.name === "company")?.label).toBe("My main books");
  });

  test("PATCH on an unknown company returns 404", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("patch-404");

    const res = await app.request("/api/companies/Nope", {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "x" })
    });
    expect(res.status).toBe(404);
  });
});
