import type { Context } from "hono";
import { z as zod } from "@hono/zod-openapi";

import { ConflictError, NotFoundError, ValidationError } from "@/core/errors";
import { getServices, getTenantId } from "@/http/context";
import { getSql } from "@/infra/postgres/client";

/** Payments applied to invoices and bills: what's paid, what's open, and applying more. */

export type DocumentKind = "invoice" | "bill";

export const paymentFieldsSchema = {
  openBalance: zod.number(),
  paidAmount: zod.number(),
  payments: zod.array(zod.object({ transactionId: zod.string(), amount: zod.number() }))
};

export const applyPaymentInputSchema = zod.object({
  paymentTransactionId: zod.string().uuid(),
  amount: zod.number().positive()
});

const KINDS = {
  invoice: { label: "invoice", paymentType: "RECEIVE_PAYMENT", side: "CREDIT", category: "ACCOUNTS_RECEIVABLE" },
  bill: { label: "bill", paymentType: "BILL_PAYMENT", side: "DEBIT", category: "ACCOUNTS_PAYABLE" }
} as const;

const cents = (value: number | string) => Math.round(Number(value) * 100);

type ApplicationRow = { document_id: string; payment_transaction_id: string; amount: string };

async function applicationsFor(kind: DocumentKind, documentIds: string[]): Promise<ApplicationRow[]> {
  if (documentIds.length === 0) return [];
  const sql = getSql();
  return kind === "invoice"
    ? await sql`select invoice_id as document_id, payment_transaction_id, amount from payment_applications where invoice_id in ${sql(documentIds)} order by created_at`
    : await sql`select bill_id as document_id, payment_transaction_id, amount from payment_applications where bill_id in ${sql(documentIds)} order by created_at`;
}

export async function withPayments<T extends { id: string; amount: number }>(kind: DocumentKind, documents: T[]) {
  const rows = await applicationsFor(kind, documents.map((document) => document.id));
  return documents.map((document) => {
    const payments = rows
      .filter((row) => row.document_id === document.id)
      .map((row) => ({ transactionId: row.payment_transaction_id, amount: Number(row.amount) }));
    const paid = payments.reduce((sum, payment) => sum + cents(payment.amount), 0);
    return { ...document, payments, paidAmount: paid / 100, openBalance: Math.max(0, cents(document.amount) - paid) / 100 };
  });
}

export async function hasPayments(kind: DocumentKind, documentId: string): Promise<boolean> {
  return (await applicationsFor(kind, [documentId])).length > 0;
}

/** Marks the document paid once its applications add up, and remembers the latest payment. */
export async function refreshDocument(kind: DocumentKind, documentId: string): Promise<void> {
  const sql = getSql();
  const rows = await applicationsFor(kind, [documentId]);
  const paid = rows.reduce((sum, row) => sum + cents(row.amount), 0);
  const latest = rows.at(-1)?.payment_transaction_id ?? null;
  if (kind === "invoice") {
    await sql`update invoices set status = case when status = 'DRAFT' then status when ${paid} >= round(amount * 100) then 'PAID' else 'OPEN' end,
      payment_transaction_id = ${latest}, updated_at = now() where id = ${documentId}`;
  } else {
    await sql`update bills set status = case when status = 'DRAFT' then status when ${paid} >= round(amount * 100) then 'PAID' else 'OPEN' end,
      payment_transaction_id = ${latest}, updated_at = now() where id = ${documentId}`;
  }
}

type DocumentRow = { ledger_id: string; amount: string; status: string; contact_name: string };

async function findDocument(context: Context, kind: DocumentKind, documentId: string): Promise<DocumentRow> {
  const tenantId = getTenantId(context);
  const sql = getSql();
  const rows =
    kind === "invoice"
      ? await sql`select d.ledger_id, d.amount, d.status, c.name as contact_name from invoices d join ledgers l on l.id = d.ledger_id
          join customers c on c.id = d.customer_id where d.id = ${documentId} and l.tenant_id = ${tenantId} limit 1`
      : await sql`select d.ledger_id, d.amount, d.status, v.name as contact_name from bills d join ledgers l on l.id = d.ledger_id
          join vendors v on v.id = d.vendor_id where d.id = ${documentId} and l.tenant_id = ${tenantId} limit 1`;
  if (rows.length === 0) throw new NotFoundError(`No ${KINDS[kind].label} '${documentId}' for this company`);
  return rows[0] as DocumentRow;
}

export async function openBalanceCents(kind: DocumentKind, documentId: string, amount: number | string): Promise<number> {
  const rows = await applicationsFor(kind, [documentId]);
  return cents(amount) - rows.reduce((sum, row) => sum + cents(row.amount), 0);
}

async function record(kind: DocumentKind, documentId: string, ledgerId: string, transactionId: string, amount: number): Promise<void> {
  const sql = getSql();
  await sql`insert into payment_applications (ledger_id, invoice_id, bill_id, payment_transaction_id, amount)
    values (${ledgerId}, ${kind === "invoice" ? documentId : null}, ${kind === "bill" ? documentId : null}, ${transactionId}, ${amount})`;
  await refreshDocument(kind, documentId);
}

/** For the pay routes, which have just posted the payment themselves. */
export async function recordNewPayment(context: Context, kind: DocumentKind, documentId: string, transactionId: string, amount: number): Promise<void> {
  const document = await findDocument(context, kind, documentId);
  await record(kind, documentId, document.ledger_id, transactionId, amount);
}

/**
 * Applies money from an existing payment transaction to an open invoice or bill.
 * Posts nothing: the payment already moved receivables or payables. Used for
 * partial payments, one payment over several documents, and unapplied credits.
 */
export async function applyPayment(
  context: Context,
  kind: DocumentKind,
  documentId: string,
  input: { paymentTransactionId: string; amount: number }
): Promise<void> {
  const rules = KINDS[kind];
  const document = await findDocument(context, kind, documentId);
  if (document.status !== "OPEN") throw new ConflictError(`This ${rules.label} is ${document.status.toLowerCase()}, not open`);
  const open = await openBalanceCents(kind, documentId, document.amount);
  if (cents(input.amount) > open) throw new ValidationError(`That's more than the ${rules.label}'s open balance of ${(open / 100).toFixed(2)}.`);

  const { accountService, transactionService } = getServices(context);
  const payment = await transactionService.getTransactionById(input.paymentTransactionId);
  if (payment.type !== rules.paymentType || payment.status !== "POSTED" || payment.reversedAt) {
    throw new ValidationError(`That transaction isn't a posted payment for a ${rules.label}.`);
  }
  if (payment.payee !== document.contact_name) {
    throw new ValidationError(`That payment belongs to a different ${kind === "invoice" ? "customer" : "vendor"}.`);
  }
  const accounts = new Set((await accountService.listAccounts()).filter((account) => account.category === rules.category).map((account) => account.id));
  const total = payment.postings.filter((p) => p.type === rules.side && accounts.has(p.accountId)).reduce((sum, p) => sum + cents(p.amount), 0);
  const used = (await getSql()`select coalesce(sum(amount), 0) as used from payment_applications
    where payment_transaction_id = ${payment.id} and ledger_id = ${document.ledger_id}`) as { used: string }[];
  const left = total - cents(used[0]!.used);
  if (cents(input.amount) > left) throw new ValidationError(`That payment only has ${(left / 100).toFixed(2)} left to apply.`);

  await record(kind, documentId, document.ledger_id, payment.id, input.amount);
}
