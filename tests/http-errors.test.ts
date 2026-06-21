import { describe, expect, test, beforeAll } from "bun:test";

import { createTestApp, jsonHeaders, readJson } from "./helpers/create-test-app";

describe("HTTP error responses", () => {
  let app: Awaited<ReturnType<typeof createTestApp>>["app"];

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  test("GET /api/accounts/{id} returns 404 for unknown account", async () => {
    const res = await app.request(`/api/accounts/${crypto.randomUUID()}`);
    expect(res.status).toBe(404);

    const body = await readJson<{ error: string }>(res);
    expect(body.error).toContain("not found");
  });

  test("POST /api/accounts returns 409 for duplicate code", async () => {
    const payload = { code: "3030", name: "Checking", category: "BANK" };

    const first = await app.request("/api/accounts", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify(payload)
    });
    expect(first.status).toBe(201);

    const second = await app.request("/api/accounts", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ ...payload, name: "Other Checking" })
    });
    expect(second.status).toBe(409);

    const body = await readJson<{ error: string }>(second);
    expect(body.error).toContain("3030");
  });

  test("GET /api/accounts/not-a-uuid returns 400", async () => {
    const res = await app.request("/api/accounts/not-a-uuid");
    expect(res.status).toBe(400);
  });

  test("POST /api/transactions returns 400 for unbalanced postings", async () => {
    const bankRes = await app.request("/api/accounts", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ code: "1040", name: "Bank", category: "BANK" })
    });
    const bank = await readJson<{ id: string }>(bankRes);

    const expenseRes = await app.request("/api/accounts", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ code: "5040", name: "Expense", category: "EXPENSE" })
    });
    const expense = await readJson<{ id: string }>(expenseRes);

    const res = await app.request("/api/transactions", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        type: "CHECK",
        transactionDate: "2024-02-01",
        postings: [
          { accountId: expense.id, type: "DEBIT", amount: 50 },
          { accountId: bank.id, type: "CREDIT", amount: 40 }
        ]
      })
    });

    expect(res.status).toBe(400);
    const body = await readJson<{ error: string }>(res);
    expect(body.error.toLowerCase()).toContain("unbalanced");
  });

  test("POST /api/transactions/{id}/post returns 400 when not DRAFT", async () => {
    const bankRes = await app.request("/api/accounts", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ code: "1050", name: "Bank", category: "BANK" })
    });
    const bank = await readJson<{ id: string }>(bankRes);

    const expenseRes = await app.request("/api/accounts", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ code: "5050", name: "Expense", category: "EXPENSE" })
    });
    const expense = await readJson<{ id: string }>(expenseRes);

    const createRes = await app.request("/api/transactions", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        type: "CHECK",
        transactionDate: "2024-02-01",
        postings: [
          { accountId: expense.id, type: "DEBIT", amount: 20 },
          { accountId: bank.id, type: "CREDIT", amount: 20 }
        ]
      })
    });
    const draft = await readJson<{ id: string }>(createRes);

    await app.request(`/api/transactions/${draft.id}/post`, { method: "POST" });

    const res = await app.request(`/api/transactions/${draft.id}/post`, { method: "POST" });
    expect(res.status).toBe(400);
  });

  test("GET /api/ledger/transactions/{id}/postings returns 404 for unknown transaction", async () => {
    const res = await app.request(`/api/ledger/transactions/${crypto.randomUUID()}/postings`);
    expect(res.status).toBe(404);
  });
});