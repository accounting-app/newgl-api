import { createRoute, z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { getLedgerName, getTenantId, getUserEmail } from "@/http/context";
import { errorResponseSchema } from "@/domain/models";
import { getSql } from "@/infra/postgres/client";

const accountIdParam = zod.object({ accountId: zod.string().uuid() });

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

async function findLedgerId(sql: ReturnType<typeof getSql>, tenantId: string, ledgerName: string): Promise<string | null> {
  const rows = await sql`select id from ledgers where tenant_id = ${tenantId} and name = ${ledgerName} limit 1`;
  return rows.length > 0 ? (rows[0] as { id: string }).id : null;
}

// ---------------------------------------------------------------------------
// Drafts -- QBO's "Save for later" / "Resume reconciling"
// ---------------------------------------------------------------------------

const draftSchema = zod.object({
  statementStartDate: zod.string().min(1),
  statementEndingDate: zod.string().min(1),
  statementEndingBalance: zod.number(),
  serviceCharge: zod.object({ amount: zod.number().positive(), date: zod.string().min(1), expenseAccountId: zod.string().min(1) }).nullable(),
  interestEarned: zod.object({ amount: zod.number().positive(), date: zod.string().min(1), incomeAccountId: zod.string().min(1) }).nullable(),
  clearedTransactionIds: zod.array(zod.string()),
  updatedAt: zod.string()
});

const draftInputSchema = draftSchema.omit({ updatedAt: true });

type DraftRow = {
  statement_start_date: Date;
  statement_ending_date: Date;
  statement_ending_balance: string;
  service_charge: unknown;
  interest_earned: unknown;
  cleared_transaction_ids: unknown;
  updated_at: Date;
};

function serializeDraft(row: DraftRow) {
  return {
    statementStartDate: row.statement_start_date.toISOString().slice(0, 10),
    statementEndingDate: row.statement_ending_date.toISOString().slice(0, 10),
    statementEndingBalance: Number(row.statement_ending_balance),
    serviceCharge: (row.service_charge ?? null) as zod.infer<typeof draftSchema>["serviceCharge"],
    interestEarned: (row.interest_earned ?? null) as zod.infer<typeof draftSchema>["interestEarned"],
    clearedTransactionIds: (row.cleared_transaction_ids ?? []) as string[],
    updatedAt: row.updated_at.toISOString()
  };
}

const getDraftRoute = createRoute({
  method: "get",
  path: "/api/accounts/{accountId}/reconciliation-draft",
  request: { params: accountIdParam },
  responses: {
    200: { content: { "application/json": { schema: draftSchema.nullable() } }, description: "The saved in-progress reconciliation for this account, or null" }
  }
});

const putDraftRoute = createRoute({
  method: "put",
  path: "/api/accounts/{accountId}/reconciliation-draft",
  request: { params: accountIdParam, body: { content: { "application/json": { schema: draftInputSchema } }, required: true } },
  responses: {
    200: { content: { "application/json": { schema: draftSchema } }, description: "The draft, saved (replaces any earlier one for this account)" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No active company" }
  }
});

const deleteDraftRoute = createRoute({
  method: "delete",
  path: "/api/accounts/{accountId}/reconciliation-draft",
  request: { params: accountIdParam },
  responses: {
    200: { content: { "application/json": { schema: zod.object({ deleted: zod.boolean() }) } }, description: "Whether a draft existed and was discarded" }
  }
});

// ---------------------------------------------------------------------------
// Attachments -- the bank statement file on a finished reconciliation
// ---------------------------------------------------------------------------

const attachmentSchema = zod.object({
  id: zod.string().uuid(),
  reconciliationId: zod.string().uuid(),
  fileName: zod.string(),
  contentType: zod.string(),
  sizeBytes: zod.number(),
  createdAt: zod.string()
});

type AttachmentRow = {
  id: string;
  reconciliation_id: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  created_at: Date;
};

function serializeAttachment(row: AttachmentRow) {
  return {
    id: row.id,
    reconciliationId: row.reconciliation_id,
    fileName: row.file_name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at.toISOString()
  };
}

const listAttachmentsRoute = createRoute({
  method: "get",
  path: "/api/accounts/{accountId}/reconciliation-attachments",
  request: { params: accountIdParam },
  responses: {
    200: { content: { "application/json": { schema: zod.array(attachmentSchema) } }, description: "Statement files attached to this account's reconciliations" }
  }
});

export function reconciliationDraftRoutes(app: OpenAPIHono): void {
  app.openapi(getDraftRoute, async (context) => {
    const tenantId = getTenantId(context);
    const ledgerName = getLedgerName(context);
    const { accountId } = context.req.valid("param");
    const sql = getSql();
    const rows = await sql`
      select d.statement_start_date, d.statement_ending_date, d.statement_ending_balance, d.service_charge, d.interest_earned,
             d.cleared_transaction_ids, d.updated_at
      from reconciliation_drafts d
      join ledgers l on l.id = d.ledger_id
      where l.tenant_id = ${tenantId} and l.name = ${ledgerName} and d.account_id = ${accountId}
      limit 1
    `;
    return context.json(rows.length > 0 ? serializeDraft(rows[0] as DraftRow) : null, 200);
  });

  app.openapi(putDraftRoute, async (context) => {
    const tenantId = getTenantId(context);
    const ledgerName = getLedgerName(context);
    const { accountId } = context.req.valid("param");
    const input = context.req.valid("json");
    const sql = getSql();
    const ledgerId = await findLedgerId(sql, tenantId, ledgerName);
    if (!ledgerId) return context.json({ error: "No active company for this request" }, 404);

    const [row] = await sql`
      insert into reconciliation_drafts (
        ledger_id, account_id, statement_start_date, statement_ending_date, statement_ending_balance,
        service_charge, interest_earned, cleared_transaction_ids, saved_by
      ) values (
        ${ledgerId}, ${accountId}, ${input.statementStartDate}, ${input.statementEndingDate}, ${input.statementEndingBalance},
        ${input.serviceCharge ? JSON.stringify(input.serviceCharge) : null}::jsonb,
        ${input.interestEarned ? JSON.stringify(input.interestEarned) : null}::jsonb,
        ${JSON.stringify(input.clearedTransactionIds)}::jsonb,
        ${getUserEmail(context)}
      )
      on conflict (ledger_id, account_id) do update set
        statement_start_date = excluded.statement_start_date,
        statement_ending_date = excluded.statement_ending_date,
        statement_ending_balance = excluded.statement_ending_balance,
        service_charge = excluded.service_charge,
        interest_earned = excluded.interest_earned,
        cleared_transaction_ids = excluded.cleared_transaction_ids,
        saved_by = excluded.saved_by,
        updated_at = now()
      returning statement_start_date, statement_ending_date, statement_ending_balance, service_charge, interest_earned,
                cleared_transaction_ids, updated_at
    `;
    return context.json(serializeDraft(row as DraftRow), 200);
  });

  app.openapi(deleteDraftRoute, async (context) => {
    const tenantId = getTenantId(context);
    const ledgerName = getLedgerName(context);
    const { accountId } = context.req.valid("param");
    const sql = getSql();
    const ledgerId = await findLedgerId(sql, tenantId, ledgerName);
    if (!ledgerId) return context.json({ deleted: false }, 200);
    const deleted = await sql`delete from reconciliation_drafts where ledger_id = ${ledgerId} and account_id = ${accountId} returning id`;
    return context.json({ deleted: deleted.length > 0 }, 200);
  });

  app.openapi(listAttachmentsRoute, async (context) => {
    const tenantId = getTenantId(context);
    const ledgerName = getLedgerName(context);
    const { accountId } = context.req.valid("param");
    const sql = getSql();
    const rows = await sql`
      select a.id, a.reconciliation_id, a.file_name, a.content_type, a.size_bytes, a.created_at
      from reconciliation_attachments a
      join reconciliations r on r.id = a.reconciliation_id
      join ledgers l on l.id = r.ledger_id
      where l.tenant_id = ${tenantId} and l.name = ${ledgerName} and r.account_id = ${accountId}
      order by a.created_at
    `;
    return context.json((rows as AttachmentRow[]).map(serializeAttachment), 200);
  });

  // Binary upload/download don't fit the JSON-only openapi route helpers, so
  // these are plain routes. Everything is still tenant/company scoped.
  app.post("/api/reconciliations/:reconciliationId/attachments", async (context) => {
    const tenantId = getTenantId(context);
    const ledgerName = getLedgerName(context);
    const reconciliationId = context.req.param("reconciliationId");
    const sql = getSql();

    const owned = await sql`
      select r.id from reconciliations r join ledgers l on l.id = r.ledger_id
      where l.tenant_id = ${tenantId} and l.name = ${ledgerName} and r.id = ${reconciliationId} limit 1
    `;
    if (owned.length === 0) return context.json({ error: "No such reconciliation for this company" }, 404);

    const body = await context.req.parseBody();
    const file = body["file"];
    if (!(file instanceof File)) return context.json({ error: "Attach a file in the 'file' field." }, 400);
    if (file.size === 0) return context.json({ error: "That file is empty." }, 400);
    if (file.size > MAX_ATTACHMENT_BYTES) return context.json({ error: "Files can be at most 10 MB." }, 400);

    const bytes = new Uint8Array(await file.arrayBuffer());
    const [row] = await sql`
      insert into reconciliation_attachments (reconciliation_id, file_name, content_type, size_bytes, content, created_by)
      values (${reconciliationId}, ${file.name}, ${file.type || "application/octet-stream"}, ${file.size}, ${bytes}, ${getUserEmail(context)})
      returning id, reconciliation_id, file_name, content_type, size_bytes, created_at
    `;
    return context.json(serializeAttachment(row as AttachmentRow), 201);
  });

  app.get("/api/reconciliation-attachments/:attachmentId", async (context) => {
    const tenantId = getTenantId(context);
    const ledgerName = getLedgerName(context);
    const sql = getSql();
    const rows = await sql`
      select a.file_name, a.content_type, a.content
      from reconciliation_attachments a
      join reconciliations r on r.id = a.reconciliation_id
      join ledgers l on l.id = r.ledger_id
      where l.tenant_id = ${tenantId} and l.name = ${ledgerName} and a.id = ${context.req.param("attachmentId")}
      limit 1
    `;
    if (rows.length === 0) return context.json({ error: "No such attachment for this company" }, 404);
    const row = rows[0] as { file_name: string; content_type: string; content: Uint8Array };
    return new Response(new Blob([new Uint8Array(row.content)], { type: row.content_type }), {
      headers: {
        "Content-Type": row.content_type,
        "Content-Disposition": `attachment; filename="${row.file_name.replace(/"/g, "")}"`
      }
    });
  });

  app.delete("/api/reconciliation-attachments/:attachmentId", async (context) => {
    const tenantId = getTenantId(context);
    const ledgerName = getLedgerName(context);
    const sql = getSql();
    const removed = await sql`
      delete from reconciliation_attachments a
      using reconciliations r, ledgers l
      where r.id = a.reconciliation_id and l.id = r.ledger_id
        and l.tenant_id = ${tenantId} and l.name = ${ledgerName} and a.id = ${context.req.param("attachmentId")}
      returning a.id
    `;
    return context.json({ deleted: removed.length > 0 }, removed.length > 0 ? 200 : 404);
  });
}
