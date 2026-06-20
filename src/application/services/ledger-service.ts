import type { LedgerService } from "@/application/contracts";
import type { LedgerRepository } from "@/application/contracts";
import type { LedgerPosting } from "@/domain/models";

export class LedgerServiceImpl implements LedgerService {
  constructor(private readonly repository: LedgerRepository) {}

  async getPostingsByTransactionId(transactionId: string): Promise<LedgerPosting[]> {
    return this.repository
      .getStore()
      .ledgerPostings.filter((posting) => posting.transactionId === transactionId);
  }

  async listPostings(): Promise<LedgerPosting[]> {
    return [...this.repository.getStore().ledgerPostings];
  }
}
