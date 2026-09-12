/**
 * Detect tasks whose acceptance criteria disagree between their two stores.
 *
 * ## The structural fact (gh#1290)
 *
 * Acceptance criteria live in **two places**, with a projection mechanism
 * between them, and until now nothing asserted they agree:
 *
 *     tasks_tasks.acceptance_json              the JSON column — what `cleo show` reads
 *     tasks_task_acceptance_criteria           typed rows, one per criterion, keyed by `kind`
 *     tasks_acceptance_projection_dirty/_state the projection mechanism
 *
 * Two representations of one fact, a mechanism to keep them in sync, and no
 * check that it worked.
 *
 * ## The composition rule, measured rather than assumed
 *
 * It is tempting to state the rule as *"the JSON column holds **text** criteria;
 * the rows table holds those **plus** `child_task` projections"* — i.e.
 * `json == text`. That is what a sample of older containers suggests, and it is
 * **wrong for the live convention**.
 *
 * The JSON column does carry child projections, serialised as text. `T001`'s
 * only JSON entry is the string `"Complete child T9092: …"`, and 476 tasks
 * carry at least one such string. Of 582 tasks with `child_task` rows, 446 have
 * `json == text + child`.
 *
 * Measured across a 5,067-task store, the convention **changed during May 2026**
 * and has been uniform since:
 *
 *     month     children IN json   children NOT in json
 *     2026-04          14                  66
 *     2026-05         363                  38
 *     2026-06+         68                   0
 *
 *     tasks created >= 2026-06-01:   608, violating `json == text + child`:   1
 *     tasks created <  2026-06-01:  4459, violating `json == text + child`: 163
 *
 * So the live rule is `json == text + child`, honoured in 607 of 608 tasks
 * created since the change. The pre-change rows are a legacy convention, not
 * drift, and are reported separately so that a real regression is not buried
 * under them.
 *
 * ## What this must NOT be built on
 *
 * `tasks_acceptance_projection_state` is the obvious place to ask "is the
 * projection fresh?", and it lies. Measured 2026-09-12:
 *
 *     projection_key    status   last_projected_at     dirty rows
 *     task_acceptance   fresh    2026-05-26 08:48:55   0
 *
 * The projection had not run in three and a half months, reported itself
 * `fresh`, and had an empty dirty queue — while acceptance rows continued to be
 * written the whole time by a different, inline path. A freshness marker that is
 * *written* rather than *derived* is a claim, not a measurement. This scan
 * therefore derives the answer from the data every time and never reads that
 * table.
 *
 * @task T12157
 * @see ADR-088 — PM-Core V2 containers
 * @see ADR-092 — failure geometries; "a status surface that reports a state it
 *   does not measure"
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openCleoDbSnapshot } from '../store/open-cleo-db.js';

/** The dual-scope store filename (ADR-068). */
const LIVE_STORE_FILENAME = 'cleo.db';

/**
 * The date from which `json == text + child` has been honoured uniformly.
 *
 * Not a guess: containers created in 2026-04 omitted child projections from the
 * JSON column 66 times against 14 that included them; 2026-05 is the crossover
 * (363 vs 38); from 2026-06 onward it is 68 vs 0. Across ALL tasks created on or
 * after this date, exactly **one** violates the rule out of 608.
 *
 * Rows older than this are reported as `legacy` rather than as regressions, so
 * that the one real defect is not buried under 163 historical rows.
 */
export const ACCEPTANCE_CONVENTION_SETTLED_AT = '2026-06-01';

/**
 * How a task's two acceptance stores disagree, once the container/projection
 * composition rule has been applied.
 */
export type AcceptanceDriftKind =
  /** JSON holds criteria; the rows table has none at all. */
  | 'json-never-projected'
  /** Rows exist while the JSON column is empty — `cleo show` reads the JSON, so
   *  a read cannot see criteria that exist. The only data-losing shape. */
  | 'rows-unreadable'
  /** JSON holds exactly the TEXT criteria and omits the child projections —
   *  the pre-2026-06 convention, expected on older rows, a regression on new
   *  ones. */
  | 'legacy-children-omitted'
  /** Both populated and disagreeing by something other than the child
   *  projections. */
  | 'count-mismatch';

/** One task whose acceptance stores disagree. */
export interface AcceptanceDriftEntry {
  /** Task id, e.g. `T11176`. */
  readonly taskId: string;
  /** `epic` | `task` | `subtask` | `saga`. */
  readonly type: string;
  /** How the two stores disagree. */
  readonly kind: AcceptanceDriftKind;
  /** Number of entries in `acceptance_json`. */
  readonly jsonCount: number;
  /** Rows in `tasks_task_acceptance_criteria` with `kind='text'`. */
  readonly textRowCount: number;
  /** Rows with `kind='child_task'` — container projections, not text. */
  readonly childRowCount: number;
  /**
   * Whether `created_at` carries the application's ISO-8601 `T` separator.
   *
   * `false` means the value came from SQLite's `CURRENT_TIMESTAMP` column
   * default — the fingerprint of a write that bypassed the application layer.
   * Measured across a 5,067-task store: the application path had **0 failures
   * in 4,771 writes**, the bypass path 24 in 26. So this field usually answers
   * "why" without further investigation.
   */
  readonly appWritten: boolean;
  /** The task's `created_at`, verbatim. */
  readonly createdAt: string | null;
  /**
   * `true` when the task predates {@link ACCEPTANCE_CONVENTION_SETTLED_AT}, so
   * its shape reflects the older convention rather than a regression.
   */
  readonly legacyEra: boolean;
}

/** The result of a whole-store acceptance consistency scan. */
export interface AcceptanceDriftScanResult {
  /** Absolute path of the store that was scanned. */
  readonly storePath: string;
  /** `false` when there is no `.cleo/cleo.db` to scan; everything else is 0. */
  readonly storeExists: boolean;
  /** Tasks examined. */
  readonly tasksScanned: number;
  /**
   * Tasks that disagree on a RAW count comparison, before the composition rule.
   * Reported only so the difference from `entries.length` is visible — a reader
   * who has run the raw query themselves should be able to see why this number
   * is larger.
   */
  readonly rawDisagreements: number;
  /** The genuine residue, after applying the container/projection rule. */
  readonly entries: readonly AcceptanceDriftEntry[];
  /** One line per drift kind, for a summary line. */
  readonly byKind: Readonly<Record<AcceptanceDriftKind, number>>;
  /**
   * Entries created on or after {@link ACCEPTANCE_CONVENTION_SETTLED_AT}.
   *
   * This is the number that should gate anything. Measured 2026-09-12 on a
   * 5,067-task store: **1** (`T11889`, an epic whose JSON carries 8 criteria
   * against 4 text + 5 child rows), against 163 legacy-era entries.
   */
  readonly currentEraDrift: number;
}

/** A row as returned by the scan query. */
interface ScanRow {
  readonly id: string;
  readonly type: string;
  readonly created_at: string | null;
  readonly json_n: number;
  readonly text_n: number;
  readonly child_n: number;
}

/**
 * Classify one task, or `null` when its two stores are consistent.
 *
 * Exported for testing: the composition rule is the load-bearing part of this
 * module and deserves direct coverage rather than coverage through a DB.
 *
 * @param row - one task's JSON count and per-kind row counts.
 * @returns the drift kind, or `null` when the task is consistent.
 */
export function classifyAcceptanceDrift(row: {
  jsonCount: number;
  textRowCount: number;
  childRowCount: number;
}): AcceptanceDriftKind | null {
  const { jsonCount, textRowCount, childRowCount } = row;
  const expected = textRowCount + childRowCount;

  // Nothing recorded anywhere — consistent.
  if (jsonCount === 0 && expected === 0) return null;

  // The live convention: the JSON column carries every criterion, text and
  // child projection alike. Measured at 607/608 for tasks created since the
  // convention settled in 2026-06.
  if (jsonCount === expected) return null;

  if (jsonCount > 0 && expected === 0) return 'json-never-projected';

  // Rows exist and the JSON column is empty. This is the only shape where the
  // read path loses criteria that exist, because `cleo show` reads the JSON.
  if (jsonCount === 0) return 'rows-unreadable';

  // Both populated and disagreeing. When the shortfall is exactly the child
  // projections, this is the pre-2026-06 convention rather than a regression —
  // the caller separates the two by task age, which is a property of the row
  // and not of the counts.
  return jsonCount === textRowCount ? 'legacy-children-omitted' : 'count-mismatch';
}

/**
 * Scan a project's store for acceptance drift.
 *
 * Read-only: opens a snapshot handle through {@link openCleoDbSnapshot} rather
 * than the live chokepoint, so a survey never registers a writable handle or
 * competes for the WAL.
 *
 * @param projectRoot - absolute path to the project root.
 * @returns the survey; `entries` is empty for a consistent store.
 *
 * @example
 * ```ts
 * const scan = scanAcceptanceDrift('/mnt/projects/cleocode');
 * console.log(scan.entries.length, 'of', scan.rawDisagreements, 'raw');
 * // 58 of 164 raw
 * ```
 *
 * @task T12157
 */
export function scanAcceptanceDrift(projectRoot: string): AcceptanceDriftScanResult {
  const storePath = join(projectRoot, '.cleo', LIVE_STORE_FILENAME);
  const empty: Readonly<Record<AcceptanceDriftKind, number>> = {
    'json-never-projected': 0,
    'rows-unreadable': 0,
    'legacy-children-omitted': 0,
    'count-mismatch': 0,
  };

  if (!existsSync(storePath)) {
    return {
      storePath,
      storeExists: false,
      tasksScanned: 0,
      rawDisagreements: 0,
      entries: [],
      byKind: empty,
      currentEraDrift: 0,
    };
  }

  const snapshot = openCleoDbSnapshot(storePath);
  try {
    // `main.` is explicit: both tables also exist in the GLOBAL cleo.db, which
    // nexus ATTACHes onto project handles as `nexus_global`. A bare name would
    // resolve by SQLite search order and could answer from the wrong file
    // (gh#1283). A snapshot handle has one schema, but the qualifier is what
    // keeps that true if this query is ever moved.
    const rows = snapshot.db
      .prepare(
        `SELECT t.id AS id,
                t.type AS type,
                t.created_at AS created_at,
                CASE WHEN t.acceptance_json IS NULL
                       OR t.acceptance_json IN ('', '[]', 'null')
                     THEN 0
                     ELSE json_array_length(t.acceptance_json) END AS json_n,
                COALESCE(SUM(CASE WHEN c.kind = 'text' THEN 1 ELSE 0 END), 0) AS text_n,
                COALESCE(SUM(CASE WHEN c.kind = 'child_task' THEN 1 ELSE 0 END), 0) AS child_n
           FROM main.tasks_tasks t
           LEFT JOIN main.tasks_task_acceptance_criteria c ON c.task_id = t.id
          GROUP BY t.id`,
      )
      .all() as ScanRow[];

    const entries: AcceptanceDriftEntry[] = [];
    const byKind: Record<AcceptanceDriftKind, number> = { ...empty };
    let rawDisagreements = 0;

    for (const row of rows) {
      const jsonCount = Number(row.json_n) || 0;
      const textRowCount = Number(row.text_n) || 0;
      const childRowCount = Number(row.child_n) || 0;
      const totalRows = textRowCount + childRowCount;

      if (jsonCount !== totalRows) rawDisagreements += 1;

      const kind = classifyAcceptanceDrift({ jsonCount, textRowCount, childRowCount });
      if (kind === null) continue;

      byKind[kind] += 1;
      entries.push({
        taskId: row.id,
        type: row.type,
        kind,
        jsonCount,
        textRowCount,
        childRowCount,
        appWritten: (row.created_at ?? '').includes('T'),
        createdAt: row.created_at,
        legacyEra: (row.created_at ?? '') < ACCEPTANCE_CONVENTION_SETTLED_AT,
      });
    }

    return {
      storePath,
      storeExists: true,
      tasksScanned: rows.length,
      rawDisagreements,
      entries,
      byKind,
      currentEraDrift: entries.filter((e) => !e.legacyEra).length,
    };
  } finally {
    snapshot.close();
  }
}
