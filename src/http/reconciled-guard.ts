import type { Context } from "hono";

import type { RegisterEntry } from "@/domain/models";
import { ReconciledTransactionError } from "@/core/errors";
import { getServices } from "@/http/context";

const CONFIRM_HEADER = "x-confirm-reconciled";

const MESSAGE =
  "This transaction has been reconciled. Changing or deleting it can put your books out of balance with the bank statement it was reconciled against. Do you want to continue?";

function confirmed(context: Context): boolean {
  return context.req.header(CONFIRM_HEADER) === "true";
}

/** Warn (409) before changing/removing a transaction that has a reconciled register entry. */
export async function guardReconciledTransaction(context: Context, transactionId: string): Promise<void> {
  if (confirmed(context)) return;
  const { registerService } = getServices(context);
  const detail = await registerService.getTransactionDetail(transactionId).catch(() => undefined);
  if (detail?.registerEntries.some((entry) => entry.reconcileStatus === "R")) {
    throw new ReconciledTransactionError(MESSAGE);
  }
}

/** Same warning when the caller only has a register entry id (inline edit/delete). */
export async function guardReconciledEntry(context: Context, entryId: string): Promise<void> {
  if (confirmed(context)) return;
  const { accountService, registerService } = getServices(context);
  const accounts = await accountService.listAccounts();
  for (const account of accounts) {
    const entries: RegisterEntry[] = await registerService.listRegisterEntries(account.id);
    const match = entries.find((entry) => entry.id === entryId);
    if (match) {
      if (match.reconcileStatus === "R") throw new ReconciledTransactionError(MESSAGE);
      return;
    }
  }
}
