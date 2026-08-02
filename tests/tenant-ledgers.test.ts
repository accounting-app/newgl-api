import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApp } from "../src/http/app";
import { getSql } from "../src/infra/postgres/client";
import {
  createConfirmedUser,
  deleteUser,
  localSupabaseStackIsReachable,
  SUPABASE_URL,
  type TestUser
} from "./helpers/supabase-test-auth";

/**
 * Integration tests for Phase 2 (see AI_INTEGRATION_PLAN.md Part 6):
 *   - GET/POST /api/ledgers/:name/download|upload, parse-before-persist.
 *   - GET /api/ledgers/:name/versions + POST .../versions/:version/restore.
 *   - Tenant isolation on all of the above.
 *
 * Requires a local Supabase stack (`bunx supabase start`); skips with a
 * warning instead of failing if it isn't reachable, same as tenant-auth.test.ts.
 */

const VALID_BEAN = [
  'option "title" "Test Co"',
  'option "operating_currency" "USD"',
  "",
  "2024-01-01 open Assets:Cash USD",
  '  id: "acct-cash"',
  "2024-01-01 open Expenses:Misc USD",
  '  id: "acct-expense"',
  "",
  '2024-02-01 * "Payee" "Memo"',
  '  id: "txn-1"',
  "  Assets:Cash 10.00 USD",
  "  Expenses:Misc -10.00 USD"
].join("\n");

const INVALID_BEAN = "this is not a valid beancount file {{{";

describe("Phase 2: ledger upload/download/versions", () => {
  let app: ReturnType<typeof createApp>;
  let reachable = false;
  const createdUserIds: string[] = [];
  const createdTenantIds: string[] = [];

  async function bootstrapUser(prefix: string): Promise<{ user: TestUser; headers: HeadersInit; tenantId: string }> {
    const user = await createConfirmedUser(`${prefix}-${crypto.randomUUID()}@example.com`, "password123!");
    createdUserIds.push(user.id);
    const headers = { Authorization: `Bearer ${user.accessToken}` };
    const res = await app.request("/api/tenants/bootstrap", { method: "POST", headers });
    const body = (await res.json()) as { id: string };
    createdTenantIds.push(body.id);
    return { user, headers, tenantId: body.id };
  }

  beforeAll(async () => {
    reachable = await localSupabaseStackIsReachable();
    if (!reachable) {
      console.warn(
        "Local Supabase/Postgres not reachable at " +
          SUPABASE_URL +
          " -- skipping tenant-ledgers integration tests. Run `bunx supabase start` to enable them."
      );
      return;
    }
    app = createApp();
  });

  afterAll(async () => {
    if (!reachable) return;
    for (const tenantId of createdTenantIds) {
      await getSql()`delete from tenants where id = ${tenantId}`.catch(() => {});
    }
    for (const userId of createdUserIds) {
      await deleteUser(userId);
    }
  });

  test("download returns the freshly-bootstrapped starter ledger", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("dl");

    const res = await app.request("/api/ledgers/company/download", { headers });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('option "title"');
  });

  test("upload rejects malformed content and leaves the ledger untouched", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("bad-upload");

    const before = await (await app.request("/api/ledgers/company/download", { headers })).text();

    const res = await app.request("/api/ledgers/company/upload", {
      method: "POST",
      headers: { ...headers, "Content-Type": "text/plain" },
      body: INVALID_BEAN
    });
    expect(res.status).toBe(400);

    const after = await (await app.request("/api/ledgers/company/download", { headers })).text();
    expect(after).toBe(before);
  });

  test("upload replaces content, bumps version, and download reflects it", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("good-upload");

    const uploadRes = await app.request("/api/ledgers/company/upload", {
      method: "POST",
      headers: { ...headers, "Content-Type": "text/plain" },
      body: VALID_BEAN
    });
    expect(uploadRes.status).toBe(200);
    const summary = (await uploadRes.json()) as { version: number; transactionCount: number; accountCount: number };
    expect(summary.version).toBe(2); // v1 is the bootstrap starter ledger
    expect(summary.transactionCount).toBe(1);
    expect(summary.accountCount).toBe(2);

    const downloaded = await (await app.request("/api/ledgers/company/download", { headers })).text();
    expect(downloaded).toContain('"Payee" "Memo"');
  });

  test("versions lists bootstrap then upload, most recent first", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("versions");

    await app.request("/api/ledgers/company/upload", {
      method: "POST",
      headers: { ...headers, "Content-Type": "text/plain" },
      body: VALID_BEAN
    });

    const res = await app.request("/api/ledgers/company/versions", { headers });
    expect(res.status).toBe(200);
    const versions = (await res.json()) as Array<{ version: number; source: string }>;
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions[0].source).toBe("upload");
    expect(versions[1].source).toBe("bootstrap");
  });

  test("restore brings back an older version's content as a new version", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("restore");

    const original = await (await app.request("/api/ledgers/company/download", { headers })).text();

    await app.request("/api/ledgers/company/upload", {
      method: "POST",
      headers: { ...headers, "Content-Type": "text/plain" },
      body: VALID_BEAN
    });

    const restoreRes = await app.request("/api/ledgers/company/versions/1/restore", {
      method: "POST",
      headers
    });
    expect(restoreRes.status).toBe(200);
    const summary = (await restoreRes.json()) as { version: number };
    expect(summary.version).toBe(3); // new row, not a rewind

    const restored = await (await app.request("/api/ledgers/company/download", { headers })).text();
    expect(restored).toBe(original);

    const versions = (await (await app.request("/api/ledgers/company/versions", { headers })).json()) as Array<{
      version: number;
      source: string;
    }>;
    expect(versions.map((v) => `${v.version}:${v.source}`)).toEqual(["3:restore", "2:upload", "1:bootstrap"]);
  });

  test("restore of a non-existent version returns 404", async () => {
    if (!reachable) return;
    const { headers } = await bootstrapUser("bad-restore");

    const res = await app.request("/api/ledgers/company/versions/999/restore", { method: "POST", headers });
    expect(res.status).toBe(404);
  });

  test("one tenant cannot download, upload, or see versions of another tenant's ledger", async () => {
    if (!reachable) return;
    const { headers: headersA } = await bootstrapUser("isolation-a");
    const { headers: headersB } = await bootstrapUser("isolation-b");

    await app.request("/api/ledgers/company/upload", {
      method: "POST",
      headers: { ...headersA, "Content-Type": "text/plain" },
      body: VALID_BEAN
    });

    // Tenant B's ledger is a fresh bootstrap -- never sees Tenant A's upload.
    const downloadedByB = await (await app.request("/api/ledgers/company/download", { headers: headersB })).text();
    expect(downloadedByB).not.toContain('"Payee" "Memo"');

    const versionsForB = (await (
      await app.request("/api/ledgers/company/versions", { headers: headersB })
    ).json()) as Array<{ version: number }>;
    expect(versionsForB).toHaveLength(1);
  });
});
