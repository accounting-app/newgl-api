import { timingSafeEqual } from "node:crypto";

export function isValidPassword(provided: string, expected: string): boolean {
  if (!expected) return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) return false;
  const safeEqual = timingSafeEqual(providedBuffer, expectedBuffer);
  return safeEqual;
}