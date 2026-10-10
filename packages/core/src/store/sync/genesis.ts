/**
 * The genesis cut: where a stream's pushed history begins (journal spec
 * §2.11 §10, §3.5 Rule 2; T12343 S4-1a).
 *
 * Before genesis nothing leaves the device: every effect is carried by the
 * stream's genesis checkpoint instead of by segments. {@link cutGenesis}
 * checks the store is fit to push (the step-0 preconditions, T13032 AC2),
 * seals what is pending, then in ONE `BEGIN IMMEDIATE` with no frame open:
 * - records `genesis_cut:<stream>` and `genesis_source_seq:<stream>` (the
 *   highest capture seq whose effect the checkpoint carries; equal by
 *   construction, since every capture at or below it is sealed first);
 * - folds every sealed, unsegmented transaction (`state = 'folded'`): it is
 *   in the checkpoint and is never sent;
 * - initialises row meta for every row that has none (§1.2 genesis HLC);
 * - sets `undo_enabled`, raises `min_writer_version` and turns `sync.push`
 *   on, so every pushed transaction has undo (C1);
 * - leaves `genesis_pending:<stream>`, which the push keeps until the
 *   genesis checkpoint is stored (S4-1b), so no segment ever precedes it.
 *
 * Draining first is what makes "every capture at or below the cut is
 * folded" hold without folding unsealed captures, whose rows would keep
 * stale meta and ledger counts: the cut transaction refuses (and retries
 * the drain) if a capture is still live.
 *
 * @task T12343
 * @module store/sync/genesis
 */

import type { DatabaseSync } from 'node:sqlite';
import type { TableScope } from '@cleocode/contracts';
import {
  BIRTH_FP_COLUMN,
  ROW_IDENTITY,
  rowIdentityRecipeCurrent,
  UID_COLUMN,
} from '../row-identity.js';
import { captureTriggerDrift, syncSetTables } from './capture.js';
import { isSyncFlagOn, setSyncFlag } from './flags.js';
import { baselineRowMeta } from './repair.js';
import { activeReplica } from './replica.js';
import { hasTable } from './schema.js';
import { sealPending, sealPreconditions } from './sealer.js';
import { hasTriggerSuspendTable, verifyOwnedTriggers } from './trigger-classes.js';
import { raiseMinWriterVersion } from './writer-version.js';

/** `_sync_meta` key prefix of a stream's genesis cut (read by `streamStarted`, T13217). */
export const GENESIS_CUT_KEY_PREFIX = 'genesis_cut:';

/** `_sync_meta` key prefix of a stream's genesis source seq (equal to the cut). */
export const GENESIS_SOURCE_SEQ_KEY_PREFIX = 'genesis_source_seq:';

/** `_sync_meta` key prefix set at the cut and cleared once the genesis checkpoint is stored. */
export const GENESIS_PENDING_KEY_PREFIX = 'genesis_pending:';

/** `_sync_meta` key the capture triggers' undo `WHEN` checks (§3.5 Rule 2). */
export const UNDO_ENABLED_KEY = 'undo_enabled';

/** How many times the cut re-drains when writes arrive between the drain and the cut. */
const CUT_ATTEMPTS = 3;

/** Options for {@link cutGenesis}. */
export interface GenesisCutOptions {
  readonly scope: TableScope;
  /** The stream whose pushed history starts here (`project:<id>` or `home:<userId>`). */
  readonly stream: string;
  /** Wall clock in ms (the genesis HLC of baselined rows). @defaultValue Date.now */
  readonly now?: () => number;
  /** Environment for the sync kill switches. @defaultValue process.env */
  readonly env?: NodeJS.ProcessEnv;
  /** Enable the unreleased `sync.seal` / `sync.push` (tests only). Never set from user input. */
  readonly allowUnreleased?: boolean;
}

/** What {@link cutGenesis} did. */
export interface GenesisCutReport {
  readonly stream: string;
  /** Why nothing was cut, or null. */
  readonly refused: string | null;
  /** The stream was already cut: nothing changed. */
  readonly already: boolean;
  /** `genesis_cut` (= `genesis_source_seq`): the highest capture seq the checkpoint carries. */
  readonly cut: number | null;
  /** Transactions the pre-cut drain sealed. */
  readonly sealed: number;
  /** Sealed, unsegmented transactions folded into genesis. */
  readonly folded: number;
  /** Rows given genesis row meta, per table (tables with none are absent). */
  readonly baselined: Readonly<Record<string, number>>;
}

const report = (stream: string, fields: Partial<GenesisCutReport>): GenesisCutReport => ({
  stream,
  refused: null,
  already: false,
  cut: null,
  sealed: 0,
  folded: 0,
  baselined: {},
  ...fields,
});

const metaValue = (db: DatabaseSync, key: string): string | undefined =>
  (
    db.prepare('SELECT value FROM _sync_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined
  )?.value;

/**
 * A stream's genesis cut, or undefined before it. Read-only.
 *
 * @param db - The store.
 * @param stream - The stream.
 */
export function genesisCutOf(db: DatabaseSync, stream: string): number | undefined {
  if (!hasTable(db, '_sync_meta')) return undefined;
  const v = metaValue(db, `${GENESIS_CUT_KEY_PREFIX}${stream}`);
  return v === undefined ? undefined : Number(v);
}

/**
 * Whether a stream is cut but its genesis checkpoint is not yet stored: the
 * push sends no segment until it is. Read-only.
 *
 * @param db - The store.
 * @param stream - The stream.
 */
export function genesisPending(db: DatabaseSync, stream: string): boolean {
  return (
    hasTable(db, '_sync_meta') &&
    metaValue(db, `${GENESIS_PENDING_KEY_PREFIX}${stream}`) !== undefined
  );
}

/** Minted sync-set rows the sealer cannot seal yet: no uid, or no birth_fp. */
function unidentifiedRows(db: DatabaseSync, scope: TableScope): Record<string, number> {
  const out: Record<string, number> = {};
  const sync = new Set(syncSetTables(scope));
  for (const spec of ROW_IDENTITY[scope]) {
    if (spec.kind !== 'minted' || !sync.has(spec.table) || !hasTable(db, spec.table)) continue;
    const cols = new Set(
      (db.prepare(`PRAGMA table_info("${spec.table}")`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    if (!cols.has(UID_COLUMN)) continue;
    const missing = [`"${UID_COLUMN}" IS NULL`];
    if (cols.has(BIRTH_FP_COLUMN)) missing.push(`"${BIRTH_FP_COLUMN}" IS NULL`);
    const n = (
      db
        .prepare(`SELECT count(*) AS n FROM "${spec.table}" WHERE ${missing.join(' OR ')}`)
        .get() as { n: number }
    ).n;
    if (n > 0) out[spec.table] = n;
  }
  return out;
}

/**
 * Why the store cannot reach genesis, or null when it can (the step-0
 * preconditions of `cleo sync enable push`, T13032 AC2). Read-only.
 *
 * - the sync schema is installed, capture is on and its triggers match the
 *   current schema, and the owned guard triggers are sound;
 * - the sealer may run (`sync.seal` on, released or explicitly allowed);
 * - a replica is bound;
 * - identity follows the current recipe, and every minted row has its uid
 *   and birth_fp (otherwise the sealer leaves its groups pending);
 * - no table is suspect and no capture is quarantined (the repair diff
 *   runs first: genesis must not freeze drift into the checkpoint).
 *
 * @param db - The store.
 * @param opts - Scope, environment, and whether unreleased flags are allowed.
 */
export function genesisPreconditions(
  db: DatabaseSync,
  opts: Pick<GenesisCutOptions, 'scope' | 'env' | 'allowUnreleased'>,
): string | null {
  const env = opts.env ?? process.env;
  if (!hasTable(db, '_sync_capture') || !hasTable(db, '_sync_segment')) {
    return 'sync schema not installed';
  }
  if (!isSyncFlagOn(db, 'sync.capture', env)) return 'sync.capture is off';
  const drift = captureTriggerDrift(db, opts.scope);
  const drifted = [...drift.missing, ...drift.differing, ...drift.extra];
  if (drifted.length > 0) {
    return `capture triggers differ from the schema (${drifted.slice(0, 3).join(', ')}): run \`cleo doctor sync-triggers --repair\``;
  }
  if (hasTriggerSuspendTable(db)) {
    const owned = verifyOwnedTriggers(db).map((f) => `${f.name} (${f.problem})`);
    if (owned.length > 0) return `owned triggers are unsound: ${owned.slice(0, 3).join(', ')}`;
  }
  const seal = sealPreconditions(db, env, opts.allowUnreleased === true);
  if (seal) return seal;
  if (!activeReplica(db, opts.scope)) return 'no bound replica';
  if (!rowIdentityRecipeCurrent(db, opts.scope)) {
    return 'row identity does not follow the current recipe: run the identity fill first';
  }
  const unidentified = Object.entries(unidentifiedRows(db, opts.scope));
  if (unidentified.length > 0) {
    return `rows without uid or birth_fp (${unidentified
      .slice(0, 3)
      .map(([t, n]) => `${t}: ${n}`)
      .join(', ')}): run the identity fill first`;
  }
  const suspect = db
    .prepare("SELECT substr(key, 9) AS t FROM _sync_meta WHERE key LIKE 'suspect:%' LIMIT 3")
    .all() as Array<{ t: string }>;
  if (suspect.length > 0) {
    return `suspect tables (${suspect.map((r) => r.t).join(', ')}): run \`cleo doctor sync-journal --repair\` first`;
  }
  if (
    hasTable(db, '_sync_quarantine') &&
    db.prepare('SELECT 1 FROM _sync_quarantine LIMIT 1').get() !== undefined
  ) {
    return 'quarantined captures: run `cleo doctor sync-journal --repair` first';
  }
  return null;
}

/** Seal until no capture is live; the reason it stopped early, or null. */
function drain(
  db: DatabaseSync,
  opts: GenesisCutOptions,
  replica: string,
): { sealed: number; refused: string | null } {
  let sealed = 0;
  for (;;) {
    const r = sealPending(db, {
      scope: opts.scope,
      replica,
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.allowUnreleased ? { allowUnreleased: true } : {}),
    });
    if (r.refused) return { sealed, refused: r.refused };
    sealed += r.txns;
    if (r.pending.length > 0) {
      return {
        sealed,
        refused: `captures cannot seal yet (${r.pending[0]?.reason ?? 'pending'}): run the identity fill first`,
      };
    }
    if (r.quarantined.length > 0) {
      return {
        sealed,
        refused: 'captures were quarantined: run `cleo doctor sync-journal --repair` first',
      };
    }
    if (r.captures === 0) return { sealed, refused: null };
  }
}

/** Write one `_sync_meta` value. */
function setMeta(db: DatabaseSync, key: string, value: string, atIso: string): void {
  db.prepare(
    'INSERT INTO _sync_meta (key, value, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run(key, value, atIso);
}

/**
 * Record a stream's genesis cut and turn push on (§2.11 §10; module docs).
 * Must run outside a transaction (it seals, then opens its own
 * `BEGIN IMMEDIATE`). A refusal changes nothing beyond the drain's seals.
 *
 * @param db - The store.
 * @param opts - {@link GenesisCutOptions}.
 * @returns What was cut, or why not.
 */
export function cutGenesis(db: DatabaseSync, opts: GenesisCutOptions): GenesisCutReport {
  if (db.isTransaction) {
    // @sync-invariant none:local-only programming-error guard: the cut seals, then opens its own transaction
    throw new Error('cutGenesis must run outside a transaction (no frame open)');
  }
  const already = genesisCutOf(db, opts.stream);
  if (already !== undefined) return report(opts.stream, { already: true, cut: already });
  const refused = genesisPreconditions(db, opts);
  if (refused) return report(opts.stream, { refused });
  const replica = activeReplica(db, opts.scope)?.replicaId;
  if (!replica) return report(opts.stream, { refused: 'no bound replica' });
  const now = opts.now ?? Date.now;
  let sealed = 0;
  for (let attempt = 0; attempt < CUT_ATTEMPTS; attempt++) {
    const d = drain(db, opts, replica);
    sealed += d.sealed;
    if (d.refused) return report(opts.stream, { refused: d.refused, sealed });
    db.exec('BEGIN IMMEDIATE');
    try {
      // A write committed between the drain and this lock: drain it too.
      if (db.prepare("SELECT 1 FROM _sync_capture WHERE state = 'live' LIMIT 1").get()) {
        db.exec('ROLLBACK');
        continue;
      }
      const raced = genesisCutOf(db, opts.stream);
      if (raced !== undefined) {
        db.exec('ROLLBACK');
        return report(opts.stream, { already: true, cut: raced, sealed });
      }
      const at = now();
      const atIso = new Date(at).toISOString();
      const cut = Number(
        (
          db.prepare("SELECT seq FROM sqlite_sequence WHERE name = '_sync_capture'").get() as
            | { seq: number }
            | undefined
        )?.seq ?? 0,
      );
      // Row meta for every row the sealer never journaled, before the stream
      // starts (after it, a meta-less row is journaled as an I, T13217).
      const baselined: Record<string, number> = {};
      for (const table of syncSetTables(opts.scope)) {
        const n = baselineRowMeta(db, opts.scope, table, replica, at);
        if (n) baselined[table] = n;
      }
      const folded = db
        .prepare("UPDATE _sync_txn SET state = 'folded' WHERE state = 'sealed'")
        .run().changes;
      setMeta(db, `${GENESIS_CUT_KEY_PREFIX}${opts.stream}`, String(cut), atIso);
      setMeta(db, `${GENESIS_SOURCE_SEQ_KEY_PREFIX}${opts.stream}`, String(cut), atIso);
      setMeta(db, `${GENESIS_PENDING_KEY_PREFIX}${opts.stream}`, String(cut), atIso);
      setMeta(db, UNDO_ENABLED_KEY, '1', atIso);
      raiseMinWriterVersion(db);
      setSyncFlag(db, 'sync.push', true, {
        now: new Date(at),
        ...(opts.allowUnreleased ? { allowUnreleased: true } : {}),
      });
      db.exec('COMMIT');
      return report(opts.stream, { cut, sealed, folded: Number(folded), baselined });
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    }
  }
  return report(opts.stream, {
    refused: 'writes kept arriving during the genesis cut: run it again',
    sealed,
  });
}
