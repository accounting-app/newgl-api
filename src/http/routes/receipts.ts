import { createRoute, z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { getLedgerName, getTenantId } from "@/http/context";
import { errorResponseSchema } from "@/domain/models";
import { getSql } from "@/infra/postgres/client";
import { deleteReceiptObject, downloadReceiptObject, uploadReceiptObject } from "@/infra/supabase-storage/client";
import { createId } from "@/shared/utils/id";

const receiptIdParam = zod.object({ receiptId: zod.string().uuid() });

const receiptSchema = zod.object({
  id: zod.string().uuid(),
  fileName: zod.string(),
  fileSizeBytes: zod.number().int(),
  contentType: zod.string(),
  uploadedAt: zod.string(),
  vendorId: zod.string().uuid().optional(),
  paymentAccountId: zod.string().optional(),
  categoryAccountId: zod.string().optional(),
  amount: zod.number().optional(),
  taxAmount: zod.number().optional(),
  note: zod.string().optional(),
  linkedTransactionId: zod.string().optional()
});

// Every review field is optional at upload time -- QBO's own flow is
// "upload first, fill in the rest while reviewing" (see the Receipts
// screen's Unreviewed/Reviewed tabs), matching the plan doc's "manual
// upload, then optionally link" resolution.
const updateReceiptInputSchema = zod.object({
  vendorId: zod.string().uuid().nullable().optional(),
  paymentAccountId: zod.string().nullable().optional(),
  categoryAccountId: zod.string().nullable().optional(),
  amount: zod.number().nullable().optional(),
  taxAmount: zod.number().nullable().optional(),
  note: zod.string().nullable().optional(),
  linkedTransactionId: zod.string().nullable().optional()
});

type ReceiptRow = {
  id: string;
  storage_path: string;
  file_name: string;
  file_size_bytes: string;
  content_type: string;
  vendor_id: string | null;
  payment_account_id: string | null;
  category_account_id: string | null;
  amount: string | null;
  tax_amount: string | null;
  note: string | null;
  linked_transaction_id: string | null;
  uploaded_at: Date;
};

function serialize(row: ReceiptRow) {
  return {
    id: row.id,
    fileName: row.file_name,
    fileSizeBytes: Number(row.file_size_bytes),
    contentType: row.content_type,
    uploadedAt: row.uploaded_at.toISOString(),
    vendorId: row.vendor_id ?? undefined,
    paymentAccountId: row.payment_account_id ?? undefined,
    categoryAccountId: row.category_account_id ?? undefined,
    amount: row.amount != null ? Number(row.amount) : undefined,
    taxAmount: row.tax_amount != null ? Number(row.tax_amount) : undefined,
    note: row.note ?? undefined,
    linkedTransactionId: row.linked_transaction_id ?? undefined
  };
}

/** Alphanumeric/dot/dash/underscore only, and never empty -- keeps the storage path predictable regardless of what the browser sends as a filename. */
function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "receipt";
}

const MAX_RECEIPT_SIZE_BYTES = 20 * 1024 * 1024; // 20MB -- generous for a photographed/scanned receipt or PDF.

const listReceiptsRoute = createRoute({
  method: "get",
  path: "/api/receipts",
  responses: {
    200: { content: { "application/json": { schema: zod.array(receiptSchema) } }, description: "Every receipt for the caller's currently active company" }
  }
});

// No declared request body schema -- this is a multipart/form-data upload
// (a `file` field plus optional metadata fields), parsed manually via
// context.req.parseBody() in the handler rather than hono-openapi's zod
// body validation, which doesn't have a clean story for file fields.
const createReceiptRoute = createRoute({
  method: "post",
  path: "/api/receipts",
  responses: {
    200: { content: { "application/json": { schema: receiptSchema } }, description: "The newly uploaded receipt" },
    400: { content: { "application/json": { schema: errorResponseSchema } }, description: "No file field, an empty file, or the file exceeds the 20MB limit" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No active company for this request" }
  }
});

const updateReceiptRoute = createRoute({
  method: "patch",
  path: "/api/receipts/{receiptId}",
  request: { params: receiptIdParam, body: { content: { "application/json": { schema: updateReceiptInputSchema } }, required: true } },
  responses: {
    200: { content: { "application/json": { schema: receiptSchema } }, description: "The updated receipt" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No such receipt for this company" }
  }
});

const downloadReceiptFileRoute = createRoute({
  method: "get",
  path: "/api/receipts/{receiptId}/file",
  request: { params: receiptIdParam },
  responses: {
    200: { content: { "application/octet-stream": { schema: zod.string() } }, description: "The receipt's raw file bytes" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No such receipt for this company" }
  }
});

const deleteReceiptRoute = createRoute({
  method: "delete",
  path: "/api/receipts/{receiptId}",
  request: { params: receiptIdParam },
  responses: {
    204: { description: "Receipt deleted, its stored file removed" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No such receipt for this company" }
  }
});

/**
 * Receipts, scoped to the caller's CURRENTLY ACTIVE company only -- same
 * scoping rule as vendors.ts/mileage.ts/bills.ts. The one domain in Phase
 * 1.5 that stores an actual file: metadata lives here in Postgres, the
 * file bytes live in Supabase Storage's `receipts` bucket (see
 * @/infra/supabase-storage/client.ts). No OCR/auto-matching -- manual
 * upload, then optionally fill in the review fields, per the plan doc.
 */
export function receiptRoutes(app: OpenAPIHono): void {
  app.openapi(listReceiptsRoute, async (context) => {
    const tenantId = getTenantId(context);
    const ledgerName = getLedgerName(context);
    const sql = getSql();

    const rows = await sql`
      select r.id, r.storage_path, r.file_name, r.file_size_bytes, r.content_type, r.vendor_id,
             r.payment_account_id, r.category_account_id, r.amount, r.tax_amount, r.note,
             r.linked_transaction_id, r.uploaded_at
      from receipts r
      join ledgers l on l.id = r.ledger_id
      where l.tenant_id = ${tenantId} and l.name = ${ledgerName}
      order by r.uploaded_at desc
    `;

    return context.json(rows.map((row: unknown) => serialize(row as ReceiptRow)), 200);
  });

  app.openapi(createReceiptRoute, async (context) => {
    const tenantId = getTenantId(context);
    const ledgerName = getLedgerName(context);
    const sql = getSql();

    const body = await context.req.parseBody();
    const file = body.file;
    if (!(file instanceof File) || file.size === 0) {
      return context.json({ error: "A non-empty 'file' field is required" }, 400);
    }
    if (file.size > MAX_RECEIPT_SIZE_BYTES) {
      return context.json({ error: `File exceeds the ${MAX_RECEIPT_SIZE_BYTES / (1024 * 1024)}MB limit` }, 400);
    }
    const asOptionalString = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
    const asOptionalNumber = (value: unknown): number | undefined => {
      const str = asOptionalString(value);
      if (str === undefined) return undefined;
      const parsed = Number(str);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    const vendorId = asOptionalString(body.vendorId);
    const paymentAccountId = asOptionalString(body.paymentAccountId);
    const categoryAccountId = asOptionalString(body.categoryAccountId);
    const amount = asOptionalNumber(body.amount);
    const taxAmount = asOptionalNumber(body.taxAmount);
    const note = asOptionalString(body.note);
    const linkedTransactionId = asOptionalString(body.linkedTransactionId);

    const ledgerRows = await sql`
      select id from ledgers where tenant_id = ${tenantId} and name = ${ledgerName} limit 1
    `;
    if (ledgerRows.length === 0) {
      return context.json({ error: "No active company for this request" }, 404);
    }
    const ledgerId = (ledgerRows[0] as { id: string }).id;

    if (vendorId) {
      const vendorRows = await sql`select id from vendors where id = ${vendorId} and ledger_id = ${ledgerId} limit 1`;
      if (vendorRows.length === 0) {
        return context.json({ error: `No vendor '${vendorId}' for this company` }, 404);
      }
    }

    const id = createId();
    const storagePath = `${ledgerId}/${id}-${sanitizeFileName(file.name)}`;
    await uploadReceiptObject(storagePath, await file.arrayBuffer(), file.type || "application/octet-stream");

    const [inserted] = await sql`
      insert into receipts (
        id, ledger_id, storage_path, file_name, file_size_bytes, content_type,
        vendor_id, payment_account_id, category_account_id, amount, tax_amount, note, linked_transaction_id
      )
      values (
        ${id}, ${ledgerId}, ${storagePath}, ${file.name}, ${file.size}, ${file.type || "application/octet-stream"},
        ${vendorId ?? null}, ${paymentAccountId ?? null}, ${categoryAccountId ?? null},
        ${amount ?? null}, ${taxAmount ?? null}, ${note ?? null}, ${linkedTransactionId ?? null}
      )
      returning id, storage_path, file_name, file_size_bytes, content_type, vendor_id,
                payment_account_id, category_account_id, amount, tax_amount, note, linked_transaction_id, uploaded_at
    `;

    return context.json(serialize(inserted as ReceiptRow), 200);
  });

  app.openapi(updateReceiptRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { receiptId } = context.req.valid("param");
    const patch = context.req.valid("json");
    const sql = getSql();

    const existingRows = await sql`
      select r.id, r.storage_path, r.file_name, r.file_size_bytes, r.content_type, r.vendor_id,
             r.payment_account_id, r.category_account_id, r.amount, r.tax_amount, r.note,
             r.linked_transaction_id, r.uploaded_at
      from receipts r
      join ledgers l on l.id = r.ledger_id
      where l.tenant_id = ${tenantId} and r.id = ${receiptId}
      limit 1
    `;
    if (existingRows.length === 0) {
      return context.json({ error: `No receipt '${receiptId}' for this company` }, 404);
    }
    const current = existingRows[0] as ReceiptRow;

    const next = {
      vendorId: "vendorId" in patch ? patch.vendorId : current.vendor_id,
      paymentAccountId: "paymentAccountId" in patch ? patch.paymentAccountId : current.payment_account_id,
      categoryAccountId: "categoryAccountId" in patch ? patch.categoryAccountId : current.category_account_id,
      amount: "amount" in patch ? patch.amount : current.amount != null ? Number(current.amount) : null,
      taxAmount: "taxAmount" in patch ? patch.taxAmount : current.tax_amount != null ? Number(current.tax_amount) : null,
      note: "note" in patch ? patch.note : current.note,
      linkedTransactionId: "linkedTransactionId" in patch ? patch.linkedTransactionId : current.linked_transaction_id
    };

    const [updated] = await sql`
      update receipts set
        vendor_id = ${next.vendorId ?? null},
        payment_account_id = ${next.paymentAccountId ?? null},
        category_account_id = ${next.categoryAccountId ?? null},
        amount = ${next.amount ?? null},
        tax_amount = ${next.taxAmount ?? null},
        note = ${next.note ?? null},
        linked_transaction_id = ${next.linkedTransactionId ?? null}
      where id = ${receiptId}
      returning id, storage_path, file_name, file_size_bytes, content_type, vendor_id,
                payment_account_id, category_account_id, amount, tax_amount, note, linked_transaction_id, uploaded_at
    `;

    return context.json(serialize(updated as ReceiptRow), 200);
  });

  app.openapi(downloadReceiptFileRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { receiptId } = context.req.valid("param");
    const sql = getSql();

    const rows = await sql`
      select r.storage_path, r.file_name, r.content_type
      from receipts r
      join ledgers l on l.id = r.ledger_id
      where l.tenant_id = ${tenantId} and r.id = ${receiptId}
      limit 1
    `;
    if (rows.length === 0) {
      return context.json({ error: `No receipt '${receiptId}' for this company` }, 404);
    }
    const { storage_path, file_name, content_type } = rows[0] as { storage_path: string; file_name: string; content_type: string };

    const { content } = await downloadReceiptObject(storage_path);
    return context.body(content, 200, {
      "Content-Type": content_type,
      "Content-Disposition": `inline; filename="${file_name.replace(/"/g, "")}"`
    });
  });

  app.openapi(deleteReceiptRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { receiptId } = context.req.valid("param");
    const sql = getSql();

    const rows = await sql`
      delete from receipts r
      using ledgers l
      where r.ledger_id = l.id and l.tenant_id = ${tenantId} and r.id = ${receiptId}
      returning r.storage_path
    `;
    if (rows.length === 0) {
      return context.json({ error: `No receipt '${receiptId}' for this company` }, 404);
    }

    await deleteReceiptObject((rows[0] as { storage_path: string }).storage_path);
    return context.body(null, 204);
  });
}
