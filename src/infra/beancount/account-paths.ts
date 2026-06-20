import type { Account } from "@/domain/models";

export const QBO_CATEGORY_BY_BEAN_ROOT: Record<string, Account["category"]> = {
  "Assets:Accounts-Receivable": "ACCOUNTS_RECEIVABLE",
  "Assets:Bank": "BANK",
  "Assets:Fixed-Asset": "FIXED_ASSET",
  "Assets:Current": "OTHER_CURRENT_ASSET",
  "Liabilities:CreditCard": "CREDIT_CARD",
  "Liabilities:Long-Term": "LONG_TERM_LIABILITY",
  "Liabilities:Current": "OTHER_CURRENT_LIABILITY",
  Equity: "EQUITY",
  Income: "INCOME",
  "Income:Other": "OTHER_INCOME",
  Expenses: "EXPENSE",
  "Expenses:Other": "OTHER_EXPENSE"
};

export const BEAN_ROOT_BY_QBO_CATEGORY: Record<Account["category"], string> = {
  ACCOUNTS_RECEIVABLE: "Assets:Accounts-Receivable",
  BANK: "Assets:Bank",
  CREDIT_CARD: "Liabilities:CreditCard",
  EQUITY: "Equity",
  EXPENSE: "Expenses",
  FIXED_ASSET: "Assets:Fixed-Asset",
  INCOME: "Income",
  LONG_TERM_LIABILITY: "Liabilities:Long-Term",
  OTHER_CURRENT_ASSET: "Assets:Current",
  OTHER_CURRENT_LIABILITY: "Liabilities:Current",
  OTHER_EXPENSE: "Expenses:Other",
  OTHER_INCOME: "Income:Other"
};

export function slugifyAccountComponent(value: string): string {
  return value
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    || "Account";
}

export function accountPathFromName(category: Account["category"], name: string): string {
  const root = BEAN_ROOT_BY_QBO_CATEGORY[category];
  const parts = name.split(":").map((part) => slugifyAccountComponent(part));
  return [root, ...parts].join(":");
}

export function categoryFromAccountPath(path: string, metadataCategory?: string): Account["category"] {
  if (metadataCategory && isAccountCategory(metadataCategory)) {
    return metadataCategory;
  }
  const entries = Object.entries(QBO_CATEGORY_BY_BEAN_ROOT).sort((a, b) => b[0].length - a[0].length);
  for (const [prefix, category] of entries) {
    if (path === prefix || path.startsWith(`${prefix}:`)) {
      return category;
    }
  }
  if (path.startsWith("Assets:")) return "OTHER_CURRENT_ASSET";
  if (path.startsWith("Liabilities:")) return "OTHER_CURRENT_LIABILITY";
  if (path.startsWith("Equity:")) return "EQUITY";
  if (path.startsWith("Income:")) return "INCOME";
  if (path.startsWith("Expenses:")) return "EXPENSE";
  return "EXPENSE";
}

function isAccountCategory(value: string): value is Account["category"] {
  return [
    "ACCOUNTS_RECEIVABLE",
    "BANK",
    "CREDIT_CARD",
    "EQUITY",
    "EXPENSE",
    "FIXED_ASSET",
    "INCOME",
    "LONG_TERM_LIABILITY",
    "OTHER_CURRENT_ASSET",
    "OTHER_CURRENT_LIABILITY",
    "OTHER_EXPENSE",
    "OTHER_INCOME"
  ].includes(value);
}

export function qboCategoryFromCsvAccountType(accountType: string): Account["category"] {
  const normalized = accountType.trim().toLowerCase();
  if (normalized === "bank") return "BANK";
  if (normalized === "credit card") return "CREDIT_CARD";
  if (normalized === "accounts receivable") return "ACCOUNTS_RECEIVABLE";
  if (normalized === "fixed asset") return "FIXED_ASSET";
  if (normalized === "long term liability") return "LONG_TERM_LIABILITY";
  if (normalized === "other current assets") return "OTHER_CURRENT_ASSET";
  if (normalized === "other current liabilities") return "OTHER_CURRENT_LIABILITY";
  if (normalized === "equity") return "EQUITY";
  if (normalized === "income") return "INCOME";
  if (normalized === "other income") return "OTHER_INCOME";
  if (normalized === "other expense") return "OTHER_EXPENSE";
  if (normalized === "cost of goods sold") return "EXPENSE";
  if (normalized === "expenses") return "EXPENSE";
  return "EXPENSE";
}

export function escapeBeancountString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
