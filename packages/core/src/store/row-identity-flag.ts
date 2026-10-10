/**
 * Switch for row uids (T12341). ON by default since T13305 (C2): the
 * real-store Gate B of the release recipe passed on every store (spec
 * `t12341-uid-scheme` §15.0). `CLEO_ROW_UID_FILL=0` is the kill switch: with it,
 * the open pass does not run, no per-connection trigger is installed, and new
 * rows get no uid. Kept tiny so the Drizzle schema can use
 * {@link defaultRowUid}.
 *
 * @module
 * @task T12341
 * @task T13305
 */

import { type SQL, sql } from 'drizzle-orm';
import { uuidv7 } from '../cloud/uuidv7.js';

/** Environment variable whose value `0` turns row uids OFF (the kill switch; T13305). */
export const ROW_UID_FILL_FLAG = 'CLEO_ROW_UID_FILL';

/**
 * Whether row uids are enabled for this process.
 *
 * @returns `false` only when {@link ROW_UID_FILL_FLAG} is `0` (on by default).
 */
export function rowUidFillEnabled(): boolean {
  return process.env[ROW_UID_FILL_FLAG] !== '0';
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
