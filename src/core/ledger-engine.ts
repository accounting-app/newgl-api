import {
  computeBalanceImpact,
  postingFiscalPeriod
} from "@/core/accounting-reports";
import { NotFoundError } from "@/core/errors";
import type {
  Account,
  ChartOfAccount,
  LedgerPosting,
  LedgerStore,
  PostingEntryType,
  RegisterEntry,
  Transaction
} from "@/domain/models";
import { createId } from "@/shared/utils/id";
import { nowIso } from "@/shared/utils/date";

const ACCOUNT_TYPE_BY_CATEGORY: Record<Account["category"], ChartOfAccount["accountType"]> = {
  ACCOUNTS_RECEIVABLE: "ASSET",
  BANK: "ASSET",
  CREDIT_CARD: "LIABILITY",
  EQUITY: "EQUITY",
  EXPENSE: "EXPENSE",
  FIXED_ASSET: "ASSET",
  INCOME: "REVENUE",
  LONG_TERM_LIABILITY: "LIABILITY",
  OTHER_CURRENT_ASSET: "ASSET",
  OTHER_CURRENT_LIABILITY: "LIABILITY",
  OTHER_EXPENSE: "EXPENSE",
  OTHER_INCOME: "REVENUE"
};

const NORMAL_BALANCE_BY_TYPE: Record<ChartOfAccount["accountType"], ChartOfAccount["normalBalance"]> = {
  ASSET: "DEBIT",
  LIABILITY: "CREDIT",
  EQUITY: "CREDIT",
  REVENUE: "CREDIT",
  EXPENSE: "DEBIT"
};

export function buildChartAccount(account: Account, createdAt?: string): ChartOfAccount {
  const accountType = ACCOUNT_TYPE_BY_CATEGORY[account.category];
  return {
    id: account.id,
    accountNumber: account.code,
    name: account.name,
    accountType,
    accountSubtype: account.subtype,
    normalBalance: NORMAL_BALANCE_BY_TYPE[accountType],
    isParent: false,
    isSystemAccount: false,
    allowsManualPostings: account.allowManualEntries,
    currency: account.currency,
    openingBalance: account.openingBalance ?? 0,
    currentBalance: account.currentBalance,
    availableBalance: account.currentBalance,
    status: account.status,
    createdAt: createdAt ?? account.createdAt,
    updatedAt: account.updatedAt
  };
}

export function requireAccount(store: LedgerStore, accountId: string): Account {
  const account = store.accounts.find((item) => item.id === accountId);
  if (!account) {
    throw new NotFoundError(`Account ${accountId} not found`);
  }
  return account;
}

export function rebuildDerivedViews(store: LedgerStore): void {
  store.ledgerPostings = [];
  store.registerEntries = [];

  const ledgerTransactions = store.transactions.filter(
    (transaction) => transaction.status === "POSTED"
  );

  ledgerTransactions.forEach((transaction) => {
    appendLedgerPostings(store, transaction);
    createRegisterEntries(store, transaction);
  });

  store.accounts.forEach((account) => {
    updateAccountBalance(store, account.id);
    recalculateRunningBalances(store, account.id);
  });

  store.chartAccounts = store.accounts.map((account) => buildChartAccount(account));
}

function appendLedgerPostings(store: LedgerStore, transaction: Transaction): void {
  const createdAt = transaction.postedAt ?? transaction.createdAt ?? nowIso();
  transaction.postings.forEach((posting) => {
    const account = requireAccount(store, posting.accountId);
    const ledgerPosting: LedgerPosting = {
      id: createId(),
      transactionId: transaction.id,
      accountId: posting.accountId,
      accountCode: account.code,
      accountName: account.name,
      entryType: posting.type,
      amount: posting.amount,
      currency: account.currency,
      exchangeRate: 1,
      postingDate: transaction.transactionDate,
      fiscalPeriod: postingFiscalPeriod(transaction.transactionDate),
      memo: transaction.memo,
      referenceNumber: transaction.referenceNumber,
      sourceDocumentType: transaction.type,
      sourceDocumentId: transaction.id,
      reconciliationStatus: "UNRECONCILED",
      status: "POSTED",
      createdBy: transaction.createdBy,
      createdAt,
      postedAt: createdAt
    };
    store.ledgerPostings.push(ledgerPosting);
  });
}

function createRegisterEntries(store: LedgerStore, transaction: Transaction): void {
  const perAccount = new Map<string, { payment: number; deposit: number }>();
  transaction.postings.forEach((posting) => {
    const current = perAccount.get(posting.accountId) ?? { payment: 0, deposit: 0 };
    if (posting.type === "DEBIT") {
      current.deposit += posting.amount;
    } else {
      current.payment += posting.amount;
    }
    perAccount.set(posting.accountId, current);
  });

  const createdAt = transaction.postedAt ?? transaction.createdAt ?? nowIso();

  perAccount.forEach((value, accountId) => {
    const counterpartyAccountNames = [
      ...new Set(
        transaction.postings
          .filter((posting) => posting.accountId !== accountId)
          .map((posting) => requireAccount(store, posting.accountId).name)
      )
    ];
    const isSourceAccountEntry = transaction.sourceAccountId === accountId;
    const displayAccountLabel = isSourceAccountEntry
      ? transaction.accountLabel ?? counterpartyAccountNames[0]
      : counterpartyAccountNames[0];
    const entryReconcileStatus =
      isSourceAccountEntry && transaction.reconcileStatus ? transaction.reconcileStatus : "";

    const entry: RegisterEntry = {
      id: createId(),
      accountId,
      transactionId: transaction.id,
      transactionType: transaction.type,
      refNumber: transaction.referenceNumber,
      payee: transaction.payee,
      accountLabel: displayAccountLabel,
      memo: transaction.memo,
      payment: value.payment > 0 ? value.payment : undefined,
      deposit: value.deposit > 0 ? value.deposit : undefined,
      reconcileStatus: entryReconcileStatus,
      runningBalance: 0,
      postedAt: createdAt,
      date: transaction.transactionDate,
      status: transaction.status,
      createdBy: transaction.createdBy ?? "system",
      createdAt
    };
    store.registerEntries.push(entry);
  });
}

export function recalculateRunningBalances(store: LedgerStore, accountId: string): void {
  const account = requireAccount(store, accountId);
  const entries = store.registerEntries
    .filter((entry) => entry.accountId === accountId)
    .sort((a, b) => `${a.date}-${a.createdAt}`.localeCompare(`${b.date}-${b.createdAt}`));

  let running = account.openingBalance ?? 0;
  entries.forEach((entry) => {
    running = running + (entry.deposit ?? 0) - (entry.payment ?? 0);
    entry.runningBalance = running;
  });
}

export function updateAccountBalance(store: LedgerStore, accountId: string): void {
  const account = requireAccount(store, accountId);
  const posted = store.ledgerPostings.filter(
    (posting) => posting.accountId === accountId && posting.status === "POSTED"
  );
  const base = account.openingBalance ?? 0;
  const impact = posted.reduce(
    (sum, posting) => sum + computeBalanceImpact(account.category, posting.entryType, posting.amount),
    0
  );
  account.currentBalance = base + impact;
}

export function updateAccountBalances(store: LedgerStore, accountIds: string[]): void {
  const uniqueIds = [...new Set(accountIds)];
  uniqueIds.forEach((accountId) => updateAccountBalance(store, accountId));
  store.chartAccounts = store.accounts.map((account) => buildChartAccount(account));
}

export function refreshDerivedViewsForAccounts(store: LedgerStore, accountIds: string[]): void {
  store.ledgerPostings = store.ledgerPostings.filter(
    (posting) => !accountIds.includes(posting.accountId)
  );
  const transactionIds = new Set(
    store.transactions
      .filter((transaction) => transaction.status === "POSTED")
      .map((transaction) => transaction.id)
  );
  store.registerEntries = store.registerEntries.filter((entry) =>
    transactionIds.has(entry.transactionId)
  );
  store.transactions
    .filter((transaction) => transaction.status === "POSTED")
    .forEach((transaction) => {
      appendLedgerPostings(store, transaction);
      createRegisterEntries(store, transaction);
    });
  updateAccountBalances(store, accountIds);
  accountIds.forEach((accountId) => recalculateRunningBalances(store, accountId));
}

export function postingSideFromRegisterAmounts(input: {
  deposit?: number;
  payment?: number;
}): PostingEntryType {
  return input.deposit && input.deposit > 0 ? "DEBIT" : "CREDIT";
}
