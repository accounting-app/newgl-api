import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink, writeFile } from "node:fs/promises";

import { createServiceContainer } from "../src/application/create-service-container";
import { createApp } from "../src/http/app";
import { BeancountLedgerRepository } from "../src/infra/beancount/repository";

const TEST_PASSWORD = "test-debug-password";
const ledgerFile = `/tmp/newgl-debug-${crypto.randomUUID()}.bean`;
const ledgerContents = ';; test ledger\noption "title" "Test Co"\n';

describe("GET /api/debug/ledger-source", () => {
  let app: ReturnType<typeof createApp>;
  const savedEnv = {
    password: process.env.DEBUG_LEDGER_PASSWORD,
    ledgerFile: process.env.LEDGER_FILE,
    appEnv: process.env.APP_ENV,
  };

  beforeAll(async () => {
    process.env.DEBUG_LEDGER_PASSWORD = TEST_PASSWORD;
    process.env.LEDGER_FILE = ledgerFile;
    process.env.APP_ENV = "local";

    await writeFile(ledgerFile, ledgerContents);

    const repository = new BeancountLedgerRepository(ledgerFile, "Test Co");
    await repository.load();
    app = createApp(createServiceContainer(repository));
  });

  afterAll(async () => {
    if (savedEnv.password === undefined) {
      delete process.env.DEBUG_LEDGER_PASSWORD;
    } else {
      process.env.DEBUG_LEDGER_PASSWORD = savedEnv.password;
    }
    if (savedEnv.ledgerFile === undefined) {
      delete process.env.LEDGER_FILE;
    } else {
      process.env.LEDGER_FILE = savedEnv.ledgerFile;
    }
    if (savedEnv.appEnv === undefined) {
      delete process.env.APP_ENV;
    } else {
      process.env.APP_ENV = savedEnv.appEnv;
    }
    await unlink(ledgerFile).catch(() => {});
  });

  test("returns 401 for wrong password", async () => {
    const res = await app.request("/api/debug/ledger-source", {
      headers: { "X-Debug-Password": "wrong" },
    });
    expect(res.status).toBe(401);
  });

  test("returns 200 and ledger contents for correct password", async () => {
    const res = await app.request("/api/debug/ledger-source", {
      headers: { "X-Debug-Password": TEST_PASSWORD },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ledgerContents);
  });

  test("returns 404 when password env is unset", async () => {
    delete process.env.DEBUG_LEDGER_PASSWORD;
    const res = await app.request("/api/debug/ledger-source", {
      headers: { "X-Debug-Password": TEST_PASSWORD },
    });
    expect(res.status).toBe(404);
    process.env.DEBUG_LEDGER_PASSWORD = TEST_PASSWORD;
  });

  // NOTE: Commentted out because it's not needed for now. Will be used in the future.
  // test("returns 404 in production", async () => {
  //   process.env.APP_ENV = "production";
  //   const res = await app.request("/api/debug/ledger-source", {
  //     headers: { "X-Debug-Password": TEST_PASSWORD },
  //   });
  //   expect(res.status).toBe(404);
  //   process.env.APP_ENV = "local";
  // });

  test("returns 404 when allow ledger read is false", async () => {
    process.env.ALLOW_LEDGER_READ = "false";
    const res = await app.request("/api/debug/ledger-source", {
      headers: { "X-Debug-Password": TEST_PASSWORD },
    });
    expect(res.status).toBe(404);
    process.env.ALLOW_LEDGER_READ = "true";
  });
});
