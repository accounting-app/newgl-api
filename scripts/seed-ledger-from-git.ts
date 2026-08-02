// One-time Phase 0 migration: load data/company.bean AS COMMITTED IN GIT (not the
// working-tree copy, which may have local test edits) into the `ledgers` table.
//
// Run once against a fresh database:  bun run seed:ledger
//
// Safe to re-run: it's a no-op if a 'company' ledger row already exists.

import { getSql } from "../src/infra/postgres/client";
import { parseBeancount, serializeBeancount } from "../src/infra/beancount/parser";

const LEDGER_NAME = "company";
const GIT_PATH = "data/company.bean";

async function sha256(text: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex");
}

async function main() {
  const sql = getSql();

  const existing = await sql`
    select id from ledgers where name = ${LEDGER_NAME} and tenant_id is null limit 1
  `;
  if (existing.length > 0) {
    console.log(`[seed] '${LEDGER_NAME}' ledger already exists (id=${existing[0].id}) — nothing to do.`);
    await sql.close();
    return;
  }

  const proc = Bun.spawn(["git", "show", `HEAD:${GIT_PATH}`], { stdout: "pipe", stderr: "pipe" });
  const [content, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  if (exitCode !== 0) {
    throw new Error(`git show HEAD:${GIT_PATH} failed: ${stderr.trim()}`);
  }

  // Validate before persisting: parse, then re-serialize, so a malformed
  // committed file can never become the seeded source of truth.
  const parsed = parseBeancount(content);
  const normalized = serializeBeancount(parsed);
  const hash = await sha256(normalized);

  const [ledger] = await sql`
    insert into ledgers (tenant_id, name, is_primary, content, content_hash, version)
    values (null, ${LEDGER_NAME}, true, ${normalized}, ${hash}, 1)
    returning id
  `;

  await sql`
    insert into ledger_versions (ledger_id, version, content, content_hash, source)
    values (${ledger.id}, 1, ${normalized}, ${hash}, 'bootstrap')
  `;

  console.log(
    `[seed] seeded '${LEDGER_NAME}' ledger (id=${ledger.id}) from ${GIT_PATH}@HEAD ` +
      `— ${parsed.transactions.length} transactions, ${parsed.opens.length} accounts.`
  );
  await sql.close();
}

main().catch((error) => {
  console.error("[seed] failed:", error);
  process.exit(1);
});
