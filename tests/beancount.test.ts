import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { validateDoubleEntry } from "../src/core/accounting-reports";
import { documentToStore, storeToDocument } from "../src/infra/beancount/mapper";
import { parseBeancount, serializeBeancount } from "../src/infra/beancount/parser";
import { BeancountLedgerRepository } from "../src/infra/beancount/repository";
import { createServiceContainer } from "../src/application/create-service-container";

const fixturePath = resolve(import.meta.dir, "../../data_stucture/beancount_standard.bean");

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
    store.transactions.forEach((transaction) => {
      if (transaction.postings.length >= 2) {
        expect(validateDoubleEntry(transaction.postings)).toBe(true);
      }
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
});
