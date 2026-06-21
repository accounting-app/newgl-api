import type { LedgerRepository, RegisterService } from "@/application/contracts";
import { NotFoundError, ValidationError } from "@/core/errors";
import {
  assertEntryDeletable,
  assertEntryEditable,
  validateTransactionAmounts
} from "@/core/accounting-reports";
import { getPeriodIdForDate, validateTransactionPeriod } from "@/core/periods";
import {
  postingSideFromRegisterAmounts,
  rebuildDerivedViews,
  recalculateRunningBalances,
  requireAccount,
  updateAccountBalances
} from "@/core/ledger-engine";
import type { LedgerPosting, PostingEntryType, ReconcileStatus, RegisterEntry } from "@/domain/models";
import { nowIso } from "@/shared/utils/date";

function auditEntry(action: string) {
  return { action, userId: "user", timestamp: nowIso(), changes: null };
}

export class RegisterServiceImpl implements RegisterService {
  constructor(private readonly repository: LedgerRepository) {}

  async listRegisterEntries(accountId: string): Promise<RegisterEntry[]> {
    return this.repository
      .getStore()
      .registerEntries.filter((entry) => entry.accountId === accountId)
      .sort((a, b) => `${b.date}-${b.createdAt}`.localeCompare(`${a.date}-${a.createdAt}`));
  }

  async getTransactionDetail(transactionId: string): Promise<{
    transaction: import("@/domain/models").Transaction;
    postings: LedgerPosting[];
    registerEntries: RegisterEntry[];
  }> {
    const store = this.repository.getStore();
    const transaction = store.transactions.find((item) => item.id === transactionId);
    if (!transaction) {
      throw new NotFoundError(`Transaction ${transactionId} not found`);
    }
    return {
      transaction,
      postings: store.ledgerPostings.filter((posting) => posting.transactionId === transactionId),
      registerEntries: store.registerEntries.filter((entry) => entry.transactionId === transactionId)
    };
  }

  async updateRegisterEntry(
    entryId: string,
    input: Pick<RegisterEntry, "date" | "refNumber" | "payee" | "memo"> & {
      payment?: number;
      deposit?: number;
      reconcileStatus?: ReconcileStatus;
      counterpartyAccountId?: string;
    }
  ): Promise<RegisterEntry> {
    return this.repository.mutate(async (store) => {
      const entry = store.registerEntries.find((item) => item.id === entryId);
      if (!entry) {
        throw new NotFoundError(`Register entry ${entryId} not found`);
      }
      assertEntryEditable(entry.reconcileStatus);
      validateTransactionAmounts(input);
      if ((input.payment ?? 0) > 0 && (input.deposit ?? 0) > 0) {
        throw new ValidationError("Register entry cannot contain both a payment and a deposit.");
      }
      validateTransactionPeriod(input.date);

      const newDeposit = input.deposit && input.deposit > 0 ? input.deposit : undefined;
      const newPayment = input.payment && input.payment > 0 ? input.payment : undefined;
      const newAmount = newDeposit ?? newPayment ?? 0;
      const thisAccountSide = postingSideFromRegisterAmounts({ deposit: newDeposit, payment: newPayment });
      const counterpartySide: PostingEntryType = thisAccountSide === "DEBIT" ? "CREDIT" : "DEBIT";
      const amountChanged = newAmount > 0;

      entry.date = input.date;
      entry.refNumber = input.refNumber;
      entry.payee = input.payee;
      entry.memo = input.memo;
      if (amountChanged) {
        entry.payment = newPayment;
        entry.deposit = newDeposit;
      }
      if (input.reconcileStatus !== undefined) {
        entry.reconcileStatus = input.reconcileStatus;
      }

      const transaction = store.transactions.find((item) => item.id === entry.transactionId);
      const affectedAccountIds = new Set<string>([entry.accountId]);

      if (transaction) {
        transaction.transactionDate = input.date;
        transaction.referenceNumber = input.refNumber;
        transaction.payee = input.payee;
        transaction.memo = input.memo;
        transaction.periodId = getPeriodIdForDate(input.date);
        if (input.reconcileStatus !== undefined) {
          transaction.reconcileStatus = input.reconcileStatus;
        }
        if (amountChanged) {
          transaction.postings = transaction.postings.map((posting) =>
            posting.accountId === entry.accountId
              ? { ...posting, type: thisAccountSide, amount: newAmount }
              : { ...posting, type: counterpartySide, amount: newAmount }
          );
        }
        transaction.postings.forEach((posting) => affectedAccountIds.add(posting.accountId));
        transaction.auditLog = [...(transaction.auditLog ?? []), auditEntry("updated")];
        transaction.updatedAt = nowIso();
      }

      store.ledgerPostings
        .filter((posting) => posting.transactionId === entry.transactionId)
        .forEach((posting) => {
          posting.postingDate = input.date;
          posting.referenceNumber = input.refNumber;
          posting.memo = input.memo;
          if (amountChanged) {
            const isThisAccount = posting.accountId === entry.accountId;
            posting.entryType = isThisAccount ? thisAccountSide : counterpartySide;
            posting.amount = newAmount;
          }
          affectedAccountIds.add(posting.accountId);
        });

      if (amountChanged) {
        store.registerEntries
          .filter((item) => item.transactionId === entry.transactionId && item.id !== entry.id)
          .forEach((counterEntry) => {
            if (counterpartySide === "DEBIT") {
              counterEntry.deposit = newAmount;
              counterEntry.payment = undefined;
            } else {
              counterEntry.payment = newAmount;
              counterEntry.deposit = undefined;
            }
            affectedAccountIds.add(counterEntry.accountId);
          });
      }

      if (input.counterpartyAccountId && input.counterpartyAccountId === entry.accountId) {
        throw new ValidationError("An account cannot be its own offset account.");
      }

      if (input.counterpartyAccountId && transaction) {
        const counterpartyPostings = transaction.postings.filter(
          (posting) => posting.accountId !== entry.accountId
        );
        const currentCounterpartyId =
          counterpartyPostings.length === 1 ? counterpartyPostings[0].accountId : undefined;

        if (currentCounterpartyId && currentCounterpartyId !== input.counterpartyAccountId) {
          const newCounterparty = requireAccount(store, input.counterpartyAccountId);
          transaction.postings = transaction.postings.map((posting) =>
            posting.accountId === currentCounterpartyId
              ? { ...posting, accountId: newCounterparty.id }
              : posting
          );
          transaction.accountLabel = newCounterparty.name;

          store.ledgerPostings
            .filter(
              (posting) =>
                posting.transactionId === entry.transactionId &&
                posting.accountId === currentCounterpartyId
            )
            .forEach((posting) => {
              posting.accountId = newCounterparty.id;
              posting.accountCode = newCounterparty.code;
              posting.accountName = newCounterparty.name;
              posting.currency = newCounterparty.currency;
            });

          store.registerEntries
            .filter(
              (item) =>
                item.transactionId === entry.transactionId && item.accountId === currentCounterpartyId
            )
            .forEach((counterEntry) => {
              counterEntry.accountId = newCounterparty.id;
            });

          entry.accountLabel = newCounterparty.name;
          affectedAccountIds.add(currentCounterpartyId);
          affectedAccountIds.add(newCounterparty.id);
        }
      }

      const accountIds = [...affectedAccountIds];
      accountIds.forEach((accountId) => recalculateRunningBalances(store, accountId));
      updateAccountBalances(store, accountIds);
      return entry;
    });
  }

  async setReconcileStatus(entryId: string, status: ReconcileStatus): Promise<RegisterEntry> {
    return this.repository.mutate(async (store) => {
      const entry = store.registerEntries.find((item) => item.id === entryId);
      if (!entry) {
        throw new NotFoundError(`Register entry ${entryId} not found`);
      }
      entry.reconcileStatus = status;
      const transaction = store.transactions.find((item) => item.id === entry.transactionId);
      if (transaction && transaction.sourceAccountId === entry.accountId) {
        transaction.reconcileStatus = status;
      }
      return entry;
    });
  }

  async deleteRegisterEntry(entryId: string): Promise<RegisterEntry> {
    return this.repository.mutate(async (store) => {
      const entry = store.registerEntries.find((item) => item.id === entryId);
      if (!entry) {
        throw new NotFoundError(`Register entry ${entryId} not found`);
      }
      assertEntryDeletable(entry.reconcileStatus);

      const transactionId = entry.transactionId;
      const deletedAt = nowIso();
      const affectedAccountIds = new Set<string>([entry.accountId]);
      store.registerEntries
        .filter((item) => item.transactionId === transactionId)
        .forEach((item) => affectedAccountIds.add(item.accountId));

      store.transactions = store.transactions.filter((item) => item.id !== transactionId);
      store.registerEntries = store.registerEntries.filter(
        (item) => item.transactionId !== transactionId
      );
      store.ledgerPostings = store.ledgerPostings.filter(
        (posting) => posting.transactionId !== transactionId
      );

      rebuildDerivedViews(store);
      const accountIds = [...affectedAccountIds];
      accountIds.forEach((accountId) => recalculateRunningBalances(store, accountId));
      updateAccountBalances(store, accountIds);

      entry.status = "DELETED";
      entry.createdAt = deletedAt;
      return entry;
    });
  }
}
