import { describe, expect, test } from "bun:test";

import { createTestApp, jsonHeaders, readJson } from "./helpers/create-test-app";

type App = Awaited<ReturnType<typeof createTestApp>>["app"];
type Entry = {
  id: string;
  date: string;
  refNumber?: string;
  memo?: string;
  payee?: string;
  deposit?: number;
  reconcileStatus?: string;
  runningBalance: number;
};

async function post<T>(app: App, url: string, body: unknown): Promise<T> {
  const res = await app.request(url, { method: "POST", headers: jsonHeaders(), body: JSON.stringify(body) });
  return readJson<T>(res);
}

// A bank account with three pending $100 deposits (Jan 10/11/12, refs A1..A3).
async function setup() {
  const { app } = await createTestApp();
  const bank = await post<{ id: string }>(app, "/api/accounts", { code: "1010", name: "Checking", category: "BANK" });
  const income = await post<{ id: string }>(app, "/api/accounts", { code: "4010", name: "Sales", category: "INCOME" });
  const other = await post<{ id: string }>(app, "/api/accounts", { code: "4020", name: "Fees", category: "INCOME" });
  for (const [index, day] of ["10", "11", "12"].entries()) {
    const res = await app.request("/api/deposits", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        transactionDate: `2026-01-${day}`,
        referenceNumber: `A${index + 1}`,
        memo: `original ${index + 1}`,
        sourceAccountId: bank.id,
        postings: [
          { accountId: bank.id, type: "DEBIT", amount: 100 },
          { accountId: income.id, type: "CREDIT", amount: 100 }
        ]
      })
    });
    expect(res.status).toBe(201);
  }
  const register = async () => readJson<Entry[]>(await app.request(`/api/accounts/${bank.id}/register`));
  // The register lists newest first.
  const entries = (await register()).sort((a, b) => a.date.localeCompare(b.date));
  return { app, bank, income, other, entries, register };
}

function batchUpdate(app: App, updates: unknown[]) {
  return app.request("/api/register/batch-update", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ updates })
  });
}

function batchDelete(app: App, entryIds: string[]) {
  return app.request("/api/register/batch-delete", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ entryIds })
  });
}

describe("register batch update", () => {
  test("applies every update in one call and keeps balances intact", async () => {
    const { app, entries, register } = await setup();
    const res = await batchUpdate(
      app,
      entries.map((entry, index) => ({
        entryId: entry.id,
        date: entry.date,
        refNumber: `B${index + 1}`,
        memo: `${entry.memo} - batch`,
        payee: "Acme"
      }))
    );
    expect(res.status).toBe(200);

    const after = (await register()).sort((a, b) => a.date.localeCompare(b.date));
    expect(after.map((entry) => entry.refNumber)).toEqual(["B1", "B2", "B3"]);
    expect(after.map((entry) => entry.memo)).toEqual(["original 1 - batch", "original 2 - batch", "original 3 - batch"]);
    expect(after.every((entry) => entry.payee === "Acme")).toBe(true);
    // Amounts were not part of the batch, so the running balance is untouched.
    expect(after.map((entry) => entry.runningBalance)).toEqual([100, 200, 300]);
  });

  test("can move entries to another offset account", async () => {
    const { app, other, entries, register } = await setup();
    const res = await batchUpdate(
      app,
      entries.slice(0, 2).map((entry) => ({ entryId: entry.id, date: entry.date, counterpartyAccountId: other.id }))
    );
    expect(res.status).toBe(200);
    const after = await register();
    expect(after.filter((entry) => (entry as Entry & { accountLabel?: string }).accountLabel === "Fees")).toHaveLength(2);
  });

  test("is all-or-nothing: one locked entry rejects the whole batch and nothing changes", async () => {
    const { app, entries, register } = await setup();
    // Clear the last entry -- cleared/reconciled entries can't be edited.
    const cleared = await app.request(`/api/register/${entries[2].id}/reconcile`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ status: "C" })
    });
    expect(cleared.status).toBe(200);

    const res = await batchUpdate(
      app,
      entries.map((entry) => ({ entryId: entry.id, date: entry.date, memo: "changed" }))
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    const after = (await register()).sort((a, b) => a.date.localeCompare(b.date));
    expect(after.map((entry) => entry.memo)).toEqual(["original 1", "original 2", "original 3"]);
  });

  test("is all-or-nothing: an invalid date in one item rejects everything", async () => {
    const { app, entries, register } = await setup();
    const res = await batchUpdate(app, [
      { entryId: entries[0].id, date: entries[0].date, memo: "changed" },
      { entryId: entries[1].id, date: "not-a-date", memo: "changed" }
    ]);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const after = (await register()).sort((a, b) => a.date.localeCompare(b.date));
    expect(after[0].memo).toBe("original 1");
  });

  test("rejects marking entries reconciled and duplicate ids", async () => {
    const { app, entries } = await setup();
    const reconciled = await batchUpdate(app, [{ entryId: entries[0].id, date: entries[0].date, reconcileStatus: "R" }]);
    expect(reconciled.status).toBeGreaterThanOrEqual(400);

    const duplicate = await batchUpdate(app, [
      { entryId: entries[0].id, date: entries[0].date },
      { entryId: entries[0].id, date: entries[0].date }
    ]);
    expect(duplicate.status).toBeGreaterThanOrEqual(400);
  });

  test("can mark pending entries cleared", async () => {
    const { app, entries, register } = await setup();
    const res = await batchUpdate(
      app,
      entries.slice(0, 2).map((entry) => ({ entryId: entry.id, date: entry.date, reconcileStatus: "C" }))
    );
    expect(res.status).toBe(200);
    const after = (await register()).sort((a, b) => a.date.localeCompare(b.date));
    expect(after.map((entry) => entry.reconcileStatus)).toEqual(["C", "C", ""]);
  });
});

describe("register batch delete", () => {
  test("deletes several entries at once and rebalances", async () => {
    const { app, entries, register } = await setup();
    const res = await batchDelete(app, [entries[0].id, entries[2].id]);
    expect(res.status).toBe(200);

    const after = await register();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(entries[1].id);
    expect(after[0].runningBalance).toBe(100);
  });

  test("is all-or-nothing: a cleared entry rejects the whole batch", async () => {
    const { app, entries, register } = await setup();
    await app.request(`/api/register/${entries[1].id}/reconcile`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ status: "C" })
    });

    const res = await batchDelete(app, [entries[0].id, entries[1].id]);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await register()).toHaveLength(3);
  });

  test("rejects unknown and duplicate ids", async () => {
    const { app, entries, register } = await setup();
    const unknown = await batchDelete(app, [entries[0].id, "6f0f4b2e-0000-4000-8000-000000000000"]);
    expect(unknown.status).toBe(404);
    const duplicate = await batchDelete(app, [entries[0].id, entries[0].id]);
    expect(duplicate.status).toBeGreaterThanOrEqual(400);
    expect(await register()).toHaveLength(3);
  });
});
