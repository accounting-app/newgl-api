import { createApp } from "@/http/app";
import { APP_ENV, APP_CONFIG, APP_PORT, APP_HOSTNAME } from "@/configuration";

const { COMPANY, DATABASE_URL, SUPABASE_URL } = APP_CONFIG;

// Phase 1: there is no boot-time repository or services container anymore --
// every request is tenant-scoped, built fresh by tenantContext() middleware
// (src/http/middleware/auth.ts) from the Supabase session on that request.
// See AI_INTEGRATION_PLAN.md Part 2 / Part 3.
if (!DATABASE_URL || !SUPABASE_URL) {
  console.warn(
    "[api] WARNING: DATABASE_URL and/or SUPABASE_URL are not set -- every " +
      "authenticated request will fail. Only /api/health, /api/debug/*, " +
      "/openapi.json and /docs will work."
  );
}

const app = createApp();
const { fetch } = app;
const port = APP_PORT;
console.log(`[api] env=${APP_ENV} company=${COMPANY} multi-tenant=true`);

const server = Bun.serve({
  fetch: (request, server) => fetch(request, server),
  port,
  hostname: APP_HOSTNAME,
});
const { protocol, hostname } = server;

console.log(`[api] listening on ${protocol}://${hostname}:${port}`);
