import type { LedgerRepository, TransactionService } from "@/application/contracts";
import { NotFoundError } from "@/core/errors";
import { validateDoubleEntry } from "@/core/accounting-reports";
import { getPeriodIdForDate, validateTransactionPeriod } from "@/core/periods";
import {
  rebuildDerivedViews,
  requireAccount,
  updateAccountBalances
} from "@/core/ledger-engine";
import type { CreateTransactionInput, Transaction } from "@/domain/models";
import { createId } from "@/shared/utils/id";
import { nowIso, todayIsoDate } from "@/shared/utils/date";

function auditEntry(action: string) {
  return { action, userId: "user", timestamp: nowIso(), changes: null };
}

function ensureAccountsActive(store: import("@/domain/models").LedgerStore, transaction: Transaction): void {
  transaction.postings.forEach((posting) => {
    const account = requireAccount(store, posting.accountId);
    if (account.status !== "ACTIVE") {
      throw new Error("Closed or archived accounts cannot receive transactions.");
    }
  });
}

export class TransactionServiceImpl implements TransactionService {
  constructor(private readonly repository: LedgerRepository) {}

  async createTransaction(input: CreateTransactionInput): Promise<Transaction> {
    return this.repository.mutate(async (store) => {
      validateDoubleEntry(input.postings);
      if (new Set(input.postings.map((posting) => posting.accountId)).size < 2) {
        throw new Error("A transaction must affect at least two different accounts.");
      }
      validateTransactionPeriod(input.transactionDate);

      const createdAt = nowIso();
      const transaction: Transaction = {
        id: createId(),
        type: input.type,
        status: "DRAFT",
        transactionDate: input.transactionDate,
        referenceNumber: input.referenceNumber,
        memo: input.memo,
        payee: input.payee,
        accountLabel: input.accountLabel,
        sourceAccountId: input.sourceAccountId,
        reconcileStatus: input.reconcileStatus,
        periodId: getPeriodIdForDate(input.transactionDate),
        postings: input.postings,
        auditLog: [auditEntry("created")],
        createdAt,
        updatedAt: createdAt,
        createdBy: "user"
      };
      store.transactions.push(transaction);
      rebuildDerivedViews(store);
      return transaction;
    });
  }

  async getTransactionById(id: string): Promise<Transaction> {
    const transaction = this.repository.getStore().transactions.find((item) => item.id === id);
    if (!transaction) {
      throw new NotFoundError(`Transaction ${id} not found`);
    }
    return transaction;
  }

  async listTransactions(): Promise<Transaction[]> {
    return [...this.repository.getStore().transactions];
  }

  async postTransaction(id: string): Promise<Transaction> {
    return this.repository.mutate(async (store) => {
      const transaction = store.transactions.find((item) => item.id === id);
      if (!transaction) {
        throw new NotFoundError(`Transaction ${id} not found`);
      }
      if (transaction.status !== "DRAFT") {
        throw new Error("Only DRAFT transactions can be posted.");
      }
      ensureAccountsActive(store, transaction);
      validateDoubleEntry(transaction.postings);

      const postedAt = nowIso();
      transaction.status = "POSTED";
      transaction.postedAt = postedAt;
      transaction.updatedAt = postedAt;
      transaction.auditLog = [...(transaction.auditLog ?? []), auditEntry("posted")];

      rebuildDerivedViews(store);
      updateAccountBalances(
        store,
        transaction.postings.map((posting) => posting.accountId)
      );
      return transaction;
    });
  }

  async voidTransaction(id: string): Promise<Transaction> {
    const original = await this.getTransactionById(id);
    if (original.status === "VOIDED") {
      throw new Error("Transaction is already voided.");
    }

    if (original.status === "DRAFT") {
      return this.repository.mutate(async (store) => {
        const transaction = store.transactions.find((item) => item.id === id);
        if (!transaction) throw new NotFoundError(`Transaction ${id} not found`);
        transaction.status = "VOIDED";
        transaction.voidedAt = nowIso();
        transaction.updatedAt = transaction.voidedAt;
        transaction.auditLog = [...(transaction.auditLog ?? []), auditEntry("voided")];
        rebuildDerivedViews(store);
        return transaction;
      });
    }

    if (original.status !== "POSTED") {
      throw new Error("Only DRAFT or POSTED transactions can be voided.");
    }

    const voidTx = await this.createTransaction({
      type: original.type,
      transactionDate: todayIsoDate(),
      memo: `VOID of ${original.id}`,
      payee: original.payee,
      referenceNumber: original.referenceNumber,
      postings: original.postings.map((posting) => ({
        accountId: posting.accountId,
        type: posting.type === "DEBIT" ? "CREDIT" : "DEBIT",
        amount: posting.amount
      }))
    });
    await this.postTransaction(voidTx.id);

    return this.repository.mutate(async (store) => {
      const reversal = store.transactions.find((item) => item.id === voidTx.id);
      const originalTx = store.transactions.find((item) => item.id === id);
      if (!reversal || !originalTx) {
        throw new NotFoundError("Void reversal transaction not found");
      }
      reversal.status = "VOIDED";
      reversal.voidedAt = nowIso();
      reversal.referenceOriginalTransactionId = original.id;
      originalTx.status = "VOIDED";
      originalTx.voidedAt = reversal.voidedAt;
      originalTx.updatedAt = reversal.voidedAt;
      originalTx.auditLog = [...(originalTx.auditLog ?? []), auditEntry("voided")];
      rebuildDerivedViews(store);
      return originalTx;
    });
  }

  async reverseTransaction(id: string): Promise<Transaction> {
    const original = await this.getTransactionById(id);
    if (original.status !== "POSTED") {
      throw new Error("Only POSTED transactions can be reversed.");
    }
    if (original.reversedAt) {
      throw new Error("Transaction has already been reversed.");
    }

    const reversal = await this.createTransaction({
      type: original.type,
      transactionDate: todayIsoDate(),
      memo: `REVERSAL of ${original.id}`,
      payee: original.payee,
      referenceNumber: original.referenceNumber,
      postings: original.postings.map((posting) => ({
        accountId: posting.accountId,
        type: posting.type === "DEBIT" ? "CREDIT" : "DEBIT",
        amount: posting.amount
      }))
    });
    await this.postTransaction(reversal.id);

    return this.repository.mutate(async (store) => {
      const reversalTx = store.transactions.find((item) => item.id === reversal.id);
      const originalTx = store.transactions.find((item) => item.id === id);
      if (!reversalTx || !originalTx) {
        throw new NotFoundError("Reversal transaction not found");
      }
      const reversedAt = nowIso();
      originalTx.reversedAt = reversedAt;
      originalTx.updatedAt = reversedAt;
      originalTx.auditLog = [...(originalTx.auditLog ?? []), auditEntry("reversed")];
      reversalTx.referenceOriginalTransactionId = original.id;
      rebuildDerivedViews(store);
      return reversalTx;
    });
  }

  async createDeposit(input: Omit<CreateTransactionInput, "type">): Promise<Transaction> {
    const transaction = await this.createTransaction({ ...input, type: "DEPOSIT" });
    return this.postTransaction(transaction.id);
  }

  async createTransfer(input: Omit<CreateTransactionInput, "type">): Promise<Transaction> {
    const accounts = new Set(input.postings.map((posting) => posting.accountId));
    if (accounts.size < 2) {
      throw new Error("Transfers require source and destination accounts.");
    }
    const transaction = await this.createTransaction({ ...input, type: "TRANSFER" });
    return this.postTransaction(transaction.id);
  }
}
