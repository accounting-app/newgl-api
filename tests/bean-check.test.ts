import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { documentToStore, storeToDocument } from "../src/infra/beancount/mapper";
import { parseBeancount, serializeBeancount } from "../src/infra/beancount/parser";

const fixturePath = resolve(import.meta.dir, "../../data_stucture/beancount_standard.bean");

describe("bean-check (optional)", () => {
  test("generated ledger passes bean-check when CLI is available", async () => {
    const source = await readFile(fixturePath, "utf8");
    const document = parseBeancount(source);
    const store = documentToStore(document);
    const serialized = serializeBeancount(storeToDocument(store, document));
    const tempFile = `/tmp/newgl-beancheck-${crypto.randomUUID()}.bean`;
    await writeFile(tempFile, serialized, "utf8");

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(["bean-check", tempFile], { stdout: "pipe", stderr: "pipe" });
    } catch {
      console.warn("bean-check not installed; skipping validation");
      return;
    }

    const exitCode = await proc.exited;

    const stderr = await new Response(proc.stderr).text();
    expect(exitCode, stderr).toBe(0);
  });
});
