import type { LedgerService } from "@/application/contracts";
import type { LedgerRepository } from "@/application/contracts";
import { NotFoundError } from "@/core/errors";
import type { LedgerPosting } from "@/domain/models";

export class LedgerServiceImpl implements LedgerService {
  constructor(private readonly repository: LedgerRepository) {}

  async getPostingsByTransactionId(transactionId: string): Promise<LedgerPosting[]> {
    const store = this.repository.getStore();
    const transaction = store.transactions.find((item) => item.id === transactionId);
    if (!transaction) {
      throw new NotFoundError(`Transaction ${transactionId} not found`);
    }
    return store.ledgerPostings.filter((posting) => posting.transactionId === transactionId);
  }

  async listPostings(): Promise<LedgerPosting[]> {
    return [...this.repository.getStore().ledgerPostings];
  }
}
