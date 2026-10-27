-- Files are kept in separate lists per area of the app: the Receipts inbox
-- ('receipts'), the "+ New" quick-add forms -- Expense, Sales Receipt,
-- Deposit -- ('forms'), and the Bank transactions screen ('bank'). Every
-- existing row belongs to the Receipts inbox.
alter table receipts
  add column zone text not null default 'receipts'
  check (zone in ('receipts', 'forms', 'bank'));

create index receipts_zone_idx on receipts (ledger_id, zone);
