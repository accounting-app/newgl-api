import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { documentToStore, storeToDocument } from "../src/infra/beancount/mapper";
import { parseBeancount, serializeBeancount } from "../src/infra/beancount/parser";
import { BEANCOUNT_STANDARD_FIXTURE } from "./helpers/constants";
const fixturePath = BEANCOUNT_STANDARD_FIXTURE

const MINIMAL_LEDGER = [
  'option "title" "Test Co"',
  'option "operating_currency" "USD"',
  "",
  "2024-01-01 open Assets:Cash USD",
  '  id: "acct-cash"',
  "2024-01-01 open Expenses:Misc USD",
  '  id: "acct-expense"',
  "",
  '2024-02-01 * "Payee" "Memo"',
  '  id: "txn-1"',
  "  Assets:Cash 10.00 USD",
  "  Expenses:Misc -10.00 USD"
].join("\n");

const IMPLICIT_POSTING_LEDGER = [
  'option "title" "Test Co"',
  'option "operating_currency" "USD"',
  "",
  "2024-01-01 open Expenses:Software USD",
  '  id: "acct-expense"',
  "2024-01-01 open Liabilities:CreditCard:Amex USD",
  '  id: "acct-card"',
  "",
  '2024-01-05 * "Figma" "Design subscription"',
  '  id: "txn-1"',
  "  Expenses:Software 45.00 USD",
  "  Liabilities:CreditCard:Amex"
].join("\n");

async function runBeanCheck(source: string): Promise<{ exitCode: number; stderr: string } | null> {
  const tempFile = `/tmp/newgl-beancheck-${crypto.randomUUID()}.bean`;
  await writeFile(tempFile, source, "utf8");

  try {
    const proc = Bun.spawn(["bean-check", tempFile], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    return { exitCode, stderr };
  } catch {
    return null;
  }
}

function domainRoundTrip(source: string): string {
  const document = parseBeancount(source);
  const store = documentToStore(document);
  return serializeBeancount(storeToDocument(store, document));
}

describe("bean-check (optional)", () => {
  test("reference fixture passes bean-check", async () => {
    const source = await readFile(fixturePath, "utf8");
    const result = await runBeanCheck(source);
    if (!result) {
      console.warn("bean-check not installed; skipping validation");
      return;
    }
    expect(result.exitCode, result.stderr).toBe(0);
  });

  test("minimal explicit ledger round-trips through domain and passes bean-check", async () => {
    const serialized = domainRoundTrip(MINIMAL_LEDGER);
    const result = await runBeanCheck(serialized);
    if (!result) {
      console.warn("bean-check not installed; skipping validation");
      return;
    }
    expect(result.exitCode, result.stderr).toBe(0);
  });

  test("implicit posting ledger round-trips through domain and passes bean-check", async () => {
    const serialized = domainRoundTrip(IMPLICIT_POSTING_LEDGER);
    const result = await runBeanCheck(serialized);
    if (!result) {
      console.warn("bean-check not installed; skipping validation");
      return;
    }
    expect(result.exitCode, result.stderr).toBe(0);
  });
});
