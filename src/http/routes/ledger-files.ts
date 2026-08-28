import { createRoute, z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { getLedgerName, getTenantId, getUserId } from "@/http/context";
import { errorResponseSchema } from "@/domain/models";
import { isPlausibleBeancountDocument, parseBeancount, serializeBeancount } from "@/infra/beancount/parser";
import { getSql } from "@/infra/postgres/client";
import { sha256 } from "@/shared/utils/hash";

const fileIdParam = zod.object({ fileId: zod.string().uuid() });
const fileVersionParam = zod.object({
  fileId: zod.string().uuid(),
  version: zod.coerce.number().int().positive()
});

const ledgerFileSchema = zod.object({
  id: zod.string().uuid(),
  name: zod.string(),
  label: zod.string().optional(),
  version: zod.number().int(),
  contentHash: zod.string(),
  updatedAt: zod.string()
});

const createLedgerFileInputSchema = zod.object({
  name: zod.string().trim().min(1).max(100),
  label: zod.string().trim().min(1).max(200).optional(),
  content: zod.string().min(1)
});

const updateLedgerFileInputSchema = zod.object({
  label: zod.string().trim().min(1).max(200).nullable()
});

const ledgerFileSummarySchema = zod.object({
  id: zod.string().uuid(),
  name: zod.string(),
  label: zod.string().optional(),
  version: zod.number().int(),
  contentHash: zod.string(),
  transactionCount: zod.number().int(),
  accountCount: zod.number().int()
});

const ledgerFileVersionSchema = zod.object({
  version: zod.number().int(),
  contentHash: zod.string(),
  source: zod.enum(["upload", "bootstrap", "restore"]),
  createdBy: zod.string().uuid().nullable(),
  createdAt: zod.string()
});

const listLedgerFilesRoute = createRoute({
  method: "get",
  path: "/api/ledger-files",
  responses: {
    200: {
      content: { "application/json": { schema: zod.array(ledgerFileSchema) } },
      description: "Every extra .bean file scoped to the caller's currently active company"
    }
  }
});

const createLedgerFileRoute = createRoute({
  method: "post",
  path: "/api/ledger-files",
  request: {
    body: { content: { "application/json": { schema: createLedgerFileInputSchema } }, required: true }
  },
  responses: {
    200: { content: { "application/json": { schema: ledgerFileSchema } }, description: "The newly created file" },
    400: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "Content that doesn't parse as valid Beancount"
    },
    404: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "No active company for this request"
    },
    409: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "A file with that name already exists for the active company"
    }
  }
});

const updateLedgerFileRoute = createRoute({
  method: "patch",
  path: "/api/ledger-files/{fileId}",
  request: { params: fileIdParam, body: { content: { "application/json": { schema: updateLedgerFileInputSchema } }, required: true } },
  responses: {
    200: { content: { "application/json": { schema: ledgerFileSchema } }, description: "The updated file" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No such file for this tenant" }
  }
});

const deleteLedgerFileRoute = createRoute({
  method: "delete",
  path: "/api/ledger-files/{fileId}",
  request: { params: fileIdParam },
  responses: {
    204: { description: "File deleted" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No such file for this tenant" }
  }
});

const downloadLedgerFileRoute = createRoute({
  method: "get",
  path: "/api/ledger-files/{fileId}/download",
  request: { params: fileIdParam },
  responses: {
    200: { content: { "text/plain": { schema: zod.string() } }, description: "Raw .bean content" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No such file for this tenant" }
  }
});

const uploadLedgerFileRoute = createRoute({
  method: "post",
  path: "/api/ledger-files/{fileId}/upload",
  request: {
    params: fileIdParam,
    body: { content: { "text/plain": { schema: zod.string() } }, required: true }
  },
  responses: {
    200: { content: { "application/json": { schema: ledgerFileSummarySchema } }, description: "File replaced with the uploaded content" },
    400: { content: { "application/json": { schema: errorResponseSchema } }, description: "Content that doesn't parse as valid Beancount -- nothing was persisted" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No such file for this tenant" }
  }
});

const listLedgerFileVersionsRoute = createRoute({
  method: "get",
  path: "/api/ledger-files/{fileId}/versions",
  request: { params: fileIdParam },
  responses: {
    200: { content: { "application/json": { schema: zod.array(ledgerFileVersionSchema) } }, description: "Version history, most recent first" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No such file for this tenant" }
  }
});

const restoreLedgerFileVersionRoute = createRoute({
  method: "post",
  path: "/api/ledger-files/{fileId}/versions/{version}/restore",
  request: { params: fileVersionParam },
  responses: {
    200: { content: { "application/json": { schema: ledgerFileSummarySchema } }, description: "File content replaced with the given version's content, recorded as a new version" },
    400: { content: { "application/json": { schema: errorResponseSchema } }, description: "The stored version no longer parses -- nothing was persisted" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No such file or version for this tenant" }
  }
});

function validateBeancount(raw: string): { normalized: string; transactionCount: number; accountCount: number } {
  const parsed = parseBeancount(raw);
  if (!isPlausibleBeancountDocument(raw, parsed)) {
    throw new Error('does not look like a Beancount ledger (missing option "title" directive)');
  }
  return {
    normalized: serializeBeancount(parsed),
    transactionCount: parsed.transactions.length,
    accountCount: parsed.opens.length
  };
}

/**
 * Extra .bean files scoped to one company (ledger row) -- separate from
 * that company's own primary content (ledgers.content, still what
 * register/reports/accounts read; unaffected by anything here). The list
 * endpoint is deliberately scoped to the caller's CURRENTLY ACTIVE company
 * only (not every company the tenant has) -- the Ledger settings page
 * shows "files for the company selected in the header," not a
 * cross-company list. Every other endpoint operates by fileId directly, so
 * it works regardless of which company happens to be active in that
 * request (matches how ledgers.ts's by-name endpoints already behave).
 */
export function ledgerFileRoutes(app: OpenAPIHono): void {
  app.openapi(listLedgerFilesRoute, async (context) => {
    const tenantId = getTenantId(context);
    const ledgerName = getLedgerName(context);
    const sql = getSql();

    const rows = await sql`
      select f.id, f.name, f.label, f.version, f.content_hash, f.updated_at
      from ledger_files f
      join ledgers l on l.id = f.ledger_id
      where l.tenant_id = ${tenantId} and l.name = ${ledgerName}
      order by f.created_at asc
    `;

    return context.json(
      rows.map((row: unknown) => {
        const typed = row as { id: string; name: string; label: string | null; version: number; content_hash: string; updated_at: Date };
        return {
          id: typed.id,
          name: typed.name,
          label: typed.label ?? undefined,
          version: typed.version,
          contentHash: typed.content_hash,
          updatedAt: typed.updated_at.toISOString()
        };
      }),
      200
    );
  });

  app.openapi(createLedgerFileRoute, async (context) => {
    const tenantId = getTenantId(context);
    const userId = getUserId(context);
    const ledgerName = getLedgerName(context);
    const { name, label, content } = context.req.valid("json");
    const sql = getSql();

    const ledgerRows = await sql`
      select id from ledgers where tenant_id = ${tenantId} and name = ${ledgerName} limit 1
    `;
    if (ledgerRows.length === 0) {
      return context.json({ error: "No active company for this request" }, 404);
    }
    const ledgerId = (ledgerRows[0] as { id: string }).id;

    let normalized: string;
    try {
      normalized = validateBeancount(content).normalized;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not parse this file";
      return context.json({ error: `Invalid Beancount file: ${message}` }, 400);
    }

    const existing = await sql`
      select id from ledger_files where ledger_id = ${ledgerId} and name = ${name} limit 1
    `;
    if (existing.length > 0) {
      return context.json({ error: `A file named '${name}' already exists for this company` }, 409);
    }

    const hash = await sha256(normalized);

    const [file] = await sql.begin(async (tx) => {
      const [inserted] = await tx`
        insert into ledger_files (ledger_id, name, label, content, content_hash, version)
        values (${ledgerId}, ${name}, ${label ?? null}, ${normalized}, ${hash}, 1)
        returning id, name, label, version, content_hash, updated_at
      `;
      await tx`
        insert into ledger_file_versions (ledger_file_id, version, content, content_hash, source, created_by)
        values (${inserted.id}, 1, ${normalized}, ${hash}, 'bootstrap', ${userId})
      `;
      return [inserted];
    });

    const typed = file as { id: string; name: string; label: string | null; version: number; content_hash: string; updated_at: Date };
    return context.json(
      {
        id: typed.id,
        name: typed.name,
        label: typed.label ?? undefined,
        version: typed.version,
        contentHash: typed.content_hash,
        updatedAt: typed.updated_at.toISOString()
      },
      200
    );
  });

  app.openapi(updateLedgerFileRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { fileId } = context.req.valid("param");
    const { label } = context.req.valid("json");
    const sql = getSql();

    const rows = await sql`
      update ledger_files f set label = ${label}, updated_at = now()
      from ledgers l
      where f.ledger_id = l.id and l.tenant_id = ${tenantId} and f.id = ${fileId}
      returning f.id, f.name, f.label, f.version, f.content_hash, f.updated_at
    `;
    if (rows.length === 0) {
      return context.json({ error: `No file '${fileId}' for this tenant` }, 404);
    }
    const typed = rows[0] as { id: string; name: string; label: string | null; version: number; content_hash: string; updated_at: Date };

    return context.json(
      {
        id: typed.id,
        name: typed.name,
        label: typed.label ?? undefined,
        version: typed.version,
        contentHash: typed.content_hash,
        updatedAt: typed.updated_at.toISOString()
      },
      200
    );
  });

  app.openapi(deleteLedgerFileRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { fileId } = context.req.valid("param");
    const sql = getSql();

    const rows = await sql`
      delete from ledger_files f
      using ledgers l
      where f.ledger_id = l.id and l.tenant_id = ${tenantId} and f.id = ${fileId}
      returning f.id
    `;
    if (rows.length === 0) {
      return context.json({ error: `No file '${fileId}' for this tenant` }, 404);
    }

    return context.body(null, 204);
  });

  app.openapi(downloadLedgerFileRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { fileId } = context.req.valid("param");
    const sql = getSql();

    const rows = await sql`
      select f.name, f.content
      from ledger_files f
      join ledgers l on l.id = f.ledger_id
      where l.tenant_id = ${tenantId} and f.id = ${fileId}
      limit 1
    `;
    if (rows.length === 0) {
      return context.json({ error: `No file '${fileId}' for this tenant` }, 404);
    }
    const { name, content } = rows[0] as { name: string; content: string };

    return context.text(content, 200, { "Content-Disposition": `attachment; filename="${name}.bean"` });
  });

  app.openapi(uploadLedgerFileRoute, async (context) => {
    const tenantId = getTenantId(context);
    const userId = getUserId(context);
    const { fileId } = context.req.valid("param");
    const sql = getSql();
    const raw = await context.req.text();

    let normalized: string;
    let transactionCount: number;
    let accountCount: number;
    try {
      const result = validateBeancount(raw);
      normalized = result.normalized;
      transactionCount = result.transactionCount;
      accountCount = result.accountCount;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not parse the uploaded file";
      return context.json({ error: `Invalid Beancount file: ${message}` }, 400);
    }

    const existing = await sql`
      select f.id, f.name, f.label, f.version
      from ledger_files f
      join ledgers l on l.id = f.ledger_id
      where l.tenant_id = ${tenantId} and f.id = ${fileId}
      limit 1
    `;
    if (existing.length === 0) {
      return context.json({ error: `No file '${fileId}' for this tenant` }, 404);
    }
    const file = existing[0] as { id: string; name: string; label: string | null; version: number };
    const nextVersion = file.version + 1;
    const hash = await sha256(normalized);

    await sql.begin(async (tx) => {
      await tx`select id from ledger_files where id = ${file.id} for update`;
      await tx`
        update ledger_files set content = ${normalized}, content_hash = ${hash}, version = ${nextVersion}, updated_at = now()
        where id = ${file.id}
      `;
      await tx`
        insert into ledger_file_versions (ledger_file_id, version, content, content_hash, source, created_by)
        values (${file.id}, ${nextVersion}, ${normalized}, ${hash}, 'upload', ${userId})
      `;
    });

    return context.json(
      {
        id: file.id,
        name: file.name,
        label: file.label ?? undefined,
        version: nextVersion,
        contentHash: hash,
        transactionCount,
        accountCount
      },
      200
    );
  });

  app.openapi(listLedgerFileVersionsRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { fileId } = context.req.valid("param");
    const sql = getSql();

    const fileRows = await sql`
      select f.id from ledger_files f
      join ledgers l on l.id = f.ledger_id
      where l.tenant_id = ${tenantId} and f.id = ${fileId}
      limit 1
    `;
    if (fileRows.length === 0) {
      return context.json({ error: `No file '${fileId}' for this tenant` }, 404);
    }

    const rows = await sql`
      select version, content_hash, source, created_by, created_at
      from ledger_file_versions
      where ledger_file_id = ${fileId}
      order by version desc
    `;

    return context.json(
      rows.map((row: unknown) => {
        const typed = row as {
          version: number;
          content_hash: string;
          source: "upload" | "bootstrap" | "restore";
          created_by: string | null;
          created_at: Date;
        };
        return {
          version: typed.version,
          contentHash: typed.content_hash,
          source: typed.source,
          createdBy: typed.created_by,
          createdAt: typed.created_at.toISOString()
        };
      }),
      200
    );
  });

  app.openapi(restoreLedgerFileVersionRoute, async (context) => {
    const tenantId = getTenantId(context);
    const userId = getUserId(context);
    const { fileId, version } = context.req.valid("param");
    const sql = getSql();

    const fileRows = await sql`
      select f.id, f.name, f.label, f.version
      from ledger_files f
      join ledgers l on l.id = f.ledger_id
      where l.tenant_id = ${tenantId} and f.id = ${fileId}
      limit 1
    `;
    if (fileRows.length === 0) {
      return context.json({ error: `No file '${fileId}' for this tenant` }, 404);
    }
    const file = fileRows[0] as { id: string; name: string; label: string | null; version: number };

    const target = await sql`
      select content from ledger_file_versions where ledger_file_id = ${file.id} and version = ${version} limit 1
    `;
    if (target.length === 0) {
      return context.json({ error: `No version ${version} for file '${fileId}'` }, 404);
    }
    const { content } = target[0] as { content: string };

    let normalized: string;
    let transactionCount: number;
    let accountCount: number;
    try {
      const result = validateBeancount(content);
      normalized = result.normalized;
      transactionCount = result.transactionCount;
      accountCount = result.accountCount;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not parse the stored version";
      return context.json({ error: `Stored version does not parse: ${message}` }, 400);
    }

    const hash = await sha256(normalized);
    const nextVersion = file.version + 1;

    await sql.begin(async (tx) => {
      await tx`select id from ledger_files where id = ${file.id} for update`;
      await tx`
        update ledger_files set content = ${normalized}, content_hash = ${hash}, version = ${nextVersion}, updated_at = now()
        where id = ${file.id}
      `;
      await tx`
        insert into ledger_file_versions (ledger_file_id, version, content, content_hash, source, created_by)
        values (${file.id}, ${nextVersion}, ${normalized}, ${hash}, 'restore', ${userId})
      `;
    });

    return context.json(
      {
        id: file.id,
        name: file.name,
        label: file.label ?? undefined,
        version: nextVersion,
        contentHash: hash,
        transactionCount,
        accountCount
      },
      200
    );
  });
}
