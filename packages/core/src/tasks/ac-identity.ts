/**
 * Acceptance-criterion identity: canonical text, text hash and row id.
 *
 * A leaf module with no schema imports. The store computes AC row identities
 * whenever it opens (`store/row-identity.ts`, `store/sqlite-data-accessor.ts`),
 * and `./ac-table.js` imports the zod acceptance-gate schema, which every
 * command opening a store would otherwise load. `./ac-table.js` re-exports
 * these helpers.
 *
 * @adr ADR-079-r1 §2.2
 * @task T10508
 * @task T13126 - split out of ac-table.ts
 */

import { createHash } from 'node:crypto';

/**
 * Canonical text used for AC hashing/idempotency. It deliberately ignores
 * display-only ordering and task lifecycle fields: ordinals, titles, and
 * statuses never enter this value.
 */
export function canonicalizeAcText(text: string): string {
  return text.normalize('NFKC').replace(/\r\n?/g, '\n').trim();
}

/** Build a deterministic sha256 over the canonical AC representation. */
export function acTextHash(text: string): string {
  return createHash('sha256').update(canonicalizeAcText(text)).digest('hex');
}

/**
 * Deterministic UUID-shaped AC id derived only from owning task + canonical AC identity.
 * This is UUIDv5-shaped for ecosystem compatibility, but it is intentionally
 * implemented with SHA-256 so we do not introduce a new runtime dependency.
 */
export function buildAcRowId(taskId: string, canonicalIdentity: string): string {
  const hex = createHash('sha256')
    .update(`cleo-ac-row\0${taskId}\0${canonicalIdentity}`)
    .digest('hex');
  const chars = hex.split('');
  chars[12] = '5';
  chars[16] = ((Number.parseInt(chars[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return `${chars.slice(0, 8).join('')}-${chars.slice(8, 12).join('')}-${chars
    .slice(12, 16)
    .join('')}-${chars.slice(16, 20).join('')}-${chars.slice(20, 32).join('')}`;
}
