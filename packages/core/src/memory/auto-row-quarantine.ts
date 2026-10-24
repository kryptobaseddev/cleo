/**
 * Reversible quarantine of auto-generated BRAIN rows (T13951, owner decision
 * D11179).
 *
 * Three kinds of rows were written by machinery, not by anyone recording
 * knowledge: dispatch traces (`brain_patterns`, one per agent resolution until
 * T13946), "Doc attached" records (`brain_observations`, until T13985) and the
 * content-free task-start/complete stubs. Recall already ignores them
 * (`eligibility.ts#autoRowExclusionClause`); this module retires them from the
 * active store by setting `invalid_at` only. Nothing is deleted.
 *
 * Safety contract (lead conditions on D11179):
 * - Dry run by default: per-store, per-table counts and the exact predicates.
 * - Apply refuses unless the caller passes the counts of a dry run taken in the
 *   same state, so it never touches more rows than were approved.
 * - The receipt (ids per store and table, timestamp, predicates, counts) is
 *   written durably BEFORE the first write, so a crash mid-apply leaves a
 *   receipt restore can use.
 * - Restore clears `invalid_at` only where it still equals the receipt's
 *   timestamp, so it is idempotent and never undoes a later invalidation.
 * - Writes go through the canonical accessors, in batches, and sync.
 *
 * Code placed in `packages/core/` per Package-Boundary Check — verified against AGENTS.md.
 *
 * @module memory/auto-row-quarantine
 * @task T13951
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  AUTO_ROW_RULES,
  type AutoRowRule,
  type AutoRowRuleId,
  CURRENT_UNVERIFIED,
} from './auto-row-rules.js';

/** Brain stores the quarantine covers, reported separately. */
export const QUARANTINE_SCOPES = ['project', 'global'] as const;
/** A brain store. */
export type QuarantineScope = (typeof QUARANTINE_SCOPES)[number];
/** Memory tables holding auto rows. */
export const QUARANTINE_TABLES = ['patterns', 'observations'] as const;
/** A memory table holding auto rows. */
export type QuarantineTable = (typeof QUARANTINE_TABLES)[number];

/** Counts per table, and per rule, for one store. */
export type QuarantineCounts = Record<
  QuarantineTable,
  { count: number; byRule: Record<string, number> }
>;

/** A count per store and table. */
export type QuarantineTally = Record<QuarantineScope, Record<QuarantineTable, number>>;

/** Row ids per table for one store. */
export type QuarantineIds = Record<QuarantineTable, string[]>;

/** The dry-run report: what an apply in this state would quarantine. */
export interface AutoRowQuarantinePlan {
  /** Counts per store and table. */
  counts: Record<QuarantineScope, QuarantineCounts>;
  /** The exact predicates, so the owner approves what will match. */
  predicates: Record<string, string>;
  /** Ids per store and table (kept out of CLI output; written to the receipt). */
  ids: Record<QuarantineScope, QuarantineIds>;
  /** Short digest of the exact id set; `--expect-digest` binds an apply to it. */
  digest: string;
}

/** Durable record of an apply, written before the first write. */
export interface AutoRowQuarantineReceipt {
  /** Receipt format. */
  version: 1;
  /** The `invalid_at` value written; restore matches on it. */
  quarantinedAt: string;
  /** `started` until every batch committed, then `complete`. */
  status: 'started' | 'complete';
  /** Predicates in force. */
  predicates: Record<string, string>;
  /** Approved counts per store and table. */
  counts: QuarantineTally;
  /** Ids per store and table. */
  ids: Record<QuarantineScope, QuarantineIds>;
  /** Digest of the approved id set. */
  digest: string;
  /** Rows actually quarantined, once complete. */
  quarantined?: QuarantineTally;
  /** Planned rows a batch skipped because they stopped matching (e.g. verified mid-apply). */
  skipped?: Record<QuarantineScope, QuarantineIds>;
}

/** Writes a store's `invalid_at` for listed rows; returns the ids that changed. */
export type InvalidAtWriter = (
  table: QuarantineTable,
  ids: readonly string[],
  invalidAt: string | null,
  expected: string | null,
  guardRules?: readonly AutoRowRuleId[],
) => Promise<string[]>;

/** Read handle and accessor-backed writer for one store. */
export interface QuarantineStore {
  /** Read handle for the store. */
  db: DatabaseSync;
  /** Accessor-backed `invalid_at` writer. */
  write: InvalidAtWriter;
}

/** Build one value per store. */
function perScope<T>(make: (scope: QuarantineScope) => T): Record<QuarantineScope, T> {
  return { project: make('project'), global: make('global') };
}

/** An all-zero tally. */
function zeroTally(): QuarantineTally {
  return perScope(() => ({ patterns: 0, observations: 0 }));
}

/** Default rows per write transaction. */
export const QUARANTINE_BATCH_SIZE = 500;

/** Error with a stable code for the CLI envelope. */
export class AutoRowQuarantineError extends Error {
  /**
   * @param code - Stable error code.
   * @param message - Human-readable explanation.
   */
  constructor(
    readonly code: 'E_QUARANTINE_EXPECT_MISMATCH' | 'E_QUARANTINE_RECEIPT',
    message: string,
  ) {
    super(message);
    this.name = 'AutoRowQuarantineError';
  }
}

/**
 * Open the project and global brain stores with accessor-backed writers.
 *
 * @param projectRoot - Project whose brain is the `project` store.
 * @returns Read handles and writers for both stores.
 * @example
 * ```ts
 * const stores = await openQuarantineStores(projectRoot);
 * ```
 */
export async function openQuarantineStores(
  projectRoot: string,
): Promise<Record<QuarantineScope, QuarantineStore>> {
  const { getBrainDb, getBrainNativeDb } = await import('../store/memory-sqlite.js');
  const { getBrainAccessor, setGlobalInvalidAtWhere } = await import('../store/memory-accessor.js');
  const { getDualScopeNativeDb, openDualScopeDb } = await import('../store/dual-scope-db.js');
  await getBrainDb(projectRoot);
  const projectDb = getBrainNativeDb(projectRoot);
  // @sync-invariant none:local-only no store handle, so nothing is read or written
  if (!projectDb) throw new Error('BRAIN database unavailable for the auto-row quarantine');
  const accessor = await getBrainAccessor(projectRoot);
  return {
    project: { db: projectDb, write: (...args) => accessor.setInvalidAtWhere(...args) },
    global: {
      db: getDualScopeNativeDb(await openDualScopeDb('global')),
      write: setGlobalInvalidAtWhere,
    },
  };
}

/**
 * Dry run: what an apply would quarantine in each store, with the predicates.
 *
 * @param stores - Project and global stores.
 * @returns Counts, predicates and ids. Nothing is written.
 * @example
 * ```ts
 * const plan = planAutoRowQuarantine(await openQuarantineStores(root));
 * ```
 */
export function planAutoRowQuarantine(
  stores: Record<QuarantineScope, QuarantineStore>,
): AutoRowQuarantinePlan {
  const ids = perScope((scope) => idsFor(stores[scope].db));
  return {
    counts: perScope((scope) => countsFor(stores[scope].db, ids[scope])),
    predicates: Object.fromEntries(
      AUTO_ROW_RULES.map((rule) => [rule.id, `${rule.predicate} AND ${CURRENT_UNVERIFIED}`]),
    ),
    ids,
    digest: digestIds(ids),
  };
}

/**
 * Short, stable digest of an id set (sha256 of the sorted ids per store and
 * table, first 16 hex characters). Approval binds to it, so an apply cannot
 * quarantine a different set of rows with the same counts.
 *
 * @param ids - Ids per store and table.
 * @returns 16 hex characters.
 * @example
 * ```ts
 * digestIds(plan.ids); // '3f2a9c0d1b7e4a55'
 * ```
 */
export function digestIds(ids: Record<QuarantineScope, QuarantineIds>): string {
  const canonical = QUARANTINE_SCOPES.flatMap((scope) =>
    QUARANTINE_TABLES.map((table) => [scope, table, [...ids[scope][table]].sort()]),
  );
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}

/** The rules a table's rows must still match when a batch writes them. */
function tableRules(table: QuarantineTable): AutoRowRuleId[] {
  return AUTO_ROW_RULES.filter((rule) => rule.table === table).map((rule) => rule.id);
}

/** Ids one rule matches in one store. */
function ruleIds(db: DatabaseSync, rule: AutoRowRule): string[] {
  return db
    .prepare(
      `SELECT id FROM main.brain_${rule.table}
       WHERE (${rule.predicate}) AND ${CURRENT_UNVERIFIED} ORDER BY id`,
    )
    .all()
    .map((row) => String(row.id));
}

/** Distinct matching ids per table for one store. */
function idsFor(db: DatabaseSync): QuarantineIds {
  const ids = (table: QuarantineTable): string[] =>
    [
      ...new Set(
        AUTO_ROW_RULES.filter((rule) => rule.table === table).flatMap((rule) => ruleIds(db, rule)),
      ),
    ].sort();
  return { patterns: ids('patterns'), observations: ids('observations') };
}

/** Per-table and per-rule counts for one store. */
function countsFor(db: DatabaseSync, ids: QuarantineIds): QuarantineCounts {
  const byRule = (table: QuarantineTable): Record<string, number> =>
    Object.fromEntries(
      AUTO_ROW_RULES.filter((rule) => rule.table === table).map((rule) => [
        rule.id,
        ruleIds(db, rule).length,
      ]),
    );
  return {
    patterns: { count: ids.patterns.length, byRule: byRule('patterns') },
    observations: { count: ids.observations.length, byRule: byRule('observations') },
  };
}

/**
 * Parse `--expect` counts: `project:patterns=N,project:observations=N,global:...`.
 * Every store/table pair must be given, once.
 *
 * @param text - The flag value.
 * @returns Expected counts per store and table.
 * @throws AutoRowQuarantineError when a pair is missing, repeated or malformed.
 * @example
 * ```ts
 * parseQuarantineExpect('project:patterns=3,project:observations=1,global:patterns=0,global:observations=0');
 * ```
 */
export function parseQuarantineExpect(text: string): QuarantineTally {
  const given = new Map<string, number>();
  for (const part of text.split(',')) {
    const match = /^\s*(project|global):(patterns|observations)=(\d+)\s*$/.exec(part);
    if (!match) {
      throw new AutoRowQuarantineError(
        'E_QUARANTINE_EXPECT_MISMATCH',
        `Malformed --expect entry '${part}'; use <project|global>:<patterns|observations>=<count>`,
      );
    }
    const pair = `${match[1]}:${match[2]}`;
    if (given.has(pair)) {
      // @sync-invariant none:input-shape a doubled --expect pair is refused before any write
      throw new AutoRowQuarantineError(
        'E_QUARANTINE_EXPECT_MISMATCH',
        `--expect gives ${pair} more than once; pass each count once`,
      );
    }
    given.set(pair, Number(match[3]));
  }
  const count = (scope: QuarantineScope, table: QuarantineTable): number => {
    const value = given.get(`${scope}:${table}`);
    if (value === undefined) {
      throw new AutoRowQuarantineError(
        'E_QUARANTINE_EXPECT_MISMATCH',
        `--expect must give ${scope}:${table}; pass every count from the dry run`,
      );
    }
    return value;
  };
  return perScope((scope) => ({
    patterns: count(scope, 'patterns'),
    observations: count(scope, 'observations'),
  }));
}

/** Write JSON durably: temp file, fsync, rename. */
function writeDurably(path: string, value: AutoRowQuarantineReceipt): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  const fd = openSync(temp, 'w');
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  // Best effort: make the rename itself durable (not supported on every platform).
  try {
    const dirFd = openSync(dirname(path), 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // A directory fsync is unavailable here; the receipt file itself is synced.
  }
}

/**
 * Default receipt path for an apply at `quarantinedAt` (gitignored backups).
 *
 * @param projectRoot - Project root.
 * @param quarantinedAt - ISO timestamp of the apply.
 * @returns Absolute receipt path.
 * @example
 * ```ts
 * defaultQuarantineReceiptPath(root, '2026-10-24T00:00:00.000Z');
 * ```
 */
export function defaultQuarantineReceiptPath(projectRoot: string, quarantinedAt: string): string {
  return join(
    projectRoot,
    '.cleo',
    'backups',
    'quarantine',
    `auto-rows-${quarantinedAt.replace(/[:.]/g, '-')}.json`,
  );
}

/**
 * Apply the quarantine after checking the approved counts still hold.
 *
 * @param stores - Project and global stores.
 * @param expect - Counts from the approved dry run; any difference refuses.
 * @param expectDigest - Id-set digest from the approved dry run; any difference refuses.
 * @param receiptPath - Where the receipt is written (before the first write).
 * @param options - `batchSize` per write transaction; `now` for tests.
 * @returns The completed receipt.
 * @throws AutoRowQuarantineError when the current counts differ from `expect`.
 * @example
 * ```ts
 * const receipt = await applyAutoRowQuarantine(stores, expect, path);
 * ```
 */
export async function applyAutoRowQuarantine(
  stores: Record<QuarantineScope, QuarantineStore>,
  expect: QuarantineTally,
  expectDigest: string,
  receiptPath: string,
  options: { batchSize?: number; now?: Date } = {},
): Promise<AutoRowQuarantineReceipt> {
  const plan = planAutoRowQuarantine(stores);
  if (plan.digest !== expectDigest) {
    // @sync-invariant none:input-shape the approved row set no longer holds; nothing is written
    throw new AutoRowQuarantineError(
      'E_QUARANTINE_EXPECT_MISMATCH',
      `The matched rows now digest to ${plan.digest}, not the approved ${expectDigest}; run the dry run again`,
    );
  }
  for (const scope of QUARANTINE_SCOPES) {
    for (const table of QUARANTINE_TABLES) {
      if (plan.counts[scope][table].count !== expect[scope][table]) {
        // @sync-invariant none:input-shape the approved counts no longer hold; nothing is written
        throw new AutoRowQuarantineError(
          'E_QUARANTINE_EXPECT_MISMATCH',
          `${scope}:${table} now matches ${plan.counts[scope][table].count} rows, not the approved ${expect[scope][table]}; run the dry run again`,
        );
      }
    }
  }
  const receipt: AutoRowQuarantineReceipt = {
    version: 1,
    quarantinedAt: (options.now ?? new Date()).toISOString(),
    status: 'started',
    predicates: plan.predicates,
    counts: expect,
    ids: plan.ids,
    digest: plan.digest,
  };
  writeDurably(receiptPath, receipt);
  const batchSize = options.batchSize ?? QUARANTINE_BATCH_SIZE;
  const quarantined = zeroTally();
  const skipped = perScope((): QuarantineIds => ({ patterns: [], observations: [] }));
  for (const scope of QUARANTINE_SCOPES) {
    for (const table of QUARANTINE_TABLES) {
      const ids = plan.ids[scope][table];
      for (let start = 0; start < ids.length; start += batchSize) {
        const batch = ids.slice(start, start + batchSize);
        // Re-check the full predicate: a row verified or edited mid-apply is skipped.
        const changed = new Set(
          await stores[scope].write(table, batch, receipt.quarantinedAt, null, tableRules(table)),
        );
        quarantined[scope][table] += changed.size;
        skipped[scope][table].push(...batch.filter((id) => !changed.has(id)));
      }
    }
  }
  const complete: AutoRowQuarantineReceipt = {
    ...receipt,
    status: 'complete',
    quarantined,
    skipped,
  };
  writeDurably(receiptPath, complete);
  return complete;
}

/**
 * Restore a quarantine from its receipt: clear `invalid_at` on the listed rows
 * that still carry the receipt's timestamp. Idempotent; works on a receipt left
 * `started` by an interrupted apply.
 *
 * @param stores - Project and global stores.
 * @param receiptPath - The receipt an apply wrote.
 * @param options - `batchSize` per write transaction.
 * @returns Rows restored per store and table.
 * @throws AutoRowQuarantineError when the receipt is unreadable or malformed.
 * @example
 * ```ts
 * const restored = await restoreAutoRowQuarantine(stores, path);
 * ```
 */
export async function restoreAutoRowQuarantine(
  stores: Record<QuarantineScope, QuarantineStore>,
  receiptPath: string,
  options: { batchSize?: number } = {},
): Promise<QuarantineTally> {
  const receipt = readReceipt(receiptPath);
  const batchSize = options.batchSize ?? QUARANTINE_BATCH_SIZE;
  const restored = zeroTally();
  for (const scope of QUARANTINE_SCOPES) {
    for (const table of QUARANTINE_TABLES) {
      const ids = receipt.ids[scope][table];
      for (let start = 0; start < ids.length; start += batchSize) {
        const changed = await stores[scope].write(
          table,
          ids.slice(start, start + batchSize),
          null,
          receipt.quarantinedAt,
        );
        restored[scope][table] += changed.length;
      }
    }
  }
  return restored;
}

const tallySchema = z.object({ patterns: z.number(), observations: z.number() });
const idsSchema = z.object({ patterns: z.array(z.string()), observations: z.array(z.string()) });
const receiptSchema = z.object({
  version: z.literal(1),
  quarantinedAt: z.string().min(1),
  status: z.enum(['started', 'complete']),
  predicates: z.record(z.string(), z.string()),
  counts: z.object({ project: tallySchema, global: tallySchema }),
  ids: z.object({ project: idsSchema, global: idsSchema }),
  digest: z.string(),
  quarantined: z.object({ project: tallySchema, global: tallySchema }).optional(),
  skipped: z.object({ project: idsSchema, global: idsSchema }).optional(),
});

/** Read and validate a receipt. */
function readReceipt(path: string): AutoRowQuarantineReceipt {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    // @sync-invariant none:input-shape an unreadable receipt is refused before any write
    throw new AutoRowQuarantineError(
      'E_QUARANTINE_RECEIPT',
      `Cannot read quarantine receipt ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // @sync-invariant none:input-shape an unparseable receipt is refused before any write
    throw new AutoRowQuarantineError('E_QUARANTINE_RECEIPT', `Receipt ${path} is not valid JSON`);
  }
  const parsed = receiptSchema.safeParse(json);
  if (!parsed.success) {
    // @sync-invariant none:input-shape a malformed receipt is refused before any write
    throw new AutoRowQuarantineError('E_QUARANTINE_RECEIPT', `Not a quarantine receipt: ${path}`);
  }
  return parsed.data;
}
