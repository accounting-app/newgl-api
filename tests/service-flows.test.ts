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

  test("importTransactions creates and posts transactions immediately", async () => {
    const { services } = await createTestServices();
    const { bank, expense } = await seedBankAndExpense(services);

    const result = await services.transactionService.importTransactions({
      mainAccountId: bank.id,
      rows: [
        { clientRowId: "row-1", transactionDate: "2024-02-01", payee: "Coffee Shop", amount: -4.5, categoryAccountId: expense.id },
        { clientRowId: "row-2", transactionDate: "2024-02-02", payee: "Employer Inc", amount: 2500, categoryAccountId: expense.id }
      ]
    });

    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.results.every((row) => row.status === "CREATED")).toBe(true);

    const posted = await services.transactionService.listTransactions({ status: "POSTED", sourceAccountId: bank.id });
    expect(posted).toHaveLength(2);
    expect(posted.every((tx) => tx.status === "POSTED")).toBe(true);

    // Posted imports must immediately appear in postings/register and update balances.
    expect(await services.ledgerService.listPostings()).toHaveLength(4);
    expect(await services.registerService.listRegisterEntries(bank.id)).toHaveLength(2);
    expect((await services.accountService.getAccountById(bank.id)).currentBalance).toBe(2495.5);
  });

  test("importTransactions reports per-row failure without aborting the batch", async () => {
    const { services } = await createTestServices();
    const { bank, expense } = await seedBankAndExpense(services);
    const closedExpense = await services.accountService.createAccount({
      code: "5020",
      name: "Closed Expense",
      category: "EXPENSE"
    });
    await services.accountService.closeAccount(closedExpense.id);

    const result = await services.transactionService.importTransactions({
      mainAccountId: bank.id,
      rows: [
        { clientRowId: "row-ok", transactionDate: "2024-02-01", amount: -10, categoryAccountId: expense.id },
        { clientRowId: "row-bad-account", transactionDate: "2024-02-01", amount: -20, categoryAccountId: closedExpense.id },
        { clientRowId: "row-same-account", transactionDate: "2024-02-01", amount: -30, categoryAccountId: bank.id }
      ]
    });

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(2);
    const byId = Object.fromEntries(result.results.map((row) => [row.clientRowId, row]));
    expect(byId["row-ok"].status).toBe("CREATED");
    expect(byId["row-bad-account"].status).toBe("FAILED");
    expect(byId["row-same-account"].status).toBe("FAILED");

    const posted = await services.transactionService.listTransactions({ status: "POSTED", sourceAccountId: bank.id });
    expect(posted).toHaveLength(1);
  });

  test("importTransactions splits a row across multiple category accounts", async () => {
    const { services } = await createTestServices();
    const { bank, expense } = await seedBankAndExpense(services);
    const otherExpense = await services.accountService.createAccount({
      code: "5011",
      name: "Software",
      category: "EXPENSE"
    });

    const result = await services.transactionService.importTransactions({
      mainAccountId: bank.id,
      rows: [
        {
          clientRowId: "row-split",
          transactionDate: "2024-02-01",
          payee: "Office Depot",
          amount: -100,
          categorySplits: [
            { accountId: expense.id, amount: 60 },
            { accountId: otherExpense.id, amount: 40 }
          ]
        }
      ]
    });

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);

    const posted = await services.transactionService.listTransactions({ status: "POSTED", sourceAccountId: bank.id });
    expect(posted).toHaveLength(1);
    expect(posted[0].postings).toHaveLength(3);
    expect((await services.accountService.getAccountById(expense.id)).currentBalance).toBe(60);
    expect((await services.accountService.getAccountById(otherExpense.id)).currentBalance).toBe(40);
  });

  test("importTransactions rejects a split row whose amounts don't add up", async () => {
    const { services } = await createTestServices();
    const { bank, expense } = await seedBankAndExpense(services);
    const otherExpense = await services.accountService.createAccount({
      code: "5011",
      name: "Software",
      category: "EXPENSE"
    });

    const result = await services.transactionService.importTransactions({
      mainAccountId: bank.id,
      rows: [
        {
          clientRowId: "row-unbalanced",
          transactionDate: "2024-02-01",
          amount: -100,
          categorySplits: [
            { accountId: expense.id, amount: 60 },
            { accountId: otherExpense.id, amount: 30 }
          ]
        }
      ]
    });

    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.results[0].status).toBe("FAILED");
    expect(result.results[0].error).toMatch(/add up/);
  });

  test("voiding an imported transaction creates a reversal like any other posted transaction", async () => {
    const { services } = await createTestServices();
    const { bank, expense } = await seedBankAndExpense(services);

    const result = await services.transactionService.importTransactions({
      mainAccountId: bank.id,
      rows: [{ clientRowId: "row-void", transactionDate: "2024-02-01", amount: -25, categoryAccountId: expense.id }]
    });
    const [imported] = result.results.map((row) => row.transactionId!);

    const voided = await services.transactionService.voidTransaction(imported);
    expect(voided.status).toBe("VOIDED");
    expect((await services.accountService.getAccountById(bank.id)).currentBalance).toBe(0);
  });
});