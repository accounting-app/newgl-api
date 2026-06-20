import { writeFile } from "node:fs/promises";

import { createServiceContainer } from "../src/application/create-service-container";
import { createLedgerRepository } from "../src/infra/beancount/repository";
import { createApp } from "../src/http/app";

const repository = createLedgerRepository("data/openapi-fixture.bean", "OpenAPI Fixture");
await repository.load();
const app = createApp(createServiceContainer(repository));

const spec = app.getOpenAPIDocument({
  openapi: "3.1.0",
  info: {
    title: "Bank Register API",
    version: "1.0.0"
  },
  servers: [{ url: "http://localhost:3001/api" }]
});

await writeFile("openapi.json", `${JSON.stringify(spec, null, 2)}\n`, "utf8");
console.log("Wrote openapi.json");
