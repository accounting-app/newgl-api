-- QBO lets you finish a reconciliation even when the difference isn't
-- $0.00: "Hold on! Your difference isn't $0.00 yet" -> confirm an
-- "Adjustment date" -> "Add adjustment and finish" posts a real
-- transaction against a "Reconciliation Discrepancies" account for
-- exactly the difference amount, then finishes as normal. Separate
-- columns from service_charge_*/interest_earned_* -- those are
-- statement-driven adjustments the user enters on the setup screen;
-- this one is a last-resort balancing entry the finish route itself
-- computes and only creates when the caller explicitly confirms it.
alter table reconciliations
  add column discrepancy_adjustment_amount numeric(12, 2),
  add column discrepancy_adjustment_transaction_id text;
