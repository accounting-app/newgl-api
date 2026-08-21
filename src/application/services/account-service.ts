import type { AccountService } from "@/application/contracts";
import type { LedgerRepository } from "@/application/contracts";
import { ConflictError, NotFoundError } from "@/core/errors";
import { buildChartAccount, rebuildDerivedViews, updateAccountBalances } from "@/core/ledger-engine";
import { DEBIT_NORMAL_CATEGORIES } from "@/core/accounting-reports";
import { getPeriodIdForDate } from "@/core/periods";
import type {
  Account,
  AccountHierarchy,
  CreateAccountInput,
  LedgerStore,
  Transaction,
  TransactionPostingInput,
  UpdateAccountInput
} from "@/domain/models";
import { accountPathFromName } from "@/infra/beancount/account-paths";
import { createId } from "@/shared/utils/id";
import { nowIso, todayIsoDate } from "@/shared/utils/date";

const OPENING_BALANCE_EQUITY_NAME = "Opening Balance Equity";
const OPENING_BALANCE_EQUITY_CODE = "9000";

function requireAccount(accounts: Account[], id: string): Account {
  const account = accounts.find((item) => item.id === id);
  if (!account) {
    throw new NotFoundError(`Account ${id} not found`);
  }
  return account;
}

function findOrCreateOpeningBalanceEquityAccount(store: LedgerStore, createdAt: string): Account {
  const existing = store.accounts.find(
    (account) => account.category === "EQUITY" && account.name === OPENING_BALANCE_EQUITY_NAME
  );
  if (existing) {
    return existing;
  }

  let code = OPENING_BALANCE_EQUITY_CODE;
  let suffix = 1;
  while (store.accounts.some((account) => account.code === code)) {
    code = `${OPENING_BALANCE_EQUITY_CODE}-${suffix++}`;
  }

  const account: Account = {
    id: createId(),
    code,
    name: OPENING_BALANCE_EQUITY_NAME,
    category: "EQUITY",
    currency: "USD",
    openingBalance: 0,
    currentBalance: 0,
    allowManualEntries: true,
    status: "ACTIVE",
    createdAt
  };
  store.accounts.push(account);
  store.chartAccounts.push(buildChartAccount(account, createdAt));
  return account;
}

function auditEntry(action: string, timestamp: string) {
  return { action, userId: "user", timestamp, changes: null };
}

/**
 * Posts a balanced JOURNAL_ENTRY against a system "Opening Balance Equity"
 * account so a new account's opening balance is real double-entry, not just
 * a number on the account row (which would leave the trial balance out of
 * balance -- see PLAINGL_FEATURES_TO_IMPLEMENT.md #15).
 */
function postOpeningBalance(store: LedgerStore, account: Account, amount: number, createdAt: string): void {
  const equityAccount = findOrCreateOpeningBalanceEquityAccount(store, createdAt);
  const isDebitNormal = DEBIT_NORMAL_CATEGORIES.has(account.category);
  const postings: TransactionPostingInput[] = isDebitNormal
    ? [
        { accountId: account.id, type: "DEBIT", amount },
        { accountId: equityAccount.id, type: "CREDIT", amount }
      ]
    : [
        { accountId: account.id, type: "CREDIT", amount },
        { accountId: equityAccount.id, type: "DEBIT", amount }
      ];

  const transactionDate = todayIsoDate();
  const transaction: Transaction = {
    id: createId(),
    type: "JOURNAL_ENTRY",
    status: "POSTED",
    transactionDate,
    memo: "Opening balance",
    periodId: getPeriodIdForDate(transactionDate),
    postings,
    auditLog: [auditEntry("created", createdAt), auditEntry("posted", createdAt)],
    createdAt,
    updatedAt: createdAt,
    postedAt: createdAt,
    createdBy: "user"
  };
  store.transactions.push(transaction);
  rebuildDerivedViews(store);
  updateAccountBalances(store, [account.id, equityAccount.id]);
}

export class AccountServiceImpl implements AccountService {
  constructor(private readonly repository: LedgerRepository) {}

  async createAccount(input: CreateAccountInput): Promise<Account> {
    return this.repository.mutate(async (store) => {
      const exists = store.accounts.find((account) => account.code === input.code);
      if (exists) {
        throw new ConflictError(`Account code "${input.code}" is already in use.`);
      }
      const createdAt = nowIso();
      const account: Account = {
        id: createId(),
        code: input.code,
        name: input.name,
        category: input.category,
        subtype: input.subtype,
        currency: input.currency ?? "USD",
        openingBalance: 0,
        currentBalance: 0,
        allowManualEntries: true,
        status: "ACTIVE",
        createdAt
      };
      store.accounts.push(account);
      store.chartAccounts.push(buildChartAccount(account, createdAt));
      accountPathFromName(account.category, account.name);

      const openingBalance = input.openingBalance ?? 0;
      if (openingBalance > 0) {
        postOpeningBalance(store, account, openingBalance, createdAt);
      }

      return account;
    });
  }

  async updateAccount(id: string, input: UpdateAccountInput): Promise<Account> {
    return this.repository.mutate(async (store) => {
      const account = requireAccount(store.accounts, id);
      Object.assign(account, input, { updatedAt: nowIso() });
      const chart = store.chartAccounts.find((item) => item.id === id);
      if (chart) {
        Object.assign(chart, {
          name: account.name,
          status: account.status,
          accountSubtype: account.subtype,
          allowsManualPostings: account.allowManualEntries,
          updatedAt: account.updatedAt
        });
      }
      return account;
    });
  }

  async closeAccount(id: string): Promise<void> {
    await this.repository.mutate(async (store) => {
      const account = requireAccount(store.accounts, id);
      account.status = "CLOSED";
      account.updatedAt = nowIso();
      const chart = store.chartAccounts.find((item) => item.id === id);
      if (chart) {
        chart.status = "CLOSED";
        chart.updatedAt = account.updatedAt;
      }
    });
  }

  async deleteAccount(id: string): Promise<void> {
    await this.repository.mutate(async (store) => {
      const account = requireAccount(store.accounts, id);
      const hasActivity = store.transactions.some((transaction) =>
        transaction.postings.some((posting) => posting.accountId === id)
      );
      if (hasActivity) {
        throw new ConflictError(`"${account.name}" has transaction activity and can't be deleted -- archive it instead.`);
      }
      store.accounts = store.accounts.filter((item) => item.id !== id);
      store.chartAccounts = store.chartAccounts.filter((item) => item.id !== id);
    });
  }

  async getAccountById(id: string): Promise<Account> {
    return requireAccount(this.repository.getStore().accounts, id);
  }

  async listAccounts(): Promise<Account[]> {
    return [...this.repository.getStore().accounts];
  }

  async getAccountHierarchy(): Promise<AccountHierarchy> {
    const store = this.repository.getStore();
    return store.chartAccounts.map((account) => ({
      ...account,
      children: store.chartAccounts.filter((candidate) => candidate.parentAccountId === account.id)
    }));
  }
}
