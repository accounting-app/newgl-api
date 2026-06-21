import { buildChartAccount, rebuildDerivedViews } from "@/core/ledger-engine";
import { getPeriodIdForDate } from "@/core/periods";
import type {
  Account,
  LedgerStore,
  PostingEntryType,
  ReconcileStatus,
  Transaction,
  TransactionPostingInput,
  TransactionStatus,
  TransactionType
} from "@/domain/models";
import {
  accountPathFromName,
  categoryFromAccountPath,
  escapeBeancountString
} from "@/infra/beancount/account-paths";
import type {
  BeancountDocument,
  ParsedOpen,
  ParsedPosting,
  ParsedTransaction
} from "@/infra/beancount/parser";
import { createId } from "@/shared/utils/id";
import { nowIso } from "@/shared/utils/date";

type AccountRecord = Account & { beancountPath: string; openDate: string; currencies: string[] };

function metaString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" ? value : undefined;
}

function signedToPosting(
  account: Account,
  signedAmount: number
): { type: PostingEntryType; amount: number } {
  const amount = Math.abs(signedAmount);
  if (signedAmount === 0) {
    return { type: "DEBIT", amount: 0 };
  }
  // Beancount: positive signed amounts are debits, negative amounts are credits.
  return { type: signedAmount > 0 ? "DEBIT" : "CREDIT", amount };
}

function postingToSigned(_account: Account, type: PostingEntryType, amount: number): number {
  return type === "DEBIT" ? amount : -amount;
}

function inferTransactionStatus(txn: ParsedTransaction): TransactionStatus {
  const status = metaString(txn.metadata, "status");
  if (status === "VOIDED" || status === "DELETED") return status;
  if (txn.flag === "!") return "DRAFT";
  return "POSTED";
}

function inferTransactionType(txn: ParsedTransaction): TransactionType {
  const explicit = metaString(txn.metadata, "qbo-type");
  if (explicit && isTransactionType(explicit)) {
    return explicit;
  }
  return "JOURNAL_ENTRY";
}

function isTransactionType(value: string): value is TransactionType {
  return [
    "CHECK",
    "DEPOSIT",
    "SALES_RECEIPT",
    "RECEIVE_PAYMENT",
    "BILL_PAYMENT",
    "REFUND",
    "EXPENSE",
    "TRANSFER",
    "JOURNAL_ENTRY"
  ].includes(value);
}

function parseReconcile(value: unknown): ReconcileStatus | undefined {
  if (value === "C" || value === "R" || value === "") return value;
  return undefined;
}

export function documentToStore(document: BeancountDocument): LedgerStore {
  const closedAccounts = new Set(document.closes.map((item) => item.account));
  const accountByPath = new Map<string, AccountRecord>();
  const accountById = new Map<string, AccountRecord>();

  document.opens.forEach((open, index) => {
    const account = openToAccount(open, index, closedAccounts.has(open.account));
    accountByPath.set(open.account, account);
    accountById.set(account.id, account);
  });

  const transactions: Transaction[] = document.transactions.map((txn) =>
    parsedTransactionToDomain(txn, accountByPath, accountById)
  );

  const store: LedgerStore = {
    accounts: [...accountById.values()].map(({ beancountPath: _p, openDate: _d, currencies: _c, ...account }) => account),
    chartAccounts: [],
    transactions,
    ledgerPostings: [],
    registerEntries: []
  };

  store.chartAccounts = store.accounts.map((account) => buildChartAccount(account));
  rebuildDerivedViews(store);
  return store;
}

function openToAccount(open: ParsedOpen, index: number, isClosed: boolean): AccountRecord {
  const id = metaString(open.metadata, "id") ?? createId();
  const name = metaString(open.metadata, "name") ?? open.account.split(":").pop() ?? open.account;
  const category = categoryFromAccountPath(open.account, metaString(open.metadata, "qbo-category"));
  const statusMeta = metaString(open.metadata, "status");
  const status: Account["status"] = isClosed
    ? "CLOSED"
    : statusMeta === "ARCHIVED" || statusMeta === "CLOSED"
      ? statusMeta
      : "ACTIVE";
  const createdAt = metaString(open.metadata, "created-at") ?? `${open.date}T00:00:00.000Z`;

  return {
    id,
    code: metaString(open.metadata, "account-number") ?? String(1000 + index * 10),
    name,
    category,
    subtype: metaString(open.metadata, "qbo-subtype"),
    currency: open.currencies[0] ?? "USD",
    openingBalance: Number(metaString(open.metadata, "opening-balance") ?? 0),
    currentBalance: 0,
    allowManualEntries: metaString(open.metadata, "allow-manual-entries") !== "FALSE",
    status,
    createdAt,
    beancountPath: open.account,
    openDate: open.date,
    currencies: open.currencies.length > 0 ? open.currencies : ["USD"]
  };
}

function resolveSignedPostings(
  txn: ParsedTransaction,
  accountByPath: Map<string, AccountRecord>
): TransactionPostingInput[] {
  type Row = { accountId: string; currency: string; signed: number | null; account: AccountRecord };

  const rows: Row[] = txn.postings.map((posting) => {
    const account = accountByPath.get(posting.account);
    if (!account) {
      throw new Error(`Unknown account path in transaction ${metaString(txn.metadata, "id") ?? txn.date}: ${posting.account}`);
    }
    const currency = posting.currency ?? account.currency;
    return {
      accountId: account.id,
      currency,
      signed: posting.amount ?? null,
      account
    };
  });

  for (const currency of [...new Set(rows.map((row) => row.currency))]) {
    const inCurrency = rows.filter((row) => row.currency === currency);
    const implicit = inCurrency.filter((row) => row.signed === null);
    const explicitSum = inCurrency
      .filter((row) => row.signed !== null)
      .reduce((total, row) => total + row.signed!, 0);

    if (implicit.length === 1) {
      implicit[0].signed = -explicitSum;
    } else if (implicit.length > 1) {
      throw new Error(`Multiple implicit postings for ${currency} in transaction.`);
    }
  }

  return rows
    .map((row) => {
      const converted = signedToPosting(row.account, row.signed ?? 0);
      return {
        accountId: row.accountId,
        type: converted.type,
        amount: converted.amount
      };
    })
    .filter((posting) => posting.amount > 0);
}

function parsedTransactionToDomain(
  txn: ParsedTransaction,
  accountByPath: Map<string, AccountRecord>,
  accountById: Map<string, AccountRecord>
): Transaction {
  const id = metaString(txn.metadata, "id") ?? createId();
  const status = inferTransactionStatus(txn);
  const type = inferTransactionType(txn);
  const sourceAccountPath = metaString(txn.metadata, "source-account-path");
  const sourceAccount = sourceAccountPath ? accountByPath.get(sourceAccountPath) : undefined;

  const postings = resolveSignedPostings(txn, accountByPath);

  const reconcileFromMeta = parseReconcile(metaString(txn.metadata, "reconcile"));
  const reconcileFromPosting = txn.postings
    .map((posting) => parseReconcile(posting.metadata.reconcile))
    .find((value) => value === "C" || value === "R");

  return {
    id,
    type,
    status,
    transactionDate: txn.date,
    referenceNumber: metaString(txn.metadata, "ref") ?? txn.links[0],
    memo: txn.narration,
    payee: txn.payee,
    accountLabel: metaString(txn.metadata, "account-label"),
    sourceAccountId: sourceAccount?.id,
    reconcileStatus: reconcileFromMeta ?? reconcileFromPosting,
    periodId: getPeriodIdForDate(txn.date),
    postings,
    createdBy: metaString(txn.metadata, "created-by") ?? "system",
    createdAt: metaString(txn.metadata, "created-at") ?? nowIso(),
    updatedAt: metaString(txn.metadata, "updated-at"),
    postedAt: status === "POSTED" ? metaString(txn.metadata, "posted-at") ?? nowIso() : undefined,
    voidedAt: metaString(txn.metadata, "voided-at"),
    reversedAt: metaString(txn.metadata, "reversed-at"),
    referenceOriginalTransactionId: metaString(txn.metadata, "reference-original-id")
  };
}

export function storeToDocument(store: LedgerStore, previous?: BeancountDocument): BeancountDocument {
  const pathByAccountId = new Map<string, string>();
  const openDateByAccountId = new Map<string, string>();

  if (previous) {
    previous.opens.forEach((open, index) => {
      const id = metaString(open.metadata, "id");
      if (id) {
        pathByAccountId.set(id, open.account);
        openDateByAccountId.set(id, open.date);
      }
      const account = id ? store.accounts.find((item) => item.id === id) : store.accounts[index];
      if (account) {
        pathByAccountId.set(account.id, open.account);
        openDateByAccountId.set(account.id, open.date);
      }
    });
  }

  store.accounts.forEach((account) => {
    if (!pathByAccountId.has(account.id)) {
      pathByAccountId.set(account.id, accountPathFromName(account.category, account.name));
      openDateByAccountId.set(account.id, account.createdAt.slice(0, 10));
    }
  });

  const opens: ParsedOpen[] = store.accounts.map((account, index) => ({
    date: openDateByAccountId.get(account.id) ?? account.createdAt.slice(0, 10),
    account: pathByAccountId.get(account.id) ?? accountPathFromName(account.category, account.name),
    currencies: [account.currency],
    metadata: {
      id: account.id,
      name: account.name,
      "qbo-category": account.category,
      ...(account.subtype ? { "qbo-subtype": account.subtype } : {}),
      "account-number": account.code || String(1000 + index * 10),
      status: account.status,
      "created-at": account.createdAt,
      ...(account.openingBalance ? { "opening-balance": account.openingBalance } : {}),
      "allow-manual-entries": account.allowManualEntries ? "TRUE" : "FALSE"
    }
  }));

  const closes = store.accounts
    .filter((account) => account.status === "CLOSED")
    .map((account) => ({
      date: account.updatedAt?.slice(0, 10) ?? account.createdAt.slice(0, 10),
      account: pathByAccountId.get(account.id) ?? accountPathFromName(account.category, account.name)
    }));

  const transactions: ParsedTransaction[] = store.transactions
    .filter((transaction) => transaction.status !== "DELETED")
    .map((transaction) => domainTransactionToParsed(transaction, pathByAccountId, store.accounts));

  return {
    preamble: previous?.preamble ?? defaultPreamble(store),
    opens,
    closes,
    transactions,
    epilogue: previous?.epilogue ?? []
  };
}

function defaultPreamble(store: LedgerStore): string[] {
  const title = store.accounts[0]?.name.split(":")[0] ?? "Company";
  return [
    ";; -*- mode: beancount; -*-",
    `option "title" "${title}"`,
    'option "operating_currency" "USD"',
    "",
    "2024-01-01 commodity USD",
    '  name: "US Dollar"'
  ];
}

function domainTransactionToParsed(
  transaction: Transaction,
  pathByAccountId: Map<string, string>,
  accounts: Account[]
): ParsedTransaction {
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const flag: "*" | "!" = transaction.status === "DRAFT" ? "!" : "*";
  const links = transaction.referenceNumber ? [transaction.referenceNumber.replace(/\s+/g, "-")] : [];

  const postings: ParsedPosting[] = transaction.postings.map((posting) => {
    const account = accountById.get(posting.accountId);
    if (!account) {
      throw new Error(`Unknown account id in transaction ${transaction.id}`);
    }
    const path = pathByAccountId.get(account.id) ?? accountPathFromName(account.category, account.name);
    const signed = postingToSigned(account, posting.type, posting.amount);
    const postingMeta: Record<string, string> = {};
    if (
      transaction.sourceAccountId === posting.accountId &&
      transaction.reconcileStatus &&
      transaction.reconcileStatus !== ""
    ) {
      postingMeta.reconcile = transaction.reconcileStatus;
    }
    return {
      account: path,
      amount: signed,
      currency: account.currency,
      metadata: postingMeta
    };
  });

  const sourceAccount = transaction.sourceAccountId
    ? accountById.get(transaction.sourceAccountId)
    : undefined;

  return {
    date: transaction.transactionDate,
    flag,
    payee: transaction.payee,
    narration: transaction.memo,
    tags: [],
    links,
    metadata: {
      id: transaction.id,
      "qbo-type": transaction.type,
      status: transaction.status,
      ...(transaction.referenceNumber ? { ref: transaction.referenceNumber } : {}),
      ...(transaction.accountLabel ? { "account-label": transaction.accountLabel } : {}),
      ...(sourceAccount
        ? {
            "source-account-path":
              pathByAccountId.get(sourceAccount.id) ??
              accountPathFromName(sourceAccount.category, sourceAccount.name)
          }
        : {}),
      ...(transaction.reconcileStatus ? { reconcile: transaction.reconcileStatus } : {}),
      ...(transaction.createdBy ? { "created-by": transaction.createdBy } : {}),
      ...(transaction.createdAt ? { "created-at": transaction.createdAt } : {}),
      ...(transaction.updatedAt ? { "updated-at": transaction.updatedAt } : {}),
      ...(transaction.postedAt ? { "posted-at": transaction.postedAt } : {}),
      ...(transaction.voidedAt ? { "voided-at": transaction.voidedAt } : {}),
      ...(transaction.reversedAt ? { "reversed-at": transaction.reversedAt } : {}),
      ...(transaction.referenceOriginalTransactionId
        ? { "reference-original-id": transaction.referenceOriginalTransactionId }
        : {}),
      ...(transaction.periodId ? { "period-id": transaction.periodId } : {})
    },
    postings
  };
}

export function formatQuoted(value: string): string {
  return escapeBeancountString(value);
}
