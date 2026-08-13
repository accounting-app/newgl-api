import { createRoute, z as zod } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import type { BankRuleCondition } from "@/domain/models";
import { bankRuleSchema, createBankRuleInputSchema, errorResponseSchema, updateBankRuleInputSchema } from "@/domain/models";
import { getTenantId } from "@/http/context";
import { getSql } from "@/infra/postgres/client";

const bankRuleIdParam = zod.object({ id: zod.string().uuid() });

type BankRuleRow = {
  id: string;
  name: string;
  target_account_id: string;
  conditions: unknown;
  enabled: boolean;
  priority: number;
  created_at: Date;
  updated_at: Date;
};

function serializeRule(row: BankRuleRow) {
  return {
    id: row.id,
    name: row.name,
    targetAccountId: row.target_account_id,
    conditions: row.conditions as BankRuleCondition[],
    enabled: row.enabled,
    priority: row.priority,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

const listBankRulesRoute = createRoute({
  method: "get",
  path: "/api/bank-rules",
  responses: {
    200: {
      content: { "application/json": { schema: zod.array(bankRuleSchema) } },
      description: "Every bank rule for the caller's tenant, highest priority first"
    }
  }
});

const createBankRuleRoute = createRoute({
  method: "post",
  path: "/api/bank-rules",
  request: {
    body: { content: { "application/json": { schema: createBankRuleInputSchema } }, required: true }
  },
  responses: {
    200: { content: { "application/json": { schema: bankRuleSchema } }, description: "The newly created rule" }
  }
});

const updateBankRuleRoute = createRoute({
  method: "patch",
  path: "/api/bank-rules/{id}",
  request: {
    params: bankRuleIdParam,
    body: { content: { "application/json": { schema: updateBankRuleInputSchema } }, required: true }
  },
  responses: {
    200: { content: { "application/json": { schema: bankRuleSchema } }, description: "The updated rule" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No rule with that id" }
  }
});

const deleteBankRuleRoute = createRoute({
  method: "delete",
  path: "/api/bank-rules/{id}",
  request: { params: bankRuleIdParam },
  responses: {
    204: { description: "Rule deleted" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "No rule with that id" }
  }
});

export function bankRuleRoutes(app: OpenAPIHono): void {
  app.openapi(listBankRulesRoute, async (context) => {
    const tenantId = getTenantId(context);
    const sql = getSql();
    const rows = (await sql`
      select id, name, target_account_id, conditions, enabled, priority, created_at, updated_at
      from bank_rules
      where tenant_id = ${tenantId}
      order by priority desc, created_at asc
    `) as unknown as BankRuleRow[];

    return context.json(rows.map(serializeRule), 200);
  });

  app.openapi(createBankRuleRoute, async (context) => {
    const tenantId = getTenantId(context);
    const input = context.req.valid("json");
    const sql = getSql();

    const rows = (await sql`
      insert into bank_rules (tenant_id, name, target_account_id, conditions, enabled, priority)
      values (
        ${tenantId},
        ${input.name},
        ${input.targetAccountId},
        ${JSON.stringify(input.conditions)},
        ${input.enabled ?? true},
        ${input.priority ?? 0}
      )
      returning id, name, target_account_id, conditions, enabled, priority, created_at, updated_at
    `) as unknown as BankRuleRow[];

    return context.json(serializeRule(rows[0]), 200);
  });

  app.openapi(updateBankRuleRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { id } = context.req.valid("param");
    const input = context.req.valid("json");
    const sql = getSql();

    const existing = (await sql`
      select id, name, target_account_id, conditions, enabled, priority
      from bank_rules where id = ${id} and tenant_id = ${tenantId} limit 1
    `) as unknown as BankRuleRow[];
    if (existing.length === 0) {
      return context.json({ error: `No rule '${id}' for this tenant` }, 404);
    }
    const current = existing[0];

    const nextName = input.name ?? current.name;
    const nextTargetAccountId = input.targetAccountId ?? current.target_account_id;
    const nextConditions = input.conditions ? JSON.stringify(input.conditions) : JSON.stringify(current.conditions);
    const nextEnabled = input.enabled ?? current.enabled;
    const nextPriority = input.priority ?? current.priority;

    const rows = (await sql`
      update bank_rules set
        name = ${nextName},
        target_account_id = ${nextTargetAccountId},
        conditions = ${nextConditions},
        enabled = ${nextEnabled},
        priority = ${nextPriority},
        updated_at = now()
      where id = ${id} and tenant_id = ${tenantId}
      returning id, name, target_account_id, conditions, enabled, priority, created_at, updated_at
    `) as unknown as BankRuleRow[];

    return context.json(serializeRule(rows[0]), 200);
  });

  app.openapi(deleteBankRuleRoute, async (context) => {
    const tenantId = getTenantId(context);
    const { id } = context.req.valid("param");
    const sql = getSql();

    const rows = (await sql`
      delete from bank_rules where id = ${id} and tenant_id = ${tenantId} returning id
    `) as unknown as { id: string }[];
    if (rows.length === 0) {
      return context.json({ error: `No rule '${id}' for this tenant` }, 404);
    }

    return context.body(null, 204);
  });
}
