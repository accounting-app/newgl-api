import { describe, expect, test, beforeAll } from "bun:test";

import { createTestApp, jsonHeaders, readJson } from "./helpers/create-test-app";

describe("HTTP API", () => {
  let app: Awaited<ReturnType<typeof createTestApp>>["app"];

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  test("GET /api/health returns 200", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);

    const body = await readJson<{
      status: number;
      timestamp: string;
      env: string;
      company: string;
      accounting: { basis: string };
    }>(res);

    expect(body.status).toBe(200);
    expect(body.accounting.basis).toMatch(/^(cash|accrual)$/);
  });

  test("POST /api/accounts creates account", async () => {
    const res = await app.request("/api/accounts", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        code: "1010",
        name: "Checking",
        category: "BANK",
        currency: "USD"
      })
    });

    expect(res.status).toBe(201);
    const account = await readJson<{ id: string; code: string; status: string }>(res);
    expect(account.code).toBe("1010");
    expect(account.status).toBe("ACTIVE");
  });

  test("GET /api/accounts lists created accounts", async () => {
    const res = await app.request("/api/accounts");
    expect(res.status).toBe(200);

    const accounts = await readJson<Array<{ code: string }>>(res);
    expect(accounts.some((account) => account.code === "1010")).toBe(true);
  });

  test("GET /api/accounts/{id} returns account", async () => {
    const createRes = await app.request("/api/accounts", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        code: "5010",
        name: "Office",
        category: "EXPENSE"
      })
    });
    const created = await readJson<{ id: string; name: string }>(createRes);

    const res = await app.request(`/api/accounts/${created.id}`);
    expect(res.status).toBe(200);

    const account = await readJson<{ id: string; name: string }>(res);
    expect(account.id).toBe(created.id);
    expect(account.name).toBe("Office");
  });

  test("POST /api/deposits posts transaction and populates register", async () => {
    const bankRes = await app.request("/api/accounts", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ code: "1020", name: "Cash", category: "BANK" })
    });
    const bank = await readJson<{ id: string }>(bankRes);

    const incomeRes = await app.request("/api/accounts", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ code: "4010", name: "Services", category: "INCOME" })
    });
    const income = await readJson<{ id: string }>(incomeRes);

    const depositRes = await app.request("/api/deposits", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        transactionDate: "2024-02-01",
        referenceNumber: "TX-DEP-1",
        sourceAccountId: bank.id,
        postings: [
          { accountId: bank.id, type: "DEBIT", amount: 75 },
          { accountId: income.id, type: "CREDIT", amount: 75 }
        ]
      })
    });

    expect(depositRes.status).toBe(201);
    const transaction = await readJson<{ status: string }>(depositRes);
    expect(transaction.status).toBe("POSTED");

    const registerRes = await app.request(`/api/accounts/${bank.id}/register`);
    expect(registerRes.status).toBe(200);

    const register = await readJson<Array<{ deposit?: number }>>(registerRes);
    expect(register.length).toBe(1);
    expect(register[0].deposit).toBe(75);
  });

  test("GET /api/ledger/postings returns posted ledger lines", async () => {
    const res = await app.request("/api/ledger/postings");
    expect(res.status).toBe(200);

    const postings = await readJson<Array<{ amount: number }>>(res);
    expect(postings.length).toBeGreaterThan(0);
  });

  test("POST /api/transactions/import creates and posts transactions immediately", async () => {
    const bankRes = await app.request("/api/accounts", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ code: "1030", name: "Import Checking", category: "BANK" })
    });
    const bank = await readJson<{ id: string }>(bankRes);

    const expenseRes = await app.request("/api/accounts", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ code: "5030", name: "Import Office", category: "EXPENSE" })
    });
    const expenseAccount = await readJson<{ id: string }>(expenseRes);

    const importRes = await app.request("/api/transactions/import", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        mainAccountId: bank.id,
        rows: [
          {
            clientRowId: "row-1",
            transactionDate: "2024-02-01",
            payee: "Starbucks",
            amount: -4.5,
            categoryAccountId: expenseAccount.id
          },
          {
            clientRowId: "row-2",
            transactionDate: "2024-02-02",
            payee: "Employer Inc",
            amount: 2500,
            categoryAccountId: expenseAccount.id
          }
        ]
      })
    });

    expect(importRes.status).toBe(200);
    const result = await readJson<{ succeeded: number; failed: number; results: Array<{ status: string }> }>(
      importRes
    );
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.results.every((row) => row.status === "CREATED")).toBe(true);

    const postedRes = await app.request(`/api/transactions?status=POSTED&sourceAccountId=${bank.id}`);
    expect(postedRes.status).toBe(200);
    const posted = await readJson<Array<{ status: string }>>(postedRes);
    expect(posted).toHaveLength(2);
    expect(posted.every((tx) => tx.status === "POSTED")).toBe(true);

    const registerRes = await app.request(`/api/accounts/${bank.id}/register`);
    expect(registerRes.status).toBe(200);
    const register = await readJson<Array<unknown>>(registerRes);
    expect(register).toHaveLength(2);
  });

  test("POST /api/transactions/import rejects an empty rows array", async () => {
    const bankRes = await app.request("/api/accounts", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ code: "1040", name: "Empty Import Checking", category: "BANK" })
    });
    const bank = await readJson<{ id: string }>(bankRes);

    const res = await app.request("/api/transactions/import", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ mainAccountId: bank.id, rows: [] })
    });

    expect(res.status).toBe(400);
  });
});