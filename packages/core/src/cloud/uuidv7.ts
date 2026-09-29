/**
 * UUIDv7 minting, kept free of other imports so the store's open path can use
 * it without loading the cloud crypto module (T12341 row uids).
 *
 * @module
 */

import { randomBytes } from 'node:crypto';

/** A UUIDv7 (RFC 9562 §5.7): 48-bit Unix millis, then random bits. Mints checkpoint ids and row uids. */
export function uuidv7(now: number = Date.now()): string {
  const b = randomBytes(16);
  const ms = BigInt(Math.max(0, Math.floor(now)));
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x70;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
