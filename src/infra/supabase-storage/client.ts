import { SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } from "@/configuration";

// Plain-fetch calls to Supabase's own Storage REST API, no SDK -- same
// convention tests/helpers/supabase-test-auth.ts already uses for the Auth
// admin API. This is the first Storage (blob) use in this backend;
// everything else so far is either the ledger's own Postgres-backed
// content or a plain Postgres table (see QBO_FREE_FEATURES_PLAN.md's
// Phase 1.5 note on Receipts).
const RECEIPTS_BUCKET = "receipts";

function requireConfig(): { url: string; key: string } {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to use receipt storage.");
  }
  return { url: SUPABASE_URL, key: SUPABASE_SERVICE_ROLE_KEY };
}

let bucketEnsured = false;

/**
 * Creates the (private) `receipts` bucket if it doesn't already exist.
 * Idempotent and cheap to call on every upload -- Storage returns 200/409
 * either way, and the in-process `bucketEnsured` flag skips the check
 * entirely after the first successful call in this process's lifetime.
 */
export async function ensureReceiptsBucketExists(): Promise<void> {
  if (bucketEnsured) return;
  const { url, key } = requireConfig();

  const existsRes = await fetch(`${url}/storage/v1/bucket/${RECEIPTS_BUCKET}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  if (existsRes.ok) {
    bucketEnsured = true;
    return;
  }

  const createRes = await fetch(`${url}/storage/v1/bucket`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
    body: JSON.stringify({ id: RECEIPTS_BUCKET, name: RECEIPTS_BUCKET, public: false })
  });
  if (!createRes.ok) {
    // Supabase Storage reports "already exists" as an HTTP 400 with a
    // {code: "BucketAlreadyExists"} body, not a 409 -- checked via the
    // bucket-already-created curl test against the local stack. A
    // concurrent request winning the race is fine either way.
    const body = (await createRes.json().catch(() => ({}))) as { code?: string };
    if (body.code !== "BucketAlreadyExists") {
      throw new Error(`Could not create the '${RECEIPTS_BUCKET}' storage bucket: ${createRes.status} ${JSON.stringify(body)}`);
    }
  }
  bucketEnsured = true;
}

export async function uploadReceiptObject(path: string, content: ArrayBuffer, contentType: string): Promise<void> {
  await ensureReceiptsBucketExists();
  const { url, key } = requireConfig();

  const res = await fetch(`${url}/storage/v1/object/${RECEIPTS_BUCKET}/${path}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": contentType,
      "x-upsert": "true"
    },
    body: content
  });
  if (!res.ok) {
    throw new Error(`Could not upload receipt file: ${res.status} ${await res.text()}`);
  }
}

export async function downloadReceiptObject(path: string): Promise<{ content: ArrayBuffer; contentType: string }> {
  const { url, key } = requireConfig();

  const res = await fetch(`${url}/storage/v1/object/${RECEIPTS_BUCKET}/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  if (!res.ok) {
    throw new Error(`Could not download receipt file: ${res.status} ${await res.text()}`);
  }
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  return { content: await res.arrayBuffer(), contentType };
}

export async function deleteReceiptObject(path: string): Promise<void> {
  const { url, key } = requireConfig();

  await fetch(`${url}/storage/v1/object/${RECEIPTS_BUCKET}/${path}`, {
    method: "DELETE",
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  }).catch(() => {
    // Best-effort -- an orphaned storage object is a cheap, recoverable
    // problem; failing the whole delete over it is worse for the user.
  });
}
