/**
 * Restores the configured Beancount ledger (`company.bean`) to its default
 * state — i.e. the version committed to git. This is the inverse of
 * `generate-transactions`: it discards any locally generated/added transactions
 * and leaves the file exactly as it was shipped.
 *
 * Usage:
 *   bun run clean-transactions
 *
 * The committed `company.bean` is the single source of truth for the default,
 * so there is no separate baseline copy to maintain. Whatever you commit as
 * `company.bean` is what `clean` restores to.
 */
import { COMPANY, LEDGER_FILE } from "@/configuration";
import { parseBeancount } from "@/infra/beancount/parser";

async function git(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text()
  ]);
  const code = await proc.exited;
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function countTransactions(): Promise<number> {
  const file = Bun.file(LEDGER_FILE);
  if (!(await file.exists())) return 0;
  return parseBeancount(await file.text()).transactions.length;
}

async function main(): Promise<void> {
  const insideRepo = await git(["rev-parse", "--is-inside-work-tree"]);
  if (insideRepo.code !== 0 || insideRepo.stdout !== "true") {
    throw new Error(
      `Not inside a git repository, so the default ${LEDGER_FILE} cannot be restored from git.`
    );
  }

  const tracked = await git(["ls-files", "--error-unmatch", "--", LEDGER_FILE]);
  if (tracked.code !== 0) {
    throw new Error(
      `${LEDGER_FILE} is not committed to git yet. Commit your default ledger first ` +
        `(git add ${LEDGER_FILE} && git commit), then re-run clean-transactions.`
    );
  }

  const diff = await git(["diff", "--quiet", "HEAD", "--", LEDGER_FILE]);
  if (diff.code === 0) {
    console.log(`${LEDGER_FILE} already matches the committed default. Nothing to do.`);
    return;
  }

  const before = await countTransactions();
  const restore = await git(["checkout", "HEAD", "--", LEDGER_FILE]);
  if (restore.code !== 0) {
    throw new Error(`Failed to restore ${LEDGER_FILE} from git: ${restore.stderr}`);
  }
  const after = await countTransactions();
  const removed = before - after;

  console.log(
    `Restored ${LEDGER_FILE} (${COMPANY}) to the committed default ` +
      `(${after} transaction${after === 1 ? "" : "s"}` +
      `${removed > 0 ? `, removed ${removed}` : ""}).`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
