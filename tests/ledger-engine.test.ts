import { describe, expect, test } from "bun:test";

import { rebuildDerivedViews, recalculateRunningBalances } from "../src/core/ledger-engine";
import type { Account, LedgerStore, Transaction } from "../src/domain/models";

function makeStore(accounts: Account[], transactions: Transaction[]): LedgerStore {
  return {
    accounts,
    chartAccounts: [],
    transactions,
    ledgerPostings: [],
    registerEntries: []
  };
}

describe("ledger-engine", () => {
  test("rebuildDerivedViews excludes DRAFT transactions", () => {
    const bank: Account = {
      id: "bank-id",
      code: "1010",
      name: "Checking",
      category: "BANK",
      currency: "USD",
      openingBalance: 0,
      currentBalance: 0,
      allowManualEntries: true,
      status: "ACTIVE",
      createdAt: "2024-01-01T00:00:00.000Z"
    };

    const expense: Account = {
      id: "expense-id",
      code: "5010",
      name: "Office",
      category: "EXPENSE",
      currency: "USD",
      openingBalance: 0,
      currentBalance: 0,
      allowManualEntries: true,
      status: "ACTIVE",
      createdAt: "2024-01-01T00:00:00.000Z"
    };

    const draft: Transaction = {
      id: "txn-id",
      type: "CHECK",
      status: "DRAFT",
      transactionDate: "2024-02-01",
      postings: [
        { accountId: expense.id, type: "DEBIT", amount: 25 },
        { accountId: bank.id, type: "CREDIT", amount: 25 }
      ],
      createdAt: "2024-02-01T00:00:00.000Z",
      updatedAt: "2024-02-01T00:00:00.000Z"
    };

    const store = makeStore([bank, expense], [draft]);
    rebuildDerivedViews(store);

    expect(store.ledgerPostings).toHaveLength(0);
    expect(store.registerEntries).toHaveLength(0);
  });

  test("recalculateRunningBalances applies opening balance and movements", () => {
    const bank: Account = {
      id: "bank-id",
      code: "1010",
      name: "Checking",
      category: "BANK",
      currency: "USD",
      openingBalance: 100,
      currentBalance: 0,
      allowManualEntries: true,
      status: "ACTIVE",
      createdAt: "2024-01-01T00:00:00.000Z"
    };

    const store = makeStore([bank], []);
    store.registerEntries = [
      {
        id: "entry-1",
        accountId: bank.id,
        transactionId: "txn-1",
        transactionType: "DEPOSIT",
        deposit: 50,
        reconcileStatus: "",
        runningBalance: 0,
        date: "2024-02-01",
        status: "POSTED",
        createdBy: "user",
        createdAt: "2024-02-01T00:00:00.000Z"
      },
      {
        id: "entry-2",
        accountId: bank.id,
        transactionId: "txn-2",
        transactionType: "CHECK",
        payment: 20,
        reconcileStatus: "",
        runningBalance: 0,
        date: "2024-02-02",
        status: "POSTED",
        createdBy: "user",
        createdAt: "2024-02-02T00:00:00.000Z"
      }
    ];

    recalculateRunningBalances(store, bank.id);
    expect(store.registerEntries[0].runningBalance).toBe(150);
    expect(store.registerEntries[1].runningBalance).toBe(130);
  });
});