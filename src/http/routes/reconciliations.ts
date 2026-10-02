import { createRoute, z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { getLedgerName, getServices, getTenantId, getUserEmail } from "@/http/context";
import { computeBalanceImpact } from "@/core/accounting-reports";
import { errorResponseSchema } from "@/domain/models";
import type { Account, RegisterEntry } from "@/domain/models";
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
  transactionType: zod.string().nullable(),
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
  registerBalance: zod.number(),
  // QBO's report shows these under "Additional Information" (togglable via
  // "Hide additional information") -- the entries dated on/before the
  // statement date that never got cleared at all, not just their total.
  unclearedEntries: zod.array(reconciliationEntrySchema),
  // The bank-vs-book proof. `bookBalance` is computed from the ledger on
  // its own (never from the statement), so `isBalanced` is a real check:
  // statement balance +/- the uncleared items must land exactly on it.
  normalBalance: zod.enum(["DEBIT", "CREDIT"]),
  bookBalance: zod.number(),
  adjustedBankBalance: zod.number(),
  isBalanced: zod.boolean()
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

/**
 * Reconciliation math is done in the account's NATURAL balance terms -- the
 * same terms a bank/card statement uses -- not raw debit-minus-credit.
 * A register entry's `deposit` column is its DEBIT side and `payment` its
 * CREDIT side (ledger-engine.ts's createRegisterEntries); for a debit-normal
 * account (bank, assets) a debit raises the balance, but for a credit-normal
 * account (credit card, liabilities, equity) it LOWERS it -- a $100 card
 * charge is a credit that raises what you owe. Assuming debit-normal for
 * everything made every credit-card statement fail by exactly double.
 */
function isCreditNormal(category: Account["category"]): boolean {
  return computeBalanceImpact(category, "CREDIT", 1) > 0;
}

function naturalEffect(category: Account["category"], entry: RegisterEntry): number {
  return computeBalanceImpact(category, "DEBIT", entry.deposit ?? 0) + computeBalanceImpact(category, "CREDIT", entry.payment ?? 0);
}

/**
 * The account's balance per the books counting ONLY already-reconciled
 * transactions -- the theoretically correct "beginning balance" for the
 * next reconciliation (opening balance + everything reconciled so far),
 * derived from the ledger itself instead of trusted from the last
 * statement's typed-in ending balance.
 */
function reconciledBalanceFromLedger(account: Account, entries: RegisterEntry[]): number {
  return entries
    .filter((entry) => entry.reconcileStatus === "R")
    .reduce((sum, entry) => sum + naturalEffect(account.category, entry), account.openingBalance ?? 0);
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

const setupSchema = zod.object({
  normalBalance: zod.enum(["DEBIT", "CREDIT"]),
  // What the books say is already reconciled (opening balance + every
  // reconciled transaction) -- the beginning balance the next
  // reconciliation will actually use.
  beginningBalance: zod.number(),
  lastStatementEndingDate: zod.string().nullable(),
  lastStatementEndingBalance: zod.number().nullable(),
  lastReconciliationId: zod.string().nullable(),
  // False means a transaction reconciled in an earlier session was edited,
  // deleted, or un-reconciled afterwards: the books no longer agree with
  // the last statement that was reconciled.
  beginningBalanceMatchesLastStatement: zod.boolean(),
  // A saved in-progress reconciliation ("Save for later"), if any -- the
  // setup screen shows "Resume reconciling" instead of the empty form.
  draft: zod.object({ statementEndingDate: zod.string(), statementEndingBalance: zod.number() }).nullable()
});

const setupRoute = createRoute({
  method: "get",
  path: "/api/accounts/{accountId}/reconciliation-setup",
  request: { params: accountIdParam },
  responses: {
    200: { content: { "application/json": { schema: setupSchema } }, description: "What the Reconcile setup screen needs to know about this account" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No such account" }
  }
});

const undoRoute = createRoute({
  method: "post",
  path: "/api/reconciliations/{reconciliationId}/undo",
  request: { params: reconciliationIdParam },
  responses: {
    200: { content: { "application/json": { schema: zod.object({ undone: zod.literal(true), accountId: zod.string() }) } }, description: "The reconciliation was undone" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No such reconciliation for this company" },
    409: { content: { "application/json": { schema: errorResponseSchema } }, description: "Only the most recent reconciliation for an account can be undone" }
  }
});

const discrepancyRowSchema = zod.object({
  reconciliationId: zod.string().uuid(),
  statementEndingDate: zod.string(),
  transactionId: zod.string(),
  change: zod.enum(["DELETED", "UNRECONCILED", "AMOUNT_CHANGED", "DATE_CHANGED"]),
  date: zod.string().nullable(),
  refNumber: zod.string().nullable(),
  payee: zod.string().nullable(),
  // Natural-balance effect when it was reconciled vs. now (null = unknown or gone).
  reconciledAmount: zod.number().nullable(),
  currentAmount: zod.number().nullable(),
  reconciledDate: zod.string().nullable()
});

const discrepancyRoute = createRoute({
  method: "get",
  path: "/api/accounts/{accountId}/reconciliation-discrepancies",
  request: { params: accountIdParam },
  responses: {
    200: { content: { "application/json": { schema: zod.array(discrepancyRowSchema) } }, description: "Reconciled transactions that were changed, deleted or un-reconciled afterwards" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No such account" }
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

    // Statements are a chain: each must end after the last one did, or the
    // new one would re-cover period that was already reconciled.
    const previousRows = await sql`
      select statement_ending_date from reconciliations
      where ledger_id = ${ledgerId} and account_id = ${accountId}
      order by statement_ending_date desc, completed_at desc
      limit 1
    `;
    if (previousRows.length > 0) {
      const lastEndingDate = toDateOnly((previousRows[0] as { statement_ending_date: Date }).statement_ending_date);
      if (input.statementEndingDate <= lastEndingDate) {
        return context.json(
          { error: `The statement ending date must be after the last reconciled statement (${lastEndingDate}).`, difference: 0 },
          400
        );
      }
    }

    const entries = await registerService.listRegisterEntries(accountId);
    const entriesByTransactionId = new Map(entries.map((entry) => [entry.transactionId, entry]));
    const category = account.category;
    const creditNormal = isCreditNormal(category);

    // Beginning balance = what the books say is already reconciled, not
    // whatever the previous statement said -- so the equation
    // beginning + cleared = ending is checked against the ledger itself.
    const beginningBalance = reconciledBalanceFromLedger(account, entries);

    let clearedNatural = 0;
    for (const transactionId of input.clearedTransactionIds) {
      const entry = entriesByTransactionId.get(transactionId);
      if (!entry) {
        return context.json({ error: `No register entry for transaction '${transactionId}' on this account`, difference: 0 }, 400);
      }
      // A transaction is reconciled exactly once. Counting it again would
      // double its effect on this statement (it's already inside the
      // beginning balance).
      if (entry.reconcileStatus === "R") {
        return context.json({ error: `Transaction '${entry.refNumber ?? entry.transactionId}' is already reconciled.`, difference: 0 }, 400);
      }
      if (entry.date > input.statementEndingDate) {
        return context.json(
          { error: `Transaction '${entry.refNumber ?? entry.transactionId}' is dated after the statement ending date and can't be part of this statement.`, difference: 0 },
          400
        );
      }
      clearedNatural += naturalEffect(category, entry);
    }

    // Service/finance charge: Dr expense, Cr the account. Interest: Dr the
    // account, Cr income. Each moves the account's natural balance in the
    // direction its debit/credit side implies for THIS account type.
    const adjustmentNatural =
      (input.interestEarned ? computeBalanceImpact(category, "DEBIT", input.interestEarned.amount) : 0) +
      (input.serviceCharge ? computeBalanceImpact(category, "CREDIT", input.serviceCharge.amount) : 0);
    let clearedBalance = beginningBalance + clearedNatural + adjustmentNatural;
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
      // `difference` is the NATURAL-balance change the account needs. A
      // debit-normal account gains on a debit and loses on a credit; a
      // credit-normal one is the reverse -- so which side the account
      // takes depends on both the sign and its normal balance.
      const accountSide = (difference > 0) === !creditNormal ? "DEBIT" : "CREDIT";
      const otherSide = accountSide === "DEBIT" ? "CREDIT" : "DEBIT";
      const draft = await transactionService.createTransaction({
        type: "JOURNAL_ENTRY",
        transactionDate: input.discrepancyAdjustmentDate,
        memo: "Reconciliation adjustment",
        sourceAccountId: accountId,
        reconcileStatus: "R",
        postings: [
          { accountId, type: accountSide, amount },
          { accountId: discrepancyAccountId, type: otherSide, amount }
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

    // The in-progress draft (Save for later) is spent once the real thing is done.
    await sql`delete from reconciliation_drafts where ledger_id = ${ledgerId} and account_id = ${accountId}`;

    // Snapshot each entry as it is reconciled (natural-balance effect and
    // date) so the discrepancy report can later tell what changed. Uses the
    // fresh entries: the adjustment transactions only exist there.
    for (const transactionId of clearedEntryIds) {
      const snapshotEntry = freshEntriesByTransactionId.get(transactionId);
      await sql`
        insert into reconciliation_entries (reconciliation_id, transaction_id, account_id, cleared_amount_snapshot, date_snapshot)
        values (
          ${reconciliationId}, ${transactionId}, ${accountId},
          ${snapshotEntry ? naturalEffect(category, snapshotEntry) : null},
          ${snapshotEntry?.date ?? null}
        )
        on conflict do nothing
      `;
    }

    return context.json(
      serialize({ ...(inserted as ReconciliationRow), entered_count: String(clearedEntryIds.length) }),
      200
    );
  });

  app.openapi(setupRoute, async (context) => {
    const tenantId = getTenantId(context);
    const ledgerName = getLedgerName(context);
    const { accountId } = context.req.valid("param");
    const sql = getSql();
    const { accountService, registerService } = getServices(context);

    let account;
    try {
      account = await accountService.getAccountById(accountId);
    } catch {
      return context.json({ error: `No account '${accountId}' for this company` }, 404);
    }
    const ledgerId = await findLedgerId(sql, tenantId, ledgerName);
    const entries = await registerService.listRegisterEntries(accountId);
    const beginningBalance = reconciledBalanceFromLedger(account, entries);

    const lastRows = ledgerId
      ? await sql`
          select id, statement_ending_date, statement_ending_balance from reconciliations
          where ledger_id = ${ledgerId} and account_id = ${accountId}
          order by statement_ending_date desc, completed_at desc
          limit 1
        `
      : [];
    const draftRows = ledgerId
      ? await sql`
          select statement_ending_date, statement_ending_balance from reconciliation_drafts
          where ledger_id = ${ledgerId} and account_id = ${accountId} limit 1
        `
      : [];
    const draft = draftRows[0] as { statement_ending_date: Date; statement_ending_balance: string } | undefined;
    const last = lastRows[0] as { id: string; statement_ending_date: Date; statement_ending_balance: string } | undefined;
    const lastEndingBalance = last ? Number(last.statement_ending_balance) : null;

    return context.json(
      {
        normalBalance: isCreditNormal(account.category) ? ("CREDIT" as const) : ("DEBIT" as const),
        beginningBalance,
        lastStatementEndingDate: last ? toDateOnly(last.statement_ending_date) : null,
        lastStatementEndingBalance: lastEndingBalance,
        lastReconciliationId: last?.id ?? null,
        beginningBalanceMatchesLastStatement: lastEndingBalance === null || Math.abs(lastEndingBalance - beginningBalance) < 0.005,
        draft: draft ? { statementEndingDate: toDateOnly(draft.statement_ending_date), statementEndingBalance: Number(draft.statement_ending_balance) } : null
      },
      200
    );
  });

  app.openapi(undoRoute, async (context) => {
    const tenantId = getTenantId(context);
    const ledgerName = getLedgerName(context);
    const { reconciliationId } = context.req.valid("param");
    const sql = getSql();
    const { registerService, transactionService } = getServices(context);

    const rows = await sql`
      select r.id, r.ledger_id, r.account_id, r.service_charge_transaction_id, r.interest_earned_transaction_id, r.discrepancy_adjustment_transaction_id
      from reconciliations r
      join ledgers l on l.id = r.ledger_id
      where l.tenant_id = ${tenantId} and l.name = ${ledgerName} and r.id = ${reconciliationId}
      limit 1
    `;
    if (rows.length === 0) {
      return context.json({ error: `No reconciliation '${reconciliationId}' for this company` }, 404);
    }
    const row = rows[0] as {
      ledger_id: string;
      account_id: string;
      service_charge_transaction_id: string | null;
      interest_earned_transaction_id: string | null;
      discrepancy_adjustment_transaction_id: string | null;
    };

    // QBO only lets the MOST RECENT reconciliation be undone: each statement
    // starts from the books as the previous one left them, so undoing an
    // older one would leave every later one standing on a changed base.
    const latest = await sql`
      select id from reconciliations
      where ledger_id = ${row.ledger_id} and account_id = ${row.account_id}
      order by statement_ending_date desc, completed_at desc
      limit 1
    `;
    if ((latest[0] as { id: string }).id !== reconciliationId) {
      return context.json({ error: "Only the most recent reconciliation for this account can be undone." }, 409);
    }

    const adjustmentTransactionIds = [row.service_charge_transaction_id, row.interest_earned_transaction_id, row.discrepancy_adjustment_transaction_id].filter(
      (id): id is string => id !== null
    );
    const memberRows = await sql`select transaction_id from reconciliation_entries where reconciliation_id = ${reconciliationId}`;
    const memberTransactionIds = (memberRows as Array<{ transaction_id: string }>)
      .map((m) => m.transaction_id)
      .filter((id) => !adjustmentTransactionIds.includes(id));

    // The auto-posted adjustment entries (service charge, interest,
    // discrepancy) only existed because of this reconciliation, so undoing
    // it voids them -- the ledger returns to exactly how it was before.
    // (Voiding regenerates register-entry ids, hence the refetch below.)
    for (const transactionId of adjustmentTransactionIds) {
      try {
        await transactionService.voidTransaction(transactionId);
      } catch {
        // Already voided by hand: nothing left to reverse.
      }
    }

    const freshEntries = await registerService.listRegisterEntries(row.account_id);
    const freshByTransactionId = new Map(freshEntries.map((entry) => [entry.transactionId, entry]));
    for (const transactionId of memberTransactionIds) {
      const entry = freshByTransactionId.get(transactionId);
      if (entry && entry.reconcileStatus === "R") {
        await registerService.setReconcileStatus(entry.id, "");
      }
    }

    await sql`delete from reconciliations where id = ${reconciliationId}`;
    return context.json({ undone: true as const, accountId: row.account_id }, 200);
  });

  app.openapi(discrepancyRoute, async (context) => {
    const tenantId = getTenantId(context);
    const ledgerName = getLedgerName(context);
    const { accountId } = context.req.valid("param");
    const sql = getSql();
    const { accountService, registerService } = getServices(context);

    let account;
    try {
      account = await accountService.getAccountById(accountId);
    } catch {
      return context.json({ error: `No account '${accountId}' for this company` }, 404);
    }
    const entries = await registerService.listRegisterEntries(accountId);
    const entriesByTransactionId = new Map(entries.map((entry) => [entry.transactionId, entry]));

    const snapshots = await sql`
      select r.id as reconciliation_id, r.statement_ending_date, e.transaction_id, e.cleared_amount_snapshot, e.date_snapshot
      from reconciliation_entries e
      join reconciliations r on r.id = e.reconciliation_id
      join ledgers l on l.id = r.ledger_id
      where l.tenant_id = ${tenantId} and l.name = ${ledgerName} and r.account_id = ${accountId}
      order by r.statement_ending_date desc, e.transaction_id
    `;

    const issues: Array<zod.infer<typeof discrepancyRowSchema>> = [];
    for (const snap of snapshots as Array<{
      reconciliation_id: string;
      statement_ending_date: Date;
      transaction_id: string;
      cleared_amount_snapshot: string | null;
      date_snapshot: Date | null;
    }>) {
      const entry = entriesByTransactionId.get(snap.transaction_id);
      const reconciledAmount = snap.cleared_amount_snapshot !== null ? Number(snap.cleared_amount_snapshot) : null;
      const reconciledDate = snap.date_snapshot ? toDateOnly(snap.date_snapshot) : null;
      const base = {
        reconciliationId: snap.reconciliation_id,
        statementEndingDate: toDateOnly(snap.statement_ending_date),
        transactionId: snap.transaction_id,
        date: entry?.date ?? reconciledDate,
        refNumber: entry?.refNumber ?? null,
        payee: entry?.payee ?? null,
        reconciledAmount,
        reconciledDate
      };
      if (!entry) {
        issues.push({ ...base, change: "DELETED", currentAmount: null });
        continue;
      }
      const currentAmount = naturalEffect(account.category, entry);
      if (entry.reconcileStatus !== "R") {
        issues.push({ ...base, change: "UNRECONCILED", currentAmount });
      } else if (reconciledAmount !== null && Math.abs(currentAmount - reconciledAmount) > 0.005) {
        issues.push({ ...base, change: "AMOUNT_CHANGED", currentAmount });
      } else if (reconciledDate !== null && entry.date !== reconciledDate) {
        issues.push({ ...base, change: "DATE_CHANGED", currentAmount });
      }
    }
    return context.json(issues, 200);
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
    const { registerService, accountService } = getServices(context);

    const rows = await sql`
      select r.id, r.account_id, r.statement_start_date, r.statement_ending_date, r.statement_beginning_balance,
             r.statement_ending_balance, r.cleared_balance, r.service_charge_amount, r.interest_earned_amount, r.discrepancy_adjustment_amount, r.created_by,
             r.completed_at, (select count(*) from reconciliation_entries e where e.reconciliation_id = r.id) as entered_count,
             r.service_charge_transaction_id, r.interest_earned_transaction_id, r.discrepancy_adjustment_transaction_id
      from reconciliations r
      join ledgers l on l.id = r.ledger_id
      where l.tenant_id = ${tenantId} and l.name = ${ledgerName} and r.id = ${reconciliationId}
      limit 1
    `;
    if (rows.length === 0) {
      return context.json({ error: `No reconciliation '${reconciliationId}' for this company` }, 404);
    }
    const row = rows[0] as ReconciliationRow;
    const autoPosted = row as unknown as { service_charge_transaction_id: string | null; interest_earned_transaction_id: string | null; discrepancy_adjustment_transaction_id: string | null };

    const entryRows = await sql`
      select transaction_id from reconciliation_entries where reconciliation_id = ${reconciliationId}
    `;
    // The service charge / interest / adjustment the finish auto-posted get
    // their own lines in the report's Summary. Leaving them in the cleared
    // totals as well would count them twice and the Summary wouldn't foot.
    const autoPostedIds = new Set([autoPosted.service_charge_transaction_id, autoPosted.interest_earned_transaction_id, autoPosted.discrepancy_adjustment_transaction_id].filter((id): id is string => id !== null));
    const transactionIds = new Set(
      entryRows.map((entryRow: unknown) => (entryRow as { transaction_id: string }).transaction_id).filter((id: string) => !autoPostedIds.has(id))
    );

    function toEntry(entry: (typeof registerEntries)[number]) {
      return {
        transactionId: entry.transactionId,
        transactionType: entry.transactionType ?? null,
        date: entry.date ?? null,
        refNumber: entry.refNumber ?? null,
        payee: entry.payee ?? null,
        memo: entry.memo ?? null,
        payment: entry.payment ?? null,
        deposit: entry.deposit ?? null
      };
    }

    const registerEntries = await registerService.listRegisterEntries(row.account_id);
    const account = await accountService.getAccountById(row.account_id);
    const category = account.category;
    const creditNormal = isCreditNormal(category);
    const statementEndingDate = toDateOnly(row.statement_ending_date);

    const clearedEntries = registerEntries.filter((entry) => transactionIds.has(entry.transactionId));
    const entries = clearedEntries.map(toEntry);

    const paymentsCount = clearedEntries.filter((entry) => (entry.payment ?? 0) > 0).length;
    const paymentsTotal = clearedEntries.reduce((sum, entry) => sum + (entry.payment ?? 0), 0);
    const depositsCount = clearedEntries.filter((entry) => (entry.deposit ?? 0) > 0).length;
    const depositsTotal = clearedEntries.reduce((sum, entry) => sum + (entry.deposit ?? 0), 0);

    // "Uncleared as of the statement date" is a statement about THAT
    // moment: dated on/before it, and not reconciled by this session or
    // any earlier one. Using each entry's CURRENT status instead would make
    // an old report change retroactively whenever a later reconciliation
    // clears something. An entry marked R by hand (no session at all) is
    // treated as reconciled unless a LATER session is what reconciled it.
    const ledgerId = await findLedgerId(sql, tenantId, ledgerName);
    const sessionMembership = await sql`
      select e.transaction_id, r2.statement_ending_date
      from reconciliation_entries e
      join reconciliations r2 on r2.id = e.reconciliation_id
      where r2.ledger_id = ${ledgerId} and r2.account_id = ${row.account_id}
    `;
    const reconciledByThen = new Set<string>();
    const reconciledLater = new Set<string>();
    for (const membership of sessionMembership as Array<{ transaction_id: string; statement_ending_date: Date }>) {
      (toDateOnly(membership.statement_ending_date) <= statementEndingDate ? reconciledByThen : reconciledLater).add(membership.transaction_id);
    }
    const unclearedRegisterEntries = registerEntries.filter(
      (entry) =>
        entry.date <= statementEndingDate &&
        !reconciledByThen.has(entry.transactionId) &&
        !(entry.reconcileStatus === "R" && !reconciledLater.has(entry.transactionId))
    );
    const unclearedTotal = unclearedRegisterEntries.reduce((sum, entry) => sum + naturalEffect(category, entry), 0);
    const unclearedEntries = unclearedRegisterEntries.map(toEntry);

    // The proof: the books' own balance at the statement date, computed
    // from the ledger independently of the statement. The statement's
    // ending balance plus the items it hasn't seen yet (deposits in
    // transit, outstanding checks) must equal it exactly.
    const bookBalance = registerEntries
      .filter((entry) => entry.date <= statementEndingDate)
      .reduce((sum, entry) => sum + naturalEffect(category, entry), account.openingBalance ?? 0);
    const adjustedBankBalance = Number(row.statement_ending_balance) + unclearedTotal;
    const isBalanced = Math.abs(adjustedBankBalance - bookBalance) < 0.005;

    return context.json(
      {
        ...serialize(row),
        entries,
        paymentsCount,
        paymentsTotal,
        depositsCount,
        depositsTotal,
        unclearedTotal,
        registerBalance: bookBalance,
        unclearedEntries,
        normalBalance: creditNormal ? ("CREDIT" as const) : ("DEBIT" as const),
        bookBalance,
        adjustedBankBalance,
        isBalanced
      },
      200
    );
  });
}
