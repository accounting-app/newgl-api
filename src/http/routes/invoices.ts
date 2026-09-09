import { createRoute, z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { getLedgerName, getServices, getTenantId } from "@/http/context";
import { errorResponseSchema } from "@/domain/models";
import type { AccountService, TransactionService } from "@/application/contracts";
import { getSql } from "@/infra/postgres/client";

const invoiceIdParam = zod.object({ invoiceId: zod.string().uuid() });

const invoiceSchema = zod.object({
  id: zod.string().uuid(),
  customerId: zod.string().uuid(),
  invoiceNumber: zod.string().optional(),
  invoiceDate: zod.string(),
  dueDate: zod.string(),
  amount: zod.number(),
  productServiceId: zod.string().uuid().optional(),
  memo: zod.string().optional(),
  status: zod.enum(["DRAFT", "OPEN", "PAID"]),
  postedTransactionId: zod.string().optional(),
  paymentTransactionId: zod.string().optional(),
  createdAt: zod.string()
});

const createInvoiceInputSchema = zod.object({
  customerId: zod.string().uuid(),
  invoiceNumber: zod.string().trim().min(1).max(100).optional(),
  invoiceDate: zod.string().min(1),
  dueDate: zod.string().min(1),
  amount: zod.number().positive(),
  productServiceId: zod.string().uuid().optional(),
  memo: zod.string().trim().min(1).max(1000).optional()
});

const updateInvoiceInputSchema = zod.object({
  customerId: zod.string().uuid().optional(),
  invoiceNumber: zod.string().trim().min(1).max(100).optional(),
  invoiceDate: zod.string().min(1).optional(),
  dueDate: zod.string().min(1).optional(),
  amount: zod.number().positive().optional(),
  productServiceId: zod.string().uuid().optional(),
  memo: zod.string().trim().min(1).max(1000).optional()
});

const payInvoiceInputSchema = zod.object({
  depositAccountId: zod.string().min(1),
  paymentDate: zod.string().min(1).optional()
});

type InvoiceRow = {
  id: string;
  customer_id: string;
  product_service_id: string | null;
  invoice_number: string | null;
  invoice_date: Date;
  due_date: Date;
  amount: string;
  memo: string | null;
  status: "DRAFT" | "OPEN" | "PAID";
  posted_transaction_id: string | null;
  payment_transaction_id: string | null;
  created_at: Date;
};

function serialize(row: InvoiceRow) {
  return {
    id: row.id,
    customerId: row.customer_id,
    productServiceId: row.product_service_id ?? undefined,
    invoiceNumber: row.invoice_number ?? undefined,
    invoiceDate: row.invoice_date.toISOString().slice(0, 10),
    dueDate: row.due_date.toISOString().slice(0, 10),
    amount: Number(row.amount),
    memo: row.memo ?? undefined,
    status: row.status,
    postedTransactionId: row.posted_transaction_id ?? undefined,
    paymentTransactionId: row.payment_transaction_id ?? undefined,
    createdAt: row.created_at.toISOString()
  };
}

const ACCOUNTS_RECEIVABLE_NAME = "Accounts Receivable";
const ACCOUNTS_RECEIVABLE_CODE = "1010";
const DEFAULT_SALES_INCOME_NAME = "Sales Income";
const DEFAULT_SALES_INCOME_CODE = "4010";

/** Mirrors bills.ts's findOrCreateAccountsPayableAccount -- not every company template includes an Accounts Receivable account (see company-templates.ts). */
async function findOrCreateAccountByCategory(
  accountService: AccountService,
  category: "ACCOUNTS_RECEIVABLE" | "INCOME",
  name: string,
  code: string
): Promise<string> {
  const accounts = await accountService.listAccounts();
  // Match by name, not just category: ACCOUNTS_RECEIVABLE is a safe
  // category-only match (a company has at most one), but INCOME is not --
  // a real chart of accounts has many income accounts (Sales of Product
  // Income, Services, Billable Expense Income, ...), so matching "any
  // INCOME-category account" would silently post revenue to whichever one
  // happens to be first, instead of this specific "Sales Income" default.
  const existing = accounts.find((account) => account.category === category && account.name === name);
  if (existing) return existing.id;

  let nextCode = code;
  let suffix = 1;
  while (accounts.some((account) => account.code === nextCode)) {
    nextCode = `${code}-${suffix++}`;
  }
  const created = await accountService.createAccount({ code: nextCode, name, category, currency: "USD" });
  return created.id;
}

/**
 * Which income account an invoice's amount should credit: the invoice's
 * own product/service item's income account if it has one, otherwise a
 * find-or-create default "Sales Income" account -- an invoice must always
 * be able to post even when no catalog item (or one with no income
 * account set) was picked, same "never block on missing setup" reasoning
 * as Accounts Payable/Receivable's own find-or-create.
 */
async function resolveIncomeAccountId(accountService: AccountService, productServiceId: string | undefined): Promise<string> {
  if (productServiceId) {
    const sql = getSql();
    const rows = await sql`select income_account_id from products_services where id = ${productServiceId} limit 1`;
    const incomeAccountId = rows.length > 0 ? (rows[0] as { income_account_id: string | null }).income_account_id : null;
    if (incomeAccountId) return incomeAccountId;
  }
  return findOrCreateAccountByCategory(accountService, "INCOME", DEFAULT_SALES_INCOME_NAME, DEFAULT_SALES_INCOME_CODE);
}

async function findOrCreateAccountsReceivableAccount(accountService: AccountService): Promise<string> {
  return findOrCreateAccountByCategory(accountService, "ACCOUNTS_RECEIVABLE", ACCOUNTS_RECEIVABLE_NAME, ACCOUNTS_RECEIVABLE_CODE);
}

/** Creates a DRAFT transaction and immediately posts it -- same shape bills.ts's postNewTransaction uses. */
async function postNewTransaction(transactionService: TransactionService, input: Parameters<TransactionService["createTransaction"]>[0]) {
  const draft = await transactionService.createTransaction(input);
  return transactionService.postTransaction(draft.id);
}

const listInvoicesRoute = createRoute({
  method: "get",
  path: "/api/invoices",
  responses: {
    200: { content: { "application/json": { schema: zod.array(invoiceSchema) } }, description: "Every invoice for the caller's currently active company" }
  }
});

const createInvoiceRoute = createRoute({
  method: "post",
  path: "/api/invoices",
  request: { body: { content: { "application/json": { schema: createInvoiceInputSchema } }, required: true } },
  responses: {
    200: { content: { "application/json": { schema: invoiceSchema } }, description: "The newly created invoice, already posted to the ledger" },
    400: { content: { "application/json": { schema: errorResponseSchema } }, description: "A ledger validation failed while posting" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No active company, or no such customer/product for this company" }
  }
});

const updateInvoiceRoute = createRoute({
  method: "patch",
  path: "/api/invoices/{invoiceId}",
  request: { params: invoiceIdParam, body: { content: { "application/json": { schema: updateInvoiceInputSchema } }, required: true } },
  responses: {
    200: { content: { "application/json": { schema: invoiceSchema } }, description: "The updated invoice" },
    400: { content: { "application/json": { schema: errorResponseSchema } }, description: "A ledger validation failed while reposting" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No such invoice for this company" },
    409: { content: { "application/json": { schema: errorResponseSchema } }, description: "This invoice is already paid and can no longer be edited" }
  }
});

const payInvoiceRoute = createRoute({
  method: "post",
  path: "/api/invoices/{invoiceId}/pay",
  request: { params: invoiceIdParam, body: { content: { "application/json": { schema: payInvoiceInputSchema } }, required: true } },
  responses: {
    200: { content: { "application/json": { schema: invoiceSchema } }, description: "The invoice, now marked paid" },
    400: { content: { "application/json": { schema: errorResponseSchema } }, description: "A ledger validation failed while posting the payment" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No such invoice for this company" },
    409: { content: { "application/json": { schema: errorResponseSchema } }, description: "This invoice isn't open (already paid, or still a draft)" }
  }
});

const deleteInvoiceRoute = createRoute({
  method: "delete",
  path: "/api/invoices/{invoiceId}",
  request: { params: invoiceIdParam },
  responses: {
    204: { description: "Invoice deleted, and its posted transaction voided" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No such invoice for this company" },
    409: { content: { "application/json": { schema: errorResponseSchema } }, description: "This invoice is already paid -- unwind the payment before deleting" }
  }
});

/**
 * Invoices, scoped to the caller's CURRENTLY ACTIVE company only -- the AR
 * mirror of bills.ts. Entering an invoice posts Dr Accounts Receivable /
 * Cr Income immediately; receiving payment posts a second Dr Cash-or-Bank
 * / Cr Accounts Receivable transaction. See
 * QBO_FREE_FEATURES_PLAN.md's Phase 1.5 resolution (same one Bills used).
 */
export function invoiceRoutes(app: OpenAPIHono): void {
  app.openapi(listInvoicesRoute, async (context) => {
    const tenantId = getTenantId(context);
    const ledgerName = getLedgerName(context);
    const sql = getSql();

    const rows = await sql`
      select i.id, i.customer_id, i.product_service_id, i.invoice_number, i.invoice_date, i.due_date,
             i.amount, i.memo, i.status, i.posted_transaction_id, i.payment_transaction_id, i.created_at
      from invoices i
      join ledgers l on l.id = i.ledger_id
      where l.tenant_id = ${tenantId} and l.name = ${ledgerName}
      order by i.invoice_date desc, i.created_at desc
    `;

    return context.json(rows.map((row: unknown) => serialize(row as InvoiceRow)), 200);
  });

  app.openapi(createInvoiceRoute, async (context) => {
    const tenantId = getTenantId(context);
    const ledgerName = getLedgerName(context);
    const input = context.req.valid("json");
    const sql = getSql();
    const { accountService, transactionService } = getServices(context);

    const ledgerRows = await sql`
      select id from ledgers where tenant_id = ${tenantId} and name = ${ledgerName} limit 1
    `;
    if (ledgerRows.length === 0) {
      return context.json({ error: "No active company for this request" }, 404);
    }
    const ledgerId = (ledgerRows[0] as { id: string }).id;

    const customerRows = await sql`select name from customers where id = ${input.customerId} and ledger_id = ${ledgerId} limit 1`;
    if (customerRows.length === 0) {
      return context.json({ error: `No customer '${input.customerId}' for this company` }, 404);
    }
    const customerName = (customerRows[0] as { name: string }).name;

    if (input.productServiceId) {
      const productRows = await sql`select id from products_services where id = ${input.productServiceId} and ledger_id = ${ledgerId} limit 1`;
      if (productRows.length === 0) {
        return context.json({ error: `No product/service '${input.productServiceId}' for this company` }, 404);
      }
    }

    let postedTransactionId: string;
    try {
      const arAccountId = await findOrCreateAccountsReceivableAccount(accountService);
      const incomeAccountId = await resolveIncomeAccountId(accountService, input.productServiceId);
      const posted = await postNewTransaction(transactionService, {
        // Not SALES_RECEIPT -- that type means "cash received immediately,
        // no AR" in this domain's own vocabulary (see domain/models.ts's
        // transactionTypeSchema); an invoice is the opposite (AR created,
        // cash comes later), and there's no dedicated INVOICE type in the
        // enum, so JOURNAL_ENTRY is the honest generic choice -- same
        // reasoning as using EXPENSE (not BILL, which also doesn't exist)
        // for a bill's entry-side posting.
        type: "JOURNAL_ENTRY",
        transactionDate: input.invoiceDate,
        dueDate: input.dueDate,
        memo: input.memo,
        payee: customerName,
        referenceNumber: input.invoiceNumber,
        postings: [
          { accountId: arAccountId, type: "DEBIT", amount: input.amount },
          { accountId: incomeAccountId, type: "CREDIT", amount: input.amount }
        ]
      });
      postedTransactionId = posted.id;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not post this invoice to the ledger";
      return context.json({ error: message }, 400);
    }

    const [inserted] = await sql`
      insert into invoices (ledger_id, customer_id, product_service_id, invoice_number, invoice_date, due_date, amount, memo, status, posted_transaction_id)
      values (
        ${ledgerId}, ${input.customerId}, ${input.productServiceId ?? null}, ${input.invoiceNumber ?? null},
        ${input.invoiceDate}, ${input.dueDate}, ${input.amount}, ${input.memo ?? null}, 'OPEN', ${postedTransactionId}
      )
      returning id, customer_id, product_service_id, invoice_number, invoice_date, due_date, amount, memo, status,
                posted_transaction_id, payment_transaction_id, created_at
    `;

    return context.json(serialize(inserted as InvoiceRow), 200);
  });

  app.openapi(updateInvoiceRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { invoiceId } = context.req.valid("param");
    const patch = context.req.valid("json");
    const sql = getSql();
    const { accountService, transactionService } = getServices(context);

    const existingRows = await sql`
      select i.id, i.customer_id, i.product_service_id, i.invoice_number, i.invoice_date, i.due_date,
             i.amount, i.memo, i.status, i.posted_transaction_id, i.payment_transaction_id, i.created_at
      from invoices i
      join ledgers l on l.id = i.ledger_id
      where l.tenant_id = ${tenantId} and i.id = ${invoiceId}
      limit 1
    `;
    if (existingRows.length === 0) {
      return context.json({ error: `No invoice '${invoiceId}' for this company` }, 404);
    }
    const current = existingRows[0] as InvoiceRow;
    if (current.status === "PAID") {
      return context.json({ error: "This invoice is already paid and can no longer be edited" }, 409);
    }

    const next = {
      customerId: patch.customerId ?? current.customer_id,
      productServiceId: patch.productServiceId !== undefined ? patch.productServiceId : (current.product_service_id ?? undefined),
      invoiceNumber: patch.invoiceNumber !== undefined ? patch.invoiceNumber : (current.invoice_number ?? undefined),
      invoiceDate: patch.invoiceDate ?? current.invoice_date.toISOString().slice(0, 10),
      dueDate: patch.dueDate ?? current.due_date.toISOString().slice(0, 10),
      amount: patch.amount ?? Number(current.amount),
      memo: patch.memo !== undefined ? patch.memo : (current.memo ?? undefined)
    };

    const needsRepost =
      current.posted_transaction_id != null &&
      (next.amount !== Number(current.amount) ||
        next.productServiceId !== (current.product_service_id ?? undefined) ||
        next.invoiceDate !== current.invoice_date.toISOString().slice(0, 10));

    let postedTransactionId = current.posted_transaction_id;
    if (needsRepost && current.posted_transaction_id) {
      try {
        await transactionService.voidTransaction(current.posted_transaction_id);
        const customerRows = await sql`select name from customers where id = ${next.customerId} limit 1`;
        const customerName = customerRows.length > 0 ? (customerRows[0] as { name: string }).name : undefined;
        const arAccountId = await findOrCreateAccountsReceivableAccount(accountService);
        const incomeAccountId = await resolveIncomeAccountId(accountService, next.productServiceId);
        const posted = await postNewTransaction(transactionService, {
          type: "JOURNAL_ENTRY",
          transactionDate: next.invoiceDate,
          dueDate: next.dueDate,
          memo: next.memo,
          payee: customerName,
          referenceNumber: next.invoiceNumber,
          postings: [
            { accountId: arAccountId, type: "DEBIT", amount: next.amount },
            { accountId: incomeAccountId, type: "CREDIT", amount: next.amount }
          ]
        });
        postedTransactionId = posted.id;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not repost this invoice to the ledger";
        return context.json({ error: message }, 400);
      }
    }

    const [updated] = await sql`
      update invoices set
        customer_id = ${next.customerId},
        product_service_id = ${next.productServiceId ?? null},
        invoice_number = ${next.invoiceNumber ?? null},
        invoice_date = ${next.invoiceDate},
        due_date = ${next.dueDate},
        amount = ${next.amount},
        memo = ${next.memo ?? null},
        posted_transaction_id = ${postedTransactionId},
        updated_at = now()
      where id = ${invoiceId}
      returning id, customer_id, product_service_id, invoice_number, invoice_date, due_date, amount, memo, status,
                posted_transaction_id, payment_transaction_id, created_at
    `;

    return context.json(serialize(updated as InvoiceRow), 200);
  });

  app.openapi(payInvoiceRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { invoiceId } = context.req.valid("param");
    const { depositAccountId, paymentDate } = context.req.valid("json");
    const sql = getSql();
    const { accountService, transactionService } = getServices(context);

    const existingRows = await sql`
      select i.id, i.customer_id, i.product_service_id, i.invoice_number, i.invoice_date, i.due_date,
             i.amount, i.memo, i.status, i.posted_transaction_id, i.payment_transaction_id, i.created_at
      from invoices i
      join ledgers l on l.id = i.ledger_id
      where l.tenant_id = ${tenantId} and i.id = ${invoiceId}
      limit 1
    `;
    if (existingRows.length === 0) {
      return context.json({ error: `No invoice '${invoiceId}' for this company` }, 404);
    }
    const current = existingRows[0] as InvoiceRow;
    if (current.status !== "OPEN") {
      return context.json({ error: `This invoice is ${current.status.toLowerCase()}, not open` }, 409);
    }

    let paymentTransactionId: string;
    try {
      const arAccountId = await findOrCreateAccountsReceivableAccount(accountService);
      const customerRows = await sql`select name from customers where id = ${current.customer_id} limit 1`;
      const customerName = customerRows.length > 0 ? (customerRows[0] as { name: string }).name : undefined;
      const posted = await postNewTransaction(transactionService, {
        type: "RECEIVE_PAYMENT",
        transactionDate: paymentDate ?? new Date().toISOString().slice(0, 10),
        memo: current.memo ?? undefined,
        payee: customerName,
        referenceNumber: current.invoice_number ?? undefined,
        postings: [
          { accountId: depositAccountId, type: "DEBIT", amount: Number(current.amount) },
          { accountId: arAccountId, type: "CREDIT", amount: Number(current.amount) }
        ]
      });
      paymentTransactionId = posted.id;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not post this payment to the ledger";
      return context.json({ error: message }, 400);
    }

    const [updated] = await sql`
      update invoices set status = 'PAID', payment_transaction_id = ${paymentTransactionId}, updated_at = now()
      where id = ${invoiceId}
      returning id, customer_id, product_service_id, invoice_number, invoice_date, due_date, amount, memo, status,
                posted_transaction_id, payment_transaction_id, created_at
    `;

    return context.json(serialize(updated as InvoiceRow), 200);
  });

  app.openapi(deleteInvoiceRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { invoiceId } = context.req.valid("param");
    const sql = getSql();
    const { transactionService } = getServices(context);

    const existingRows = await sql`
      select i.id, i.status, i.posted_transaction_id
      from invoices i
      join ledgers l on l.id = i.ledger_id
      where l.tenant_id = ${tenantId} and i.id = ${invoiceId}
      limit 1
    `;
    if (existingRows.length === 0) {
      return context.json({ error: `No invoice '${invoiceId}' for this company` }, 404);
    }
    const current = existingRows[0] as { id: string; status: "DRAFT" | "OPEN" | "PAID"; posted_transaction_id: string | null };
    if (current.status === "PAID") {
      return context.json({ error: "This invoice is already paid -- unwind the payment before deleting" }, 409);
    }

    if (current.posted_transaction_id) {
      await transactionService.voidTransaction(current.posted_transaction_id);
    }

    await sql`delete from invoices where id = ${invoiceId}`;
    return context.body(null, 204);
  });
}
