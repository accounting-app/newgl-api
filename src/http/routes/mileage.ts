import { createRoute, z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { getLedgerName, getTenantId } from "@/http/context";
import { errorResponseSchema } from "@/domain/models";
import { getSql } from "@/infra/postgres/client";

const entryIdParam = zod.object({ entryId: zod.string().uuid() });

const mileageEntrySchema = zod.object({
  id: zod.string().uuid(),
  date: zod.string(),
  miles: zod.number(),
  ratePerMile: zod.number(),
  type: zod.enum(["BUSINESS", "PERSONAL"]),
  startAddress: zod.string().optional(),
  endAddress: zod.string().optional(),
  purpose: zod.string().optional(),
  createdAt: zod.string()
});

const createMileageEntryInputSchema = zod.object({
  date: zod.string().min(1),
  miles: zod.number().positive(),
  ratePerMile: zod.number().min(0),
  type: zod.enum(["BUSINESS", "PERSONAL"]),
  startAddress: zod.string().trim().min(1).max(500).optional(),
  endAddress: zod.string().trim().min(1).max(500).optional(),
  purpose: zod.string().trim().min(1).max(500).optional()
});

type MileageEntryRow = {
  id: string;
  date: Date;
  miles: string;
  rate_per_mile: string;
  type: "BUSINESS" | "PERSONAL";
  start_address: string | null;
  end_address: string | null;
  purpose: string | null;
  created_at: Date;
};

function serialize(row: MileageEntryRow) {
  return {
    id: row.id,
    // Postgres `date` columns come back from bun's SQL client as a
    // midnight-UTC Date -- always render just the date portion, not a
    // timezone-dependent full ISO timestamp.
    date: row.date.toISOString().slice(0, 10),
    miles: Number(row.miles),
    ratePerMile: Number(row.rate_per_mile),
    type: row.type,
    startAddress: row.start_address ?? undefined,
    endAddress: row.end_address ?? undefined,
    purpose: row.purpose ?? undefined,
    createdAt: row.created_at.toISOString()
  };
}

const listMileageEntriesRoute = createRoute({
  method: "get",
  path: "/api/mileage-entries",
  responses: {
    200: {
      content: { "application/json": { schema: zod.array(mileageEntrySchema) } },
      description: "Every mileage entry for the caller's currently active company"
    }
  }
});

const createMileageEntryRoute = createRoute({
  method: "post",
  path: "/api/mileage-entries",
  request: { body: { content: { "application/json": { schema: createMileageEntryInputSchema } }, required: true } },
  responses: {
    200: { content: { "application/json": { schema: mileageEntrySchema } }, description: "The newly created entry" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No active company for this request" }
  }
});

const deleteMileageEntryRoute = createRoute({
  method: "delete",
  path: "/api/mileage-entries/{entryId}",
  request: { params: entryIdParam },
  responses: {
    204: { description: "Entry deleted" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No such entry for this company" }
  }
});

/**
 * Mileage trip log, scoped to the caller's CURRENTLY ACTIVE company only --
 * same scoping rule as vendors.ts. No update endpoint -- the UI only ever
 * adds or deletes an entry (round-trip logging creates two entries), never
 * edits one in place.
 */
export function mileageRoutes(app: OpenAPIHono): void {
  app.openapi(listMileageEntriesRoute, async (context) => {
    const tenantId = getTenantId(context);
    const ledgerName = getLedgerName(context);
    const sql = getSql();

    const rows = await sql`
      select m.id, m.date, m.miles, m.rate_per_mile, m.type, m.start_address, m.end_address, m.purpose, m.created_at
      from mileage_entries m
      join ledgers l on l.id = m.ledger_id
      where l.tenant_id = ${tenantId} and l.name = ${ledgerName}
      order by m.date desc, m.created_at desc
    `;

    return context.json(rows.map((row: unknown) => serialize(row as MileageEntryRow)), 200);
  });

  app.openapi(createMileageEntryRoute, async (context) => {
    const tenantId = getTenantId(context);
    const ledgerName = getLedgerName(context);
    const input = context.req.valid("json");
    const sql = getSql();

    const ledgerRows = await sql`
      select id from ledgers where tenant_id = ${tenantId} and name = ${ledgerName} limit 1
    `;
    if (ledgerRows.length === 0) {
      return context.json({ error: "No active company for this request" }, 404);
    }
    const ledgerId = (ledgerRows[0] as { id: string }).id;

    const [inserted] = await sql`
      insert into mileage_entries (ledger_id, date, miles, rate_per_mile, type, start_address, end_address, purpose)
      values (
        ${ledgerId}, ${input.date}, ${input.miles}, ${input.ratePerMile}, ${input.type},
        ${input.startAddress ?? null}, ${input.endAddress ?? null}, ${input.purpose ?? null}
      )
      returning id, date, miles, rate_per_mile, type, start_address, end_address, purpose, created_at
    `;

    return context.json(serialize(inserted as MileageEntryRow), 200);
  });

  app.openapi(deleteMileageEntryRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { entryId } = context.req.valid("param");
    const sql = getSql();

    const rows = await sql`
      delete from mileage_entries m
      using ledgers l
      where m.ledger_id = l.id and l.tenant_id = ${tenantId} and m.id = ${entryId}
      returning m.id
    `;
    if (rows.length === 0) {
      return context.json({ error: `No mileage entry '${entryId}' for this company` }, 404);
    }

    return context.body(null, 204);
  });
}
