/**
 * Mandatory consolidation pragma set for the SG-DB-SUBSTRATE-V2 spike (T11244).
 *
 * These are the pragmas the spike validates as the *target* consolidation
 * policy — NOT the current `specs/sqlite-pragmas.json` set. The two differ in
 * exactly one value: `busy_timeout`. The spike mandates `30000` (30 s) per the
 * epic ACs ("busy_timeout=30000 … reduces lock-contention crashes ~40% per
 * research"), whereas today's shipped SSoT uses `5000`. Aligning the live SSoT
 * to 30000 is downstream epic E2 work; the spike measures against the target.
 *
 * Every consolidated-file open in the spike harnesses applies this exact set
 * uniformly so concurrency/durability/idempotency numbers reflect the proposed
 * runtime, not the legacy one.
 *
 * @task T11244
 * @task T11322
 * @saga T11242
 */
import type { DatabaseSync } from 'node:sqlite';

/**
 * Canonical (name, value) pragma pairs applied per consolidated-file open.
 * Order matters: `journal_mode=WAL` must precede the durability-relevant
 * pragmas so they apply against the WAL journal.
 */
export const SPIKE_PRAGMAS: ReadonlyArray<readonly [string, string]> = [
  ['journal_mode', 'WAL'],
  ['synchronous', 'NORMAL'],
  ['busy_timeout', '30000'],
  ['wal_autocheckpoint', '1000'],
  ['foreign_keys', 'ON'],
] as const;

/**
 * The five mandatory pragmas the epic ACs require, expressed as the values
 * `PRAGMA <name>` reports back after application. Used by the fixture harness
 * to assert post-open pragma state.
 */
export const EXPECTED_PRAGMA_READBACK: Readonly<Record<string, string | number>> = {
  // journal_mode reports lowercase 'wal'
  journal_mode: 'wal',
  // synchronous reports the numeric level: NORMAL === 1
  synchronous: 1,
  busy_timeout: 30000,
  wal_autocheckpoint: 1000,
  foreign_keys: 1,
} as const;

/**
 * Apply the mandatory consolidation pragma set to an open `DatabaseSync`
 * handle. Idempotent and safe to call on every open.
 *
 * @param db - An open `node:sqlite` `DatabaseSync` handle.
 */
export function applySpikePragmas(db: DatabaseSync): void {
  for (const [name, value] of SPIKE_PRAGMAS) {
    db.exec(`PRAGMA ${name} = ${value};`);
  }
}
