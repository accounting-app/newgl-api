import { createRemoteJWKSet, jwtVerify } from "jose";
import type { MiddlewareHandler } from "hono";

import { createServiceContainer } from "@/application/create-service-container";
import type { ServiceContainer } from "@/application/service-container";
import { LEDGER_NAME, SUPABASE_URL } from "@/configuration";
import { createPostgresLedgerRepository } from "@/infra/beancount/postgres-repository";
import { getSql } from "@/infra/postgres/client";

// Routes reachable with no Supabase session at all.
const PUBLIC_PATHS = new Set([
  "/api/health",
  "/api/debug/ledger-source",
  "/api/ledger/download",
  "/openapi.json",
  "/docs"
]);

// Requires a valid session (so we know *who* is asking) but not yet a
// membership -- its entire job is to create one.
const AUTH_ONLY_PATHS = new Set(["/api/tenants/bootstrap"]);

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  if (!jwks) {
    if (!SUPABASE_URL) {
      throw new Error("SUPABASE_URL is not set -- required to verify Supabase session tokens.");
    }
    jwks = createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`));
  }
  return jwks;
}

async function verifySupabaseToken(token: string): Promise<{ userId: string; email: string | null }> {
  const { payload } = await jwtVerify(token, getJwks(), {
    issuer: `${SUPABASE_URL}/auth/v1`
  });
  if (typeof payload.sub !== "string") {
    throw new Error("Token has no subject claim");
  }
  return {
    userId: payload.sub,
    email: typeof payload.email === "string" ? payload.email : null
  };
}

/**
 * Single global middleware handling both concerns:
 *   1. Authentication -- verify the Supabase access token, set userId/userEmail.
 *   2. Tenant resolution -- look up the caller's membership, build a
 *      tenant-scoped ServiceContainer fresh for this request, set it on context.
 *
 * Test mode: when `defaultServices` is supplied (test helpers / scripts that
 * predate multi-tenancy), auth and tenant resolution are both skipped and
 * every request gets that fixed container -- this is what preserves the
 * existing test suite unchanged.
 */
export function tenantContext(defaultServices?: ServiceContainer): MiddlewareHandler {
  return async (context, next) => {
    if (defaultServices) {
      context.set("userId", "test-user");
      context.set("tenantId", "test-tenant");
      context.set("services", defaultServices);
      await next();
      return;
    }

    const path = context.req.path;
    if (PUBLIC_PATHS.has(path)) {
      await next();
      return;
    }

    const header = context.req.header("Authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) {
      return context.json({ error: { message: "Missing bearer token" } }, 401);
    }

    let userId: string;
    let email: string | null;
    try {
      const verified = await verifySupabaseToken(token);
      userId = verified.userId;
      email = verified.email;
    } catch {
      return context.json({ error: { message: "Invalid or expired token" } }, 401);
    }
    context.set("userId", userId);
    context.set("userEmail", email);

    if (AUTH_ONLY_PATHS.has(path)) {
      await next();
      return;
    }

    const sql = getSql();
    const rows = await sql`
      select m.tenant_id, t.name as tenant_name
      from memberships m
      join tenants t on t.id = m.tenant_id
      where m.user_id = ${userId}
      limit 1
    `;
    if (rows.length === 0) {
      return context.json(
        { error: { message: "No tenant membership. Call POST /api/tenants/bootstrap first." } },
        403
      );
    }

    const row = rows[0] as { tenant_id: string; tenant_name: string };
    const repository = createPostgresLedgerRepository(sql, LEDGER_NAME, row.tenant_name, row.tenant_id);
    await repository.load();

    context.set("tenantId", row.tenant_id);
    context.set("services", createServiceContainer(repository));
    await next();
  };
}
