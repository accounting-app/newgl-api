import type {
  Account,
  AccountHierarchy,
  CreateAccountInput,
  CreateTransactionInput,
  ImportTransactionsInput,
  ImportTransactionsResult,
  LedgerPosting,
  ReconcileStatus,
  RegisterEntry,
  Transaction,
  TransactionStatus,
  UpdateAccountInput
} from "@/domain/models";

export interface AccountService {
  createAccount(input: CreateAccountInput): Promise<Account>;
  updateAccount(id: string, input: UpdateAccountInput): Promise<Account>;
  closeAccount(id: string): Promise<void>;
  /** Permanently removes an account with zero posting activity. Throws if any transaction posts to it -- use closeAccount (Archive) instead for accounts with history. */
  deleteAccount(id: string): Promise<void>;
  getAccountById(id: string): Promise<Account>;
  listAccounts(): Promise<Account[]>;
  getAccountHierarchy(): Promise<AccountHierarchy>;
}

export type ListTransactionsFilter = {
  status?: TransactionStatus;
  sourceAccountId?: string;
};

export interface TransactionService {
  createTransaction(input: CreateTransactionInput): Promise<Transaction>;
  getTransactionById(id: string): Promise<Transaction>;
  listTransactions(filter?: ListTransactionsFilter): Promise<Transaction[]>;
  postTransaction(id: string): Promise<Transaction>;
  voidTransaction(id: string): Promise<Transaction>;
  reverseTransaction(id: string): Promise<Transaction>;
  createDeposit(input: Omit<CreateTransactionInput, "type">): Promise<Transaction>;
  createTransfer(input: Omit<CreateTransactionInput, "type">): Promise<Transaction>;
  importTransactions(input: ImportTransactionsInput): Promise<ImportTransactionsResult>;
}

export interface LedgerService {
  getPostingsByTransactionId(transactionId: string): Promise<LedgerPosting[]>;
  listPostings(): Promise<LedgerPosting[]>;
}

export interface RegisterService {
  listRegisterEntries(accountId: string): Promise<RegisterEntry[]>;
  getTransactionDetail(transactionId: string): Promise<{
    transaction: Transaction;
    postings: LedgerPosting[];
    registerEntries: RegisterEntry[];
  }>;
  updateRegisterEntry(
    entryId: string,
    input: Pick<RegisterEntry, "date" | "refNumber" | "payee" | "memo"> & {
      payment?: number;
      deposit?: number;
      reconcileStatus?: ReconcileStatus;
      counterpartyAccountId?: string;
    }
  ): Promise<RegisterEntry>;
  setReconcileStatus(entryId: string, status: ReconcileStatus): Promise<RegisterEntry>;
  deleteRegisterEntry(entryId: string): Promise<RegisterEntry>;
}

export interface LedgerRepository {
  load(): Promise<void>;
  getStore(): import("@/domain/models").LedgerStore;
  mutate<T>(fn: (store: import("@/domain/models").LedgerStore) => Promise<T>): Promise<T>;
}
