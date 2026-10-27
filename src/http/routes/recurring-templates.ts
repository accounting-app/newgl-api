import { createRoute, z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { getLedgerName, getServices, getTenantId } from "@/http/context";
import { errorResponseSchema } from "@/domain/models";
import { getSql } from "@/infra/postgres/client";
import { addDays, firstOccurrence, isPastEnd, nextOccurrence } from "@/shared/utils/recurrence";
import type { Recurrence, RecurrenceEnd } from "@/shared/utils/recurrence";

const templateIdParam = zod.object({ templateId: zod.string().uuid() });
const dateString = zod.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const kindSchema = zod.enum(["EXPENSE", "CHECK", "DEPOSIT", "SALES_RECEIPT", "JOURNAL_ENTRY"]);
const modeSchema = zod.enum(["SCHEDULED", "REMINDER", "UNSCHEDULED"]);

// What the ledger needs to post one occurrence: createTransaction's input
// minus the date (the schedule supplies that).
const payloadSchema = zod.object({
  referenceNumber: zod.string().optional(),
  memo: zod.string().optional(),
  payee: zod.string().optional(),
  accountLabel: zod.string().optional(),
  sourceAccountId: zod.string().optional(),
  postings: zod.array(zod.object({ accountId: zod.string().min(1), type: zod.enum(["DEBIT", "CREDIT"]), amount: zod.number().positive() })).min(2)
});

const scheduleSchema = zod.object({
  unit: zod.enum(["DAY", "WEEK", "MONTH", "YEAR"]),
  every: zod.number().int().min(1).max(999),
  onDay: zod.number().int().min(-1).max(31).optional(),
  onWeekday: zod.number().int().min(0).max(6).optional(),
  onMonth: zod.number().int().min(1).max(12).optional(),
  startDate: dateString,
  endType: zod.enum(["NONE", "BY", "AFTER"]),
  endDate: dateString.optional(),
  endAfter: zod.number().int().min(1).optional()
});

const templateSchema = zod.object({
  id: zod.string().uuid(),
  name: zod.string(),
  kind: kindSchema,
  mode: modeSchema,
  daysInAdvance: zod.number().int(),
  schedule: scheduleSchema.optional(),
  occurrences: zod.number().int(),
  nextDate: dateString.optional(),
  lastRun: dateString.optional(),
  lastError: zod.string().optional(),
  enabled: zod.boolean(),
  payload: payloadSchema,
  formState: zod.record(zod.string(), zod.any()).optional(),
  createdAt: zod.string()
});

const createTemplateInputSchema = zod.object({
  name: zod.string().trim().min(1).max(200),
  kind: kindSchema,
  mode: modeSchema,
  daysInAdvance: zod.number().int().min(0).max(365).optional(),
  schedule: scheduleSchema.optional(),
  payload: payloadSchema,
  formState: zod.record(zod.string(), zod.any()).optional()
});

const updateTemplateInputSchema = zod.object({
  name: zod.string().trim().min(1).max(200).optional(),
  mode: modeSchema.optional(),
  daysInAdvance: zod.number().int().min(0).max(365).optional(),
  schedule: scheduleSchema.optional(),
  enabled: zod.boolean().optional(),
  payload: payloadSchema.optional(),
  formState: zod.record(zod.string(), zod.any()).optional()
});

type TemplateRow = {
  id: string;
  name: string;
  kind: zod.infer<typeof kindSchema>;
  mode: zod.infer<typeof modeSchema>;
  days_in_advance: number;
  interval_unit: Recurrence["unit"] | null;
  interval_every: number | null;
  on_day: number | null;
  on_weekday: number | null;
  on_month: number | null;
  start_date: Date | null;
  end_type: "NONE" | "BY" | "AFTER";
  end_date: Date | null;
  end_after: number | null;
  occurrences: number;
  next_date: Date | null;
  last_run: Date | null;
  last_error: string | null;
  enabled: boolean;
  payload: zod.infer<typeof payloadSchema>;
  form_state: unknown;
  created_at: Date;
};

const COLUMNS = `id, name, kind, mode, days_in_advance, interval_unit, interval_every, on_day, on_weekday, on_month,
  start_date, end_type, end_date, end_after, occurrences, next_date, last_run, last_error, enabled, payload, form_state, created_at`;

// Postgres `date` columns come back as JS Dates at local midnight of the
// session time zone; format them from local parts so they round-trip.
const day = (value: Date | null): string | undefined =>
  value ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}` : undefined;

function serialize(row: TemplateRow) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    mode: row.mode,
    daysInAdvance: row.days_in_advance,
    schedule: row.interval_unit && row.interval_every && row.start_date
      ? {
          unit: row.interval_unit,
          every: row.interval_every,
          onDay: row.on_day ?? undefined,
          onWeekday: row.on_weekday ?? undefined,
          onMonth: row.on_month ?? undefined,
          startDate: day(row.start_date) as string,
          endType: row.end_type,
          endDate: day(row.end_date),
          endAfter: row.end_after ?? undefined
        }
      : undefined,
    occurrences: row.occurrences,
    nextDate: day(row.next_date),
    lastRun: day(row.last_run),
    lastError: row.last_error ?? undefined,
    enabled: row.enabled,
    payload: row.payload,
    formState: row.form_state ?? undefined,
    createdAt: row.created_at.toISOString()
  };
}

const ruleOf = (row: TemplateRow): Recurrence => ({
  unit: row.interval_unit as Recurrence["unit"],
  every: row.interval_every as number,
  onDay: row.on_day ?? undefined,
  onWeekday: row.on_weekday ?? undefined,
  onMonth: row.on_month ?? undefined
});
const endOf = (row: TemplateRow): RecurrenceEnd =>
  row.end_type === "BY" ? { type: "BY", date: day(row.end_date) as string } : row.end_type === "AFTER" ? { type: "AFTER", count: row.end_after as number } : { type: "NONE" };

function validateSchedule(mode: zod.infer<typeof modeSchema>, schedule: zod.infer<typeof scheduleSchema> | undefined): string | null {
  if (mode === "UNSCHEDULED") return null;
  if (!schedule) return "A scheduled or reminder template needs a schedule";
  if (schedule.endType === "BY" && !schedule.endDate) return "An end date is required";
  if (schedule.endType === "AFTER" && !schedule.endAfter) return "The number of occurrences is required";
  return null;
}

/** Where a fresh schedule starts: the first occurrence on/after its start date (null if the end rule already excludes it). */
function firstDate(schedule: zod.infer<typeof scheduleSchema>): string | null {
  const first = firstOccurrence(schedule, schedule.startDate);
  const end: RecurrenceEnd = schedule.endType === "BY" ? { type: "BY", date: schedule.endDate as string } : schedule.endType === "AFTER" ? { type: "AFTER", count: schedule.endAfter as number } : { type: "NONE" };
  return isPastEnd(end, first, 0) ? null : first;
}

const MAX_CATCH_UP = 120; // per template per run, so a template left running for years can't stall a request

const listRoute = createRoute({
  method: "get",
  path: "/api/recurring-templates",
  responses: { 200: { content: { "application/json": { schema: zod.array(templateSchema) } }, description: "Every recurring template for the caller's currently active company" } }
});
const createRoute_ = createRoute({
  method: "post",
  path: "/api/recurring-templates",
  request: { body: { content: { "application/json": { schema: createTemplateInputSchema } }, required: true } },
  responses: {
    200: { content: { "application/json": { schema: templateSchema } }, description: "The new template" },
    400: { content: { "application/json": { schema: errorResponseSchema } }, description: "Invalid schedule" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No active company" }
  }
});
const updateRoute = createRoute({
  method: "patch",
  path: "/api/recurring-templates/{templateId}",
  request: { params: templateIdParam, body: { content: { "application/json": { schema: updateTemplateInputSchema } }, required: true } },
  responses: {
    200: { content: { "application/json": { schema: templateSchema } }, description: "The updated template" },
    400: { content: { "application/json": { schema: errorResponseSchema } }, description: "Invalid schedule" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No such template" }
  }
});
const deleteRoute = createRoute({
  method: "delete",
  path: "/api/recurring-templates/{templateId}",
  request: { params: templateIdParam },
  responses: {
    204: { description: "Deleted" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No such template" }
  }
});
const advanceRoute = createRoute({
  method: "post",
  path: "/api/recurring-templates/{templateId}/advance",
  request: { params: templateIdParam },
  responses: {
    200: { content: { "application/json": { schema: templateSchema } }, description: "The template after counting one occurrence as done (a reminder was acted on, or an unscheduled template was used)" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No such template" }
  }
});
const runRoute = createRoute({
  method: "post",
  path: "/api/recurring-templates/run",
  responses: { 200: { content: { "application/json": { schema: zod.object({ created: zod.number().int(), failed: zod.number().int() }) } }, description: "Posted every scheduled occurrence that is due (missed ones included)" } }
});

/**
 * Recurring transactions for the caller's CURRENTLY ACTIVE company. There is
 * no background scheduler: POST /run is a catch-up the app calls on load (and
 * a cron can call too). It claims each due occurrence by moving next_date
 * forward in a conditional UPDATE *before* posting, so two concurrent runs
 * can never post the same occurrence twice.
 */
export function recurringTemplateRoutes(app: OpenAPIHono): void {
  async function ledgerIdFor(tenantId: string, ledgerName: string): Promise<string | null> {
    const rows = await getSql()`select id from ledgers where tenant_id = ${tenantId} and name = ${ledgerName} limit 1`;
    return rows.length > 0 ? (rows[0] as { id: string }).id : null;
  }

  app.openapi(listRoute, async (context) => {
    const tenantId = getTenantId(context);
    const ledgerName = getLedgerName(context);
    const rows = await getSql().unsafe(
      `select ${COLUMNS.split(",").map((c) => `t.${c.trim()}`).join(", ")} from recurring_templates t join ledgers l on l.id = t.ledger_id
       where l.tenant_id = $1 and l.name = $2 order by t.created_at desc`,
      [tenantId, ledgerName]
    );
    return context.json(rows.map((r: unknown) => serialize(r as TemplateRow)), 200);
  });

  app.openapi(createRoute_, async (context) => {
    const tenantId = getTenantId(context);
    const ledgerName = getLedgerName(context);
    const input = context.req.valid("json");
    const problem = validateSchedule(input.mode, input.schedule);
    if (problem) return context.json({ error: problem }, 400);
    const ledgerId = await ledgerIdFor(tenantId, ledgerName);
    if (!ledgerId) return context.json({ error: "No active company for this request" }, 404);

    const s = input.mode === "UNSCHEDULED" ? undefined : input.schedule;
    const next = s ? firstDate(s) : null;
    const [row] = await getSql()`
      insert into recurring_templates (
        ledger_id, name, kind, mode, days_in_advance, interval_unit, interval_every, on_day, on_weekday, on_month,
        start_date, end_type, end_date, end_after, next_date, enabled, payload, form_state
      ) values (
        ${ledgerId}, ${input.name}, ${input.kind}, ${input.mode}, ${input.daysInAdvance ?? 0},
        ${s?.unit ?? null}, ${s?.every ?? null}, ${s?.onDay ?? null}, ${s?.onWeekday ?? null}, ${s?.onMonth ?? null},
        ${s?.startDate ?? null}, ${s?.endType ?? "NONE"}, ${s?.endDate ?? null}, ${s?.endAfter ?? null}, ${next},
        ${s ? next !== null : true}, ${JSON.stringify(input.payload)}::jsonb, ${input.formState === undefined ? null : JSON.stringify(input.formState)}::jsonb
      )
      returning id, name, kind, mode, days_in_advance, interval_unit, interval_every, on_day, on_weekday, on_month,
        start_date, end_type, end_date, end_after, occurrences, next_date, last_run, last_error, enabled, payload, form_state, created_at
    `;
    return context.json(serialize(row as unknown as TemplateRow), 200);
  });

  app.openapi(updateRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { templateId } = context.req.valid("param");
    const patch = context.req.valid("json");
    const sql = getSql();
    const existing = await sql`
      select t.id, t.mode, t.interval_unit from recurring_templates t join ledgers l on l.id = t.ledger_id
      where l.tenant_id = ${tenantId} and t.id = ${templateId} limit 1`;
    if (existing.length === 0) return context.json({ error: `No recurring template '${templateId}' for this company` }, 404);
    const mode = patch.mode ?? (existing[0] as { mode: zod.infer<typeof modeSchema> }).mode;
    if (patch.schedule || patch.mode) {
      const problem = validateSchedule(mode, patch.schedule ?? (patch.mode && patch.mode !== "UNSCHEDULED" && (existing[0] as { interval_unit: string | null }).interval_unit ? ({} as never) : undefined));
      if (problem && patch.schedule) return context.json({ error: problem }, 400);
    }

    const s = patch.schedule;
    const next = s ? firstDate(s) : undefined;
    await sql`
      update recurring_templates set
        name = coalesce(${patch.name ?? null}, name),
        mode = ${mode},
        days_in_advance = coalesce(${patch.daysInAdvance ?? null}, days_in_advance),
        enabled = coalesce(${patch.enabled ?? null}, enabled),
        payload = coalesce(${patch.payload ? JSON.stringify(patch.payload) : null}::jsonb, payload),
        form_state = coalesce(${patch.formState === undefined ? null : JSON.stringify(patch.formState)}::jsonb, form_state),
        updated_at = now()
      where id = ${templateId}`;
    if (s) {
      await sql`
        update recurring_templates set
          interval_unit = ${s.unit}, interval_every = ${s.every}, on_day = ${s.onDay ?? null}, on_weekday = ${s.onWeekday ?? null},
          on_month = ${s.onMonth ?? null}, start_date = ${s.startDate}, end_type = ${s.endType}, end_date = ${s.endDate ?? null},
          end_after = ${s.endAfter ?? null}, next_date = ${next ?? null}, occurrences = 0
        where id = ${templateId}`;
    }
    const [row] = await sql.unsafe(`select ${COLUMNS} from recurring_templates where id = $1`, [templateId]);
    return context.json(serialize(row as unknown as TemplateRow), 200);
  });

  app.openapi(deleteRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { templateId } = context.req.valid("param");
    const deleted = await getSql()`
      delete from recurring_templates t using ledgers l
      where l.id = t.ledger_id and l.tenant_id = ${tenantId} and t.id = ${templateId} returning t.id`;
    if (deleted.length === 0) return context.json({ error: `No recurring template '${templateId}' for this company` }, 404);
    return context.body(null, 204);
  });

  app.openapi(advanceRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { templateId } = context.req.valid("param");
    const sql = getSql();
    const rows = await sql.unsafe(
      `select ${COLUMNS.split(",").map((c) => `t.${c.trim()}`).join(", ")} from recurring_templates t join ledgers l on l.id = t.ledger_id
       where l.tenant_id = $1 and t.id = $2 limit 1`,
      [tenantId, templateId]
    );
    if (rows.length === 0) return context.json({ error: `No recurring template '${templateId}' for this company` }, 404);
    const row = rows[0] as unknown as TemplateRow;
    const done = row.occurrences + 1;
    const current = day(row.next_date);
    let next: string | null = null;
    if (row.interval_unit && current) {
      const candidate = nextOccurrence(ruleOf(row), current);
      next = isPastEnd(endOf(row), candidate, done) ? null : candidate;
    }
    const [updated] = await sql.unsafe(
      `update recurring_templates set occurrences = $2, last_run = $3, next_date = $4, enabled = $5, updated_at = now() where id = $1 returning ${COLUMNS}`,
      [templateId, done, current ?? new Date().toISOString().slice(0, 10), next, row.interval_unit ? next !== null && row.enabled : row.enabled]
    );
    return context.json(serialize(updated as unknown as TemplateRow), 200);
  });

  app.openapi(runRoute, async (context) => {
    const tenantId = getTenantId(context);
    const ledgerName = getLedgerName(context);
    const { transactionService } = getServices(context);
    const sql = getSql();
    const today = new Date().toISOString().slice(0, 10);
    const ledgerId = await ledgerIdFor(tenantId, ledgerName);
    let created = 0;
    let failed = 0;
    if (!ledgerId) return context.json({ created, failed }, 200);

    const due = await sql.unsafe(
      `select ${COLUMNS} from recurring_templates
       where ledger_id = $1 and enabled and mode = 'SCHEDULED' and next_date is not null and next_date - days_in_advance <= $2::date`,
      [ledgerId, today]
    );
    for (const raw of due) {
      let row = raw as unknown as TemplateRow;
      for (let i = 0; i < MAX_CATCH_UP; i++) {
        const occurrence = day(row.next_date);
        if (!occurrence || addDays(occurrence, -row.days_in_advance) > today) break;
        const done = row.occurrences + 1;
        const candidate = nextOccurrence(ruleOf(row), occurrence);
        const next = isPastEnd(endOf(row), candidate, done) ? null : candidate;
        // Claim the occurrence first: only one concurrent run can move next_date off `occurrence`.
        const claimed = await sql.unsafe(
          `update recurring_templates set occurrences = $2, last_run = $3, next_date = $4, enabled = $5, last_error = null, updated_at = now()
           where id = $1 and next_date = $3::date returning ${COLUMNS}`,
          [row.id, done, occurrence, next, next !== null]
        );
        if (claimed.length === 0) break;
        try {
          const draft = await transactionService.createTransaction({ ...row.payload, type: row.kind, transactionDate: occurrence });
          await transactionService.postTransaction(draft.id);
          created += 1;
        } catch (error) {
          failed += 1;
          // Give the occurrence back so the next run retries it, and keep the reason visible.
          await sql.unsafe(`update recurring_templates set occurrences = $2, next_date = $3, enabled = true, last_error = $4 where id = $1`, [
            row.id,
            row.occurrences,
            occurrence,
            error instanceof Error ? error.message : "Could not post this occurrence"
          ]);
          break;
        }
        row = claimed[0] as unknown as TemplateRow;
      }
    }
    return context.json({ created, failed }, 200);
  });
}
