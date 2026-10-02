import { describe, expect, test } from "bun:test";

import { createServiceContainer } from "../src/application/create-service-container";
import { createApp } from "../src/http/app";
import { BeancountLedgerRepository } from "../src/infra/beancount/repository";
import { createTestApp, jsonHeaders, readJson } from "./helpers/create-test-app";

type Entry = { id: string; reconcileStatus?: string };

async function post<T>(app: { request: (u: string, i?: RequestInit) => Response | Promise<Response> }, url: string, body: unknown) {
  const res = await app.request(url, { method: "POST", headers: jsonHeaders(), body: JSON.stringify(body) });
  return readJson<T>(res);
}

describe("register entry ids", () => {
  test("are stable across ledger reloads and usable by reconcile", async () => {
    const { app, ledgerFile } = await createTestApp();
    const bank = await post<{ id: string }>(app, "/api/accounts", { code: "1010", name: "Checking", category: "BANK" });
    const income = await post<{ id: string }>(app, "/api/accounts", { code: "4010", name: "Sales", category: "INCOME" });
    const dep = await app.request("/api/deposits", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        transactionDate: "2026-01-15",
        sourceAccountId: bank.id,
        postings: [
          { accountId: bank.id, type: "DEBIT", amount: 75 },
          { accountId: income.id, type: "CREDIT", amount: 75 }
        ]
      })
    });
    expect(dep.status).toBe(201);

    const first = await readJson<Entry[]>(await app.request(`/api/accounts/${bank.id}/register`));

    // Simulate the per-request reload: a fresh repository parsing the same file.
    const repository = new BeancountLedgerRepository(ledgerFile, "Test Co");
    await repository.load();
    const reloaded = createApp(createServiceContainer(repository));

    const second = await readJson<Entry[]>(await reloaded.request(`/api/accounts/${bank.id}/register`));
    expect(second.map((e) => e.id)).toEqual(first.map((e) => e.id));

    const repository2 = new BeancountLedgerRepository(ledgerFile, "Test Co");
    await repository2.load();
    const again = createApp(createServiceContainer(repository2));
    const res = await again.request(`/api/register/${first[0].id}/reconcile`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ status: "C" })
    });
    expect(res.status).toBe(200);
  });
});
