/**
 * Opt-in switch for row uids (T12341). OFF by default until a real-store
 * Gate B of the release recipe passes in CI: with it off, the open pass does
 * not run, no per-connection trigger is installed, and new rows get no uid.
 * Kept tiny so the Drizzle schema can use {@link defaultRowUid}.
 *
 * @module
 * @task T12341
 */

import { type SQL, sql } from 'drizzle-orm';
import { uuidv7 } from '../cloud/uuidv7.js';

/** Environment variable that turns row uids ON (`1`). */
export const ROW_UID_FILL_FLAG = 'CLEO_ROW_UID_FILL';

/**
 * Whether row uids are enabled for this process.
 *
 * @returns `true` only when {@link ROW_UID_FILL_FLAG} is `1`.
 */
export function rowUidFillEnabled(): boolean {
  return process.env[ROW_UID_FILL_FLAG] === '1';
}

/**
 * Drizzle `$defaultFn` for a minted table's uid: a random UUIDv7 when row
 * uids are enabled, else SQL NULL (the open pass fills it once they are).
 *
 * @returns A uid, or `NULL`.
 */
export function defaultRowUid(): string | SQL {
  return rowUidFillEnabled() ? uuidv7() : sql`NULL`;
}
