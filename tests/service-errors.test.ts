import { describe, expect, test } from "bun:test";

import { createServiceContainer } from "../src/application/create-service-container";
import {
  ConflictError,
  NotFoundError,
  ValidationError
} from "../src/core/errors";
import { BeancountLedgerRepository } from "../src/infra/beancount/repository";

async function createTestServices() {
  const ledgerFile = `/tmp/newgl-errors-${crypto.randomUUID()}.bean`;
  const repository = new BeancountLedgerRepository(ledgerFile, "Test Co");
  await repository.load();
  return createServiceContainer(repository);
}

describe("service error handling", () => {
  test("createAccount throws ConflictError for duplicate code", async () => {
    const services = await createTestServices();
    await services.accountService.createAccount({
      code: "1010",
      name: "Checking",
      category: "BANK"
    });

    await expect(
      services.accountService.createAccount({
        code: "1010",
        name: "Other Checking",
        category: "BANK"
      })
    ).rejects.toThrow(ConflictError);
  });

  test("getAccountById throws NotFoundError for unknown id", async () => {
    const services = await createTestServices();
    const missingId = crypto.randomUUID();

    await expect(services.accountService.getAccountById(missingId)).rejects.toThrow(NotFoundError);
  });

  test("createTransaction throws ValidationError for unbalanced postings", async () => {
    const services = await createTestServices();
    const bank = await services.accountService.createAccount({
      code: "1010",
      name: "Checking",
      category: "BANK"
    });
    const expense = await services.accountService.createAccount({
      code: "5010",
      name: "Office",
      category: "EXPENSE"
    });

    await expect(
      services.transactionService.createTransaction({
        type: "CHECK",
        transactionDate: "2024-02-01",
        postings: [
          { accountId: expense.id, type: "DEBIT", amount: 50 },
          { accountId: bank.id, type: "CREDIT", amount: 40 }
        ]
      })
    ).rejects.toThrow(ValidationError);
  });

  test("postTransaction throws ValidationError when transaction is not DRAFT", async () => {
    const services = await createTestServices();
    const bank = await services.accountService.createAccount({
      code: "1010",
      name: "Checking",
      category: "BANK"
    });
    const expense = await services.accountService.createAccount({
      code: "5010",
      name: "Office",
      category: "EXPENSE"
    });

    const draft = await services.transactionService.createTransaction({
      type: "CHECK",
      transactionDate: "2024-02-01",
      postings: [
        { accountId: expense.id, type: "DEBIT", amount: 25 },
        { accountId: bank.id, type: "CREDIT", amount: 25 }
      ]
    });
    await services.transactionService.postTransaction(draft.id);

    await expect(services.transactionService.postTransaction(draft.id)).rejects.toThrow(
      ValidationError
    );
  });

  test("voidTransaction throws ValidationError when already voided", async () => {
    const services = await createTestServices();
    const bank = await services.accountService.createAccount({
      code: "1010",
      name: "Checking",
      category: "BANK"
    });
    const expense = await services.accountService.createAccount({
      code: "5010",
      name: "Office",
      category: "EXPENSE"
    });

    const draft = await services.transactionService.createTransaction({
      type: "CHECK",
      transactionDate: "2024-02-01",
      postings: [
        { accountId: expense.id, type: "DEBIT", amount: 10 },
        { accountId: bank.id, type: "CREDIT", amount: 10 }
      ]
    });
    await services.transactionService.voidTransaction(draft.id);

    await expect(services.transactionService.voidTransaction(draft.id)).rejects.toThrow(
      ValidationError
    );
  });

  test("getPostingsByTransactionId throws NotFoundError for unknown transaction", async () => {
    const services = await createTestServices();
    const missingId = crypto.randomUUID();

    await expect(
      services.ledgerService.getPostingsByTransactionId(missingId)
    ).rejects.toThrow(NotFoundError);
  });

  test("getPostingsByTransactionId returns empty array for DRAFT transaction", async () => {
    const services = await createTestServices();
    const bank = await services.accountService.createAccount({
      code: "1010",
      name: "Checking",
      category: "BANK"
    });
    const expense = await services.accountService.createAccount({
      code: "5010",
      name: "Office",
      category: "EXPENSE"
    });

    const draft = await services.transactionService.createTransaction({
      type: "CHECK",
      transactionDate: "2024-02-01",
      postings: [
        { accountId: expense.id, type: "DEBIT", amount: 15 },
        { accountId: bank.id, type: "CREDIT", amount: 15 }
      ]
    });

    const postings = await services.ledgerService.getPostingsByTransactionId(draft.id);
    expect(postings).toEqual([]);
  });

  test("updateRegisterEntry throws ValidationError for payment and deposit together", async () => {
    const services = await createTestServices();
    const bank = await services.accountService.createAccount({
      code: "1010",
      name: "Checking",
      category: "BANK"
    });
    const expense = await services.accountService.createAccount({
      code: "5010",
      name: "Office",
      category: "EXPENSE"
    });

    await services.transactionService.createDeposit({
      transactionDate: "2024-02-01",
      sourceAccountId: bank.id,
      postings: [
        { accountId: bank.id, type: "DEBIT", amount: 100 },
        { accountId: expense.id, type: "CREDIT", amount: 100 }
      ]
    });

    const [entry] = await services.registerService.listRegisterEntries(bank.id);
    expect(entry).toBeDefined();

    await expect(
      services.registerService.updateRegisterEntry(entry.id, {
        date: "2024-02-01",
        payment: 10,
        deposit: 10
      })
    ).rejects.toThrow(ValidationError);
  });
});
