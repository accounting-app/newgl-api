-- QBO's "Reconciliation Discrepancy Report" lists reconciled transactions
-- that were changed or deleted afterwards. Detecting that needs to know
-- what each transaction looked like WHEN it was reconciled. The amount
-- column already existed (cleared_amount_snapshot, never populated); the
-- date is added here. Both are the account's natural-balance effect and
-- the transaction date at the moment of Finish. Sessions finished before
-- this migration have nulls, so they are only checked for being deleted
-- or no longer reconciled, not for amount/date changes.
alter table reconciliation_entries
  add column if not exists date_snapshot date;
