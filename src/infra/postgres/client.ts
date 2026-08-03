import { SQL } from "bun";

let client: SQL | null = null;

export function getSql(): SQL {
  if (!client) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is not set — required for Postgres-backed ledger storage.");
    }
    // Supabase's Transaction pooler (PgBouncer, port 6543) doesn't support
    // server-side prepared statements across pooled connections -- each
    // query can land on a different backend connection mid-session, so a
    // statement prepared on one physical connection may not exist (or may
    // collide with a same-named one) on the next. Disabling client-side
    // prepare avoids both "does not exist" and "already exists" errors.
    client = new SQL(url, { prepare: false });
  }
  return client;
}
