# General Ledger API

Single-tenant REST API backed by one strict Beancount (`.bean`) file per company. Implements the same service contracts as the Next.js UI and exposes a generated OpenAPI contract for portability.

## Stack

- **Runtime:** Bun
- **HTTP:** Hono + `@hono/zod-openapi`
- **Validation:** Zod
- **Storage:** Beancount text file (`LEDGER_FILE`)

## Architecture (hexagonal)

```text
src/
  core/           Pure domain (double-entry, periods, derived balances)
  domain/         Zod schemas + types (API contract)
  application/    Service interfaces + implementations
  infra/beancount Beancount parser/serializer + LedgerRepository adapter
  http/           Hono routes (thin layer)
```

The only format-aware code lives in `src/infra/beancount/`. Everything else is storage-agnostic and can be reused if you migrate to Postgres, SQLite, or another language.

### LedgerRepository port

```typescript
interface LedgerRepository {
  load(): Promise<void>;
  getStore(): LedgerStore;
  mutate<T>(fn: (store: LedgerStore) => Promise<T>): Promise<T>;
}
```

- `load()` reads the `.bean` file into memory and derives ledger postings, register rows, and balances.
- `mutate()` runs a write transaction: update the in-memory store, re-serialize to Beancount, atomically replace the file.

## Beancount ↔ QBO mapping

| QBO / domain concept | Beancount representation |
|---|---|
| Account | `open` / `close` directive; path = category root + slugified name |
| Account UUID | `id:` metadata on `open` |
| Display name | `name:` metadata (path uses slug) |
| QBO category (BANK, EXPENSE, …) | `qbo-category:` metadata + path prefix |
| QBO detail type | `qbo-subtype:` metadata |
| Account number | `account-number:` metadata |
| Transaction | `*` (posted) or `!` (draft) transaction directive |
| Transaction UUID | `id:` metadata |
| QBO transaction type | `qbo-type:` metadata |
| Reference number | `ref:` metadata + `^link` |
| Status (POSTED, VOIDED, …) | `status:` metadata |
| Journal posting DEBIT/CREDIT | Signed amount (debit-normal accounts: + = debit; credit-normal: + = credit) |
| Reconcile C/R flag | `reconcile:` posting metadata on source-account leg |
| Void / reverse | New balancing transaction + `reference-original-id:` link; original marked `status: VOIDED` |

**Derived (never stored):** `LedgerPosting[]`, `RegisterEntry[]`, running balances, trial balance.

## Configuration

Copy `.env.example` to `.env`:

```env
APP_ENV=local | development | staging | production
COMPANY=Maple Lane Studio LLC
LEDGER_FILE=data/company.bean
PORT=3001
HOST=0.0.0.0
```

Each company deployment has it own `LEDGER_FILE` `data/company.bean`

## Commands

```bash
bun install
bun run dev          # watch mode
bun run start        # production
bun test             # unit tests (includes beancount_standard.bean fixture)
bun run seed         # CSV → open directives (imported_chart_of_accounts.csv)
bun run openapi      # regenerate openapi.json
bun run bean-check   # optional: requires Python beancount CLI
```

## API endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/accounts` | List accounts |
| POST | `/api/accounts` | Create account |
| GET | `/api/accounts/:id` | Get account |
| PATCH | `/api/accounts/:id` | Update account |
| GET | `/api/accounts/:id/register` | Register entries |
| GET | `/api/transactions` | List transactions |
| POST | `/api/transactions` | Create draft transaction |
| GET | `/api/transactions/:id` | Get transaction |
| POST | `/api/transactions/:id/post` | Post transaction |
| POST | `/api/transactions/:id/void` | Void transaction |
| POST | `/api/transactions/:id/reverse` | Reverse transaction |
| POST | `/api/deposits` | Create + post deposit |
| POST | `/api/transfers` | Create + post transfer |
| POST | `/api/expenses` | Create + post expense |
| PATCH | `/api/register/:entryId` | Update register entry |
| POST | `/api/register/:entryId/reconcile` | Set reconcile status |
| DELETE | `/api/register/:entryId` | Delete pending entry |
| GET | `/api/ledger/postings` | All ledger postings |
| GET | `/openapi.json` | OpenAPI 3.1 spec |

## UI integration

Set in the UI `.env.local`:

```env
NEXT_PUBLIC_API_URL=http://localhost:3001/api
```

When set, the UI uses HTTP services instead of in-browser mocks.

## Migrating to another language

1. Read `openapi.json` for the HTTP contract.
2. Read this mapping table and implement `LedgerRepository` against the same `.bean` format.
3. Port `src/core/` (pure functions, no I/O) for business rules.
4. Re-implement the four services against your repository.

The Beancount file remains the portable source of truth; Fava and `bean-check` can validate it independently.
