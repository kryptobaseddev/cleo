/**
 * Hybrid logical clock (HLC) for the change journal.
 *
 * Wire format (fixed by the cloud contract, `Hlc` in `@cleocode/contracts`):
 * `PPPPPPPPPPPPP-CCCCCC-<replica uuid>`, where `P` is physical milliseconds
 * since the Unix epoch zero-padded to 13 digits, `C` is the logical counter
 * zero-padded to 6 digits, and the replica id is the lowercase UUIDv7 of the
 * store that issued the timestamp. Tuple order `(phys, ctr, replica)` is
 * exactly the lexical order of the encoded string, so SQL `ORDER BY hlc` and
 * `MAX(hlc)` are correct.
 *
 * This module is pure. The persisted clock row lives in `clock-store.ts`.
 *
 * It never reads time from a uid (journal spec R7, T12341 §5.2): a backfilled
 * uid's timestamp is the row's birth, or 0, not the time of a change. The
 * module therefore imports nothing, and a test pins that.
 *
 * @task T12342
 * @module store/sync/hlc
 */

/** A decoded HLC. */
export interface Hlc {
  /** Physical milliseconds since the Unix epoch. */
  readonly phys: number;
  /** Logical counter, 0 to {@link MAX_COUNTER}. */
  readonly ctr: number;
  /** Lowercase UUID of the issuing replica. */
  readonly replica: string;
}

/** The largest counter the 6-digit field can hold. */
export const MAX_COUNTER = 999_999;

/** The largest physical time the 13-digit field can hold (year 2286). */
export const MAX_PHYS = 9_999_999_999_999;

/**
 * Default skew bound: a received HLC more than this far ahead of the local
 * wall clock is held, never applied or dropped (journal spec §1.3, Q6).
 */
export const MAX_DRIFT_MS = 5 * 60 * 1000;

const HLC_RE = /^(\d{13})-(\d{6})-([0-9a-f-]{36})$/;
const REPLICA_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Thrown for a malformed HLC, replica id or physical time. */
export class HlcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HlcError';
  }
}

function assertParts(phys: number, ctr: number, replica: string): void {
  if (!Number.isSafeInteger(phys) || phys < 0 || phys > MAX_PHYS) {
    // @sync-invariant none:input-shape an HLC is a fixed-format value; a malformed one is refused wherever it arrives
    throw new HlcError(`HLC physical time out of range: ${phys}`);
  }
  if (!Number.isSafeInteger(ctr) || ctr < 0 || ctr > MAX_COUNTER) {
    // @sync-invariant none:input-shape an HLC is a fixed-format value; a malformed one is refused wherever it arrives
    throw new HlcError(`HLC counter out of range: ${ctr}`);
  }
  if (!REPLICA_RE.test(replica)) {
    // @sync-invariant none:input-shape an HLC is a fixed-format value; a malformed one is refused wherever it arrives
    throw new HlcError(`HLC replica id is not a lowercase UUID: ${replica}`);
  }
}

/**
 * Encode an HLC to its wire form.
 *
 * @param h - The clock value.
 * @returns `PPPPPPPPPPPPP-CCCCCC-<replica>`.
 * @throws {HlcError} When a part is out of range or the replica id is malformed.
 */
export function encodeHlc(h: Hlc): string {
  assertParts(h.phys, h.ctr, h.replica);
  return `${String(h.phys).padStart(13, '0')}-${String(h.ctr).padStart(6, '0')}-${h.replica}`;
}

/**
 * Decode an HLC from its wire form.
 *
 * @param s - An encoded HLC.
 * @returns The decoded parts.
 * @throws {HlcError} When `s` is not an encoded HLC.
 */
export function parseHlc(s: string): Hlc {
  const m = HLC_RE.exec(s);
  // @sync-invariant none:input-shape an HLC is a fixed-format value; a malformed one is refused wherever it arrives
  if (!m) throw new HlcError(`not an encoded HLC: ${s}`);
  const h = { phys: Number(m[1]), ctr: Number(m[2]), replica: m[3] as string };
  assertParts(h.phys, h.ctr, h.replica);
  return h;
}

/**
 * Total order on HLCs: `(phys, ctr, replica)`. The replica tiebreak is
 * arbitrary but deterministic, so every replica orders identically.
 *
 * @returns Negative, zero or positive, like a sort comparator.
 */
export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.phys !== b.phys) return a.phys < b.phys ? -1 : 1;
  if (a.ctr !== b.ctr) return a.ctr < b.ctr ? -1 : 1;
  if (a.replica === b.replica) return 0;
  return a.replica < b.replica ? -1 : 1;
}

/**
 * The clock of a replica that has issued nothing yet.
 *
 * @param replica - The replica id.
 */
export function genesisHlc(replica: string): Hlc {
  assertParts(0, 0, replica);
  return { phys: 0, ctr: 0, replica };
}

/** Carry a counter overflow into the physical part. */
function carry(phys: number, ctr: number, replica: string): Hlc {
  if (ctr > MAX_COUNTER) return { phys: phys + 1, ctr: 0, replica };
  return { phys, ctr, replica };
}

/**
 * Issue the next local HLC.
 *
 * `phys' = max(last.phys, wall)`; the counter increments when the physical
 * part did not move and resets to 0 when it did; a counter past
 * {@link MAX_COUNTER} carries into `phys`. HLCs therefore increase strictly
 * per replica, even when the wall clock steps backwards or a batch issues
 * 10^6 timestamps in one millisecond.
 *
 * @param last - The replica's current clock.
 * @param wallMs - The physical candidate (a capture's `at_ms`, or `Date.now()`).
 * @returns The new clock value, which is also the issued timestamp.
 */
export function tick(last: Hlc, wallMs: number): Hlc {
  const wall = Math.floor(wallMs);
  assertParts(Math.max(0, wall), 0, last.replica);
  const phys = Math.max(last.phys, wall);
  const ctr = phys === last.phys ? last.ctr + 1 : 0;
  return carry(phys, ctr, last.replica);
}

/**
 * Merge a received HLC into the local clock (standard HLC receive rule).
 *
 * `phys' = max(last.phys, remote.phys, now)`. The counter is
 * `max(last.ctr, remote.ctr) + 1` when all three agree, `last.ctr + 1` or
 * `remote.ctr + 1` when `phys'` equals only that one, and 0 otherwise. The
 * result keeps the LOCAL replica id.
 *
 * Callers apply the skew bound first ({@link isWithinSkew}): a remote HLC too
 * far ahead must be held, never merged.
 *
 * @param last - The local clock.
 * @param remote - The received timestamp.
 * @param nowMs - The local wall clock.
 * @returns The new local clock value.
 */
export function receive(last: Hlc, remote: Hlc, nowMs: number): Hlc {
  const now = Math.floor(nowMs);
  const phys = Math.max(last.phys, remote.phys, now);
  let ctr: number;
  if (phys === last.phys && phys === remote.phys) ctr = Math.max(last.ctr, remote.ctr) + 1;
  else if (phys === last.phys) ctr = last.ctr + 1;
  else if (phys === remote.phys) ctr = remote.ctr + 1;
  else ctr = 0;
  return carry(phys, ctr, last.replica);
}

/**
 * Whether a received HLC is inside the skew bound: `phys <= now + maxDrift`.
 *
 * @param remote - The received timestamp.
 * @param nowMs - The local wall clock.
 * @param maxDriftMs - The bound; defaults to {@link MAX_DRIFT_MS}.
 */
export function isWithinSkew(remote: Hlc, nowMs: number, maxDriftMs = MAX_DRIFT_MS): boolean {
  return remote.phys <= Math.floor(nowMs) + maxDriftMs;
}

/**
 * The larger of two HLCs (by {@link compareHlc}).
 */
export function maxHlc(a: Hlc, b: Hlc): Hlc {
  return compareHlc(a, b) >= 0 ? a : b;
}
