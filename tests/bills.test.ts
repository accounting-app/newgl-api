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
 * Integration tests for Bills -- the first Expenses & Bills domain that
 * also posts real beancount transactions (Dr Expense / Cr Accounts
 * Payable on entry, Dr Accounts Payable / Cr Cash-or-Bank on payment). See
 * QBO_FREE_FEATURES_PLAN.md's Phase 1.5 resolution.
 *
 * Requires a local Supabase stack (`bunx supabase start`); skips with a
 * warning instead of failing if it isn't reachable.
 */
describe("Bill routes (metadata + real ledger postings, scoped to the active company)", () => {
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

  async function createVendor(headers: HeadersInit, name: string): Promise<string> {
    const res = await app.request("/api/vendors", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });
    return ((await res.json()) as { id: string }).id;
  }

  async function findAccount(headers: HeadersInit, category: string): Promise<{ id: string; name: string } | undefined> {
    const accounts = (await (await app.request("/api/accounts", { headers })).json()) as Array<{ id: string; name: string; category: string }>;
    return accounts.find((a) => a.category === category);
  }

  beforeAll(async () => {
    reachable = await localSupabaseStackIsReachable();
    if (!reachable) {
      console.warn(
        "Local Supabase/Postgres not reachable at " + SUPABASE_URL + " -- skipping bills integration tests. Run `bunx supabase start` to enable them."
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

    const res = await app.request("/api/bills", { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("create posts a real Dr Expense / Cr Accounts Payable transaction and creates the AP account on first use", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("create");
    const vendorId = await createVendor(headers, "Acme Office Supply");
    const expenseAccount = await findAccount(headers, "EXPENSE");
    expect(expenseAccount).toBeDefined();

    expect(await findAccount(headers, "ACCOUNTS_PAYABLE")).toBeUndefined();

    const createRes = await app.request("/api/bills", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        vendorId,
        billDate: "2026-03-01",
        dueDate: "2026-03-31",
        amount: 250,
        categoryAccountId: expenseAccount!.id,
        memo: "March supplies"
      })
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as { id: string; status: string; postedTransactionId?: string };
    expect(created.status).toBe("OPEN");
    expect(created.postedTransactionId).toBeTruthy();

    const apAccount = await findAccount(headers, "ACCOUNTS_PAYABLE");
    expect(apAccount).toBeDefined();
    expect(apAccount!.name).toBe("Accounts Payable");

    const txnRes = await app.request(`/api/transactions/${created.postedTransactionId}`, { headers });
    expect(txnRes.status).toBe(200);
    const txn = (await txnRes.json()) as { status: string; postings: Array<{ accountId: string; type: string; amount: number }> };
    expect(txn.status).toBe("POSTED");
    expect(txn.postings).toEqual(
      expect.arrayContaining([
        { accountId: expenseAccount!.id, type: "DEBIT", amount: 250 },
        { accountId: apAccount!.id, type: "CREDIT", amount: 250 }
      ])
    );
  });

  test("create requires a vendor that belongs to this company", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("bad-vendor");
    const expenseAccount = await findAccount(headers, "EXPENSE");

    const res = await app.request("/api/bills", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ vendorId: crypto.randomUUID(), billDate: "2026-01-01", dueDate: "2026-01-31", amount: 10, categoryAccountId: expenseAccount!.id })
    });
    expect(res.status).toBe(404);
  });

  test("PATCH updates non-financial fields without reposting", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("patch-memo");
    const vendorId = await createVendor(headers, "Vendor A");
    const expenseAccount = await findAccount(headers, "EXPENSE");

    const created = (await (
      await app.request("/api/bills", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ vendorId, billDate: "2026-01-01", dueDate: "2026-01-31", amount: 100, categoryAccountId: expenseAccount!.id })
      })
    ).json()) as { id: string; postedTransactionId: string };

    const patchRes = await app.request(`/api/bills/${created.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ memo: "Updated memo", billNumber: "INV-1" })
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { memo?: string; postedTransactionId?: string };
    expect(patched.memo).toBe("Updated memo");
    expect(patched.postedTransactionId).toBe(created.postedTransactionId);
  });

  test("PATCH reposts when the amount changes, voiding the old transaction", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("patch-amount");
    const vendorId = await createVendor(headers, "Vendor B");
    const expenseAccount = await findAccount(headers, "EXPENSE");

    const created = (await (
      await app.request("/api/bills", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ vendorId, billDate: "2026-01-01", dueDate: "2026-01-31", amount: 100, categoryAccountId: expenseAccount!.id })
      })
    ).json()) as { id: string; postedTransactionId: string };

    const patchRes = await app.request(`/api/bills/${created.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 175 })
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { amount: number; postedTransactionId?: string };
    expect(patched.amount).toBe(175);
    expect(patched.postedTransactionId).not.toBe(created.postedTransactionId);

    const oldTxn = (await (await app.request(`/api/transactions/${created.postedTransactionId}`, { headers })).json()) as { status: string };
    expect(oldTxn.status).toBe("VOIDED");

    const newTxn = (await (await app.request(`/api/transactions/${patched.postedTransactionId}`, { headers })).json()) as { status: string };
    expect(newTxn.status).toBe("POSTED");
  });

  test("PATCH rejects editing a paid bill", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("patch-paid");
    const vendorId = await createVendor(headers, "Vendor C");
    const expenseAccount = await findAccount(headers, "EXPENSE");
    const bankAccount = await findAccount(headers, "BANK");

    const created = (await (
      await app.request("/api/bills", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ vendorId, billDate: "2026-01-01", dueDate: "2026-01-31", amount: 50, categoryAccountId: expenseAccount!.id })
      })
    ).json()) as { id: string };

    await app.request(`/api/bills/${created.id}/pay`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ paymentAccountId: bankAccount!.id })
    });

    const patchRes = await app.request(`/api/bills/${created.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ memo: "too late" })
    });
    expect(patchRes.status).toBe(409);
  });

  test("pay posts a real Dr Accounts Payable / Cr Bank transaction and marks the bill paid", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("pay");
    const vendorId = await createVendor(headers, "Vendor D");
    const expenseAccount = await findAccount(headers, "EXPENSE");
    const bankAccount = await findAccount(headers, "BANK");

    const created = (await (
      await app.request("/api/bills", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ vendorId, billDate: "2026-01-01", dueDate: "2026-01-31", amount: 300, categoryAccountId: expenseAccount!.id })
      })
    ).json()) as { id: string };

    const payRes = await app.request(`/api/bills/${created.id}/pay`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ paymentAccountId: bankAccount!.id, paymentDate: "2026-02-01" })
    });
    expect(payRes.status).toBe(200);
    const paid = (await payRes.json()) as { status: string; paymentTransactionId?: string };
    expect(paid.status).toBe("PAID");
    expect(paid.paymentTransactionId).toBeTruthy();

    const apAccount = await findAccount(headers, "ACCOUNTS_PAYABLE");
    const txn = (await (await app.request(`/api/transactions/${paid.paymentTransactionId}`, { headers })).json()) as {
      status: string;
      postings: Array<{ accountId: string; type: string; amount: number }>;
    };
    expect(txn.status).toBe("POSTED");
    expect(txn.postings).toEqual(
      expect.arrayContaining([
        { accountId: apAccount!.id, type: "DEBIT", amount: 300 },
        { accountId: bankAccount!.id, type: "CREDIT", amount: 300 }
      ])
    );
  });

  test("pay rejects a bill that isn't open", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("pay-twice");
    const vendorId = await createVendor(headers, "Vendor E");
    const expenseAccount = await findAccount(headers, "EXPENSE");
    const bankAccount = await findAccount(headers, "BANK");

    const created = (await (
      await app.request("/api/bills", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ vendorId, billDate: "2026-01-01", dueDate: "2026-01-31", amount: 40, categoryAccountId: expenseAccount!.id })
      })
    ).json()) as { id: string };

    await app.request(`/api/bills/${created.id}/pay`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ paymentAccountId: bankAccount!.id })
    });

    const secondPay = await app.request(`/api/bills/${created.id}/pay`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ paymentAccountId: bankAccount!.id })
    });
    expect(secondPay.status).toBe(409);
  });

  test("DELETE voids the posted transaction and removes the bill", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("delete");
    const vendorId = await createVendor(headers, "Vendor F");
    const expenseAccount = await findAccount(headers, "EXPENSE");

    const created = (await (
      await app.request("/api/bills", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ vendorId, billDate: "2026-01-01", dueDate: "2026-01-31", amount: 60, categoryAccountId: expenseAccount!.id })
      })
    ).json()) as { id: string; postedTransactionId: string };

    const deleteRes = await app.request(`/api/bills/${created.id}`, { method: "DELETE", headers });
    expect(deleteRes.status).toBe(204);

    const list = (await (await app.request("/api/bills", { headers })).json()) as unknown[];
    expect(list).toEqual([]);

    const txn = (await (await app.request(`/api/transactions/${created.postedTransactionId}`, { headers })).json()) as { status: string };
    expect(txn.status).toBe("VOIDED");
  });

  test("DELETE rejects a paid bill", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("delete-paid");
    const vendorId = await createVendor(headers, "Vendor G");
    const expenseAccount = await findAccount(headers, "EXPENSE");
    const bankAccount = await findAccount(headers, "BANK");

    const created = (await (
      await app.request("/api/bills", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ vendorId, billDate: "2026-01-01", dueDate: "2026-01-31", amount: 20, categoryAccountId: expenseAccount!.id })
      })
    ).json()) as { id: string };
    await app.request(`/api/bills/${created.id}/pay`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ paymentAccountId: bankAccount!.id })
    });

    const deleteRes = await app.request(`/api/bills/${created.id}`, { method: "DELETE", headers });
    expect(deleteRes.status).toBe(409);
  });

  test("deleting a vendor with bills against it is rejected, not silently orphaned", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("vendor-fk");
    const vendorId = await createVendor(headers, "Vendor H");
    const expenseAccount = await findAccount(headers, "EXPENSE");

    await app.request("/api/bills", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ vendorId, billDate: "2026-01-01", dueDate: "2026-01-31", amount: 15, categoryAccountId: expenseAccount!.id })
    });

    const deleteRes = await app.request(`/api/vendors/${vendorId}`, { method: "DELETE", headers });
    expect(deleteRes.status).toBe(409);
  });

  test("list only shows the currently active company's bills, not other companies'", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("scoping");
    const primaryVendorId = await createVendor(headers, "Primary Vendor");
    const primaryExpenseAccount = await findAccount(headers, "EXPENSE");

    await app.request("/api/bills", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ vendorId: primaryVendorId, billDate: "2026-01-01", dueDate: "2026-01-31", amount: 10, categoryAccountId: primaryExpenseAccount!.id })
    });

    await app.request("/api/companies", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Second Co", templateId: "freelancer" })
    });
    await app.request("/api/companies/Second%20Co/switch", { method: "POST", headers });
    const secondVendorId = await createVendor(headers, "Second Co Vendor");
    const secondExpenseAccount = await findAccount(headers, "EXPENSE");
    await app.request("/api/bills", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ vendorId: secondVendorId, billDate: "2026-01-02", dueDate: "2026-02-01", amount: 20, categoryAccountId: secondExpenseAccount!.id })
    });

    const secondCoList = (await (await app.request("/api/bills", { headers })).json()) as Array<{ amount: number }>;
    expect(secondCoList.map((b) => b.amount)).toEqual([20]);

    await app.request("/api/companies/company/switch", { method: "POST", headers });
    const primaryList = (await (await app.request("/api/bills", { headers })).json()) as Array<{ amount: number }>;
    expect(primaryList.map((b) => b.amount)).toEqual([10]);
  });
});
