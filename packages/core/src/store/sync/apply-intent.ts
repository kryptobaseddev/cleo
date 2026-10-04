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
   * column; the new uid for `*K`; `''` for `*I` and `*D`.
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
  for (const i of intents) ins.run(frame, i.tbl, i.uid, i.col, i.enc);
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

/** Whether a captured value is exactly what the intent says was written. */
function matches(intent: string | undefined, raw: unknown): boolean {
  if (intent === undefined) return false;
  if (raw === SECRET_MARKER) return intent === SECRET_INTENT;
  return localEnc(raw) === intent;
}

/**
 * Subtract a frame's intents from its captures (§3.3).
 *
 * - **U:** each changed column whose after-value equals the intent is
 *   removed. A capture with no column left is removed.
 * - **I:** with a `*I` intent, a column is residual only when an intent
 *   names it with a different value; the rest were written as part of the
 *   insert. With nothing residual the insert is removed; otherwise the
 *   residual columns remain as an update against the intent values.
 * - **D:** removed when a `*D` intent exists.
 * - **K:** removed when a `*K` intent names the same new uid.
 * - Residual changes to {@link SYNC_TRIGGER_DERIVED_COLUMNS} are dropped.
 *
 * Nothing the apply did not write is ever removed: a capture with no intent
 * for its row stays whole.
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
  const residual: C[] = [];
  const removed: C[] = [];
  for (const c of captures) {
    const uid = uidOf(c);
    if (uid === null) {
      residual.push(c);
      continue;
    }
    const intent = (col: string) => intents.get(intentKey(c.tbl, uid, col));
    const derived = SYNC_TRIGGER_DERIVED_COLUMNS.get(c.tbl);
    const img = JSON.parse(c.img) as Record<string, unknown>;
    if (c.op === 'D') {
      (intent(INTENT_DELETE) !== undefined ? removed : residual).push(c);
      continue;
    }
    if (c.op === 'K') {
      const pair = img.uid;
      const next = Array.isArray(pair) && typeof pair[1] === 'string' ? decodeEnc(pair[1]) : null;
      const want = intent(INTENT_REKEY);
      (want !== undefined && next === want ? removed : residual).push(c);
      continue;
    }
    const left: Record<string, unknown> = {};
    if (c.op === 'U') {
      for (const [col, pair] of Object.entries(img)) {
        const after = Array.isArray(pair) ? pair[1] : undefined;
        if (matches(intent(col), after) || derived?.has(col)) continue;
        left[col] = pair;
      }
    } else {
      if (intent(INTENT_INSERT) === undefined) {
        residual.push(c);
        continue;
      }
      for (const [col, raw] of Object.entries(img)) {
        const want = intent(col);
        if (want === undefined || matches(want, raw) || derived?.has(col)) continue;
        // Residual on an applied insert: an update from the value the apply
        // wrote to the value the capture holds.
        left[col] = [Array.isArray(raw) ? [want, null] : want, raw];
      }
    }
    if (Object.keys(left).length === 0) {
      removed.push(c);
      continue;
    }
    residual.push({ ...c, op: 'U', img: JSON.stringify(left) });
  }
  return { residual, removed };
}
