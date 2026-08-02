import { createServiceContainer } from "@/application/create-service-container";
import { createLedgerRepository } from "@/infra/beancount/repository";
import { createPostgresLedgerRepository } from "@/infra/beancount/postgres-repository";
import { getSql } from "@/infra/postgres/client";
import { createApp } from "@/http/app";
import { APP_ENV, APP_CONFIG, APP_PORT, APP_HOSTNAME } from "@/configuration";

const { LEDGER_FILE, LEDGER_NAME, DATABASE_URL, COMPANY } = APP_CONFIG;

// Phase 0: ledger content lives in Postgres (see AI_INTEGRATION_PLAN.md Part 6).
// Falls back to the file-based repository only when DATABASE_URL isn't set,
// so an unconfigured environment fails obviously rather than silently.
const repository = DATABASE_URL
  ? createPostgresLedgerRepository(getSql(), LEDGER_NAME, COMPANY)
  : createLedgerRepository(LEDGER_FILE, COMPANY);

await repository.load();

const services = createServiceContainer(repository);
const app = createApp(services);
const { fetch } = app;
const port = APP_PORT;
console.log(
  `[api] env=${APP_ENV} company=${COMPANY} ledger=${DATABASE_URL ? `postgres:${LEDGER_NAME}` : LEDGER_FILE}`
);

const server = Bun.serve({
  fetch: (request, server) => fetch(request, server),
  port,
  hostname: APP_HOSTNAME,
});
const { protocol, hostname } = server;

console.log(`[api] listening on ${protocol}://${hostname}:${port}`);