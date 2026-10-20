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
import type { LedgerPosting, LedgerStore, PostingEntryType, ReconcileStatus, RegisterEntry } from "@/domain/models";
import { nowIso } from "@/shared/utils/date";

function auditEntry(action: string) {
  return { action, userId: "user", timestamp: nowIso(), changes: null };
}

export type RegisterEntryUpdateInput = Pick<RegisterEntry, "date" | "refNumber" | "payee" | "memo"> & {
  payment?: number;
  deposit?: number;
  reconcileStatus?: ReconcileStatus;
  counterpartyAccountId?: string;
};

/**
 * Everything an update can reject, checked WITHOUT touching the store. Kept
 * separate from applyRegisterEntryUpdate so a batch can validate every entry
 * first and only then change anything -- the store is mutated in place, so
 * an error thrown halfway through a batch would otherwise leave it
 * half-updated in memory.
 */
function validateRegisterEntryUpdate(
  store: LedgerStore,
  entryId: string,
  input: RegisterEntryUpdateInput
): RegisterEntry {
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
  if (input.counterpartyAccountId) {
    if (input.counterpartyAccountId === entry.accountId) {
      throw new ValidationError("An account cannot be its own offset account.");
    }
    requireAccount(store, input.counterpartyAccountId);
  }
  return entry;
}

/** Applies an update that validateRegisterEntryUpdate already accepted. */
function applyRegisterEntryUpdate(store: LedgerStore, entry: RegisterEntry, input: RegisterEntryUpdateInput): void {
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

  if (input.counterpartyAccountId && transaction) {
    const counterpartyPostings = transaction.postings.filter((posting) => posting.accountId !== entry.accountId);
    const currentCounterpartyId = counterpartyPostings.length === 1 ? counterpartyPostings[0].accountId : undefined;

    if (currentCounterpartyId && currentCounterpartyId !== input.counterpartyAccountId) {
      const newCounterparty = requireAccount(store, input.counterpartyAccountId);
      transaction.postings = transaction.postings.map((posting) =>
        posting.accountId === currentCounterpartyId ? { ...posting, accountId: newCounterparty.id } : posting
      );
      transaction.accountLabel = newCounterparty.name;

      store.ledgerPostings
        .filter((posting) => posting.transactionId === entry.transactionId && posting.accountId === currentCounterpartyId)
        .forEach((posting) => {
          posting.accountId = newCounterparty.id;
          posting.accountCode = newCounterparty.code;
          posting.accountName = newCounterparty.name;
          posting.currency = newCounterparty.currency;
        });

      store.registerEntries
        .filter((item) => item.transactionId === entry.transactionId && item.accountId === currentCounterpartyId)
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
}

/** Removes the entries' whole transactions from the store and rebalances every account they touched. */
function deleteRegisterEntriesFromStore(store: LedgerStore, entries: RegisterEntry[]): RegisterEntry[] {
  const deletedAt = nowIso();
  const transactionIds = new Set(entries.map((entry) => entry.transactionId));
  const affectedAccountIds = new Set<string>(entries.map((entry) => entry.accountId));
  store.registerEntries
    .filter((item) => transactionIds.has(item.transactionId))
    .forEach((item) => affectedAccountIds.add(item.accountId));

  store.transactions = store.transactions.filter((item) => !transactionIds.has(item.id));
  store.registerEntries = store.registerEntries.filter((item) => !transactionIds.has(item.transactionId));
  store.ledgerPostings = store.ledgerPostings.filter((posting) => !transactionIds.has(posting.transactionId));

  rebuildDerivedViews(store);
  const accountIds = [...affectedAccountIds];
  accountIds.forEach((accountId) => recalculateRunningBalances(store, accountId));
  updateAccountBalances(store, accountIds);

  entries.forEach((entry) => {
    entry.status = "DELETED";
    entry.createdAt = deletedAt;
  });
  return entries;
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

  async updateRegisterEntry(entryId: string, input: RegisterEntryUpdateInput): Promise<RegisterEntry> {
    return this.repository.mutate(async (store) => {
      const entry = validateRegisterEntryUpdate(store, entryId, input);
      applyRegisterEntryUpdate(store, entry, input);
      return entry;
    });
  }

  /**
   * Updates several entries in ONE ledger mutation: every entry is validated
   * before any is changed, so either the whole batch applies or nothing does
   * -- and it saves as a single ledger version (one undo, not N).
   */
  async batchUpdateRegisterEntries(
    updates: Array<RegisterEntryUpdateInput & { entryId: string }>
  ): Promise<RegisterEntry[]> {
    if (updates.length === 0) {
      throw new ValidationError("Select at least one transaction.");
    }
    if (new Set(updates.map((update) => update.entryId)).size !== updates.length) {
      throw new ValidationError("A transaction can only appear once in a batch.");
    }
    if (updates.some((update) => update.reconcileStatus === "R")) {
      throw new ValidationError("Reconciled is set by finishing a reconciliation on the Reconcile screen.");
    }
    return this.repository.mutate(async (store) => {
      const entries = updates.map((update) => validateRegisterEntryUpdate(store, update.entryId, update));
      entries.forEach((entry, index) => applyRegisterEntryUpdate(store, entry, updates[index]));
      return entries;
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
      return deleteRegisterEntriesFromStore(store, [entry])[0];
    });
  }

  /** Deletes several entries' transactions in ONE ledger mutation -- all or nothing, one ledger version. */
  async batchDeleteRegisterEntries(entryIds: string[]): Promise<RegisterEntry[]> {
    if (entryIds.length === 0) {
      throw new ValidationError("Select at least one transaction.");
    }
    if (new Set(entryIds).size !== entryIds.length) {
      throw new ValidationError("A transaction can only appear once in a batch.");
    }
    return this.repository.mutate(async (store) => {
      const entries = entryIds.map((entryId) => {
        const entry = store.registerEntries.find((item) => item.id === entryId);
        if (!entry) {
          throw new NotFoundError(`Register entry ${entryId} not found`);
        }
        assertEntryDeletable(entry.reconcileStatus);
        return entry;
      });
      return deleteRegisterEntriesFromStore(store, entries);
    });
  }
}
