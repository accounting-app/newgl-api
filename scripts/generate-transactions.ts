/**
 * Generates a batch of random, realistic transactions and appends them to the
 * configured Beancount ledger (`company.bean`).
 *
 * Usage:
 *   bun run generate-transactions          # adds 50 transactions
 *   bun run generate-transactions 120      # adds a custom amount
 *
 * The script drives the real application layer (ledger repository + transaction
 * service), so every generated entry is validated, balanced (double-entry),
 * assigned to an accounting period, posted, and serialized exactly like a
 * transaction created through the API. Transactions are intentionally varied and
 * collectively touch every account category available in the ledger.
 */
import { COMPANY, LEDGER_FILE } from "@/configuration";
import { createServiceContainer } from "@/application/create-service-container";
import { generateNextRefNumber } from "@/core/accounting-reports";
import type { Account, CreateTransactionInput, TransactionType } from "@/domain/models";
import { createLedgerRepository } from "@/infra/beancount/repository";

const DEFAULT_COUNT = 50;

type PostingInput = CreateTransactionInput["postings"][number];

type GeneratedTransaction = Omit<CreateTransactionInput, "referenceNumber">;

type Archetype = {
  name: string;
  /** Returns a transaction, or null when the ledger lacks the accounts it needs. */
  build: () => GeneratedTransaction | null;
};

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function pickDifferent<T>(items: T[], exclude: T): T | undefined {
  const candidates = items.filter((item) => item !== exclude);
  return candidates.length > 0 ? pick(candidates) : undefined;
}

function money(min: number, max: number): number {
  return Math.round((min + Math.random() * (max - min)) * 100) / 100;
}

function maybe(probability: number): boolean {
  return Math.random() < probability;
}

/** Random ISO (YYYY-MM-DD) date within the last `daysBack` days. */
function randomRecentDate(daysBack: number): string {
  const offsetDays = Math.floor(Math.random() * daysBack);
  const date = new Date(Date.now() - offsetDays * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

const VENDORS = [
  "Amazon Web Services",
  "Anthropic",
  "GitHub",
  "Adobe",
  "Notion Labs",
  "WeWork",
  "Staples",
  "FedEx",
  "Delta Air Lines",
  "Marriott Hotels",
  "Uber",
  "Shell",
  "Verizon",
  "Comcast Business",
  "State Farm",
  "Figma"
];

const CLIENTS = [
  "Acme Corp",
  "Globex LLC",
  "Initech",
  "Umbrella Inc",
  "Stark Industries",
  "Wayne Enterprises",
  "Soylent Co",
  "Hooli",
  "Pied Piper",
  "Vandelay Industries"
];

const OWNERS = ["David Castillo", "Hector M Garcia"];

const EXPENSE_MEMOS = [
  "Monthly subscription",
  "Office supplies",
  "Team lunch",
  "Software license",
  "Travel reimbursement",
  "Professional services",
  "Equipment purchase",
  "Marketing campaign",
  ""
];

const INCOME_MEMOS = [
  "Invoice payment",
  "Consulting services",
  "Project milestone",
  "Retainer",
  "Product sale",
  ""
];

function buildGenerator(accounts: Account[]) {
  const active = accounts.filter(
    (account) => account.status === "ACTIVE" && account.allowManualEntries
  );
  const byCategory = (category: Account["category"]): Account[] =>
    active.filter((account) => account.category === category);

  const banks = byCategory("BANK");
  const creditCards = byCategory("CREDIT_CARD");
  const incomes = byCategory("INCOME");
  const otherIncomes = byCategory("OTHER_INCOME");
  const expenses = byCategory("EXPENSE");
  const otherExpenses = byCategory("OTHER_EXPENSE");
  const equities = byCategory("EQUITY");
  const otherCurrentAssets = byCategory("OTHER_CURRENT_ASSET");
  const otherCurrentLiabilities = byCategory("OTHER_CURRENT_LIABILITY");

  const debit = (account: Account, amount: number): PostingInput => ({
    accountId: account.id,
    type: "DEBIT",
    amount
  });
  const credit = (account: Account, amount: number): PostingInput => ({
    accountId: account.id,
    type: "CREDIT",
    amount
  });

  // A handful of source-account legs are randomly marked cleared/reconciled to
  // mimic a real, partially-reconciled register.
  const randomReconcile = (): CreateTransactionInput["reconcileStatus"] =>
    maybe(0.2) ? "C" : maybe(0.1) ? "R" : "";

  const archetypes: Archetype[] = [
    {
      // Expense paid directly from a bank account (money out).
      name: "bank-expense",
      build: () => {
        if (banks.length === 0 || expenses.length === 0) return null;
        const bank = pick(banks);
        const expense = pick(expenses);
        const amount = money(8, 2500);
        const type: TransactionType = maybe(0.5) ? "CHECK" : "EXPENSE";
        return {
          type,
          transactionDate: randomRecentDate(120),
          payee: pick(VENDORS),
          memo: pick(EXPENSE_MEMOS) || undefined,
          accountLabel: expense.name,
          sourceAccountId: bank.id,
          reconcileStatus: randomReconcile(),
          postings: [debit(expense, amount), credit(bank, amount)]
        };
      }
    },
    {
      // Income deposited into a bank account (money in).
      name: "income-deposit",
      build: () => {
        if (banks.length === 0 || incomes.length === 0) return null;
        const bank = pick(banks);
        const income = pick(incomes);
        const amount = money(250, 9000);
        const type: TransactionType = pick<TransactionType>([
          "DEPOSIT",
          "SALES_RECEIPT",
          "RECEIVE_PAYMENT"
        ]);
        return {
          type,
          transactionDate: randomRecentDate(120),
          payee: pick(CLIENTS),
          memo: pick(INCOME_MEMOS) || undefined,
          accountLabel: income.name,
          sourceAccountId: bank.id,
          reconcileStatus: randomReconcile(),
          postings: [debit(bank, amount), credit(income, amount)]
        };
      }
    },
    {
      // Transfer between two bank accounts.
      name: "bank-transfer",
      build: () => {
        if (banks.length < 2) return null;
        const source = pick(banks);
        const destination = pickDifferent(banks, source);
        if (!destination) return null;
        const amount = money(100, 6000);
        return {
          type: "TRANSFER",
          transactionDate: randomRecentDate(120),
          memo: `Transfer to ${destination.name}`,
          accountLabel: destination.name,
          sourceAccountId: source.id,
          reconcileStatus: randomReconcile(),
          postings: [debit(destination, amount), credit(source, amount)]
        };
      }
    },
    {
      // Purchase charged to a credit card (liability increases).
      name: "credit-card-purchase",
      build: () => {
        if (creditCards.length === 0 || expenses.length === 0) return null;
        const card = pick(creditCards);
        const expense = pick(expenses);
        const amount = money(15, 1800);
        return {
          type: "EXPENSE",
          transactionDate: randomRecentDate(120),
          payee: pick(VENDORS),
          memo: pick(EXPENSE_MEMOS) || undefined,
          accountLabel: expense.name,
          sourceAccountId: card.id,
          reconcileStatus: randomReconcile(),
          postings: [debit(expense, amount), credit(card, amount)]
        };
      }
    },
    {
      // Pay down a credit card from a bank account.
      name: "credit-card-payment",
      build: () => {
        if (creditCards.length === 0 || banks.length === 0) return null;
        const card = pick(creditCards);
        const bank = pick(banks);
        const amount = money(100, 3500);
        return {
          type: "BILL_PAYMENT",
          transactionDate: randomRecentDate(120),
          payee: card.name,
          memo: "Credit card payment",
          accountLabel: card.name,
          sourceAccountId: bank.id,
          reconcileStatus: randomReconcile(),
          postings: [debit(card, amount), credit(bank, amount)]
        };
      }
    },
    {
      // Owner / shareholder contribution into a bank account.
      name: "equity-contribution",
      build: () => {
        if (equities.length === 0 || banks.length === 0) return null;
        const bank = pick(banks);
        const equity = pick(equities);
        const amount = money(1000, 25000);
        return {
          type: "DEPOSIT",
          transactionDate: randomRecentDate(120),
          payee: pick(OWNERS),
          memo: "Owner contribution",
          accountLabel: equity.name,
          sourceAccountId: bank.id,
          reconcileStatus: randomReconcile(),
          postings: [debit(bank, amount), credit(equity, amount)]
        };
      }
    },
    {
      // Interest / other income credited to a bank account.
      name: "other-income",
      build: () => {
        if (otherIncomes.length === 0 || banks.length === 0) return null;
        const bank = pick(banks);
        const income = pick(otherIncomes);
        const amount = money(0.5, 150);
        return {
          type: "DEPOSIT",
          transactionDate: randomRecentDate(120),
          memo: income.name,
          accountLabel: income.name,
          sourceAccountId: bank.id,
          reconcileStatus: randomReconcile(),
          postings: [debit(bank, amount), credit(income, amount)]
        };
      }
    },
    {
      // Miscellaneous / other expense paid from a bank account.
      name: "other-expense",
      build: () => {
        if (otherExpenses.length === 0 || banks.length === 0) return null;
        const bank = pick(banks);
        const expense = pick(otherExpenses);
        const amount = money(20, 1200);
        return {
          type: "EXPENSE",
          transactionDate: randomRecentDate(120),
          payee: pick(VENDORS),
          memo: expense.name,
          accountLabel: expense.name,
          sourceAccountId: bank.id,
          reconcileStatus: randomReconcile(),
          postings: [debit(expense, amount), credit(bank, amount)]
        };
      }
    },
    {
      // Buy a current asset (prepaid expense / inventory) with bank funds.
      name: "current-asset-purchase",
      build: () => {
        if (otherCurrentAssets.length === 0 || banks.length === 0) return null;
        const bank = pick(banks);
        const asset = pick(otherCurrentAssets);
        const amount = money(200, 5000);
        return {
          type: "CHECK",
          transactionDate: randomRecentDate(120),
          payee: pick(VENDORS),
          memo: `Purchase: ${asset.name}`,
          accountLabel: asset.name,
          sourceAccountId: bank.id,
          reconcileStatus: randomReconcile(),
          postings: [debit(asset, amount), credit(bank, amount)]
        };
      }
    },
    {
      // Accrue a current liability (e.g. payroll tax) against an expense account.
      name: "liability-accrual",
      build: () => {
        if (otherCurrentLiabilities.length === 0 || expenses.length === 0) return null;
        const liability = pick(otherCurrentLiabilities);
        const payrollExpenses = expenses.filter((account) =>
          account.name.toLowerCase().includes("payroll")
        );
        const expense = pick(payrollExpenses.length > 0 ? payrollExpenses : expenses);
        const amount = money(100, 1500);
        return {
          type: "JOURNAL_ENTRY",
          transactionDate: randomRecentDate(120),
          memo: `Accrue ${liability.name}`,
          accountLabel: liability.name,
          sourceAccountId: liability.id,
          postings: [debit(expense, amount), credit(liability, amount)]
        };
      }
    },
    {
      // Refund issued to a customer (money out of the bank).
      name: "customer-refund",
      build: () => {
        if (incomes.length === 0 || banks.length === 0) return null;
        const bank = pick(banks);
        const refundAccount =
          incomes.find((account) => account.name.toLowerCase().includes("refund")) ?? pick(incomes);
        const amount = money(20, 1500);
        return {
          type: "REFUND",
          transactionDate: randomRecentDate(120),
          payee: pick(CLIENTS),
          memo: "Customer refund",
          accountLabel: refundAccount.name,
          sourceAccountId: bank.id,
          reconcileStatus: randomReconcile(),
          postings: [debit(refundAccount, amount), credit(bank, amount)]
        };
      }
    }
  ];

  return archetypes;
}

function buildBatch(archetypes: Archetype[], count: number): GeneratedTransaction[] {
  const usable = archetypes.filter((archetype) => archetype.build() !== null);
  if (usable.length === 0) {
    throw new Error(
      "No usable transaction archetypes for this ledger — make sure the chart of accounts has bank/income/expense accounts."
    );
  }

  const batch: GeneratedTransaction[] = [];

  // Guarantee variety: use each available archetype at least once (up to count).
  for (const archetype of usable) {
    if (batch.length >= count) break;
    const built = archetype.build();
    if (built) batch.push(built);
  }

  // Fill the rest with randomly chosen archetypes.
  let guard = count * 20;
  while (batch.length < count && guard-- > 0) {
    const built = pick(usable).build();
    if (built) batch.push(built);
  }

  return batch;
}

async function main(): Promise<void> {
  const requested = Number.parseInt(process.argv[2] ?? "", 10);
  const count = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_COUNT;

  const repository = createLedgerRepository(LEDGER_FILE, COMPANY);
  await repository.load();
  const services = createServiceContainer(repository);

  const accounts = await services.accountService.listAccounts();
  if (accounts.length === 0) {
    throw new Error(`No accounts found in ${LEDGER_FILE}. Run "bun run seed" first.`);
  }

  const existingRefs = (await services.transactionService.listTransactions()).map(
    (transaction) => transaction.referenceNumber
  );
  let nextRefNumber = Number.parseInt(generateNextRefNumber(existingRefs).slice(3), 10);

  const archetypes = buildGenerator(accounts);
  const batch = buildBatch(archetypes, count);

  const byType: Record<string, number> = {};
  let created = 0;

  for (const draft of batch) {
    const referenceNumber = `TX-${nextRefNumber++}`;
    const transaction = await services.transactionService.createTransaction({
      ...draft,
      referenceNumber
    });
    await services.transactionService.postTransaction(transaction.id);
    byType[transaction.type] = (byType[transaction.type] ?? 0) + 1;
    created += 1;
  }

  const firstRef = `TX-${nextRefNumber - created}`;
  const lastRef = `TX-${nextRefNumber - 1}`;

  console.log(`Added ${created} transactions to ${LEDGER_FILE} (${firstRef} … ${lastRef}).`);
  console.log("Breakdown by type:");
  for (const [type, amount] of Object.entries(byType).sort()) {
    console.log(`  ${type.padEnd(16)} ${amount}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
