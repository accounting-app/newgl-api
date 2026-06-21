import { describe, expect, test } from "bun:test";

import { createServiceContainer } from "../src/application/create-service-container";
import { BeancountLedgerRepository } from "../src/infra/beancount/repository";

async function createTestServices() {
  const ledgerFile = `/tmp/newgl-flows-${crypto.randomUUID()}.bean`;
  const repository = new BeancountLedgerRepository(ledgerFile, "Test Co");
  await repository.load();
  return { services: createServiceContainer(repository), ledgerFile };
}

async function seedBankAndExpense(services: Awaited<ReturnType<typeof createTestServices>>["services"]) {
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
  return { bank, expense };
}

describe("service flows", () => {
  test("voidTransaction voids DRAFT without reversal postings", async () => {
    const { services } = await createTestServices();
    const { bank, expense } = await seedBankAndExpense(services);

    const draft = await services.transactionService.createTransaction({
      type: "CHECK",
      transactionDate: "2024-02-01",
      postings: [
        { accountId: expense.id, type: "DEBIT", amount: 30 },
        { accountId: bank.id, type: "CREDIT", amount: 30 }
      ]
    });

    const voided = await services.transactionService.voidTransaction(draft.id);
    expect(voided.status).toBe("VOIDED");
    expect(await services.ledgerService.listPostings()).toHaveLength(0);
  });

  test("reverseTransaction creates opposite POSTED entry", async () => {
    const { services } = await createTestServices();
    const { bank, expense } = await seedBankAndExpense(services);

    const posted = await services.transactionService.createDeposit({
      transactionDate: "2024-02-01",
      sourceAccountId: bank.id,
      postings: [
        { accountId: bank.id, type: "DEBIT", amount: 100 },
        { accountId: expense.id, type: "CREDIT", amount: 100 }
      ]
    });

    const reversal = await services.transactionService.reverseTransaction(posted.id);
    expect(reversal.status).toBe("POSTED");
    expect(reversal.postings[0].type).toBe("CREDIT");
  });

  test("createTransfer requires two accounts", async () => {
    const { services } = await createTestServices();
    const bank = await services.accountService.createAccount({
      code: "1010",
      name: "Checking",
      category: "BANK"
    });

    await expect(
      services.transactionService.createTransfer({
        transactionDate: "2024-02-01",
        postings: [{ accountId: bank.id, type: "DEBIT", amount: 10 }]
      })
    ).rejects.toThrow();
  });

  test("deleteRegisterEntry removes transaction and recalculates balances", async () => {
    const { services } = await createTestServices();
    const { bank, expense } = await seedBankAndExpense(services);

    await services.transactionService.createDeposit({
      transactionDate: "2024-02-01",
      sourceAccountId: bank.id,
      postings: [
        { accountId: bank.id, type: "DEBIT", amount: 50 },
        { accountId: expense.id, type: "CREDIT", amount: 50 }
      ]
    });

    const [entry] = await services.registerService.listRegisterEntries(bank.id);
    await services.registerService.deleteRegisterEntry(entry.id);

    expect(await services.registerService.listRegisterEntries(bank.id)).toHaveLength(0);
    expect((await services.accountService.getAccountById(bank.id)).currentBalance).toBe(0);
  });
});