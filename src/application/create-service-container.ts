import type { LedgerRepository } from "@/application/contracts";
import type { ServiceContainer } from "@/application/service-container";
import { AccountServiceImpl } from "@/application/services/account-service";
import { LedgerServiceImpl } from "@/application/services/ledger-service";
import { RegisterServiceImpl } from "@/application/services/register-service";
import { TransactionServiceImpl } from "@/application/services/transaction-service";

export function createServiceContainer(repository: LedgerRepository): ServiceContainer {
  return {
    accountService: new AccountServiceImpl(repository),
    transactionService: new TransactionServiceImpl(repository),
    ledgerService: new LedgerServiceImpl(repository),
    registerService: new RegisterServiceImpl(repository)
  };
}
