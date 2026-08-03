import { getSql } from "../../src/infra/postgres/client";

export const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
// Well-known local Supabase dev key -- identical on every `supabase start`,
// never a real secret. Overridable via env for CI stacks that differ.
export const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

export type TestUser = { id: string; email: string; accessToken: string };

export async function createConfirmedUser(email: string, password: string): Promise<TestUser> {
  const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`
    },
    body: JSON.stringify({ email, password, email_confirm: true })
  });
  if (!createRes.ok) {
    throw new Error(`admin/users create failed: ${createRes.status} ${await createRes.text()}`);
  }
  const created = (await createRes.json()) as { id: string };

  const tokenRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SERVICE_ROLE_KEY },
    body: JSON.stringify({ email, password })
  });
  if (!tokenRes.ok) {
    throw new Error(`token grant failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const token = (await tokenRes.json()) as { access_token: string };

  return { id: created.id, email, accessToken: token.access_token };
}

export async function deleteUser(userId: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: "DELETE",
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` }
  }).catch(() => {});
}

export async function localSupabaseStackIsReachable(): Promise<boolean> {
  try {
    const health = await fetch(`${SUPABASE_URL}/auth/v1/health`);
    if (!health.ok) return false;
    await getSql()`select 1`;
    return true;
  } catch {
    return false;
  }
}
