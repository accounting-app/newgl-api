import { createRoute, z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { getTenantId, getUserId } from "@/http/context";
import { errorResponseSchema } from "@/domain/models";
import { isPlausibleBeancountDocument, parseBeancount, serializeBeancount } from "@/infra/beancount/parser";
import { getSql } from "@/infra/postgres/client";
import { sha256 } from "@/shared/utils/hash";

const ledgerNameParam = zod.object({ name: zod.string().min(1) });
const ledgerVersionParam = zod.object({
  name: zod.string().min(1),
  version: zod.coerce.number().int().positive()
});

const ledgerSummarySchema = zod.object({
  name: zod.string(),
  version: zod.number().int(),
  contentHash: zod.string(),
  transactionCount: zod.number().int(),
  accountCount: zod.number().int()
});

const ledgerVersionSummarySchema = zod.object({
  version: zod.number().int(),
  contentHash: zod.string(),
  source: zod.enum(["app", "upload", "bootstrap", "restore"]),
  createdBy: zod.string().uuid().nullable(),
  createdAt: zod.string()
});

const ledgerDownloadRoute = createRoute({
  method: "get",
  path: "/api/ledgers/{name}/download",
  request: { params: ledgerNameParam },
  responses: {
    200: {
      content: { "text/plain": { schema: zod.string() } },
      description: "Raw .bean content"
    },
    404: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "No ledger with that name for this tenant"
    }
  }
});

const ledgerUploadRoute = createRoute({
  method: "post",
  path: "/api/ledgers/{name}/upload",
  request: {
    params: ledgerNameParam,
    body: {
      content: { "text/plain": { schema: zod.string() } },
      required: true
    }
  },
  responses: {
    200: {
      content: { "application/json": { schema: ledgerSummarySchema } },
      description: "Ledger replaced with the uploaded content"
    },
    400: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "The uploaded file does not parse as valid Beancount -- nothing was persisted"
    },
    404: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "No ledger with that name for this tenant"
    }
  }
});

const ledgerVersionsRoute = createRoute({
  method: "get",
  path: "/api/ledgers/{name}/versions",
  request: { params: ledgerNameParam },
  responses: {
    200: {
      content: { "application/json": { schema: zod.array(ledgerVersionSummarySchema) } },
      description: "Version history, most recent first (metadata only -- no content)"
    },
    404: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "No ledger with that name for this tenant"
    }
  }
});

const ledgerRestoreRoute = createRoute({
  method: "post",
  path: "/api/ledgers/{name}/versions/{version}/restore",
  request: { params: ledgerVersionParam },
  responses: {
    200: {
      content: { "application/json": { schema: ledgerSummarySchema } },
      description: "Ledger content replaced with the given version's content, recorded as a new version"
    },
    400: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "The stored version no longer parses -- nothing was persisted"
    },
    404: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "No ledger with that name, or no such version, for this tenant"
    }
  }
});

/**
 * Tenant-scoped upload/download of raw .bean content, stored in Postgres
 * (see AI_INTEGRATION_PLAN.md Part 6). Upload REPLACES the named ledger's
 * content wholesale -- this is the "manage multiple .bean files, edit them
 * directly" workflow's v1: one file per name, replace-not-merge. Multiple
 * distinct ledgers per tenant already works (the `name` column), just not
 * exposed as a create-a-new-one flow yet.
 *
 * The one rule that must never be violated: PARSE AND VALIDATE BEFORE
 * PERSISTING. A malformed upload must never become the source of truth --
 * if it did, every subsequent request against that ledger would fail with
 * no way to recover except restoring a previous ledger_versions row by hand.
 */
export function ledgerRoutesV2(app: OpenAPIHono): void {
  app.openapi(ledgerDownloadRoute, async (context) => {
    const { name } = context.req.valid("param");
    const tenantId = getTenantId(context);
    const sql = getSql();

    const rows = await sql`
      select content from ledgers where tenant_id = ${tenantId} and name = ${name} limit 1
    `;
    if (rows.length === 0) {
      return context.json({ error: { message: `No ledger named '${name}'` } }, 404);
    }

    const { content } = rows[0] as { content: string };
    return context.body(content, 200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}.bean"`
    });
  });

  app.openapi(ledgerUploadRoute, async (context) => {
    const { name } = context.req.valid("param");
    const tenantId = getTenantId(context);
    const userId = getUserId(context);
    const sql = getSql();

    const raw = await context.req.text();

    // Validate BEFORE touching the database. parseBeancount throws on
    // malformed input; re-serializing normalizes formatting so the stored
    // content always matches what the rest of the app would produce itself.
    let normalized: string;
    let transactionCount: number;
    let accountCount: number;
    try {
      const parsed = parseBeancount(raw);
      if (!isPlausibleBeancountDocument(raw, parsed)) {
        throw new Error('does not look like a Beancount ledger (missing option "title" directive)');
      }
      normalized = serializeBeancount(parsed);
      transactionCount = parsed.transactions.length;
      accountCount = parsed.opens.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not parse the uploaded file";
      return context.json({ error: { message: `Invalid Beancount file: ${message}` } }, 400);
    }

    const hash = await sha256(normalized);

    const existing = await sql`
      select id, version from ledgers where tenant_id = ${tenantId} and name = ${name} limit 1
    `;
    if (existing.length === 0) {
      return context.json({ error: { message: `No ledger named '${name}'` } }, 404);
    }
    const ledger = existing[0] as { id: string; version: number };
    const nextVersion = ledger.version + 1;

    await sql.begin(async (tx) => {
      await tx`select id from ledgers where id = ${ledger.id} for update`;
      await tx`
        update ledgers
        set content = ${normalized}, content_hash = ${hash}, version = ${nextVersion}, updated_at = now()
        where id = ${ledger.id}
      `;
      await tx`
        insert into ledger_versions (ledger_id, version, content, content_hash, source, created_by)
        values (${ledger.id}, ${nextVersion}, ${normalized}, ${hash}, 'upload', ${userId})
      `;
    });

    return context.json(
      { name, version: nextVersion, contentHash: hash, transactionCount, accountCount },
      200
    );
  });

  app.openapi(ledgerVersionsRoute, async (context) => {
    const { name } = context.req.valid("param");
    const tenantId = getTenantId(context);
    const sql = getSql();

    const ledger = await sql`
      select id from ledgers where tenant_id = ${tenantId} and name = ${name} limit 1
    `;
    if (ledger.length === 0) {
      return context.json({ error: { message: `No ledger named '${name}'` } }, 404);
    }
    const { id: ledgerId } = ledger[0] as { id: string };

    const rows = await sql`
      select version, content_hash, source, created_by, created_at
      from ledger_versions
      where ledger_id = ${ledgerId}
      order by version desc
    `;

    return context.json(
      rows.map((row) => {
        const typedRow = row as {
          version: number;
          content_hash: string;
          source: "app" | "upload" | "bootstrap" | "restore";
          created_by: string | null;
          created_at: Date;
        };
        return {
          version: typedRow.version,
          contentHash: typedRow.content_hash,
          source: typedRow.source,
          createdBy: typedRow.created_by,
          createdAt: typedRow.created_at.toISOString()
        };
      }),
      200
    );
  });

  // Restoring writes a brand-new version rather than rewinding in place, so
  // the history stays append-only -- "restore to v3" is itself an auditable
  // event, not a deletion of v4..vN (see migration 20260802220000).
  app.openapi(ledgerRestoreRoute, async (context) => {
    const { name, version } = context.req.valid("param");
    const tenantId = getTenantId(context);
    const userId = getUserId(context);
    const sql = getSql();

    const ledger = await sql`
      select id, version from ledgers where tenant_id = ${tenantId} and name = ${name} limit 1
    `;
    if (ledger.length === 0) {
      return context.json({ error: { message: `No ledger named '${name}'` } }, 404);
    }
    const current = ledger[0] as { id: string; version: number };

    const target = await sql`
      select content from ledger_versions where ledger_id = ${current.id} and version = ${version} limit 1
    `;
    if (target.length === 0) {
      return context.json({ error: { message: `No version ${version} for ledger '${name}'` } }, 404);
    }
    const { content } = target[0] as { content: string };

    // Re-validate even though this content was valid when first written --
    // guards against any future change to the parser's accepted grammar.
    let normalized: string;
    let transactionCount: number;
    let accountCount: number;
    try {
      const parsed = parseBeancount(content);
      if (!isPlausibleBeancountDocument(content, parsed)) {
        throw new Error('does not look like a Beancount ledger (missing option "title" directive)');
      }
      normalized = serializeBeancount(parsed);
      transactionCount = parsed.transactions.length;
      accountCount = parsed.opens.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not parse the stored version";
      return context.json({ error: { message: `Stored version does not parse: ${message}` } }, 400);
    }

    const hash = await sha256(normalized);
    const nextVersion = current.version + 1;

    await sql.begin(async (tx) => {
      await tx`select id from ledgers where id = ${current.id} for update`;
      await tx`
        update ledgers
        set content = ${normalized}, content_hash = ${hash}, version = ${nextVersion}, updated_at = now()
        where id = ${current.id}
      `;
      await tx`
        insert into ledger_versions (ledger_id, version, content, content_hash, source, created_by)
        values (${current.id}, ${nextVersion}, ${normalized}, ${hash}, 'restore', ${userId})
      `;
    });

    return context.json(
      { name, version: nextVersion, contentHash: hash, transactionCount, accountCount },
      200
    );
  });
}
