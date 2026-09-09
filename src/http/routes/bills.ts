import { createRoute, z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { getLedgerName, getServices, getTenantId } from "@/http/context";
import { errorResponseSchema } from "@/domain/models";
import type { AccountService, TransactionService } from "@/application/contracts";
import { getSql } from "@/infra/postgres/client";

const billIdParam = zod.object({ billId: zod.string().uuid() });

const billSchema = zod.object({
  id: zod.string().uuid(),
  vendorId: zod.string().uuid(),
  billNumber: zod.string().optional(),
  billDate: zod.string(),
  dueDate: zod.string(),
  amount: zod.number(),
  categoryAccountId: zod.string(),
  memo: zod.string().optional(),
  status: zod.enum(["DRAFT", "OPEN", "PAID"]),
  postedTransactionId: zod.string().optional(),
  paymentTransactionId: zod.string().optional(),
  createdAt: zod.string()
});

const createBillInputSchema = zod.object({
  vendorId: zod.string().uuid(),
  billNumber: zod.string().trim().min(1).max(100).optional(),
  billDate: zod.string().min(1),
  dueDate: zod.string().min(1),
  amount: zod.number().positive(),
  categoryAccountId: zod.string().min(1),
  memo: zod.string().trim().min(1).max(1000).optional()
});

const updateBillInputSchema = zod.object({
  vendorId: zod.string().uuid().optional(),
  billNumber: zod.string().trim().min(1).max(100).optional(),
  billDate: zod.string().min(1).optional(),
  dueDate: zod.string().min(1).optional(),
  amount: zod.number().positive().optional(),
  categoryAccountId: zod.string().min(1).optional(),
  memo: zod.string().trim().min(1).max(1000).optional()
});

const payBillInputSchema = zod.object({
  paymentAccountId: zod.string().min(1),
  paymentDate: zod.string().min(1).optional()
});

type BillRow = {
  id: string;
  vendor_id: string;
  bill_number: string | null;
  bill_date: Date;
  due_date: Date;
  amount: string;
  category_account_id: string;
  memo: string | null;
  status: "DRAFT" | "OPEN" | "PAID";
  posted_transaction_id: string | null;
  payment_transaction_id: string | null;
  created_at: Date;
};

function serialize(row: BillRow) {
  return {
    id: row.id,
    vendorId: row.vendor_id,
    billNumber: row.bill_number ?? undefined,
    billDate: row.bill_date.toISOString().slice(0, 10),
    dueDate: row.due_date.toISOString().slice(0, 10),
    amount: Number(row.amount),
    categoryAccountId: row.category_account_id,
    memo: row.memo ?? undefined,
    status: row.status,
    postedTransactionId: row.posted_transaction_id ?? undefined,
    paymentTransactionId: row.payment_transaction_id ?? undefined,
    createdAt: row.created_at.toISOString()
  };
}

const ACCOUNTS_PAYABLE_NAME = "Accounts Payable";
const ACCOUNTS_PAYABLE_CODE = "2000";

/**
 * Every company needs exactly one Accounts Payable account to post bills
 * against -- not every company template includes one (see
 * company-templates.ts), so find-or-create it the first time a bill is
 * ever entered, mirroring account-service.ts's own
 * findOrCreateOpeningBalanceEquityAccount pattern for Opening Balance
 * Equity. Goes through the public AccountService, not LedgerStore
 * directly -- this route file is outside the ledger-store service layer.
 */
async function findOrCreateAccountsPayableAccount(accountService: AccountService): Promise<string> {
  const accounts = await accountService.listAccounts();
  const existing = accounts.find((account) => account.category === "ACCOUNTS_PAYABLE");
  if (existing) return existing.id;

  let code = ACCOUNTS_PAYABLE_CODE;
  let suffix = 1;
  while (accounts.some((account) => account.code === code)) {
    code = `${ACCOUNTS_PAYABLE_CODE}-${suffix++}`;
  }
  const created = await accountService.createAccount({
    code,
    name: ACCOUNTS_PAYABLE_NAME,
    category: "ACCOUNTS_PAYABLE",
    currency: "USD"
  });
  return created.id;
}

/** Creates a DRAFT transaction and immediately posts it -- same two-call shape createDeposit/createTransfer already use. */
async function postNewTransaction(
  transactionService: TransactionService,
  input: Parameters<TransactionService["createTransaction"]>[0]
) {
  const draft = await transactionService.createTransaction(input);
  return transactionService.postTransaction(draft.id);
}

const listBillsRoute = createRoute({
  method: "get",
  path: "/api/bills",
  responses: {
    200: { content: { "application/json": { schema: zod.array(billSchema) } }, description: "Every bill for the caller's currently active company" }
  }
});

const createBillRoute = createRoute({
  method: "post",
  path: "/api/bills",
  request: { body: { content: { "application/json": { schema: createBillInputSchema } }, required: true } },
  responses: {
    200: { content: { "application/json": { schema: billSchema } }, description: "The newly created bill, already posted to the ledger" },
    400: { content: { "application/json": { schema: errorResponseSchema } }, description: "The category account can't accept postings, or another ledger validation failed" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No active company, or no such vendor for this company" }
  }
});

const updateBillRoute = createRoute({
  method: "patch",
  path: "/api/bills/{billId}",
  request: { params: billIdParam, body: { content: { "application/json": { schema: updateBillInputSchema } }, required: true } },
  responses: {
    200: { content: { "application/json": { schema: billSchema } }, description: "The updated bill" },
    400: { content: { "application/json": { schema: errorResponseSchema } }, description: "A ledger validation failed while reposting" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No such bill for this company" },
    409: { content: { "application/json": { schema: errorResponseSchema } }, description: "This bill is already paid and can no longer be edited" }
  }
});

const payBillRoute = createRoute({
  method: "post",
  path: "/api/bills/{billId}/pay",
  request: { params: billIdParam, body: { content: { "application/json": { schema: payBillInputSchema } }, required: true } },
  responses: {
    200: { content: { "application/json": { schema: billSchema } }, description: "The bill, now marked paid" },
    400: { content: { "application/json": { schema: errorResponseSchema } }, description: "A ledger validation failed while posting the payment" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No such bill for this company" },
    409: { content: { "application/json": { schema: errorResponseSchema } }, description: "This bill isn't open (already paid, or still a draft)" }
  }
});

const deleteBillRoute = createRoute({
  method: "delete",
  path: "/api/bills/{billId}",
  request: { params: billIdParam },
  responses: {
    204: { description: "Bill deleted, and its posted transaction voided" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No such bill for this company" },
    409: { content: { "application/json": { schema: errorResponseSchema } }, description: "This bill is already paid -- unwind the payment before deleting" }
  }
});

/**
 * Bills, scoped to the caller's CURRENTLY ACTIVE company only -- same
 * scoping rule as vendors.ts and mileage.ts. Unlike those two, this
 * domain also posts real beancount transactions (via TransactionService)
 * at two points, matching how QuickBooks itself works: entering a bill
 * posts Dr Expense / Cr Accounts Payable immediately; paying it later
 * posts a second Dr Accounts Payable / Cr Cash-or-Bank transaction. See
 * QBO_FREE_FEATURES_PLAN.md's Phase 1.5 resolution.
 */
export function billRoutes(app: OpenAPIHono): void {
  app.openapi(listBillsRoute, async (context) => {
    const tenantId = getTenantId(context);
    const ledgerName = getLedgerName(context);
    const sql = getSql();

    const rows = await sql`
      select b.id, b.vendor_id, b.bill_number, b.bill_date, b.due_date, b.amount, b.category_account_id,
             b.memo, b.status, b.posted_transaction_id, b.payment_transaction_id, b.created_at
      from bills b
      join ledgers l on l.id = b.ledger_id
      where l.tenant_id = ${tenantId} and l.name = ${ledgerName}
      order by b.bill_date desc, b.created_at desc
    `;

    return context.json(rows.map((row: unknown) => serialize(row as BillRow)), 200);
  });

  app.openapi(createBillRoute, async (context) => {
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

    const vendorRows = await sql`select name from vendors where id = ${input.vendorId} and ledger_id = ${ledgerId} limit 1`;
    if (vendorRows.length === 0) {
      return context.json({ error: `No vendor '${input.vendorId}' for this company` }, 404);
    }
    const vendorName = (vendorRows[0] as { name: string }).name;

    let postedTransactionId: string;
    try {
      const apAccountId = await findOrCreateAccountsPayableAccount(accountService);
      const posted = await postNewTransaction(transactionService, {
        type: "EXPENSE",
        transactionDate: input.billDate,
        dueDate: input.dueDate,
        memo: input.memo,
        payee: vendorName,
        referenceNumber: input.billNumber,
        postings: [
          { accountId: input.categoryAccountId, type: "DEBIT", amount: input.amount },
          { accountId: apAccountId, type: "CREDIT", amount: input.amount }
        ]
      });
      postedTransactionId = posted.id;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not post this bill to the ledger";
      return context.json({ error: message }, 400);
    }

    const [inserted] = await sql`
      insert into bills (ledger_id, vendor_id, bill_number, bill_date, due_date, amount, category_account_id, memo, status, posted_transaction_id)
      values (
        ${ledgerId}, ${input.vendorId}, ${input.billNumber ?? null}, ${input.billDate}, ${input.dueDate},
        ${input.amount}, ${input.categoryAccountId}, ${input.memo ?? null}, 'OPEN', ${postedTransactionId}
      )
      returning id, vendor_id, bill_number, bill_date, due_date, amount, category_account_id, memo, status,
                posted_transaction_id, payment_transaction_id, created_at
    `;

    return context.json(serialize(inserted as BillRow), 200);
  });

  app.openapi(updateBillRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { billId } = context.req.valid("param");
    const patch = context.req.valid("json");
    const sql = getSql();
    const { accountService, transactionService } = getServices(context);

    const existingRows = await sql`
      select b.id, b.vendor_id, b.bill_number, b.bill_date, b.due_date, b.amount, b.category_account_id,
             b.memo, b.status, b.posted_transaction_id, b.payment_transaction_id, b.created_at
      from bills b
      join ledgers l on l.id = b.ledger_id
      where l.tenant_id = ${tenantId} and b.id = ${billId}
      limit 1
    `;
    if (existingRows.length === 0) {
      return context.json({ error: `No bill '${billId}' for this company` }, 404);
    }
    const current = existingRows[0] as BillRow;
    if (current.status === "PAID") {
      return context.json({ error: "This bill is already paid and can no longer be edited" }, 409);
    }

    const next = {
      vendorId: patch.vendorId ?? current.vendor_id,
      billNumber: patch.billNumber !== undefined ? patch.billNumber : (current.bill_number ?? undefined),
      billDate: patch.billDate ?? current.bill_date.toISOString().slice(0, 10),
      dueDate: patch.dueDate ?? current.due_date.toISOString().slice(0, 10),
      amount: patch.amount ?? Number(current.amount),
      categoryAccountId: patch.categoryAccountId ?? current.category_account_id,
      memo: patch.memo !== undefined ? patch.memo : (current.memo ?? undefined)
    };

    // Only the fields that actually feed the posted transaction's numbers
    // trigger a repost -- billNumber/memo/dueDate changes alone leave the
    // existing transaction alone.
    const needsRepost =
      current.posted_transaction_id != null &&
      (next.amount !== Number(current.amount) || next.categoryAccountId !== current.category_account_id || next.billDate !== current.bill_date.toISOString().slice(0, 10));

    let postedTransactionId = current.posted_transaction_id;
    if (needsRepost && current.posted_transaction_id) {
      try {
        await transactionService.voidTransaction(current.posted_transaction_id);
        const vendorRows = await sql`select name from vendors where id = ${next.vendorId} limit 1`;
        const vendorName = vendorRows.length > 0 ? (vendorRows[0] as { name: string }).name : undefined;
        const apId = await findOrCreateAccountsPayableAccount(accountService);
        const posted = await postNewTransaction(transactionService, {
          type: "EXPENSE",
          transactionDate: next.billDate,
          dueDate: next.dueDate,
          memo: next.memo,
          payee: vendorName,
          referenceNumber: next.billNumber,
          postings: [
            { accountId: next.categoryAccountId, type: "DEBIT", amount: next.amount },
            { accountId: apId, type: "CREDIT", amount: next.amount }
          ]
        });
        postedTransactionId = posted.id;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not repost this bill to the ledger";
        return context.json({ error: message }, 400);
      }
    }

    const [updated] = await sql`
      update bills set
        vendor_id = ${next.vendorId},
        bill_number = ${next.billNumber ?? null},
        bill_date = ${next.billDate},
        due_date = ${next.dueDate},
        amount = ${next.amount},
        category_account_id = ${next.categoryAccountId},
        memo = ${next.memo ?? null},
        posted_transaction_id = ${postedTransactionId},
        updated_at = now()
      where id = ${billId}
      returning id, vendor_id, bill_number, bill_date, due_date, amount, category_account_id, memo, status,
                posted_transaction_id, payment_transaction_id, created_at
    `;

    return context.json(serialize(updated as BillRow), 200);
  });

  app.openapi(payBillRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { billId } = context.req.valid("param");
    const { paymentAccountId, paymentDate } = context.req.valid("json");
    const sql = getSql();
    const { accountService, transactionService } = getServices(context);

    const existingRows = await sql`
      select b.id, b.vendor_id, b.bill_number, b.bill_date, b.due_date, b.amount, b.category_account_id,
             b.memo, b.status, b.posted_transaction_id, b.payment_transaction_id, b.created_at
      from bills b
      join ledgers l on l.id = b.ledger_id
      where l.tenant_id = ${tenantId} and b.id = ${billId}
      limit 1
    `;
    if (existingRows.length === 0) {
      return context.json({ error: `No bill '${billId}' for this company` }, 404);
    }
    const current = existingRows[0] as BillRow;
    if (current.status !== "OPEN") {
      return context.json({ error: `This bill is ${current.status.toLowerCase()}, not open` }, 409);
    }

    let paymentTransactionId: string;
    try {
      const apAccountId = await findOrCreateAccountsPayableAccount(accountService);
      const vendorRows = await sql`select name from vendors where id = ${current.vendor_id} limit 1`;
      const vendorName = vendorRows.length > 0 ? (vendorRows[0] as { name: string }).name : undefined;
      const posted = await postNewTransaction(transactionService, {
        type: "BILL_PAYMENT",
        transactionDate: paymentDate ?? new Date().toISOString().slice(0, 10),
        memo: current.memo ?? undefined,
        payee: vendorName,
        referenceNumber: current.bill_number ?? undefined,
        postings: [
          { accountId: apAccountId, type: "DEBIT", amount: Number(current.amount) },
          { accountId: paymentAccountId, type: "CREDIT", amount: Number(current.amount) }
        ]
      });
      paymentTransactionId = posted.id;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not post this payment to the ledger";
      return context.json({ error: message }, 400);
    }

    const [updated] = await sql`
      update bills set status = 'PAID', payment_transaction_id = ${paymentTransactionId}, updated_at = now()
      where id = ${billId}
      returning id, vendor_id, bill_number, bill_date, due_date, amount, category_account_id, memo, status,
                posted_transaction_id, payment_transaction_id, created_at
    `;

    return context.json(serialize(updated as BillRow), 200);
  });

  app.openapi(deleteBillRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { billId } = context.req.valid("param");
    const sql = getSql();
    const { transactionService } = getServices(context);

    const existingRows = await sql`
      select b.id, b.status, b.posted_transaction_id
      from bills b
      join ledgers l on l.id = b.ledger_id
      where l.tenant_id = ${tenantId} and b.id = ${billId}
      limit 1
    `;
    if (existingRows.length === 0) {
      return context.json({ error: `No bill '${billId}' for this company` }, 404);
    }
    const current = existingRows[0] as { id: string; status: "DRAFT" | "OPEN" | "PAID"; posted_transaction_id: string | null };
    if (current.status === "PAID") {
      return context.json({ error: "This bill is already paid -- unwind the payment before deleting" }, 409);
    }

    if (current.posted_transaction_id) {
      await transactionService.voidTransaction(current.posted_transaction_id);
    }

    await sql`delete from bills where id = ${billId}`;
    return context.body(null, 204);
  });
}
