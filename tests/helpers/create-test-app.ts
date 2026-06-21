import { createServiceContainer } from "../../src/application/create-service-container";
import { createApp } from "../../src/http/app";
import { BeancountLedgerRepository } from "../../src/infra/beancount/repository";

export async function createTestApp() {
  const ledgerFile = `/tmp/newgl-http-${crypto.randomUUID()}.bean`;
  const repository = new BeancountLedgerRepository(ledgerFile, "Test Co");
  await repository.load();
  const services = createServiceContainer(repository);
  const app = createApp(services);
  return { app, services, ledgerFile };
}

export function jsonHeaders(): HeadersInit {
  return { "Content-Type": "application/json" };
}

export async function readJson<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}