export function createId(): string {
  return crypto.randomUUID();
}

const ID_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/** Deterministic UUID v5 (SHA-1) of `name` within the fixed namespace. */
export function createStableId(name: string): string {
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(Buffer.from(ID_NAMESPACE.replace(/-/g, ""), "hex"));
  hasher.update(name);
  const bytes = hasher.digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Buffer.from(bytes.subarray(0, 16)).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
