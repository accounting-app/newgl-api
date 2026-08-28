import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApp } from "../src/http/app";
import { parseBeancount, serializeBeancount } from "../src/infra/beancount/parser";
import { getSql } from "../src/infra/postgres/client";
import {
  createConfirmedUser,
  deleteUser,
  localSupabaseStackIsReachable,
  SUPABASE_URL,
  type TestUser
} from "./helpers/supabase-test-auth";

/**
 * Integration tests for extra .bean files scoped to one company (ledger
 * row) -- separate from that company's own primary content. The key
 * behavior under test: the list endpoint only ever shows files for the
 * caller's CURRENTLY ACTIVE company, never a cross-company list, matching
 * the Ledger settings page showing "files for the company selected in the
 * header."
 *
 * Requires a local Supabase stack (`bunx supabase start`); skips with a
 * warning instead of failing if it isn't reachable, same as
 * companies.test.ts.
 */
describe("Ledger file routes (extra files scoped to the active company)", () => {
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

  const VALID_BEAN = [
    'option "title" "Extra File"',
    'option "operating_currency" "USD"',
    "",
    "2024-01-01 open Assets:Cash USD",
    '  id: "acct-cash"'
  ].join("\n");
  // Every write path normalizes via parse+serialize (same as ledgers.ts's
  // own upload/restore routes) so stored content always matches what the
  // rest of the app would produce -- round-trip the fixture the same way
  // to get a byte-accurate expectation instead of asserting against the
  // raw, unnormalized input.
  const NORMALIZED_VALID_BEAN = serializeBeancount(parseBeancount(VALID_BEAN));

  beforeAll(async () => {
    reachable = await localSupabaseStackIsReachable();
    if (!reachable) {
      console.warn(
        "Local Supabase/Postgres not reachable at " +
          SUPABASE_URL +
          " -- skipping ledger-files integration tests. Run `bunx supabase start` to enable them."
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

    const res = await app.request("/api/ledger-files", { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("create adds a file to the active company's list", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("create");

    const createRes = await app.request("/api/ledger-files", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "payroll", label: "Payroll notes", content: VALID_BEAN })
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as { id: string; name: string; label?: string };
    expect(created.name).toBe("payroll");
    expect(created.label).toBe("Payroll notes");

    const listRes = await app.request("/api/ledger-files", { headers });
    const list = (await listRes.json()) as Array<{ name: string }>;
    expect(list.map((f) => f.name)).toEqual(["payroll"]);
  });

  test("create rejects content that doesn't look like a valid Beancount ledger", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("bad-content");

    const res = await app.request("/api/ledger-files", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "garbage", content: "not a ledger" })
    });
    expect(res.status).toBe(400);
  });

  test("create rejects a duplicate name within the same company", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("dup-name");

    await app.request("/api/ledger-files", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "payroll", content: VALID_BEAN })
    });
    const res = await app.request("/api/ledger-files", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "payroll", content: VALID_BEAN })
    });
    expect(res.status).toBe(409);
  });

  test("list only shows the currently active company's files, not other companies'", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("scoping");

    // File under the primary ("company") while it's active.
    await app.request("/api/ledger-files", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "primary-file", content: VALID_BEAN })
    });

    // A second company, switched to, gets its own separate file.
    await app.request("/api/companies", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Second Co" })
    });
    await app.request("/api/companies/Second%20Co/switch", { method: "POST", headers });
    await app.request("/api/ledger-files", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "second-file", content: VALID_BEAN })
    });

    const secondCoList = (await (await app.request("/api/ledger-files", { headers })).json()) as Array<{ name: string }>;
    expect(secondCoList.map((f) => f.name)).toEqual(["second-file"]);

    // Switch back to primary -- its list is exactly what it was, unaffected.
    await app.request("/api/companies/company/switch", { method: "POST", headers });
    const primaryList = (await (await app.request("/api/ledger-files", { headers })).json()) as Array<{ name: string }>;
    expect(primaryList.map((f) => f.name)).toEqual(["primary-file"]);
  });

  test("download returns the file's content", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("download");

    const created = (await (
      await app.request("/api/ledger-files", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "payroll", content: VALID_BEAN })
      })
    ).json()) as { id: string };

    const res = await app.request(`/api/ledger-files/${created.id}/download`, { headers });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(NORMALIZED_VALID_BEAN);
  });

  test("upload replaces content and bumps version", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("upload");

    const created = (await (
      await app.request("/api/ledger-files", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "payroll", content: VALID_BEAN })
      })
    ).json()) as { id: string; version: number };
    expect(created.version).toBe(1);

    const updatedBean = VALID_BEAN + "\n2024-01-02 open Expenses:Misc USD\n  id: \"acct-misc\"";
    const uploadRes = await app.request(`/api/ledger-files/${created.id}/upload`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "text/plain" },
      body: updatedBean
    });
    expect(uploadRes.status).toBe(200);
    const summary = (await uploadRes.json()) as { version: number; accountCount: number };
    expect(summary.version).toBe(2);
    expect(summary.accountCount).toBe(2);
  });

  test("upload rejects invalid content, leaving the file untouched", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("bad-upload");

    const created = (await (
      await app.request("/api/ledger-files", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "payroll", content: VALID_BEAN })
      })
    ).json()) as { id: string };

    const res = await app.request(`/api/ledger-files/${created.id}/upload`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "text/plain" },
      body: "garbage"
    });
    expect(res.status).toBe(400);

    const stillOriginal = await (await app.request(`/api/ledger-files/${created.id}/download`, { headers })).text();
    expect(stillOriginal).toBe(NORMALIZED_VALID_BEAN);
  });

  test("versions and restore work like the ledger-level equivalent", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("versions");

    const created = (await (
      await app.request("/api/ledger-files", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "payroll", content: VALID_BEAN })
      })
    ).json()) as { id: string };

    const updatedBean = VALID_BEAN + "\n2024-01-02 open Expenses:Misc USD\n  id: \"acct-misc\"";
    await app.request(`/api/ledger-files/${created.id}/upload`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "text/plain" },
      body: updatedBean
    });

    const versions = (await (
      await app.request(`/api/ledger-files/${created.id}/versions`, { headers })
    ).json()) as Array<{ version: number; source: string }>;
    expect(versions.map((v) => `${v.version}:${v.source}`)).toEqual(["2:upload", "1:bootstrap"]);

    const restoreRes = await app.request(`/api/ledger-files/${created.id}/versions/1/restore`, {
      method: "POST",
      headers
    });
    expect(restoreRes.status).toBe(200);

    const restored = await (await app.request(`/api/ledger-files/${created.id}/download`, { headers })).text();
    expect(restored).toBe(NORMALIZED_VALID_BEAN);
  });

  test("PATCH updates a file's label", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("patch");

    const created = (await (
      await app.request("/api/ledger-files", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "payroll", content: VALID_BEAN })
      })
    ).json()) as { id: string };

    const patchRes = await app.request(`/api/ledger-files/${created.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Renamed" })
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { label?: string };
    expect(patched.label).toBe("Renamed");
  });

  test("DELETE removes a file", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("delete");

    const created = (await (
      await app.request("/api/ledger-files", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "payroll", content: VALID_BEAN })
      })
    ).json()) as { id: string };

    const deleteRes = await app.request(`/api/ledger-files/${created.id}`, { method: "DELETE", headers });
    expect(deleteRes.status).toBe(204);

    const list = (await (await app.request("/api/ledger-files", { headers })).json()) as unknown[];
    expect(list).toEqual([]);
  });

  test("operations on an unknown fileId return 404", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("unknown-id");
    const fakeId = crypto.randomUUID();

    expect((await app.request(`/api/ledger-files/${fakeId}/download`, { headers })).status).toBe(404);
    expect(
      (
        await app.request(`/api/ledger-files/${fakeId}/upload`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "text/plain" },
          body: VALID_BEAN
        })
      ).status
    ).toBe(404);
    expect((await app.request(`/api/ledger-files/${fakeId}/versions`, { headers })).status).toBe(404);
    expect(
      (await app.request(`/api/ledger-files/${fakeId}/versions/1/restore`, { method: "POST", headers })).status
    ).toBe(404);
    expect(
      (
        await app.request(`/api/ledger-files/${fakeId}`, {
          method: "PATCH",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ label: "x" })
        })
      ).status
    ).toBe(404);
    expect((await app.request(`/api/ledger-files/${fakeId}`, { method: "DELETE", headers })).status).toBe(404);
  });

  test("deleting a company cascades to its files", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("cascade");

    await app.request("/api/companies", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Disposable Co" })
    });
    await app.request("/api/companies/Disposable%20Co/switch", { method: "POST", headers });
    const created = (await (
      await app.request("/api/ledger-files", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "payroll", content: VALID_BEAN })
      })
    ).json()) as { id: string };

    await app.request("/api/companies/company/switch", { method: "POST", headers });
    await app.request("/api/companies/Disposable%20Co", { method: "DELETE", headers });

    const res = await app.request(`/api/ledger-files/${created.id}/download`, { headers });
    expect(res.status).toBe(404);
  });
});
