import { createRoute, z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { getLedgerName, getServices, getTenantId } from "@/http/context";
import { errorResponseSchema } from "@/domain/models";
import { getSql } from "@/infra/postgres/client";

const accountIdParam = zod.object({ accountId: zod.string().uuid() });
const reconciliationIdParam = zod.object({ reconciliationId: zod.string().uuid() });

const serviceChargeInputSchema = zod.object({
  amount: zod.number().positive(),
  date: zod.string().min(1),
  expenseAccountId: zod.string().min(1)
});

const interestEarnedInputSchema = zod.object({
  amount: zod.number().positive(),
  date: zod.string().min(1),
  incomeAccountId: zod.string().min(1)
});

const finishReconciliationInputSchema = zod.object({
  statementStartDate: zod.string().min(1),
  statementEndingDate: zod.string().min(1),
  statementEndingBalance: zod.number(),
  serviceCharge: serviceChargeInputSchema.optional(),
  interestEarned: interestEarnedInputSchema.optional(),
  clearedTransactionIds: zod.array(zod.string().uuid())
});

const reconciliationSchema = zod.object({
  id: zod.string().uuid(),
  accountId: zod.string(),
  statementStartDate: zod.string(),
  statementEndingDate: zod.string(),
  statementBeginningBalance: zod.number(),
  statementEndingBalance: zod.number(),
  clearedBalance: zod.number(),
  serviceChargeAmount: zod.number().nullable(),
  interestEarnedAmount: zod.number().nullable(),
  enteredCount: zod.number(),
  completedAt: zod.string()
});

const reconciliationEntrySchema = zod.object({
  transactionId: zod.string(),
  date: zod.string().nullable(),
  refNumber: zod.string().nullable(),
  payee: zod.string().nullable(),
  memo: zod.string().nullable(),
  payment: zod.number().nullable(),
  deposit: zod.number().nullable()
});

const reconciliationDetailSchema = reconciliationSchema.extend({
  entries: zod.array(reconciliationEntrySchema)
});

type ReconciliationRow = {
  id: string;
  account_id: string;
  statement_start_date: Date;
  statement_ending_date: Date;
  statement_beginning_balance: string;
  statement_ending_balance: string;
  cleared_balance: string;
  service_charge_amount: string | null;
  interest_earned_amount: string | null;
  entered_count: string;
  completed_at: Date;
};

function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function serialize(row: ReconciliationRow) {
  return {
    id: row.id,
    accountId: row.account_id,
    statementStartDate: toDateOnly(row.statement_start_date),
    statementEndingDate: toDateOnly(row.statement_ending_date),
    statementBeginningBalance: Number(row.statement_beginning_balance),
    statementEndingBalance: Number(row.statement_ending_balance),
    clearedBalance: Number(row.cleared_balance),
    serviceChargeAmount: row.service_charge_amount !== null ? Number(row.service_charge_amount) : null,
    interestEarnedAmount: row.interest_earned_amount !== null ? Number(row.interest_earned_amount) : null,
    enteredCount: Number(row.entered_count),
    completedAt: row.completed_at.toISOString()
  };
}

async function findLedgerId(sql: ReturnType<typeof getSql>, tenantId: string, ledgerName: string): Promise<string | null> {
  const rows = await sql`select id from ledgers where tenant_id = ${tenantId} and name = ${ledgerName} limit 1`;
  return rows.length > 0 ? (rows[0] as { id: string }).id : null;
}

const finishReconciliationRoute = createRoute({
  method: "post",
  path: "/api/accounts/{accountId}/reconciliations/finish",
  request: {
    params: accountIdParam,
    body: { content: { "application/json": { schema: finishReconciliationInputSchema } }, required: true }
  },
  responses: {
    200: { content: { "application/json": { schema: reconciliationSchema } }, description: "The finished reconciliation session" },
    400: { content: { "application/json": { schema: errorResponseSchema } }, description: "Out of balance, or an unknown transaction id was checked" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No active company, or no such account" }
  }
});

const historyRoute = createRoute({
  method: "get",
  path: "/api/accounts/{accountId}/reconciliations",
  request: { params: accountIdParam },
  responses: {
    200: { content: { "application/json": { schema: zod.array(reconciliationSchema) } }, description: "Every finished reconciliation for this account, most recent first" }
  }
});

const summaryRoute = createRoute({
  method: "get",
  path: "/api/reconciliations",
  responses: {
    200: { content: { "application/json": { schema: zod.array(reconciliationSchema) } }, description: "Every finished reconciliation for the caller's company, most recent first" }
  }
});

const detailRoute = createRoute({
  method: "get",
  path: "/api/reconciliations/{reconciliationId}",
  request: { params: reconciliationIdParam },
  responses: {
    200: { content: { "application/json": { schema: reconciliationDetailSchema } }, description: "One reconciliation session, with its cleared entries resolved for the printable report" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No such reconciliation for this company" }
  }
});

/**
 * Session-level reconciliation records -- see the migration's own comment
 * for why this is a separate Postgres table rather than an extension of
 * the ledger's beancount metadata. Clearing an individual transaction
 * still goes exclusively through RegisterService.setReconcileStatus; this
 * route file only ever calls that as part of a validated Finish, never
 * exposes a way to flip a status without going through the balance check
 * below.
 */
export function reconciliationRoutes(app: OpenAPIHono): void {
  app.openapi(finishReconciliationRoute, async (context) => {
    const tenantId = getTenantId(context);
    const ledgerName = getLedgerName(context);
    const { accountId } = context.req.valid("param");
    const input = context.req.valid("json");
    const sql = getSql();
    const { accountService, registerService, transactionService } = getServices(context);

    const ledgerId = await findLedgerId(sql, tenantId, ledgerName);
    if (!ledgerId) {
      return context.json({ error: "No active company for this request" }, 404);
    }

    let account;
    try {
      account = await accountService.getAccountById(accountId);
    } catch {
      return context.json({ error: `No account '${accountId}' for this company` }, 404);
    }

    const previousRows = await sql`
      select statement_ending_balance from reconciliations
      where ledger_id = ${ledgerId} and account_id = ${accountId}
      order by statement_ending_date desc, completed_at desc
      limit 1
    `;
    const beginningBalance =
      previousRows.length > 0
        ? Number((previousRows[0] as { statement_ending_balance: string }).statement_ending_balance)
        : (account.openingBalance ?? 0);

    const entries = await registerService.listRegisterEntries(accountId);
    const entriesByTransactionId = new Map(entries.map((entry) => [entry.transactionId, entry]));

    let paymentsTotal = 0;
    let depositsTotal = 0;
    for (const transactionId of input.clearedTransactionIds) {
      const entry = entriesByTransactionId.get(transactionId);
      if (!entry) {
        return context.json({ error: `No register entry for transaction '${transactionId}' on this account` }, 400);
      }
      paymentsTotal += entry.payment ?? 0;
      depositsTotal += entry.deposit ?? 0;
    }

    const adjustmentDelta = (input.interestEarned?.amount ?? 0) - (input.serviceCharge?.amount ?? 0);
    const clearedBalance = beginningBalance - paymentsTotal + depositsTotal + adjustmentDelta;

    if (Math.abs(input.statementEndingBalance - clearedBalance) > 0.005) {
      const difference = (input.statementEndingBalance - clearedBalance).toFixed(2);
      return context.json({ error: `This reconciliation is out of balance by ${difference}` }, 400);
    }

    const adjustmentTransactionIds: string[] = [];

    if (input.serviceCharge) {
      const draft = await transactionService.createTransaction({
        type: "JOURNAL_ENTRY",
        transactionDate: input.serviceCharge.date,
        memo: "Service charge",
        reconcileStatus: "R",
        postings: [
          { accountId: input.serviceCharge.expenseAccountId, type: "DEBIT", amount: input.serviceCharge.amount },
          { accountId, type: "CREDIT", amount: input.serviceCharge.amount }
        ]
      });
      const posted = await transactionService.postTransaction(draft.id);
      adjustmentTransactionIds.push(posted.id);
    }

    if (input.interestEarned) {
      const draft = await transactionService.createTransaction({
        type: "JOURNAL_ENTRY",
        transactionDate: input.interestEarned.date,
        memo: "Interest earned",
        reconcileStatus: "R",
        postings: [
          { accountId, type: "DEBIT", amount: input.interestEarned.amount },
          { accountId: input.interestEarned.incomeAccountId, type: "CREDIT", amount: input.interestEarned.amount }
        ]
      });
      const posted = await transactionService.postTransaction(draft.id);
      adjustmentTransactionIds.push(posted.id);
    }

    // Register-entry ids are regenerated every time the ledger document is
    // rebuilt (see the migration's own comment) -- posting the adjustment
    // transactions above just did exactly that, so the ids captured in
    // `entriesByTransactionId` before this point are already stale. Refetch
    // before resolving transactionId -> current register-entry id.
    const freshEntries = await registerService.listRegisterEntries(accountId);
    const freshEntriesByTransactionId = new Map(freshEntries.map((entry) => [entry.transactionId, entry]));
    for (const transactionId of input.clearedTransactionIds) {
      const entry = freshEntriesByTransactionId.get(transactionId);
      if (entry && entry.reconcileStatus !== "R") {
        await registerService.setReconcileStatus(entry.id, "R");
      }
    }

    const clearedEntryIds = [...input.clearedTransactionIds, ...adjustmentTransactionIds];

    const [inserted] = await sql`
      insert into reconciliations (
        ledger_id, account_id, statement_start_date, statement_ending_date,
        statement_beginning_balance, statement_ending_balance, cleared_balance,
        service_charge_amount, service_charge_date, service_charge_expense_account_id, service_charge_transaction_id,
        interest_earned_amount, interest_earned_date, interest_earned_income_account_id, interest_earned_transaction_id
      ) values (
        ${ledgerId}, ${accountId}, ${input.statementStartDate}, ${input.statementEndingDate},
        ${beginningBalance}, ${input.statementEndingBalance}, ${clearedBalance},
        ${input.serviceCharge?.amount ?? null}, ${input.serviceCharge?.date ?? null}, ${input.serviceCharge?.expenseAccountId ?? null}, ${adjustmentTransactionIds[0] ?? null},
        ${input.interestEarned?.amount ?? null}, ${input.interestEarned?.date ?? null}, ${input.interestEarned?.incomeAccountId ?? null}, ${input.interestEarned && input.serviceCharge ? adjustmentTransactionIds[1] : input.interestEarned ? adjustmentTransactionIds[0] : null}
      )
      returning id, account_id, statement_start_date, statement_ending_date, statement_beginning_balance,
                statement_ending_balance, cleared_balance, service_charge_amount, interest_earned_amount, completed_at
    `;
    const reconciliationId = (inserted as { id: string }).id;

    for (const transactionId of clearedEntryIds) {
      await sql`
        insert into reconciliation_entries (reconciliation_id, transaction_id, account_id, cleared_amount_snapshot)
        values (${reconciliationId}, ${transactionId}, ${accountId}, null)
        on conflict do nothing
      `;
    }

    return context.json(
      serialize({ ...(inserted as ReconciliationRow), entered_count: String(clearedEntryIds.length) }),
      200
    );
  });

  app.openapi(historyRoute, async (context) => {
    const tenantId = getTenantId(context);
    const ledgerName = getLedgerName(context);
    const { accountId } = context.req.valid("param");
    const sql = getSql();

    const rows = await sql`
      select r.id, r.account_id, r.statement_start_date, r.statement_ending_date, r.statement_beginning_balance,
             r.statement_ending_balance, r.cleared_balance, r.service_charge_amount, r.interest_earned_amount,
             r.completed_at, (select count(*) from reconciliation_entries e where e.reconciliation_id = r.id) as entered_count
      from reconciliations r
      join ledgers l on l.id = r.ledger_id
      where l.tenant_id = ${tenantId} and l.name = ${ledgerName} and r.account_id = ${accountId}
      order by r.statement_ending_date desc, r.completed_at desc
    `;
    return context.json(rows.map((row: unknown) => serialize(row as ReconciliationRow)), 200);
  });

  app.openapi(summaryRoute, async (context) => {
    const tenantId = getTenantId(context);
    const ledgerName = getLedgerName(context);
    const sql = getSql();

    const rows = await sql`
      select r.id, r.account_id, r.statement_start_date, r.statement_ending_date, r.statement_beginning_balance,
             r.statement_ending_balance, r.cleared_balance, r.service_charge_amount, r.interest_earned_amount,
             r.completed_at, (select count(*) from reconciliation_entries e where e.reconciliation_id = r.id) as entered_count
      from reconciliations r
      join ledgers l on l.id = r.ledger_id
      where l.tenant_id = ${tenantId} and l.name = ${ledgerName}
      order by r.statement_ending_date desc, r.completed_at desc
    `;
    return context.json(rows.map((row: unknown) => serialize(row as ReconciliationRow)), 200);
  });

  app.openapi(detailRoute, async (context) => {
    const tenantId = getTenantId(context);
    const ledgerName = getLedgerName(context);
    const { reconciliationId } = context.req.valid("param");
    const sql = getSql();
    const { registerService } = getServices(context);

    const rows = await sql`
      select r.id, r.account_id, r.statement_start_date, r.statement_ending_date, r.statement_beginning_balance,
             r.statement_ending_balance, r.cleared_balance, r.service_charge_amount, r.interest_earned_amount,
             r.completed_at, (select count(*) from reconciliation_entries e where e.reconciliation_id = r.id) as entered_count
      from reconciliations r
      join ledgers l on l.id = r.ledger_id
      where l.tenant_id = ${tenantId} and l.name = ${ledgerName} and r.id = ${reconciliationId}
      limit 1
    `;
    if (rows.length === 0) {
      return context.json({ error: `No reconciliation '${reconciliationId}' for this company` }, 404);
    }
    const row = rows[0] as ReconciliationRow;

    const entryRows = await sql`
      select transaction_id from reconciliation_entries where reconciliation_id = ${reconciliationId}
    `;
    const transactionIds = new Set(entryRows.map((entryRow: unknown) => (entryRow as { transaction_id: string }).transaction_id));

    const registerEntries = await registerService.listRegisterEntries(row.account_id);
    const entries = registerEntries
      .filter((entry) => transactionIds.has(entry.transactionId))
      .map((entry) => ({
        transactionId: entry.transactionId,
        date: entry.date ?? null,
        refNumber: entry.refNumber ?? null,
        payee: entry.payee ?? null,
        memo: entry.memo ?? null,
        payment: entry.payment ?? null,
        deposit: entry.deposit ?? null
      }));

    return context.json({ ...serialize(row), entries }, 200);
  });
}
