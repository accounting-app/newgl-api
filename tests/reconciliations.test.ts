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

    const registerRes = await app.request(`/api/accounts/${bankAccount.id}/register`, { headers });
    const register = (await registerRes.json()) as Array<{ transactionId: string; reconcileStatus: string; deposit?: number }>;
    const adjustmentEntry = register.find((e) => e.deposit === 800);
    expect(adjustmentEntry?.reconcileStatus).toBe("R");
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

    // The adjustment transaction's own register entry must be reconciled
    // too, not just counted -- reconcileStatus only lands on the entry
    // whose account matches the transaction's sourceAccountId.
    const registerRes = await app.request(`/api/accounts/${bankAccount.id}/register`, { headers });
    const register = (await registerRes.json()) as Array<{ transactionId: string; reconcileStatus: string; payment?: number }>;
    const adjustmentEntry = register.find((e) => e.payment === 15);
    expect(adjustmentEntry?.reconcileStatus).toBe("R");
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


  async function chargeToCard(headers: HeadersInit, cardId: string, expenseId: string, amount: number, date: string): Promise<string> {
    const res = await app.request("/api/expenses", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        transactionDate: date,
        sourceAccountId: cardId,
        postings: [
          { accountId: expenseId, type: "DEBIT", amount },
          { accountId: cardId, type: "CREDIT", amount }
        ]
      })
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  async function finish(headers: HeadersInit, accountId: string, body: Record<string, unknown>) {
    return app.request(`/api/accounts/${accountId}/reconciliations/finish`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  test("a credit card reconciles in natural-balance terms: a $100 charge matches a statement showing $100 owed", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("credit-card");
    const card = await findAccount(headers, "CREDIT_CARD");
    const expense = await findAccount(headers, "EXPENSE");
    const chargeId = await chargeToCard(headers, card.id, expense.id, 100, "2026-04-10");

    const res = await finish(headers, card.id, {
      statementStartDate: "2026-04-01",
      statementEndingDate: "2026-04-30",
      statementEndingBalance: 100,
      clearedTransactionIds: [chargeId]
    });
    expect(res.status).toBe(200);
    const finished = (await res.json()) as { id: string; clearedBalance: number };
    expect(finished.clearedBalance).toBe(100);

    const detail = (await (await app.request(`/api/reconciliations/${finished.id}`, { headers })).json()) as {
      normalBalance: string;
      bookBalance: number;
      adjustedBankBalance: number;
      isBalanced: boolean;
    };
    expect(detail.normalBalance).toBe("CREDIT");
    expect(detail.bookBalance).toBe(100);
    expect(detail.adjustedBankBalance).toBe(100);
    expect(detail.isBalanced).toBe(true);
  });

  test("a credit card discrepancy adjustment takes the side that raises what is owed", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("credit-card-plug");
    const card = await findAccount(headers, "CREDIT_CARD");
    const expense = await findAccount(headers, "EXPENSE");
    const chargeId = await chargeToCard(headers, card.id, expense.id, 100, "2026-04-10");

    // Statement says $150 owed; books only have the $100 charge. The $50
    // gap means the card's owed balance must RISE by 50 -> a credit.
    const res = await finish(headers, card.id, {
      statementStartDate: "2026-04-01",
      statementEndingDate: "2026-04-30",
      statementEndingBalance: 150,
      clearedTransactionIds: [chargeId],
      discrepancyAdjustmentDate: "2026-04-30"
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { discrepancyAdjustmentAmount: number }).discrepancyAdjustmentAmount).toBe(50);

    const register = (await (await app.request(`/api/accounts/${card.id}/register`, { headers })).json()) as Array<{
      payment?: number;
      deposit?: number;
      reconcileStatus: string;
    }>;
    const plug = register.find((e) => e.payment === 50);
    expect(plug?.reconcileStatus).toBe("R");
    expect(register.find((e) => e.deposit === 50)).toBeUndefined();
  });

  test("a transaction can only be reconciled once", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("double-reconcile");
    const bank = await findAccount(headers, "BANK");
    const income = await findAccount(headers, "INCOME");
    const txnId = await depositToBank(headers, bank.id, income.id, 100, "2026-01-05");

    const first = await finish(headers, bank.id, {
      statementStartDate: "2026-01-01",
      statementEndingDate: "2026-01-31",
      statementEndingBalance: 100,
      clearedTransactionIds: [txnId]
    });
    expect(first.status).toBe(200);

    // Counting it again would make a $200 statement "balance" at $100 cleared + $100 beginning.
    const again = await finish(headers, bank.id, {
      statementStartDate: "2026-02-01",
      statementEndingDate: "2026-02-28",
      statementEndingBalance: 200,
      clearedTransactionIds: [txnId]
    });
    expect(again.status).toBe(400);
    expect(((await again.json()) as { error: string }).error).toContain("already reconciled");
  });

  test("statements form a chain: a new one must end after the last reconciled statement", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("statement-chain");
    const bank = await findAccount(headers, "BANK");
    const income = await findAccount(headers, "INCOME");
    const first = await depositToBank(headers, bank.id, income.id, 100, "2026-01-05");
    const second = await depositToBank(headers, bank.id, income.id, 40, "2026-01-20");

    expect(
      (await finish(headers, bank.id, { statementStartDate: "2026-01-01", statementEndingDate: "2026-01-31", statementEndingBalance: 100, clearedTransactionIds: [first] })).status
    ).toBe(200);

    const overlapping = await finish(headers, bank.id, {
      statementStartDate: "2026-01-01",
      statementEndingDate: "2026-01-31",
      statementEndingBalance: 140,
      clearedTransactionIds: [second]
    });
    expect(overlapping.status).toBe(400);
    expect(((await overlapping.json()) as { error: string }).error).toContain("after the last reconciled statement");
  });

  test("a transaction dated after the statement ending date can't be cleared into it", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("future-dated");
    const bank = await findAccount(headers, "BANK");
    const income = await findAccount(headers, "INCOME");
    const lateId = await depositToBank(headers, bank.id, income.id, 75, "2026-02-10");

    const res = await finish(headers, bank.id, {
      statementStartDate: "2026-01-01",
      statementEndingDate: "2026-01-31",
      statementEndingBalance: 75,
      clearedTransactionIds: [lateId]
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("dated after the statement ending date");
  });

  test("the next beginning balance comes from the reconciled ledger, and setup flags drift if a reconciled item is later undone", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("setup-drift");
    const bank = await findAccount(headers, "BANK");
    const income = await findAccount(headers, "INCOME");
    const txnId = await depositToBank(headers, bank.id, income.id, 500, "2026-01-10");

    const before = (await (await app.request(`/api/accounts/${bank.id}/reconciliation-setup`, { headers })).json()) as {
      beginningBalance: number;
      lastStatementEndingDate: string | null;
      beginningBalanceMatchesLastStatement: boolean;
    };
    expect(before.beginningBalance).toBe(0);
    expect(before.lastStatementEndingDate).toBeNull();

    await finish(headers, bank.id, { statementStartDate: "2026-01-01", statementEndingDate: "2026-01-31", statementEndingBalance: 500, clearedTransactionIds: [txnId] });

    const after = (await (await app.request(`/api/accounts/${bank.id}/reconciliation-setup`, { headers })).json()) as typeof before & {
      normalBalance: string;
    };
    expect(after.beginningBalance).toBe(500);
    expect(after.lastStatementEndingDate).toBe("2026-01-31");
    expect(after.beginningBalanceMatchesLastStatement).toBe(true);
    expect(after.normalBalance).toBe("DEBIT");

    // Void a reconciled transaction afterwards: the books no longer back the
    // last statement that was reconciled against them.
    const voidRes = await app.request(`/api/transactions/${txnId}/void`, { method: "POST", headers: { ...headers, "X-Confirm-Reconciled": "true" } });
    expect(voidRes.status).toBe(200);
    const drifted = (await (await app.request(`/api/accounts/${bank.id}/reconciliation-setup`, { headers })).json()) as typeof before;
    expect(drifted.beginningBalance).toBe(0);
    expect(drifted.beginningBalanceMatchesLastStatement).toBe(false);
  });

  test("an old report keeps listing what was uncleared AT that statement date, even after a later reconciliation clears it", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("historical-uncleared");
    const bank = await findAccount(headers, "BANK");
    const income = await findAccount(headers, "INCOME");
    const jan = await depositToBank(headers, bank.id, income.id, 500, "2026-01-10");
    const inTransit = await depositToBank(headers, bank.id, income.id, 100, "2026-01-30");

    const janRes = await finish(headers, bank.id, { statementStartDate: "2026-01-01", statementEndingDate: "2026-01-31", statementEndingBalance: 500, clearedTransactionIds: [jan] });
    const janId = ((await janRes.json()) as { id: string }).id;
    // February's statement picks up the deposit that was in transit at Jan 31.
    expect(
      (await finish(headers, bank.id, { statementStartDate: "2026-02-01", statementEndingDate: "2026-02-28", statementEndingBalance: 600, clearedTransactionIds: [inTransit] })).status
    ).toBe(200);

    const janDetail = (await (await app.request(`/api/reconciliations/${janId}`, { headers })).json()) as {
      unclearedTotal: number;
      unclearedEntries: Array<{ deposit: number | null }>;
      bookBalance: number;
      isBalanced: boolean;
    };
    expect(janDetail.unclearedTotal).toBe(100);
    expect(janDetail.unclearedEntries.map((e) => e.deposit)).toEqual([100]);
    expect(janDetail.bookBalance).toBe(600);
    expect(janDetail.isBalanced).toBe(true);
  });


  test("undo reverses the reconciliation: statuses reset, adjustments voided, session gone, beginning balance back", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("undo");
    const bank = await findAccount(headers, "BANK");
    const income = await findAccount(headers, "INCOME");
    const expense = await findAccount(headers, "EXPENSE");
    const txnId = await depositToBank(headers, bank.id, income.id, 1000, "2026-02-01");
    const finishRes = await finish(headers, bank.id, {
      statementStartDate: "2026-02-01",
      statementEndingDate: "2026-02-28",
      statementEndingBalance: 985,
      serviceCharge: { amount: 15, date: "2026-02-28", expenseAccountId: expense.id },
      clearedTransactionIds: [txnId]
    });
    const sessionId = ((await finishRes.json()) as { id: string }).id;

    const undoRes = await app.request(`/api/reconciliations/${sessionId}/undo`, { method: "POST", headers });
    expect(undoRes.status).toBe(200);

    const register = (await (await app.request(`/api/accounts/${bank.id}/register`, { headers })).json()) as Array<{
      transactionId: string;
      reconcileStatus: string;
      payment?: number;
    }>;
    expect(register.find((e) => e.transactionId === txnId)?.reconcileStatus).toBe("");
    // The auto-posted service charge existed only for this reconciliation.
    expect(register.find((e) => e.payment === 15)).toBeUndefined();

    const history = (await (await app.request(`/api/accounts/${bank.id}/reconciliations`, { headers })).json()) as unknown[];
    expect(history).toEqual([]);
    const setup = (await (await app.request(`/api/accounts/${bank.id}/reconciliation-setup`, { headers })).json()) as { beginningBalance: number };
    expect(setup.beginningBalance).toBe(0);

    // ...and the same deposit can be reconciled again afterwards.
    const again = await finish(headers, bank.id, { statementStartDate: "2026-02-01", statementEndingDate: "2026-02-28", statementEndingBalance: 1000, clearedTransactionIds: [txnId] });
    expect(again.status).toBe(200);
  });

  test("only the most recent reconciliation can be undone", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("undo-latest");
    const bank = await findAccount(headers, "BANK");
    const income = await findAccount(headers, "INCOME");
    const a = await depositToBank(headers, bank.id, income.id, 100, "2026-01-10");
    const b = await depositToBank(headers, bank.id, income.id, 50, "2026-02-10");
    const jan = ((await (await finish(headers, bank.id, { statementStartDate: "2026-01-01", statementEndingDate: "2026-01-31", statementEndingBalance: 100, clearedTransactionIds: [a] })).json()) as { id: string }).id;
    const feb = ((await (await finish(headers, bank.id, { statementStartDate: "2026-02-01", statementEndingDate: "2026-02-28", statementEndingBalance: 150, clearedTransactionIds: [b] })).json()) as { id: string }).id;

    const tooEarly = await app.request(`/api/reconciliations/${jan}/undo`, { method: "POST", headers });
    expect(tooEarly.status).toBe(409);
    expect((await app.request(`/api/reconciliations/${feb}/undo`, { method: "POST", headers })).status).toBe(200);
    expect((await app.request(`/api/reconciliations/${jan}/undo`, { method: "POST", headers })).status).toBe(200);
  });

  test("changing a reconciled transaction asks for confirmation (409) and the change lands on the discrepancy report", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("discrepancy-report");
    const bank = await findAccount(headers, "BANK");
    const income = await findAccount(headers, "INCOME");
    const txnId = await depositToBank(headers, bank.id, income.id, 500, "2026-01-10");
    await finish(headers, bank.id, { statementStartDate: "2026-01-01", statementEndingDate: "2026-01-31", statementEndingBalance: 500, clearedTransactionIds: [txnId] });

    const clean = (await (await app.request(`/api/accounts/${bank.id}/reconciliation-discrepancies`, { headers })).json()) as unknown[];
    expect(clean).toEqual([]);

    const blocked = await app.request(`/api/transactions/${txnId}/void`, { method: "POST", headers });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { code: string }).code).toBe("RECONCILED_TRANSACTION");

    const confirmed = await app.request(`/api/transactions/${txnId}/void`, { method: "POST", headers: { ...headers, "X-Confirm-Reconciled": "true" } });
    expect(confirmed.status).toBe(200);

    const issues = (await (await app.request(`/api/accounts/${bank.id}/reconciliation-discrepancies`, { headers })).json()) as Array<{
      change: string;
      reconciledAmount: number | null;
      transactionId: string;
    }>;
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ change: "DELETED", reconciledAmount: 500, transactionId: txnId });
  });

  test("voiding a transaction that was never reconciled needs no confirmation", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("void-free");
    const bank = await findAccount(headers, "BANK");
    const income = await findAccount(headers, "INCOME");
    const txnId = await depositToBank(headers, bank.id, income.id, 20, "2026-01-10");
    expect((await app.request(`/api/transactions/${txnId}/void`, { method: "POST", headers })).status).toBe(200);
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
