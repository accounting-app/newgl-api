import type {
  AccountService,
  LedgerService,
  RegisterService,
  TransactionService
} from "@/application/contracts";

export type ServiceContainer = {
  accountService: AccountService;
  transactionService: TransactionService;
  ledgerService: LedgerService;
  registerService: RegisterService;
};
