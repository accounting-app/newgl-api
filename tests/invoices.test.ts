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
 * Integration tests for Invoices -- the AR mirror of Bills. See
 * bills.test.ts for the template this closely follows.
 *
 * Requires a local Supabase stack (`bunx supabase start`); skips with a
 * warning instead of failing if it isn't reachable.
 */
describe("Invoice routes (metadata + real ledger postings, scoped to the active company)", () => {
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

  async function findAccount(headers: HeadersInit, category: string): Promise<{ id: string; name: string } | undefined> {
    const accounts = (await (await app.request("/api/accounts", { headers })).json()) as Array<{ id: string; name: string; category: string }>;
    return accounts.find((a) => a.category === category);
  }

  beforeAll(async () => {
    reachable = await localSupabaseStackIsReachable();
    if (!reachable) {
      console.warn(
        "Local Supabase/Postgres not reachable at " + SUPABASE_URL + " -- skipping invoices integration tests. Run `bunx supabase start` to enable them."
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

    const res = await app.request("/api/invoices", { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("create posts a real Dr Accounts Receivable / Cr Income transaction, creating the AR account on first use", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("create");
    const customerId = await createCustomer(headers, "Jane Smith");

    expect(await findAccount(headers, "ACCOUNTS_RECEIVABLE")).toBeUndefined();

    const createRes = await app.request("/api/invoices", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ customerId, invoiceDate: "2026-03-01", dueDate: "2026-03-31", amount: 500, memo: "March consulting" })
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as { id: string; status: string; postedTransactionId?: string };
    expect(created.status).toBe("OPEN");
    expect(created.postedTransactionId).toBeTruthy();

    const arAccount = await findAccount(headers, "ACCOUNTS_RECEIVABLE");
    expect(arAccount).toBeDefined();
    expect(arAccount!.name).toBe("Accounts Receivable");
    // The bootstrap tenant's seed ledger already has an INCOME account
    // (see data/company.bean) -- find-or-create picks that existing one up
    // rather than creating a redundant "Sales Income", same "find before
    // create" behavior as Accounts Payable/Receivable. The dedicated
    // create-a-new-one path is covered by the "no income account exists
    // yet" case below (a fresh, no-template company).
    const incomeAccount = await findAccount(headers, "INCOME");
    expect(incomeAccount).toBeDefined();

    const txn = (await (await app.request(`/api/transactions/${created.postedTransactionId}`, { headers })).json()) as {
      status: string;
      postings: Array<{ accountId: string; type: string; amount: number }>;
    };
    expect(txn.status).toBe("POSTED");
    expect(txn.postings).toEqual(
      expect.arrayContaining([
        { accountId: arAccount!.id, type: "DEBIT", amount: 500 },
        { accountId: incomeAccount!.id, type: "CREDIT", amount: 500 }
      ])
    );
  });

  test("create makes a new 'Sales Income' account when the company has no income account at all", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("no-income-account");

    // A company created with none of templateId/duplicateFromName/content
    // starts completely blank -- no accounts at all (unlike the bootstrap
    // tenant's seeded demo company).
    await app.request("/api/companies", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Blank Co" })
    });
    await app.request("/api/companies/Blank%20Co/switch", { method: "POST", headers });
    expect(await findAccount(headers, "INCOME")).toBeUndefined();

    const customerId = await createCustomer(headers, "Someone");
    const created = (await (
      await app.request("/api/invoices", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, invoiceDate: "2026-01-01", dueDate: "2026-01-31", amount: 75 })
      })
    ).json()) as { postedTransactionId: string };

    const incomeAccount = await findAccount(headers, "INCOME");
    expect(incomeAccount).toBeDefined();
    expect(incomeAccount!.name).toBe("Sales Income");

    const txn = (await (await app.request(`/api/transactions/${created.postedTransactionId}`, { headers })).json()) as {
      postings: Array<{ accountId: string; type: string; amount: number }>;
    };
    expect(txn.postings).toEqual(expect.arrayContaining([{ accountId: incomeAccount!.id, type: "CREDIT", amount: 75 }]));
  });

  test("create uses the product/service's own income account when it has one", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("with-product");
    const customerId = await createCustomer(headers, "Acme Corp");
    const incomeAccount = await findAccount(headers, "INCOME");

    const productRes = await app.request("/api/products-services", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Consulting hour", type: "SERVICE", incomeAccountId: incomeAccount!.id })
    });
    const productServiceId = ((await productRes.json()) as { id: string }).id;

    const created = (await (
      await app.request("/api/invoices", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, productServiceId, invoiceDate: "2026-01-01", dueDate: "2026-01-31", amount: 250 })
      })
    ).json()) as { postedTransactionId: string };

    const txn = (await (await app.request(`/api/transactions/${created.postedTransactionId}`, { headers })).json()) as {
      postings: Array<{ accountId: string; type: string; amount: number }>;
    };
    expect(txn.postings).toEqual(expect.arrayContaining([{ accountId: incomeAccount!.id, type: "CREDIT", amount: 250 }]));
  });

  test("create requires a customer that belongs to this company", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("bad-customer");

    const res = await app.request("/api/invoices", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ customerId: crypto.randomUUID(), invoiceDate: "2026-01-01", dueDate: "2026-01-31", amount: 10 })
    });
    expect(res.status).toBe(404);
  });

  test("PATCH reposts when the amount changes, voiding the old transaction", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("patch-amount");
    const customerId = await createCustomer(headers, "Customer B");

    const created = (await (
      await app.request("/api/invoices", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, invoiceDate: "2026-01-01", dueDate: "2026-01-31", amount: 100 })
      })
    ).json()) as { id: string; postedTransactionId: string };

    const patchRes = await app.request(`/api/invoices/${created.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 175 })
    });
    const patched = (await patchRes.json()) as { amount: number; postedTransactionId?: string };
    expect(patched.amount).toBe(175);
    expect(patched.postedTransactionId).not.toBe(created.postedTransactionId);

    const oldTxn = (await (await app.request(`/api/transactions/${created.postedTransactionId}`, { headers })).json()) as { status: string };
    expect(oldTxn.status).toBe("VOIDED");
  });

  test("PATCH rejects editing a paid invoice", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("patch-paid");
    const customerId = await createCustomer(headers, "Customer C");
    const bankAccount = await findAccount(headers, "BANK");

    const created = (await (
      await app.request("/api/invoices", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, invoiceDate: "2026-01-01", dueDate: "2026-01-31", amount: 50 })
      })
    ).json()) as { id: string };

    await app.request(`/api/invoices/${created.id}/pay`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ depositAccountId: bankAccount!.id })
    });

    const patchRes = await app.request(`/api/invoices/${created.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ memo: "too late" })
    });
    expect(patchRes.status).toBe(409);
  });

  test("pay posts a real Dr Bank / Cr Accounts Receivable transaction and marks the invoice paid", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("pay");
    const customerId = await createCustomer(headers, "Customer D");
    const bankAccount = await findAccount(headers, "BANK");

    const created = (await (
      await app.request("/api/invoices", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, invoiceDate: "2026-01-01", dueDate: "2026-01-31", amount: 300 })
      })
    ).json()) as { id: string };

    const payRes = await app.request(`/api/invoices/${created.id}/pay`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ depositAccountId: bankAccount!.id, paymentDate: "2026-02-01" })
    });
    expect(payRes.status).toBe(200);
    const paid = (await payRes.json()) as { status: string; paymentTransactionId?: string };
    expect(paid.status).toBe("PAID");

    const arAccount = await findAccount(headers, "ACCOUNTS_RECEIVABLE");
    const txn = (await (await app.request(`/api/transactions/${paid.paymentTransactionId}`, { headers })).json()) as {
      status: string;
      postings: Array<{ accountId: string; type: string; amount: number }>;
    };
    expect(txn.status).toBe("POSTED");
    expect(txn.postings).toEqual(
      expect.arrayContaining([
        { accountId: bankAccount!.id, type: "DEBIT", amount: 300 },
        { accountId: arAccount!.id, type: "CREDIT", amount: 300 }
      ])
    );
  });

  test("pay rejects an invoice that isn't open", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("pay-twice");
    const customerId = await createCustomer(headers, "Customer E");
    const bankAccount = await findAccount(headers, "BANK");

    const created = (await (
      await app.request("/api/invoices", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, invoiceDate: "2026-01-01", dueDate: "2026-01-31", amount: 40 })
      })
    ).json()) as { id: string };

    await app.request(`/api/invoices/${created.id}/pay`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ depositAccountId: bankAccount!.id })
    });

    const secondPay = await app.request(`/api/invoices/${created.id}/pay`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ depositAccountId: bankAccount!.id })
    });
    expect(secondPay.status).toBe(409);
  });

  test("DELETE voids the posted transaction and removes the invoice", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("delete");
    const customerId = await createCustomer(headers, "Customer F");

    const created = (await (
      await app.request("/api/invoices", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, invoiceDate: "2026-01-01", dueDate: "2026-01-31", amount: 60 })
      })
    ).json()) as { id: string; postedTransactionId: string };

    const deleteRes = await app.request(`/api/invoices/${created.id}`, { method: "DELETE", headers });
    expect(deleteRes.status).toBe(204);

    const list = (await (await app.request("/api/invoices", { headers })).json()) as unknown[];
    expect(list).toEqual([]);

    const txn = (await (await app.request(`/api/transactions/${created.postedTransactionId}`, { headers })).json()) as { status: string };
    expect(txn.status).toBe("VOIDED");
  });

  test("DELETE rejects a paid invoice", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("delete-paid");
    const customerId = await createCustomer(headers, "Customer G");
    const bankAccount = await findAccount(headers, "BANK");

    const created = (await (
      await app.request("/api/invoices", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, invoiceDate: "2026-01-01", dueDate: "2026-01-31", amount: 20 })
      })
    ).json()) as { id: string };
    await app.request(`/api/invoices/${created.id}/pay`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ depositAccountId: bankAccount!.id })
    });

    const deleteRes = await app.request(`/api/invoices/${created.id}`, { method: "DELETE", headers });
    expect(deleteRes.status).toBe(409);
  });

  test("deleting a customer with invoices against it is rejected, not silently orphaned", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("customer-fk");
    const customerId = await createCustomer(headers, "Customer H");

    await app.request("/api/invoices", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ customerId, invoiceDate: "2026-01-01", dueDate: "2026-01-31", amount: 15 })
    });

    const deleteRes = await app.request(`/api/customers/${customerId}`, { method: "DELETE", headers });
    expect(deleteRes.status).toBe(409);
  });

  test("list only shows the currently active company's invoices, not other companies'", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("scoping");
    const primaryCustomerId = await createCustomer(headers, "Primary Customer");

    await app.request("/api/invoices", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ customerId: primaryCustomerId, invoiceDate: "2026-01-01", dueDate: "2026-01-31", amount: 10 })
    });

    await app.request("/api/companies", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Second Co", templateId: "freelancer" })
    });
    await app.request("/api/companies/Second%20Co/switch", { method: "POST", headers });
    const secondCustomerId = await createCustomer(headers, "Second Co Customer");
    await app.request("/api/invoices", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ customerId: secondCustomerId, invoiceDate: "2026-01-02", dueDate: "2026-02-01", amount: 20 })
    });

    const secondCoList = (await (await app.request("/api/invoices", { headers })).json()) as Array<{ amount: number }>;
    expect(secondCoList.map((i) => i.amount)).toEqual([20]);

    await app.request("/api/companies/company/switch", { method: "POST", headers });
    const primaryList = (await (await app.request("/api/invoices", { headers })).json()) as Array<{ amount: number }>;
    expect(primaryList.map((i) => i.amount)).toEqual([10]);
  });
});
