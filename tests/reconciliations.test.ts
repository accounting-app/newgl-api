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
 * Integration tests for the Reconcile session routes -- the real,
 * statement-matching version of Reconcile (issue #30), replacing the old
 * localStorage-only "Phase 1" stub. Requires a local Supabase stack
 * (`bunx supabase start`); skips with a warning instead of failing if it
 * isn't reachable.
 */
describe("Reconciliation routes", () => {
  let app: ReturnType<typeof createApp>;
  let reachable = false;
  const createdUserIds: string[] = [];
  const createdTenantIds: string[] = [];

  async function bootstrapUser(prefix: string): Promise<{ headers: HeadersInit; tenantId: string }> {
    const user = await createConfirmedUser(`${prefix}-${crypto.randomUUID()}@example.com`, "password123!");
    createdUserIds.push(user.id);
    const headers = { Authorization: `Bearer ${user.accessToken}` };
    const res = await app.request("/api/tenants/bootstrap", { method: "POST", headers });
    const body = (await res.json()) as { id: string };
    createdTenantIds.push(body.id);
    return { headers, tenantId: body.id };
  }

  async function findAccount(headers: HeadersInit, category: string): Promise<{ id: string; name: string }> {
    const accounts = (await (await app.request("/api/accounts", { headers })).json()) as Array<{ id: string; name: string; category: string }>;
    const found = accounts.find((a) => a.category === category);
    if (!found) throw new Error(`No account with category ${category} in this company's default template`);
    return found;
  }

  async function depositToBank(headers: HeadersInit, bankAccountId: string, incomeAccountId: string, amount: number, date: string): Promise<string> {
    const res = await app.request("/api/deposits", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        transactionDate: date,
        sourceAccountId: bankAccountId,
        postings: [
          { accountId: bankAccountId, type: "DEBIT", amount },
          { accountId: incomeAccountId, type: "CREDIT", amount }
        ]
      })
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };
    return created.id;
  }

  beforeAll(async () => {
    reachable = await localSupabaseStackIsReachable();
    if (!reachable) {
      console.warn(
        "Local Supabase/Postgres not reachable at " + SUPABASE_URL + " -- skipping reconciliation integration tests. Run `bunx supabase start` to enable them."
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

  test("finish rejects when the checked transactions don't add up to the statement ending balance", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("out-of-balance");
    const bankAccount = await findAccount(headers, "BANK");
    const incomeAccount = await findAccount(headers, "INCOME");
    const transactionId = await depositToBank(headers, bankAccount.id, incomeAccount.id, 100, "2026-01-05");

    const res = await app.request(`/api/accounts/${bankAccount.id}/reconciliations/finish`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        statementStartDate: "2026-01-01",
        statementEndingDate: "2026-01-31",
        statementEndingBalance: 999,
        clearedTransactionIds: [transactionId]
      })
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { difference: number };
    expect(body.difference).toBeCloseTo(899, 2);
  });

  test("finish with discrepancyAdjustmentDate posts a balancing entry against Reconciliation Discrepancies and finishes anyway", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("discrepancy");
    const bankAccount = await findAccount(headers, "BANK");
    const incomeAccount = await findAccount(headers, "INCOME");
    const transactionId = await depositToBank(headers, bankAccount.id, incomeAccount.id, 100, "2026-01-05");

    // Statement says 900 but only a $100 deposit is checked -- QBO's "Hold
    // on! Your difference isn't $0.00 yet" -> "Add adjustment and finish".
    const finishRes = await app.request(`/api/accounts/${bankAccount.id}/reconciliations/finish`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        statementStartDate: "2026-01-01",
        statementEndingDate: "2026-01-31",
        statementEndingBalance: 900,
        clearedTransactionIds: [transactionId],
        discrepancyAdjustmentDate: "2026-01-31"
      })
    });
    expect(finishRes.status).toBe(200);
    const finished = (await finishRes.json()) as {
      clearedBalance: number;
      discrepancyAdjustmentAmount: number | null;
      enteredCount: number;
    };
    expect(finished.clearedBalance).toBe(900);
    expect(finished.discrepancyAdjustmentAmount).toBe(800);
    // The deposit + the auto-created discrepancy adjustment transaction.
    expect(finished.enteredCount).toBe(2);

    const accounts = (await (await app.request("/api/accounts", { headers })).json()) as Array<{ name: string; category: string }>;
    expect(accounts).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Reconciliation Discrepancies", category: "OTHER_EXPENSE" })]));
  });

  test("finish succeeds when the balance matches, marks the entry reconciled, and shows up in history", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("balanced");
    const bankAccount = await findAccount(headers, "BANK");
    const incomeAccount = await findAccount(headers, "INCOME");
    const transactionId = await depositToBank(headers, bankAccount.id, incomeAccount.id, 500, "2026-01-10");

    const finishRes = await app.request(`/api/accounts/${bankAccount.id}/reconciliations/finish`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        statementStartDate: "2026-01-01",
        statementEndingDate: "2026-01-31",
        statementEndingBalance: 500,
        clearedTransactionIds: [transactionId]
      })
    });
    expect(finishRes.status).toBe(200);
    const finished = (await finishRes.json()) as { id: string; clearedBalance: number; enteredCount: number };
    expect(finished.clearedBalance).toBe(500);
    expect(finished.enteredCount).toBe(1);

    const registerRes = await app.request(`/api/accounts/${bankAccount.id}/register`, { headers });
    const register = (await registerRes.json()) as Array<{ transactionId: string; reconcileStatus: string }>;
    const entry = register.find((e) => e.transactionId === transactionId);
    expect(entry?.reconcileStatus).toBe("R");

    const historyRes = await app.request(`/api/accounts/${bankAccount.id}/reconciliations`, { headers });
    const history = (await historyRes.json()) as Array<{ id: string }>;
    expect(history.map((h) => h.id)).toContain(finished.id);

    const summaryRes = await app.request("/api/reconciliations", { headers });
    const summary = (await summaryRes.json()) as Array<{ id: string }>;
    expect(summary.map((s) => s.id)).toContain(finished.id);

    const detailRes = await app.request(`/api/reconciliations/${finished.id}`, { headers });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as { entries: Array<{ transactionId: string; deposit: number | null }> };
    expect(detail.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ transactionId, deposit: 500 })])
    );
  });

  test("finish with a service charge posts a real adjustment transaction and folds it into the cleared balance", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("service-charge");
    const bankAccount = await findAccount(headers, "BANK");
    const incomeAccount = await findAccount(headers, "INCOME");
    const expenseAccount = await findAccount(headers, "EXPENSE");
    const transactionId = await depositToBank(headers, bankAccount.id, incomeAccount.id, 1000, "2026-02-01");

    // Beginning balance is 0 for a fresh account; a $1000 deposit plus a
    // $15 service charge (which reduces the balance) should require a
    // statement ending balance of exactly 985 to balance.
    const finishRes = await app.request(`/api/accounts/${bankAccount.id}/reconciliations/finish`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        statementStartDate: "2026-02-01",
        statementEndingDate: "2026-02-28",
        statementEndingBalance: 985,
        serviceCharge: { amount: 15, date: "2026-02-28", expenseAccountId: expenseAccount.id },
        clearedTransactionIds: [transactionId]
      })
    });
    expect(finishRes.status).toBe(200);
    const finished = (await finishRes.json()) as { clearedBalance: number; serviceChargeAmount: number | null; enteredCount: number };
    expect(finished.clearedBalance).toBe(985);
    expect(finished.serviceChargeAmount).toBe(15);
    // The deposit + the auto-created service-charge adjustment transaction.
    expect(finished.enteredCount).toBe(2);
  });

  test("detail reports uncleared total, register balance, cleared counts/totals, and reconciledBy", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("report-detail");
    const bankAccount = await findAccount(headers, "BANK");
    const incomeAccount = await findAccount(headers, "INCOME");
    const clearedTransactionId = await depositToBank(headers, bankAccount.id, incomeAccount.id, 500, "2026-01-10");
    // Left uncleared on purpose, dated within the same statement period.
    await depositToBank(headers, bankAccount.id, incomeAccount.id, 100, "2026-01-15");

    const finishRes = await app.request(`/api/accounts/${bankAccount.id}/reconciliations/finish`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        statementStartDate: "2026-01-01",
        statementEndingDate: "2026-01-31",
        statementEndingBalance: 500,
        clearedTransactionIds: [clearedTransactionId]
      })
    });
    expect(finishRes.status).toBe(200);
    const finished = (await finishRes.json()) as { id: string; reconciledBy: string | null };
    expect(finished.reconciledBy).toContain("report-detail-");

    const detailRes = await app.request(`/api/reconciliations/${finished.id}`, { headers });
    const detail = (await detailRes.json()) as {
      paymentsCount: number;
      paymentsTotal: number;
      depositsCount: number;
      depositsTotal: number;
      unclearedTotal: number;
      registerBalance: number;
    };
    expect(detail.paymentsCount).toBe(0);
    expect(detail.paymentsTotal).toBe(0);
    expect(detail.depositsCount).toBe(1);
    expect(detail.depositsTotal).toBe(500);
    expect(detail.unclearedTotal).toBe(100);
    expect(detail.registerBalance).toBe(600);
  });

  test("finish rejects an unknown transaction id for this account", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("unknown-txn");
    const bankAccount = await findAccount(headers, "BANK");

    const res = await app.request(`/api/accounts/${bankAccount.id}/reconciliations/finish`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        statementStartDate: "2026-01-01",
        statementEndingDate: "2026-01-31",
        statementEndingBalance: 0,
        clearedTransactionIds: [crypto.randomUUID()]
      })
    });
    expect(res.status).toBe(400);
  });
});
