import { loadConfig } from "@/config";
import { createServiceContainer } from "@/application/create-service-container";
import { createLedgerRepository } from "@/infra/beancount/repository";
import { createApp } from "@/http/app";

const config = loadConfig();
const repository = createLedgerRepository(config.ledgerFile, config.company);

await repository.load();

const services = createServiceContainer(repository);
const app = createApp(services);

console.log(`[api] company=${config.company} ledger=${config.ledgerFile}`);

const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  fetch: app.fetch
});

console.log(`[api] listening on http://${server.hostname}:${server.port}`);
