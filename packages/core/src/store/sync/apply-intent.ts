/**
 * Apply intents and echo subtraction (journal spec §3.3; H1, N1; T12757).
 *
 * An apply frame writes remote ops into the store, and the capture triggers
 * capture those writes like any other. Sealing them as local writes would
 * echo every remote change back with fresh HLCs, which corrupts LWW. Exact
 * image matching under-drops: partial LWW, `$inc` applied as an absolute
 * value, re-encrypted secrets, remaps and normalisation all make the capture
 * differ from the incoming op.
 *
 * So the apply records what it actually wrote, per (frame, tbl, uid, col),
 * with the exact `enc()` of the stored value ({@link recordApplyIntents}),
 * and the sealer subtracts it from the frame's captures field by field
 * ({@link subtractApplyIntents}). What remains is residual: fields the apply
 * did not write, or wrote with a different value (a validator side effect, a
 * re-mint, a trigger cascade, an interleaved writer). Only the residual is
 * sealed, as local writes with new HLCs.
 *
 * Writing intents belongs to the apply API (T12344); the sealer half lives
 * here so the contract is fixed before apply lands.
 *
 * @task T12757
 * @module store/sync/apply-intent
 */

import type { DatabaseSync } from 'node:sqlite';
import { SECRET_MARKER } from './capture.js';
import { mergeGroupsOf } from './merge/rules.js';
import { decodeEnc } from './sealer-values.js';

/** `col` of the intent for a row insert. */
export const INTENT_INSERT = '*I';
/** `col` of the intent for a row delete. */
export const INTENT_DELETE = '*D';
/** `col` of the intent for a re-key; its `enc` is the new uid. */
export const INTENT_REKEY = '*K';
/** `enc` recorded for a secret column (the capture holds `<changed>`). */
export const SECRET_INTENT = '<secret>';

/** One thing an apply frame wrote. */
export interface ApplyIntent {
  /** Table written. */
  readonly tbl: string;
  /** The row's uid (before a re-key, for `*K`). */
  readonly uid: string;
  /** A column name, or {@link INTENT_INSERT} / {@link INTENT_DELETE} / {@link INTENT_REKEY}. */
  readonly col: string;
  /**
   * `enc()` of the stored value, computed by the same SQL `enc()` as the
   * capture triggers (use `RETURNING`); {@link SECRET_INTENT} for a secret
   * column ({@link recordApplyIntents} binds it to the capture the write
   * produced); the new uid for `*K`; `''` for `*I` and `*D`. An insert
   * records `*I` plus one intent for EVERY column it wrote: a captured column
   * without an intent is treated as something the apply did not write.
   */
  readonly enc: string;
}

/**
 * Columns a persistent trigger derives deterministically from a replicated
 * change, so every replica writes them identically when it applies the op
 * (§3.3). In an apply frame their residual changes are dropped rather than
 * sealed. Keyed by table. Empty until a trigger writing a sync-set column is
 * declared here.
 */
export const SYNC_TRIGGER_DERIVED_COLUMNS: ReadonlyMap<string, ReadonlySet<string>> = new Map();

/**
 * Record what an apply wrote, in the caller's (apply frame) transaction.
 * A later write to the same (frame, tbl, uid, col) replaces the earlier
 * intent: the capture of the last write is what the sealer compares.
 *
 * @param db - The store, inside the apply frame's transaction.
 * @param frame - The apply frame's id (`openCaptureFrame(db, 'apply', …)`).
 * @param intents - The writes.
 */
export function recordApplyIntents(
  db: DatabaseSync,
  frame: string,
  intents: readonly ApplyIntent[],
): void {
  const ins = db.prepare(
    `INSERT INTO _sync_apply_intent (frame, tbl, uid, col, enc) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (frame, tbl, uid, col) DO UPDATE SET enc = excluded.enc`,
  );
  // A secret column's capture is only a change marker, so the intent names
  // the capture the apply's write produced (its seq; frame labels are written
  // only when the frame finishes, and the write lock makes the row's newest
  // capture of this column this write's): a later local write of the same
  // secret in the frame then never matches it. Contract (T12344): record a
  // row's intents before the frame writes that column again.
  // The newest live capture of this row that changed THIS column: a same-row
  // cascade or another column's write in between must not take the binding.
  const lastCapture = db.prepare(
    "SELECT max(seq) AS seq FROM _sync_capture WHERE state = 'live' AND tbl = ? AND uid = ? AND json_type(img, ?) IS NOT NULL",
  );
  for (const i of intents) {
    let value = i.enc;
    if (value === SECRET_INTENT) {
      const seq = (
        lastCapture.get(i.tbl, i.uid, `$."${i.col.replaceAll('"', '\\"')}"`) as
          | { seq: number | null }
          | undefined
      )?.seq;
      if (typeof seq === 'number') value = `${SECRET_INTENT}@${seq}`;
    }
    ins.run(frame, i.tbl, i.uid, i.col, value);
  }
}

/** The intents of one frame, keyed `tbl \0 uid \0 col`. */
export type FrameIntents = ReadonlyMap<string, string>;

const intentKey = (tbl: string, uid: string, col: string): string =>
  `${tbl}\u0000${uid}\u0000${col}`;

/** Load one frame's intents. */
export function loadFrameIntents(db: DatabaseSync, frame: string): FrameIntents {
  const out = new Map<string, string>();
  for (const r of db
    .prepare('SELECT tbl, uid, col, enc FROM _sync_apply_intent WHERE frame = ?')
    .all(frame) as Array<{ tbl: string; uid: string; col: string; enc: string }>) {
    out.set(intentKey(r.tbl, r.uid, r.col), r.enc);
  }
  return out;
}

/** The capture fields subtraction reads. */
export interface IntentCapture {
  readonly seq: number;
  readonly tbl: string;
  readonly op: 'I' | 'U' | 'D' | 'K';
  readonly img: string;
}

/** What {@link subtractApplyIntents} left of a frame's captures. */
export interface IntentSubtraction<C extends IntentCapture> {
  /** Captures with residual fields, their image cut down to the residual. */
  readonly residual: C[];
  /** Captures the apply fully explains. They are consumed, never sealed. */
  readonly removed: C[];
}

/**
 * The local value a capture image holds for a column: a reference is
 * `[local key enc, uid]` and compares by its local key; anything else is the
 * `enc()` text itself.
 */
function localEnc(raw: unknown): string | null {
  if (Array.isArray(raw)) return typeof raw[0] === 'string' ? raw[0] : null;
  return typeof raw === 'string' ? raw : null;
}

/**
 * Whether a column's net captured value is exactly what the intent says the
 * apply wrote. A secret compares by the capture the apply's write produced
 * (`<secret>@seq`); a bare `<secret>` intent matches only a column the frame
 * changed once.
 */
function matches(
  intent: string | undefined,
  raw: unknown,
  seq: number,
  changesInFrame: number,
): boolean {
  if (intent === undefined) return false;
  if (raw === SECRET_MARKER) {
    if (intent === `${SECRET_INTENT}@${seq}`) return true;
    return intent === SECRET_INTENT && changesInFrame === 1;
  }
  return localEnc(raw) === intent;
}

/** The value a column's capture holds after the write (U: the after half). */
function afterValue(c: IntentCapture, raw: unknown): unknown {
  return c.op === 'U' && Array.isArray(raw) ? raw[1] : raw;
}

/**
 * Subtract a frame's intents from its captures (§3.3), against the frame's
 * NET value per (row, column): within one frame, only the last capture that
 * changes a column carries it; an earlier change of the same column is
 * superseded (netting would collapse it) and never seals on its own.
 *
 * - **U:** each column whose net after-value equals the intent is removed,
 *   and so is every superseded change. A capture with no column left is
 *   removed.
 * - **I:** with a `*I` intent (the apply records an intent for EVERY column
 *   it inserted), a column is removed when its net value equals its intent
 *   or a later capture supersedes it. A column with no intent is something
 *   the apply did not write (a local default, a trigger fill) and stays
 *   residual. With nothing residual the insert is removed; otherwise the
 *   residual columns remain as an update from the intent value (`NULL` when
 *   there is none). An I without `*I` is a local insert and stays whole.
 * - **D:** removed when a `*D` intent exists.
 * - **K:** removed when a `*K` intent names the same new uid.
 * - Residual changes to {@link SYNC_TRIGGER_DERIVED_COLUMNS} are dropped.
 *
 * Nothing the apply did not write is ever removed: a column with no intent,
 * or whose net value differs, is residual; a capture with no intent for its
 * row stays whole.
 *
 * @param captures - The frame's captures, in capture order.
 * @param intents - The frame's intents ({@link loadFrameIntents}).
 * @param uidOf - The uid of a capture's row, resolved as the sealer resolves it.
 */
export function subtractApplyIntents<C extends IntentCapture>(
  captures: readonly C[],
  intents: FrameIntents,
  uidOf: (c: C) => string | null,
): IntentSubtraction<C> {
  const uids = captures.map((c) => uidOf(c));
  const images = captures.map((c) => JSON.parse(c.img) as Record<string, unknown>);
  // Per (row, column): the index of the last capture that changes it, and
  // how many captures in the frame change it.
  const last = new Map<string, number>();
  const count = new Map<string, number>();
  captures.forEach((c, k) => {
    const uid = uids[k];
    if (uid === null || uid === undefined || (c.op !== 'U' && c.op !== 'I')) return;
    for (const col of Object.keys(images[k] ?? {})) {
      const key = intentKey(c.tbl, uid, col);
      last.set(key, k);
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  });

  const residual: C[] = [];
  const removed: C[] = [];
  captures.forEach((c, k) => {
    const uid = uids[k];
    if (uid === null || uid === undefined) {
      residual.push(c);
      return;
    }
    const intent = (col: string) => intents.get(intentKey(c.tbl, uid, col));
    const derived = SYNC_TRIGGER_DERIVED_COLUMNS.get(c.tbl);
    const img = images[k] ?? {};
    if (c.op === 'D') {
      (intent(INTENT_DELETE) !== undefined ? removed : residual).push(c);
      return;
    }
    if (c.op === 'K') {
      const pair = img.uid;
      const next = Array.isArray(pair) && typeof pair[1] === 'string' ? decodeEnc(pair[1]) : null;
      const want = intent(INTENT_REKEY);
      (want !== undefined && next === want ? removed : residual).push(c);
      return;
    }
    if (c.op === 'I' && intent(INTENT_INSERT) === undefined) {
      residual.push(c);
      return;
    }
    const left: Record<string, unknown> = {};
    const keep = (col: string, raw: unknown): void => {
      if (c.op === 'U') {
        left[col] = raw;
      } else {
        // Residual on an applied insert: an update from the value the apply
        // wrote (NULL when it wrote none) to the value the capture holds.
        const from = intent(col) ?? 'NULL';
        left[col] = [Array.isArray(raw) ? [from, null] : from, raw];
      }
    };
    const live = (col: string): boolean =>
      (last.get(intentKey(c.tbl, uid, col)) ?? k) <= k && !derived?.has(col);
    for (const [col, raw] of Object.entries(img)) {
      if (!live(col)) continue;
      const key = intentKey(c.tbl, uid, col);
      if (matches(intent(col), afterValue(c, raw), c.seq, count.get(key) ?? 1)) continue;
      keep(col, raw);
    }
    // A merge group stays whole (T13222): one residual member keeps every
    // member the capture recorded, so the sealed op never splits a group.
    for (const g of mergeGroupsOf(c.tbl, Object.keys(img))) {
      if (!g.some((col) => col in left)) continue;
      for (const col of g) if (!(col in left) && live(col)) keep(col, img[col]);
    }
    if (Object.keys(left).length === 0) {
      removed.push(c);
      return;
    }
    residual.push({ ...c, op: 'U', img: JSON.stringify(left) });
  });
  return { residual, removed };
}
