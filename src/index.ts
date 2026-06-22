import { createServiceContainer } from "@/application/create-service-container";
import { createLedgerRepository } from "@/infra/beancount/repository";
import { createApp } from "@/http/app";
import { APP_ENV, APP_CONFIG, APP_PORT, APP_HOSTNAME } from "@/configuration";

const { LEDGER_FILE, COMPANY } = APP_CONFIG;

const repository = createLedgerRepository(LEDGER_FILE, COMPANY);

await repository.load();

const services = createServiceContainer(repository);
const app = createApp(services);
const { fetch } = app;
const port = APP_PORT;
console.log(
  `[api] env=${APP_ENV} company=${COMPANY} ledger=${LEDGER_FILE}`
);

const server = Bun.serve({
  fetch,
  port,
  hostname: APP_HOSTNAME,
});
const { protocol, hostname } = server;

console.log(`[api] listening on ${protocol}://${hostname}:${port}`);
