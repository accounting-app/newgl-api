import { createRoute, z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { getLedgerName, getTenantId } from "@/http/context";
import { errorResponseSchema } from "@/domain/models";
import { getSql } from "@/infra/postgres/client";

const employeeIdParam = zod.object({ employeeId: zod.string().uuid() });

const employeeSchema = zod.object({
  id: zod.string().uuid(),
  name: zod.string(),
  jobTitle: zod.string().optional(),
  email: zod.string().optional(),
  phone: zod.string().optional(),
  hireDate: zod.string().optional(),
  status: zod.enum(["ACTIVE", "ARCHIVED"]),
  createdAt: zod.string()
});

const employeeWritableFields = {
  name: zod.string().trim().min(1).max(200),
  jobTitle: zod.string().trim().min(1).max(200).optional(),
  email: zod.string().trim().min(1).max(200).optional(),
  phone: zod.string().trim().min(1).max(50).optional(),
  hireDate: zod.string().min(1).optional()
};

const createEmployeeInputSchema = zod.object(employeeWritableFields);
// Every field explicit and optional -- see vendors.ts's own comment on
// why this isn't a spread over Object.entries(...).map(...optional()).
const updateEmployeeInputSchema = zod.object({
  name: employeeWritableFields.name.optional(),
  jobTitle: employeeWritableFields.jobTitle,
  email: employeeWritableFields.email,
  phone: employeeWritableFields.phone,
  hireDate: employeeWritableFields.hireDate,
  status: zod.enum(["ACTIVE", "ARCHIVED"]).optional()
});

type EmployeeRow = {
  id: string;
  name: string;
  job_title: string | null;
  email: string | null;
  phone: string | null;
  hire_date: Date | null;
  status: "ACTIVE" | "ARCHIVED";
  created_at: Date;
};

function serialize(row: EmployeeRow) {
  return {
    id: row.id,
    name: row.name,
    jobTitle: row.job_title ?? undefined,
    email: row.email ?? undefined,
    phone: row.phone ?? undefined,
    hireDate: row.hire_date ? row.hire_date.toISOString().slice(0, 10) : undefined,
    status: row.status,
    createdAt: row.created_at.toISOString()
  };
}

const listEmployeesRoute = createRoute({
  method: "get",
  path: "/api/employees",
  responses: {
    200: { content: { "application/json": { schema: zod.array(employeeSchema) } }, description: "Every employee for the caller's currently active company" }
  }
});

const createEmployeeRoute = createRoute({
  method: "post",
  path: "/api/employees",
  request: { body: { content: { "application/json": { schema: createEmployeeInputSchema } }, required: true } },
  responses: {
    200: { content: { "application/json": { schema: employeeSchema } }, description: "The newly created employee" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No active company for this request" }
  }
});

const updateEmployeeRoute = createRoute({
  method: "patch",
  path: "/api/employees/{employeeId}",
  request: { params: employeeIdParam, body: { content: { "application/json": { schema: updateEmployeeInputSchema } }, required: true } },
  responses: {
    200: { content: { "application/json": { schema: employeeSchema } }, description: "The updated employee" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No such employee for this company" }
  }
});

const deleteEmployeeRoute = createRoute({
  method: "delete",
  path: "/api/employees/{employeeId}",
  request: { params: employeeIdParam },
  responses: {
    204: { description: "Employee deleted" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No such employee for this company" }
  }
});

/**
 * Employee roster/directory, scoped to the caller's CURRENTLY ACTIVE
 * company only -- same scoping/pattern as vendors.ts. No pay rate, no
 * paychecks -- there's no Payroll behind this (out of scope, see
 * QBO_FREE_FEATURES_PLAN.md).
 */
export function employeeRoutes(app: OpenAPIHono): void {
  app.openapi(listEmployeesRoute, async (context) => {
    const tenantId = getTenantId(context);
    const ledgerName = getLedgerName(context);
    const sql = getSql();

    const rows = await sql`
      select e.id, e.name, e.job_title, e.email, e.phone, e.hire_date, e.status, e.created_at
      from employees e
      join ledgers l on l.id = e.ledger_id
      where l.tenant_id = ${tenantId} and l.name = ${ledgerName}
      order by e.created_at asc
    `;

    return context.json(rows.map((row: unknown) => serialize(row as EmployeeRow)), 200);
  });

  app.openapi(createEmployeeRoute, async (context) => {
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
      insert into employees (ledger_id, name, job_title, email, phone, hire_date)
      values (${ledgerId}, ${input.name}, ${input.jobTitle ?? null}, ${input.email ?? null}, ${input.phone ?? null}, ${input.hireDate ?? null})
      returning id, name, job_title, email, phone, hire_date, status, created_at
    `;

    return context.json(serialize(inserted as EmployeeRow), 200);
  });

  app.openapi(updateEmployeeRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { employeeId } = context.req.valid("param");
    const patch = context.req.valid("json");
    const sql = getSql();

    const existingRows = await sql`
      select e.id, e.name, e.job_title, e.email, e.phone, e.hire_date, e.status
      from employees e
      join ledgers l on l.id = e.ledger_id
      where l.tenant_id = ${tenantId} and e.id = ${employeeId}
      limit 1
    `;
    if (existingRows.length === 0) {
      return context.json({ error: `No employee '${employeeId}' for this company` }, 404);
    }
    const current = existingRows[0] as EmployeeRow;

    const next = {
      name: patch.name ?? current.name,
      jobTitle: patch.jobTitle !== undefined ? patch.jobTitle : (current.job_title ?? undefined),
      email: patch.email !== undefined ? patch.email : (current.email ?? undefined),
      phone: patch.phone !== undefined ? patch.phone : (current.phone ?? undefined),
      hireDate: patch.hireDate !== undefined ? patch.hireDate : current.hire_date ? current.hire_date.toISOString().slice(0, 10) : undefined,
      status: patch.status ?? current.status
    };

    const [updated] = await sql`
      update employees set
        name = ${next.name},
        job_title = ${next.jobTitle ?? null},
        email = ${next.email ?? null},
        phone = ${next.phone ?? null},
        hire_date = ${next.hireDate ?? null},
        status = ${next.status},
        updated_at = now()
      where id = ${employeeId}
      returning id, name, job_title, email, phone, hire_date, status, created_at
    `;

    return context.json(serialize(updated as EmployeeRow), 200);
  });

  app.openapi(deleteEmployeeRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { employeeId } = context.req.valid("param");
    const sql = getSql();

    const rows = await sql`
      delete from employees e
      using ledgers l
      where e.ledger_id = l.id and l.tenant_id = ${tenantId} and e.id = ${employeeId}
      returning e.id
    `;
    if (rows.length === 0) {
      return context.json({ error: `No employee '${employeeId}' for this company` }, 404);
    }

    return context.body(null, 204);
  });
}
