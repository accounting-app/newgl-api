import type { AccountService } from "@/application/contracts";
import type { LedgerRepository } from "@/application/contracts";
import { NotFoundError } from "@/core/errors";
import { buildChartAccount } from "@/core/ledger-engine";
import type {
  Account,
  AccountHierarchy,
  CreateAccountInput,
  UpdateAccountInput
} from "@/domain/models";
import { accountPathFromName } from "@/infra/beancount/account-paths";
import { createId } from "@/shared/utils/id";
import { nowIso } from "@/shared/utils/date";

function requireAccount(accounts: Account[], id: string): Account {
  const account = accounts.find((item) => item.id === id);
  if (!account) {
    throw new NotFoundError(`Account ${id} not found`);
  }
  return account;
}

export class AccountServiceImpl implements AccountService {
  constructor(private readonly repository: LedgerRepository) {}

  async createAccount(input: CreateAccountInput): Promise<Account> {
    return this.repository.mutate(async (store) => {
      const exists = store.accounts.find((account) => account.code === input.code);
      if (exists) {
        throw new Error("Account code must be unique.");
      }
      const createdAt = nowIso();
      const account: Account = {
        id: createId(),
        code: input.code,
        name: input.name,
        category: input.category,
        subtype: input.subtype,
        currency: input.currency ?? "USD",
        openingBalance: input.openingBalance ?? 0,
        currentBalance: input.openingBalance ?? 0,
        allowManualEntries: true,
        status: "ACTIVE",
        createdAt
      };
      store.accounts.push(account);
      store.chartAccounts.push(buildChartAccount(account, createdAt));
      accountPathFromName(account.category, account.name);
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
