import { timingSafeEqual } from "node:crypto";

export function isValidPassword(provided: string, expected: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(provided);
  console.log('a: ', a)
  const b = Buffer.from(expected);
  console.log('b: ', b)
  if (a.length !== b.length) return false;
  const safeEqual = timingSafeEqual(a, b);
  console.log('safeEqual: ', safeEqual)
  return safeEqual;
}