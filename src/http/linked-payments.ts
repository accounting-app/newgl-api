import type { Context } from "hono";

import { ValidationError } from "@/core/errors";
import type { LedgerPosting, PostingEntryType } from "@/domain/models";
import { getServices, getTenantId } from "@/http/context";
import { getSql } from "@/infra/postgres/client";

/**
 * Invoices and bills live in Postgres and point at the ledger transaction that
 * paid them. These keep the two in step when that transaction is changed from
 * the register or the transaction routes.
 */

const LOCKED_MESSAGE =
  "This payment paid an invoice or bill, so its amount and accounts receivable or payable line can't change. Delete the payment and record it again.";

// Test mode (fixed services, no real tenant) has no invoices or bills to look up.
function tenantWithDocuments(context: Context): string | undefined {
  const tenantId = getTenantId(context);
  return /^[0-9a-f-]{36}$/i.test(tenantId) ? tenantId : undefined;
}

async function paidSomething(context: Context, transactionId: string): Promise<boolean> {
  const tenantId = tenantWithDocuments(context);
  if (!tenantId) return false;
  const rows = await getSql()`
    select 1 from invoices i join ledgers l on l.id = i.ledger_id
    where l.tenant_id = ${tenantId} and i.payment_transaction_id = ${transactionId}
    union all
    select 1 from bills b join ledgers l on l.id = b.ledger_id
    where l.tenant_id = ${tenantId} and b.payment_transaction_id = ${transactionId}
    limit 1
  `;
  return rows.length > 0;
}

/** A deleted, voided or reversed payment no longer pays anything: its invoices and bills are open again. */
export async function reopenPaidDocuments(context: Context, transactionIds: string[]): Promise<void> {
  const tenantId = tenantWithDocuments(context);
  if (!tenantId) return;
  const sql = getSql();
  for (const transactionId of new Set(transactionIds)) {
    await sql`
      update invoices set status = 'OPEN', payment_transaction_id = null, updated_at = now()
      where payment_transaction_id = ${transactionId}
        and ledger_id in (select id from ledgers where tenant_id = ${tenantId})
    `;
    await sql`
      update bills set status = 'OPEN', payment_transaction_id = null, updated_at = now()
      where payment_transaction_id = ${transactionId}
        and ledger_id in (select id from ledgers where tenant_id = ${tenantId})
    `;
  }
}

const cents = (value: number) => Math.round(value * 100);

/** Full-form save: the receivable or payable line of a linked payment must stay exactly as it is. */
export async function guardLinkedPaymentUpdate(
  context: Context,
  transactionId: string,
  postings: { accountId: string; type: PostingEntryType; amount: number }[]
): Promise<void> {
  if (!(await paidSomething(context, transactionId))) return;
  const { accountService, registerService } = getServices(context);
  const { transaction } = await registerService.getTransactionDetail(transactionId);
  const documentAccounts = new Set(
    (await accountService.listAccounts())
      .filter((account) => account.category === "ACCOUNTS_RECEIVABLE" || account.category === "ACCOUNTS_PAYABLE")
      .map((account) => account.id)
  );
  const total = (list: { type: PostingEntryType; amount: number }[]) =>
    list.filter((posting) => posting.type === "DEBIT").reduce((sum, posting) => sum + cents(posting.amount), 0);
  const kept = transaction.postings
    .filter((posting) => documentAccounts.has(posting.accountId))
    .every((posting) =>
      postings.some((next) => next.accountId === posting.accountId && next.type === posting.type && cents(next.amount) === cents(posting.amount))
    );
  if (!kept || total(postings) !== total(transaction.postings)) {
    throw new ValidationError(LOCKED_MESSAGE);
  }
}

/** Inline register save: no change of amount, side or offset account on a linked payment. */
export async function guardLinkedPaymentRows(
  context: Context,
  updates: { entryId: string; payment?: number; deposit?: number; counterpartyAccountId?: string }[]
): Promise<void> {
  if (!tenantWithDocuments(context)) return;
  const { accountService, registerService } = getServices(context);
  const wanted = new Map(updates.map((update) => [update.entryId, update]));
  for (const account of await accountService.listAccounts()) {
    for (const entry of await registerService.listRegisterEntries(account.id)) {
      const update = wanted.get(entry.id);
      if (!update || !(await paidSomething(context, entry.transactionId))) continue;
      const payment = update.payment ?? 0;
      const deposit = update.deposit ?? 0;
      const amountChanged =
        (payment > 0 || deposit > 0) && (cents(payment) !== cents(entry.payment ?? 0) || cents(deposit) !== cents(entry.deposit ?? 0));
      const { postings }: { postings: LedgerPosting[] } = await registerService.getTransactionDetail(entry.transactionId);
      const accountChanged = Boolean(update.counterpartyAccountId) && !postings.some((posting) => posting.accountId === update.counterpartyAccountId);
      if (amountChanged || accountChanged) throw new ValidationError(LOCKED_MESSAGE);
    }
  }
}
