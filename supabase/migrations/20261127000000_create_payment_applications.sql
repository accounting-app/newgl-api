-- How much of each payment went to each invoice or bill, so a document can be
-- paid in parts and one payment (or an unapplied credit) can cover several.
-- invoices/bills.payment_transaction_id stays as "the latest payment", and
-- status becomes PAID only once the applications add up to the amount.
--
-- `payment_transaction_id` is plain text for the same reason as on those
-- tables: transactions live in the ledger's .bean content.
create table payment_applications (
  id                     uuid primary key default gen_random_uuid(),
  ledger_id              uuid not null references ledgers(id) on delete cascade,
  invoice_id             uuid references invoices(id) on delete cascade,
  bill_id                uuid references bills(id) on delete cascade,
  payment_transaction_id text not null,
  amount                 numeric(12, 2) not null check (amount > 0),
  created_at             timestamptz not null default now(),
  check ((invoice_id is null) <> (bill_id is null))
);

create index payment_applications_ledger_id_idx on payment_applications (ledger_id);
create index payment_applications_invoice_id_idx on payment_applications (invoice_id);
create index payment_applications_bill_id_idx on payment_applications (bill_id);
create index payment_applications_transaction_idx on payment_applications (payment_transaction_id);

alter table payment_applications enable row level security;
-- No policies: deny-by-default backstop, same rationale as every other
-- ledger-scoped table -- see migration 20260826000000.

-- Everything already marked paid was paid in full by its payment.
insert into payment_applications (ledger_id, invoice_id, payment_transaction_id, amount, created_at)
select ledger_id, id, payment_transaction_id, amount, updated_at
from invoices where status = 'PAID' and payment_transaction_id is not null;

insert into payment_applications (ledger_id, bill_id, payment_transaction_id, amount, created_at)
select ledger_id, id, payment_transaction_id, amount, updated_at
from bills where status = 'PAID' and payment_transaction_id is not null;
