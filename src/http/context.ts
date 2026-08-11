import type { Context } from "hono";

import type { ServiceContainer } from "@/application/service-container";

/**
 * The tenantContext middleware (src/http/middleware/auth.ts) sets these on
 * every request before any route handler runs -- either from a real,
 * per-request, tenant-scoped repository, or (test mode) from a fixed
 * container. Route handlers should never build a ServiceContainer
 * themselves; always read it from context.
 */
export function getServices(context: Context): ServiceContainer {
  const services = context.get("services") as ServiceContainer | undefined;
  if (!services) {
    throw new Error(
      "No services on request context -- tenantContext middleware did not run before this route."
    );
  }
  return services;
}

export function getTenantId(context: Context): string {
  const tenantId = context.get("tenantId") as string | undefined;
  if (!tenantId) {
    throw new Error("No tenantId on request context.");
  }
  return tenantId;
}

export function getUserId(context: Context): string {
  const userId = context.get("userId") as string | undefined;
  if (!userId) {
    throw new Error("No userId on request context.");
  }
  return userId;
}

export function getUserEmail(context: Context): string | null {
  return (context.get("userEmail") as string | null | undefined) ?? null;
}

// The company (ledger) this request is scoped to -- resolved once by
// tenantContext from the caller's membership.active_ledger_name, falling
// back to the tenant's primary ledger. See newgl-specs/INSTANCE_ARCHITECTURE_PLAN.md
// Phase A.
export function getLedgerName(context: Context): string {
  const ledgerName = context.get("ledgerName") as string | undefined;
  if (!ledgerName) {
    throw new Error("No ledgerName on request context.");
  }
  return ledgerName;
}
