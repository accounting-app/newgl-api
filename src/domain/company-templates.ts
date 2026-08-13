import type { Account } from "@/domain/models";

// Static starter chart-of-accounts presets for new-company creation
// (PLAINGL_FEATURES_TO_IMPLEMENT.md #13), mirroring PlainGL's
// lib/coa-templates.ts. Deliberately small and industry-shaped -- just
// enough accounts to make a new company usable on day one, not a full
// chart. Account hierarchy (e.g. "Office Expenses:Software & Apps") lives
// in the colon-segmented `name`, the same convention used everywhere else
// in this app (see account-hierarchy.ts).
export type CompanyTemplateAccount = Pick<Account, "code" | "name" | "category">;

export type CompanyTemplate = {
  id: string;
  label: string;
  description: string;
  accounts: CompanyTemplateAccount[];
};

export const COMPANY_TEMPLATES: CompanyTemplate[] = [
  {
    id: "freelancer",
    label: "Freelancer / Consultant",
    description: "A checking account, consulting income, and common solo-business expenses.",
    accounts: [
      { code: "1000", name: "Checking", category: "BANK" },
      { code: "1010", name: "Accounts Receivable", category: "ACCOUNTS_RECEIVABLE" },
      { code: "4000", name: "Consulting Income", category: "INCOME" },
      { code: "6000", name: "Contractor Payments", category: "EXPENSE" },
      { code: "6010", name: "Office Expenses:Software & Apps", category: "EXPENSE" },
      { code: "6020", name: "Home Office", category: "EXPENSE" },
      { code: "6030", name: "Travel", category: "EXPENSE" },
      { code: "3000", name: "Owner's Equity", category: "EQUITY" }
    ]
  },
  {
    id: "retail",
    label: "Retail / E-commerce",
    description: "Checking and merchant accounts, sales income, COGS, and inventory.",
    accounts: [
      { code: "1000", name: "Checking", category: "BANK" },
      { code: "1010", name: "Merchant Account", category: "BANK" },
      { code: "1020", name: "Inventory Asset", category: "OTHER_CURRENT_ASSET" },
      { code: "4000", name: "Sales Income", category: "INCOME" },
      { code: "5000", name: "Cost of Goods Sold", category: "EXPENSE" },
      { code: "6000", name: "Shipping", category: "EXPENSE" },
      { code: "6010", name: "Advertising", category: "EXPENSE" },
      { code: "3000", name: "Owner's Equity", category: "EQUITY" }
    ]
  },
  {
    id: "real-estate",
    label: "Real Estate / Property Management",
    description: "Rental income, security deposits held, and property-related expenses.",
    accounts: [
      { code: "1000", name: "Checking", category: "BANK" },
      { code: "2000", name: "Security Deposits Held", category: "OTHER_CURRENT_LIABILITY" },
      { code: "4000", name: "Rental Income", category: "INCOME" },
      { code: "6000", name: "Repairs & Maintenance", category: "EXPENSE" },
      { code: "6010", name: "Property Management Fees", category: "EXPENSE" },
      { code: "6020", name: "Mortgage Interest", category: "EXPENSE" },
      { code: "3000", name: "Owner's Equity", category: "EQUITY" }
    ]
  }
];

export function findCompanyTemplate(id: string): CompanyTemplate | undefined {
  return COMPANY_TEMPLATES.find((template) => template.id === id);
}
