import { createRoute, z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { getLedgerName, getServices, getTenantId, getUserEmail } from "@/http/context";
import { errorResponseSchema } from "@/domain/models";
import type { AccountService } from "@/application/contracts";
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
  clearedTransactionIds: zod.array(zod.string().uuid()),
  // Set only on the confirmed retry after a 400 "out of balance" response --
  // matches QBO's "Hold on! Your difference isn't $0.00 yet" -> "Add
  // adjustment and finish" flow. Presence is the caller's explicit
  // confirmation to post a balancing entry for the remaining difference.
  discrepancyAdjustmentDate: zod.string().min(1).optional()
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
  discrepancyAdjustmentAmount: zod.number().nullable(),
  enteredCount: zod.number(),
  reconciledBy: zod.string().nullable(),
  completedAt: zod.string()
});

const outOfBalanceResponseSchema = errorResponseSchema.extend({
  difference: zod.number()
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
  entries: zod.array(reconciliationEntrySchema),
  // Everything below backs the printable Reconciliation Report's Summary
  // section -- matches QBO's own report layout (checks/payments cleared,
  // deposits/credits cleared, uncleared-as-of, register-balance-as-of).
  paymentsCount: zod.number(),
  paymentsTotal: zod.number(),
  depositsCount: zod.number(),
  depositsTotal: zod.number(),
  unclearedTotal: zod.number(),
  registerBalance: zod.number()
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
  discrepancy_adjustment_amount: string | null;
  entered_count: string;
  created_by: string | null;
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
    discrepancyAdjustmentAmount: row.discrepancy_adjustment_amount !== null ? Number(row.discrepancy_adjustment_amount) : null,
    enteredCount: Number(row.entered_count),
    reconciledBy: row.created_by,
    completedAt: row.completed_at.toISOString()
  };
}

async function findLedgerId(sql: ReturnType<typeof getSql>, tenantId: string, ledgerName: string): Promise<string | null> {
  const rows = await sql`select id from ledgers where tenant_id = ${tenantId} and name = ${ledgerName} limit 1`;
  return rows.length > 0 ? (rows[0] as { id: string }).id : null;
}

const DISCREPANCIES_ACCOUNT_NAME = "Reconciliation Discrepancies";
const DISCREPANCIES_ACCOUNT_CODE = "9999";

/**
 * QBO's own default chart of accounts ships a "Reconciliation
 * Discrepancies" (Other Expense) account for exactly this -- the
 * balancing entry Finish posts when the caller confirms "Add adjustment
 * and finish" despite a nonzero difference. Not every company template
 * here includes one, so find-or-create it the first time it's needed,
 * same pattern as bills.ts's findOrCreateAccountsPayableAccount.
 */
async function findOrCreateDiscrepanciesAccount(accountService: AccountService): Promise<string> {
  const accounts = await accountService.listAccounts();
  const existing = accounts.find((account) => account.name === DISCREPANCIES_ACCOUNT_NAME);
  if (existing) return existing.id;

  let code = DISCREPANCIES_ACCOUNT_CODE;
  let suffix = 1;
  while (accounts.some((account) => account.code === code)) {
    code = `${DISCREPANCIES_ACCOUNT_CODE}-${suffix++}`;
  }
  const created = await accountService.createAccount({
    code,
    name: DISCREPANCIES_ACCOUNT_NAME,
    category: "OTHER_EXPENSE",
    currency: "USD"
  });
  return created.id;
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
    400: {
      content: { "application/json": { schema: outOfBalanceResponseSchema } },
      description: "Out of balance (unless discrepancyAdjustmentDate is set), or an unknown transaction id was checked"
    },
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
        return context.json({ error: `No register entry for transaction '${transactionId}' on this account`, difference: 0 }, 400);
      }
      paymentsTotal += entry.payment ?? 0;
      depositsTotal += entry.deposit ?? 0;
    }

    const adjustmentDelta = (input.interestEarned?.amount ?? 0) - (input.serviceCharge?.amount ?? 0);
    let clearedBalance = beginningBalance - paymentsTotal + depositsTotal + adjustmentDelta;
    let difference = input.statementEndingBalance - clearedBalance;

    if (Math.abs(difference) > 0.005 && !input.discrepancyAdjustmentDate) {
      return context.json({ error: `This reconciliation is out of balance by ${difference.toFixed(2)}`, difference }, 400);
    }

    const adjustmentTransactionIds: string[] = [];
    let discrepancyAdjustmentAmount: number | null = null;
    let discrepancyAdjustmentTransactionId: string | null = null;

    if (input.serviceCharge) {
      const draft = await transactionService.createTransaction({
        type: "JOURNAL_ENTRY",
        transactionDate: input.serviceCharge.date,
        memo: "Service charge",
        // reconcileStatus only ever lands on the register entry whose
        // account matches sourceAccountId (see ledger-engine.ts's
        // createRegisterEntries) -- omitting this silently left every
        // adjustment transaction's own entry unreconciled.
        sourceAccountId: accountId,
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
        sourceAccountId: accountId,
        reconcileStatus: "R",
        postings: [
          { accountId, type: "DEBIT", amount: input.interestEarned.amount },
          { accountId: input.interestEarned.incomeAccountId, type: "CREDIT", amount: input.interestEarned.amount }
        ]
      });
      const posted = await transactionService.postTransaction(draft.id);
      adjustmentTransactionIds.push(posted.id);
    }

    if (Math.abs(difference) > 0.005 && input.discrepancyAdjustmentDate) {
      const discrepancyAccountId = await findOrCreateDiscrepanciesAccount(accountService);
      const amount = Math.abs(difference);
      const draft = await transactionService.createTransaction({
        type: "JOURNAL_ENTRY",
        transactionDate: input.discrepancyAdjustmentDate,
        memo: "Reconciliation adjustment",
        sourceAccountId: accountId,
        reconcileStatus: "R",
        postings:
          difference > 0
            ? [
                { accountId, type: "DEBIT", amount },
                { accountId: discrepancyAccountId, type: "CREDIT", amount }
              ]
            : [
                { accountId: discrepancyAccountId, type: "DEBIT", amount },
                { accountId, type: "CREDIT", amount }
              ]
      });
      const posted = await transactionService.postTransaction(draft.id);
      adjustmentTransactionIds.push(posted.id);
      discrepancyAdjustmentAmount = difference;
      discrepancyAdjustmentTransactionId = posted.id;
      clearedBalance = input.statementEndingBalance;
      difference = 0;
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

    const serviceChargeTransactionId = input.serviceCharge ? adjustmentTransactionIds[0] : null;
    const interestEarnedTransactionId = input.interestEarned ? adjustmentTransactionIds[input.serviceCharge ? 1 : 0] : null;

    const [inserted] = await sql`
      insert into reconciliations (
        ledger_id, account_id, statement_start_date, statement_ending_date,
        statement_beginning_balance, statement_ending_balance, cleared_balance,
        service_charge_amount, service_charge_date, service_charge_expense_account_id, service_charge_transaction_id,
        interest_earned_amount, interest_earned_date, interest_earned_income_account_id, interest_earned_transaction_id,
        discrepancy_adjustment_amount, discrepancy_adjustment_transaction_id, created_by
      ) values (
        ${ledgerId}, ${accountId}, ${input.statementStartDate}, ${input.statementEndingDate},
        ${beginningBalance}, ${input.statementEndingBalance}, ${clearedBalance},
        ${input.serviceCharge?.amount ?? null}, ${input.serviceCharge?.date ?? null}, ${input.serviceCharge?.expenseAccountId ?? null}, ${serviceChargeTransactionId},
        ${input.interestEarned?.amount ?? null}, ${input.interestEarned?.date ?? null}, ${input.interestEarned?.incomeAccountId ?? null}, ${interestEarnedTransactionId},
        ${discrepancyAdjustmentAmount}, ${discrepancyAdjustmentTransactionId}, ${getUserEmail(context)}
      )
      returning id, account_id, statement_start_date, statement_ending_date, statement_beginning_balance,
                statement_ending_balance, cleared_balance, service_charge_amount, interest_earned_amount, discrepancy_adjustment_amount, created_by, completed_at
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
             r.statement_ending_balance, r.cleared_balance, r.service_charge_amount, r.interest_earned_amount, r.discrepancy_adjustment_amount, r.created_by,
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
             r.statement_ending_balance, r.cleared_balance, r.service_charge_amount, r.interest_earned_amount, r.discrepancy_adjustment_amount, r.created_by,
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
             r.statement_ending_balance, r.cleared_balance, r.service_charge_amount, r.interest_earned_amount, r.discrepancy_adjustment_amount, r.created_by,
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
    const clearedEntries = registerEntries.filter((entry) => transactionIds.has(entry.transactionId));
    const entries = clearedEntries.map((entry) => ({
      transactionId: entry.transactionId,
      date: entry.date ?? null,
      refNumber: entry.refNumber ?? null,
      payee: entry.payee ?? null,
      memo: entry.memo ?? null,
      payment: entry.payment ?? null,
      deposit: entry.deposit ?? null
    }));

    const paymentsCount = clearedEntries.filter((entry) => (entry.payment ?? 0) > 0).length;
    const paymentsTotal = clearedEntries.reduce((sum, entry) => sum + (entry.payment ?? 0), 0);
    const depositsCount = clearedEntries.filter((entry) => (entry.deposit ?? 0) > 0).length;
    const depositsTotal = clearedEntries.reduce((sum, entry) => sum + (entry.deposit ?? 0), 0);

    // Register entries dated on/before the statement date that this
    // session's own statement_ending_date reflects, but were never
    // cleared/reconciled at all -- matches QBO's "Uncleared transactions
    // as of [date]" line, and registerBalance is what the account's real
    // running balance is once those are added back in.
    const statementEndingDate = toDateOnly(row.statement_ending_date);
    const unclearedTotal = registerEntries
      .filter((entry) => entry.reconcileStatus === "" && entry.date <= statementEndingDate)
      .reduce((sum, entry) => sum + (entry.deposit ?? 0) - (entry.payment ?? 0), 0);
    const registerBalance = Number(row.statement_ending_balance) + unclearedTotal;

    return context.json(
      { ...serialize(row), entries, paymentsCount, paymentsTotal, depositsCount, depositsTotal, unclearedTotal, registerBalance },
      200
    );
  });
}
