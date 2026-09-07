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
 * Integration tests for Receipts -- the one Phase 1.5 domain that stores
 * an actual file, in Supabase Storage's `receipts` bucket (see
 * @/infra/supabase-storage/client.ts). Manual upload + optional review
 * fields only, no OCR/auto-matching, per the plan doc's resolved open
 * question.
 *
 * Requires a local Supabase stack (`bunx supabase start`); skips with a
 * warning instead of failing if it isn't reachable.
 */
describe("Receipt routes (metadata + real file storage, scoped to the active company)", () => {
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

  function receiptFormData(fields: Record<string, string> = {}): FormData {
    const form = new FormData();
    form.append("file", new File(["fake receipt bytes"], "coffee-receipt.png", { type: "image/png" }));
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    return form;
  }

  beforeAll(async () => {
    reachable = await localSupabaseStackIsReachable();
    if (!reachable) {
      console.warn(
        "Local Supabase/Postgres not reachable at " + SUPABASE_URL + " -- skipping receipts integration tests. Run `bunx supabase start` to enable them."
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

    const res = await app.request("/api/receipts", { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("upload creates a receipt with the file's own name/size/type", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("upload");

    const res = await app.request("/api/receipts", { method: "POST", headers, body: receiptFormData() });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { id: string; fileName: string; fileSizeBytes: number; contentType: string; vendorId?: string };
    expect(created.fileName).toBe("coffee-receipt.png");
    expect(created.contentType).toBe("image/png");
    expect(created.fileSizeBytes).toBe("fake receipt bytes".length);
    expect(created.vendorId).toBeUndefined();

    const list = (await (await app.request("/api/receipts", { headers })).json()) as Array<{ id: string }>;
    expect(list.map((r) => r.id)).toEqual([created.id]);
  });

  test("upload rejects a request with no file", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("no-file");

    const res = await app.request("/api/receipts", { method: "POST", headers, body: new FormData() });
    expect(res.status).toBe(400);
  });

  test("upload accepts optional review fields and validates the vendor belongs to this company", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("with-fields");

    const badVendorRes = await app.request("/api/receipts", {
      method: "POST",
      headers,
      body: receiptFormData({ vendorId: crypto.randomUUID() })
    });
    expect(badVendorRes.status).toBe(404);

    const vendorRes = await app.request("/api/vendors", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Office Supply Co" })
    });
    const vendorId = ((await vendorRes.json()) as { id: string }).id;

    const res = await app.request("/api/receipts", {
      method: "POST",
      headers,
      body: receiptFormData({ vendorId, amount: "42.50", note: "Printer paper" })
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { vendorId?: string; amount?: number; note?: string };
    expect(created.vendorId).toBe(vendorId);
    expect(created.amount).toBe(42.5);
    expect(created.note).toBe("Printer paper");
  });

  test("the uploaded file's actual bytes can be downloaded back", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("download");

    const created = (await (await app.request("/api/receipts", { method: "POST", headers, body: receiptFormData() })).json()) as { id: string };

    const fileRes = await app.request(`/api/receipts/${created.id}/file`, { headers });
    expect(fileRes.status).toBe(200);
    expect(fileRes.headers.get("content-type")).toBe("image/png");
    const text = await fileRes.text();
    expect(text).toBe("fake receipt bytes");
  });

  test("PATCH updates review fields, and can explicitly clear one back to unset", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("patch");

    const created = (await (await app.request("/api/receipts", { method: "POST", headers, body: receiptFormData({ note: "Original note" }) })).json()) as {
      id: string;
    };

    const patchRes = await app.request(`/api/receipts/${created.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 19.99, categoryAccountId: "some-account-id" })
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { amount?: number; categoryAccountId?: string; note?: string };
    expect(patched.amount).toBe(19.99);
    expect(patched.categoryAccountId).toBe("some-account-id");
    expect(patched.note).toBe("Original note");

    const clearRes = await app.request(`/api/receipts/${created.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ note: null })
    });
    const cleared = (await clearRes.json()) as { note?: string; amount?: number };
    expect(cleared.note).toBeUndefined();
    expect(cleared.amount).toBe(19.99);
  });

  test("PATCH on an unknown receiptId returns 404", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("unknown-patch");

    const res = await app.request(`/api/receipts/${crypto.randomUUID()}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ note: "x" })
    });
    expect(res.status).toBe(404);
  });

  test("DELETE removes the receipt and its stored file", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("delete");

    const created = (await (await app.request("/api/receipts", { method: "POST", headers, body: receiptFormData() })).json()) as { id: string };

    const deleteRes = await app.request(`/api/receipts/${created.id}`, { method: "DELETE", headers });
    expect(deleteRes.status).toBe(204);

    const list = (await (await app.request("/api/receipts", { headers })).json()) as unknown[];
    expect(list).toEqual([]);

    const fileRes = await app.request(`/api/receipts/${created.id}/file`, { headers });
    expect(fileRes.status).toBe(404);
  });

  test("list only shows the currently active company's receipts, not other companies'", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("scoping");

    await app.request("/api/receipts", { method: "POST", headers, body: receiptFormData({ note: "Primary Co receipt" }) });

    await app.request("/api/companies", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Second Co" })
    });
    await app.request("/api/companies/Second%20Co/switch", { method: "POST", headers });
    await app.request("/api/receipts", { method: "POST", headers, body: receiptFormData({ note: "Second Co receipt" }) });

    const secondCoList = (await (await app.request("/api/receipts", { headers })).json()) as Array<{ note?: string }>;
    expect(secondCoList.map((r) => r.note)).toEqual(["Second Co receipt"]);

    await app.request("/api/companies/company/switch", { method: "POST", headers });
    const primaryList = (await (await app.request("/api/receipts", { headers })).json()) as Array<{ note?: string }>;
    expect(primaryList.map((r) => r.note)).toEqual(["Primary Co receipt"]);
  });

  test("deleting a company cascades to its receipts", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("cascade");

    await app.request("/api/companies", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Disposable Co" })
    });
    await app.request("/api/companies/Disposable%20Co/switch", { method: "POST", headers });
    const created = (await (await app.request("/api/receipts", { method: "POST", headers, body: receiptFormData() })).json()) as { id: string };

    await app.request("/api/companies/company/switch", { method: "POST", headers });
    await app.request("/api/companies/Disposable%20Co", { method: "DELETE", headers });

    const res = await app.request(`/api/receipts/${created.id}/file`, { headers });
    expect(res.status).toBe(404);
  });
});
