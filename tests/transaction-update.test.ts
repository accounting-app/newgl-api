import { describe, expect, test } from "bun:test";

import { createTestApp, jsonHeaders, readJson } from "./helpers/create-test-app";

type Posting = { accountId: string; type: "DEBIT" | "CREDIT"; amount: number; description?: string };
type Txn = { id: string; memo?: string; paymentMethod?: string; postings: Posting[] };
type Entry = { id: string; transactionId: string; payment?: number; reconcileStatus: string; runningBalance: number };

async function setup() {
  const { app } = await createTestApp();
  const send = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(url, { method, headers: { ...jsonHeaders(), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const account = async (code: string, name: string, category: string) =>
    readJson<{ id: string }>(await send("POST", "/api/accounts", { code, name, category }));
  const bank = await account("1010", "Checking", "BANK");
  const office = await account("6010", "Office", "EXPENSE");
  const travel = await account("6020", "Travel", "EXPENSE");
  const input = (lines: Array<[string, number, string?]>) => ({
    transactionDate: "2026-01-10",
    memo: "memo",
    paymentMethod: "Cash",
    sourceAccountId: bank.id,
    postings: [
      ...lines.map(([accountId, amount, description]) => ({ accountId, type: "DEBIT", amount, description })),
      { accountId: bank.id, type: "CREDIT", amount: lines.reduce((sum, line) => sum + line[1], 0) }
    ]
  });
  const created = await readJson<Txn>(await send("POST", "/api/transactions", { type: "EXPENSE", ...input([[office.id, 50, "Printer ink"]]) }));
  await send("POST", `/api/transactions/${created.id}/post`);
  const register = async () => readJson<Entry[]>(await send("GET", `/api/accounts/${bank.id}/register`));
  return { send, bank, office, travel, input, id: created.id, register };
}

describe("update a saved transaction", () => {
  test("keeps line descriptions and the payment method", async () => {
    const { send, id } = await setup();
    const saved = await readJson<Txn>(await send("GET", `/api/transactions/${id}`));
    expect(saved.paymentMethod).toBe("Cash");
    expect(saved.postings[0].description).toBe("Printer ink");
  });

  test("replaces the lines in place and rebalances", async () => {
    const { send, office, travel, input, id, register } = await setup();
    const before = await register();
    const res = await send("PUT", `/api/transactions/${id}`, input([[office.id, 20, "Paper"], [travel.id, 100, "Taxi"]]));
    expect(res.status).toBe(200);
    const saved = await readJson<Txn>(res);
    expect(saved.id).toBe(id);
    expect(saved.postings.map((posting) => posting.description)).toEqual(["Paper", "Taxi", undefined]);

    const after = await register();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before[0].id);
    expect(after[0].payment).toBe(120);
    expect(after[0].runningBalance).toBe(-120);
  });

  test("keeps form-only details, including line breaks and quotes", async () => {
    const { send, office, input, id } = await setup();
    const body = { ...input([[office.id, 50]]), details: { mailing: 'ACME "North"\n1 Main St', printLater: "1" } };
    (body.postings[0] as { details?: Record<string, string> }).details = { name: "John Doe", qty: "2", rate: "25" };
    expect((await send("PUT", `/api/transactions/${id}`, body)).status).toBe(200);
    const saved = await readJson<{ details?: Record<string, string>; postings: Array<{ details?: Record<string, string> }> }>(
      await send("GET", `/api/transactions/${id}`)
    );
    expect(saved.details).toEqual({ mailing: 'ACME "North"\n1 Main St', printLater: "1" });
    expect(saved.postings[0].details).toEqual({ name: "John Doe", qty: "2", rate: "25" });
  });

  test("a row save on a split keeps every line's amount, and refuses to change the total", async () => {
    const { send, office, travel, input, id, register } = await setup();
    await send("PUT", `/api/transactions/${id}`, input([[office.id, 20], [travel.id, 100]]));
    const entry = (await register())[0];

    const same = await send("PATCH", `/api/register/${entry.id}`, { date: "2026-01-11", memo: "moved", payment: 120 });
    expect(same.status).toBe(200);
    const amounts = async () =>
      (await readJson<Txn>(await send("GET", `/api/transactions/${id}`))).postings.map((posting) => posting.amount);
    expect(await amounts()).toEqual([20, 100, 120]);

    const changed = await send("PATCH", `/api/register/${entry.id}`, { date: "2026-01-11", payment: 90 });
    expect(changed.status).toBeGreaterThanOrEqual(400);
    expect(await amounts()).toEqual([20, 100, 120]);
  });

  test("rejects unbalanced lines and leaves the transaction alone", async () => {
    const { send, input, office, bank, id, register } = await setup();
    const res = await send("PUT", `/api/transactions/${id}`, {
      ...input([[office.id, 10]]),
      postings: [
        { accountId: office.id, type: "DEBIT", amount: 10 },
        { accountId: bank.id, type: "CREDIT", amount: 9 }
      ]
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await register())[0].payment).toBe(50);
  });

  test("a reconciled transaction needs confirmation and keeps its mark", async () => {
    const { send, input, office, id, register } = await setup();
    const entry = (await register())[0];
    await send("POST", `/api/register/${entry.id}/reconcile`, { status: "R" });
    const change = input([[office.id, 75]]);
    expect((await send("PUT", `/api/transactions/${id}`, change)).status).toBe(409);
    expect((await send("PUT", `/api/transactions/${id}`, change, { "X-Confirm-Reconciled": "true" })).status).toBe(200);
    expect((await register())[0].reconcileStatus).toBe("R");
  });
});

describe("details survive the .bean file", () => {
  test("serialize then parse keeps descriptions and details", async () => {
    const { documentToStore, storeToDocument } = await import("@/infra/beancount/mapper");
    const { parseBeancount, serializeBeancount } = await import("@/infra/beancount/parser");
    const account = (id: string, name: string, category: "BANK" | "EXPENSE") => ({
      id, code: name, name, category, currency: "USD", openingBalance: 0, currentBalance: 0,
      allowManualEntries: true, status: "ACTIVE" as const, createdAt: "2026-01-01T00:00:00.000Z"
    });
    const bank = account("11111111-1111-4111-8111-111111111111", "Checking", "BANK");
    const office = account("22222222-2222-4222-8222-222222222222", "Office", "EXPENSE");
    const store = {
      accounts: [bank, office],
      chartAccounts: [],
      ledgerPostings: [],
      registerEntries: [],
      transactions: [{
        id: "33333333-3333-4333-8333-333333333333", type: "EXPENSE" as const, status: "POSTED" as const,
        transactionDate: "2026-01-10", sourceAccountId: bank.id, details: { mailing: 'A "B"\\C\nD' },
        postings: [
          { accountId: office.id, type: "DEBIT" as const, amount: 5, description: "Line \"one\"", details: { name: "Jane", qty: "2" } },
          { accountId: bank.id, type: "CREDIT" as const, amount: 5 }
        ]
      }]
    };
    const text = serializeBeancount(storeToDocument(store));
    const [txn] = documentToStore(parseBeancount(text)).transactions;
    expect(txn.details).toEqual({ mailing: 'A "B"\\C\nD' });
    expect(txn.postings[0].description).toBe('Line "one"');
    expect(txn.postings[0].details).toEqual({ name: "Jane", qty: "2" });
  });
});
