import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { validateDoubleEntry } from "../src/core/accounting-reports";
import { documentToStore, storeToDocument } from "../src/infra/beancount/mapper";
import { parseBeancount, serializeBeancount } from "../src/infra/beancount/parser";
import { BeancountLedgerRepository } from "../src/infra/beancount/repository";
import { createServiceContainer } from "../src/application/create-service-container";

import { BEANCOUNT_STANDARD_FIXTURE } from "./helpers/constants";
const fixturePath = BEANCOUNT_STANDARD_FIXTURE

describe("beancount parser", () => {
  test("parses reference ledger", async () => {
    const source = await readFile(fixturePath, "utf8");
    const document = parseBeancount(source);
    expect(document.opens.length).toBeGreaterThan(10);
    expect(document.transactions.length).toBeGreaterThan(5);
  });

  test("round-trips without losing transaction count", async () => {
    const source = await readFile(fixturePath, "utf8");
    const document = parseBeancount(source);
    const serialized = serializeBeancount(document);
    const roundTripped = parseBeancount(serialized);
    expect(roundTripped.transactions.length).toBe(document.transactions.length);
    expect(roundTripped.opens.length).toBe(document.opens.length);
  });

  test("maps to domain store with balanced transactions", async () => {
    const source = await readFile(fixturePath, "utf8");
    const document = parseBeancount(source);
    const store = documentToStore(document);
    document.transactions.forEach((parsed, index) => {
      if (parsed.postings.length < 2) {
        return;
      }
      if (parsed.postings.some((posting) => posting.currency && posting.currency !== "USD")) {
        return;
      }
      const transaction = store.transactions[index];
      if (transaction.postings.length < 2) {
        return;
      }
      expect(validateDoubleEntry(transaction.postings)).toBe(true);
    });
  });

  test("store round-trip preserves account ids", async () => {
    const source = await readFile(fixturePath, "utf8");
    const document = parseBeancount(source);
    const store = documentToStore(document);
    const idsBefore = new Set(store.accounts.map((account) => account.id));
    const roundTrip = storeToDocument(store, document);
    const storeAgain = documentToStore(roundTrip);
    const idsAfter = new Set(storeAgain.accounts.map((account) => account.id));
    expect(idsAfter).toEqual(idsBefore);
  });

  test("does not duplicate generated section headers on round-trip", () => {
    const source = [
      'option "title" "Company"',
      'option "operating_currency" "USD"',
      "",
      ";; ---- Chart of accounts ----",
      "2024-01-01 open Assets:Cash USD",
      '  id: "acct-1"',
      "",
      ";; ---- Transactions ----",
      '2024-02-01 * "Payee" "Memo"',
      '  id: "txn-1"',
      "  Assets:Cash 10.00 USD",
      "  Expenses:Misc -10.00 USD"
    ].join("\n");

    const once = serializeBeancount(parseBeancount(source));
    const twice = serializeBeancount(parseBeancount(once));

    expect(once).toBe(twice);
    expect(once.match(/;; ---- Chart of accounts ----/g)?.length).toBe(1);
    expect(once.match(/;; ---- Transactions ----/g)?.length).toBe(1);
  });

  test("parses posting lines when account paths contain colons", () => {
    const source = [
      '2026-06-20 * "David Castillo" ^TX-1003',
      '  id: "txn-1"',
      '  qbo-type: "CHECK"',
      '  status: "POSTED"',
      "  Expenses:Admin-Contractor 180.00 USD",
      "  Assets:Bank:Cash -180.00 USD"
    ].join("\n");

    const document = parseBeancount(source);
    expect(document.transactions).toHaveLength(1);
    expect(document.transactions[0].postings).toHaveLength(2);
    expect(document.transactions[0].postings[0].account).toBe("Expenses:Admin-Contractor");
    expect(document.transactions[0].postings[0].amount).toBe(180);
    expect(document.transactions[0].postings[1].account).toBe("Assets:Bank:Cash");
    expect(document.transactions[0].postings[1].amount).toBe(-180);
  });

  test("parses implicit posting lines without amounts", () => {
    const source = [
      '2024-01-05 * "Figma" "Design subscription"',
      "  Expenses:Software 45.00 USD",
      "  Liabilities:CreditCard:Amex"
    ].join("\n");

    const document = parseBeancount(source);
    expect(document.transactions).toHaveLength(1);
    expect(document.transactions[0].postings).toHaveLength(2);
    expect(document.transactions[0].postings[0].account).toBe("Expenses:Software");
    expect(document.transactions[0].postings[1].account).toBe("Liabilities:CreditCard:Amex");
    expect(document.transactions[0].postings[1].amount).toBeUndefined();

    const serialized = serializeBeancount(document);
    expect(serialized).toContain("  Expenses:Software 45.00 USD");
    expect(serialized).toContain("  Liabilities:CreditCard:Amex");
    expect(serialized).not.toContain('Liabilities: "CreditCard:Amex"');
  });
});

describe("repository + services", () => {
  test("creates and posts a transaction", async () => {
    const ledgerFile = `/tmp/newgl-test-${crypto.randomUUID()}.bean`;
    const repository = new BeancountLedgerRepository(ledgerFile, "Test Co");
    await repository.load();
    const services = createServiceContainer(repository);

    const account = await services.accountService.createAccount({
      code: "1010",
      name: "Checking",
      category: "BANK",
      currency: "USD",
      openingBalance: 0
    });
    const expense = await services.accountService.createAccount({
      code: "5010",
      name: "Office",
      category: "EXPENSE",
      currency: "USD",
      openingBalance: 0
    });

    const draft = await services.transactionService.createTransaction({
      type: "CHECK",
      transactionDate: "2024-02-01",
      payee: "Staples",
      memo: "Supplies",
      referenceNumber: "TX-2001",
      sourceAccountId: account.id,
      postings: [
        { accountId: expense.id, type: "DEBIT", amount: 50 },
        { accountId: account.id, type: "CREDIT", amount: 50 }
      ]
    });
    expect(draft.status).toBe("DRAFT");

    const posted = await services.transactionService.postTransaction(draft.id);
    expect(posted.status).toBe("POSTED");

    const register = await services.registerService.listRegisterEntries(account.id);
    expect(register.length).toBe(1);
    expect(register[0].payment).toBe(50);
  });

  test("deposit round-trips through persist and reload with register entries", async () => {
    const ledgerFile = `/tmp/newgl-deposit-${crypto.randomUUID()}.bean`;
    const repository = new BeancountLedgerRepository(ledgerFile, "Test Co");
    await repository.load();
    const services = createServiceContainer(repository);

    const bank = await services.accountService.createAccount({
      code: "1010",
      name: "Cash",
      category: "BANK",
      currency: "USD"
    });
    const income = await services.accountService.createAccount({
      code: "4010",
      name: "Services",
      category: "INCOME",
      currency: "USD"
    });

    await services.transactionService.createDeposit({
      transactionDate: "2026-06-20",
      referenceNumber: "TX-DEP-1",
      sourceAccountId: bank.id,
      accountLabel: income.name,
      postings: [
        { accountId: bank.id, type: "DEBIT", amount: 75 },
        { accountId: income.id, type: "CREDIT", amount: 75 }
      ]
    });

    const reloaded = new BeancountLedgerRepository(ledgerFile, "Test Co");
    await reloaded.load();
    const reloadedServices = createServiceContainer(reloaded);

    const register = await reloadedServices.registerService.listRegisterEntries(bank.id);
    expect(register.length).toBe(1);
    expect(register[0].deposit).toBe(75);
    expect(register[0].runningBalance).toBe(75);
  });
});
