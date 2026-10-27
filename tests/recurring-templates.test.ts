import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApp } from "../src/http/app";
import { getSql } from "../src/infra/postgres/client";
import { addDays } from "../src/shared/utils/recurrence";
import { createConfirmedUser, deleteUser, localSupabaseStackIsReachable, SUPABASE_URL, type TestUser } from "./helpers/supabase-test-auth";

/**
 * Integration tests for recurring transactions: templates are saved forms
 * plus a schedule, and POST /run posts every scheduled occurrence that is
 * due (catching up on missed ones) without ever double-posting.
 *
 * Requires a local Supabase stack (`bunx supabase start`); skips with a
 * warning instead of failing if it isn't reachable.
 */
describe("Recurring template routes", () => {
  let app: ReturnType<typeof createApp>;
  let reachable = false;
  const createdUserIds: string[] = [];
  const createdTenantIds: string[] = [];

  async function bootstrapUser(prefix: string): Promise<{ user: TestUser; headers: HeadersInit }> {
    const user = await createConfirmedUser(`${prefix}-${crypto.randomUUID()}@example.com`, "password123!");
    createdUserIds.push(user.id);
    const headers = { Authorization: `Bearer ${user.accessToken}`, "Content-Type": "application/json" };
    const res = await app.request("/api/tenants/bootstrap", { method: "POST", headers });
    createdTenantIds.push(((await res.json()) as { id: string }).id);
    return { user, headers };
  }

  async function accountIds(headers: HeadersInit): Promise<{ bank: string; expense: string }> {
    const accounts = (await (await app.request("/api/accounts", { headers })).json()) as Array<{ id: string; category: string }>;
    return { bank: accounts.find((a) => a.category === "BANK")?.id as string, expense: accounts.find((a) => a.category === "EXPENSE")?.id as string };
  }

  const payloadFor = (a: { bank: string; expense: string }) => ({
    payee: "Landlord",
    accountLabel: "Rent",
    sourceAccountId: a.bank,
    postings: [
      { accountId: a.expense, type: "DEBIT", amount: 100 },
      { accountId: a.bank, type: "CREDIT", amount: 100 }
    ]
  });
  const post = (headers: HeadersInit, path: string, body?: unknown) => app.request(path, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const today = () => new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    reachable = await localSupabaseStackIsReachable();
    if (!reachable) {
      console.warn("Local Supabase/Postgres not reachable at " + SUPABASE_URL + " -- skipping recurring template integration tests. Run `bunx supabase start` to enable them.");
      return;
    }
    app = createApp();
  });

  afterAll(async () => {
    if (!reachable) return;
    for (const tenantId of createdTenantIds) await getSql()`delete from tenants where id = ${tenantId}`.catch(() => {});
    for (const userId of createdUserIds) await deleteUser(userId);
  });

  test("a scheduled template catches up on missed occurrences once, and never double-posts", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("recurring-run");
    const accounts = await accountIds(headers);
    const start = addDays(today(), -20); // daily, every 5 days: start, +5, +10, +15, +20(today)
    const created = await post(headers, "/api/recurring-templates", {
      name: "Rent",
      kind: "EXPENSE",
      mode: "SCHEDULED",
      schedule: { unit: "DAY", every: 5, startDate: start, endType: "NONE" },
      payload: payloadFor(accounts)
    });
    expect(created.status).toBe(200);
    const template = (await created.json()) as { id: string; nextDate: string };
    expect(template.nextDate).toBe(start);

    const first = (await (await post(headers, "/api/recurring-templates/run")).json()) as { created: number; failed: number };
    expect(first).toEqual({ created: 5, failed: 0 });
    const second = (await (await post(headers, "/api/recurring-templates/run")).json()) as { created: number };
    expect(second.created).toBe(0);

    const txns = (await (await app.request("/api/transactions?status=POSTED", { headers })).json()) as Array<{ transactionDate: string; type: string; payee?: string }>;
    const rent = txns.filter((t) => t.payee === "Landlord");
    expect(rent.length).toBe(5);
    expect(rent.every((t) => t.type === "EXPENSE")).toBe(true);

    const [after] = (await (await app.request("/api/recurring-templates", { headers })).json()) as Array<{ occurrences: number; nextDate: string; lastRun: string }>;
    expect(after.occurrences).toBe(5);
    expect(after.lastRun).toBe(today());
    expect(after.nextDate).toBe(addDays(today(), 5));
  });

  test("an end-after-N series stops itself", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("recurring-end");
    const accounts = await accountIds(headers);
    await post(headers, "/api/recurring-templates", {
      name: "Three times",
      kind: "EXPENSE",
      mode: "SCHEDULED",
      schedule: { unit: "DAY", every: 1, startDate: addDays(today(), -10), endType: "AFTER", endAfter: 3 },
      payload: payloadFor(accounts)
    });
    expect(((await (await post(headers, "/api/recurring-templates/run")).json()) as { created: number }).created).toBe(3);
    const [t] = (await (await app.request("/api/recurring-templates", { headers })).json()) as Array<{ enabled: boolean; nextDate?: string }>;
    expect(t.enabled).toBe(false);
    expect(t.nextDate).toBeUndefined();
  });

  test("reminders and unscheduled templates are never posted by /run, and advance counts one as done", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("recurring-reminder");
    const accounts = await accountIds(headers);
    const reminder = (await (await post(headers, "/api/recurring-templates", {
      name: "Remind me",
      kind: "EXPENSE",
      mode: "REMINDER",
      schedule: { unit: "WEEK", every: 1, startDate: addDays(today(), -3), endType: "NONE" },
      payload: payloadFor(accounts)
    })).json()) as { id: string; nextDate: string };
    const unscheduled = await post(headers, "/api/recurring-templates", { name: "Saved", kind: "EXPENSE", mode: "UNSCHEDULED", payload: payloadFor(accounts) });
    expect(unscheduled.status).toBe(200);
    expect(((await unscheduled.json()) as { nextDate?: string }).nextDate).toBeUndefined();

    expect(((await (await post(headers, "/api/recurring-templates/run")).json()) as { created: number }).created).toBe(0);

    const advanced = (await (await post(headers, `/api/recurring-templates/${reminder.id}/advance`)).json()) as { occurrences: number; nextDate: string };
    expect(advanced.occurrences).toBe(1);
    expect(advanced.nextDate).toBe(addDays(reminder.nextDate, 7));
  });

  test("validation: a scheduled template needs a schedule; unknown ids 404; delete removes", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("recurring-validate");
    const accounts = await accountIds(headers);
    expect((await post(headers, "/api/recurring-templates", { name: "No schedule", kind: "EXPENSE", mode: "SCHEDULED", payload: payloadFor(accounts) })).status).toBe(400);
    expect((await app.request(`/api/recurring-templates/${crypto.randomUUID()}`, { method: "DELETE", headers })).status).toBe(404);

    const made = (await (await post(headers, "/api/recurring-templates", { name: "Temp", kind: "EXPENSE", mode: "UNSCHEDULED", payload: payloadFor(accounts) })).json()) as { id: string };
    expect((await app.request(`/api/recurring-templates/${made.id}`, { method: "DELETE", headers })).status).toBe(204);
    expect(await (await app.request("/api/recurring-templates", { headers })).json()).toEqual([]);
  });

  test("templates are scoped to the company", async () => {
    if (!reachable) return;
    const a = await bootstrapUser("recurring-scope-a");
    const b = await bootstrapUser("recurring-scope-b");
    const accounts = await accountIds(a.headers);
    await post(a.headers, "/api/recurring-templates", { name: "Mine", kind: "EXPENSE", mode: "UNSCHEDULED", payload: payloadFor(accounts) });
    expect(await (await app.request("/api/recurring-templates", { headers: b.headers })).json()).toEqual([]);
  });
});
