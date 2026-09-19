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
 * ## This is an OPERATOR command, NOT a CI gate — deliberately
 *
 * The baseline is per-install and lives at `.cleo/acceptance-drift-baseline.json`,
 * which `.cleo/.gitignore` excludes by design (line 25 is a blanket `*` with an
 * explicit allow list, and this file is correctly not on it — see
 * {@link ACCEPTANCE_DRIFT_BASELINE_FILE} for why it must not be tracked).
 *
 * So **in CI, or in any fresh clone, no baseline exists, every entry reports
 * unbaselined, and this command exits non-zero.** That is not a bug to route
 * around; it follows from the baseline being about rows in one store rather
 * than about source files. Every other baselined check in this repo IS a CI
 * gate whose baseline is tracked, so the next reader who sees
 * `--update-baseline` and a `.cleo/*-baseline.json` will reasonably
 * pattern-match this into `cleo check arch`. Do not.
 *
 * What CI *can* assert is the invariant that needs no per-install state: **no
 * task created since the convention settled violates `json == text + child`.**
 * That is a single query over the same data and it is clean in a fresh clone.
 *
 * ## Scope: cardinality, not content
 *
 * This compares COUNTS — how many criteria each store holds. It cannot see a
 * task whose JSON has the right number of entries but the wrong text, which is
 * what a renamed child produces, since JSON entries are literal
 * `"Complete child T9092: <title>"` strings.
 *
 * That gap was measured rather than assumed. Comparing the sorted multiset of
 * JSON strings against the row texts, restricted to tasks whose counts already
 * agree: **601 current-era tasks, 0 content differences; 4,053 legacy tasks, 1**
 * — `T11011`. So count identity is an excellent proxy in this store, and
 * content comparison would earn one legacy row. Named as out of scope rather
 * than left for a reader to discover.
 *
 * @task T12157
 * @see ADR-088 — PM-Core V2 containers
 * @see ADR-092 — failure geometries; "a status surface that reports a state it
 *   does not measure"
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SQLOutputValue } from 'node:sqlite';
import { acceptanceItemSchema } from '@cleocode/contracts';
import { openCleoDbSnapshot } from '../store/open-cleo-db.js';
import { acItemToText } from '../tasks/ac-table.js';

/** The dual-scope store filename (ADR-068). */
const LIVE_STORE_FILENAME = 'cleo.db';

/**
 * Where a project records the drift it has decided to live with.
 *
 * Per-INSTALL, not per-repo. The entries are task ids from this project's own
 * store, so a baseline committed to the cleo repository would bake cleocode's
 * task ids into a CLI that ships to everyone else.
 */
export const ACCEPTANCE_DRIFT_BASELINE_FILE = 'acceptance-drift-baseline.json';

/**
 * The date from which `json == text + child` has been honoured uniformly.
 *
 * Not a guess: containers created in 2026-04 omitted child projections from the
 * JSON column 66 times against 14 that included them; 2026-05 is the crossover
 * (363 vs 38); from 2026-06 onward it is 68 vs 0. Across ALL tasks created on or
 * after this date, exactly **one** violates the rule out of 608.
 *
 * Rows older than this are reported as `legacy` so a reader can see WHY an entry
 * is in the baseline. It is a REPORTING attribute only and does not decide what
 * fails — see {@link AcceptanceDriftScanResult.unbaselined} for why.
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
  | 'count-mismatch'
  /** Equal populations carry different criterion text or ordering. */
  | 'content-mismatch';

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
  /** Non-child rows in `tasks_task_acceptance_criteria` (text or evidence-bound). */
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
  /** Entries created on or after {@link ACCEPTANCE_CONVENTION_SETTLED_AT}. */
  readonly currentEraDrift: number;
  /**
   * Entries whose task id is NOT in the baseline — the number that gates.
   *
   * Creation date deliberately does not appear in this calculation. Acceptance
   * rows are written throughout a task's life (reparenting, child completion,
   * an edited criterion), so drift is introduced by a WRITE while a birthday is
   * fixed forever. Keying the gate on creation date exempts every old task from
   * every future regression: measured on this store, **223 tasks created before
   * the convention settled have been updated since**, and a date-keyed gate is
   * blind to new drift across 4,459 of 5,068 rows — 88% of the store.
   *
   * A baseline of known ids fixes that. It is wrong about the past on purpose
   * so it can be right about the future: the 163 historical rows stay quiet,
   * and a pre-June task that drifts tomorrow is a net-add and fails.
   */
  readonly unbaselined: readonly AcceptanceDriftEntry[];
  /** Baselined ids that no longer drift — safe to prune. */
  readonly staleBaselineIds: readonly string[];
  /** Absolute path of the baseline file, whether or not it exists. */
  readonly baselinePath: string;
}

/**
 * Read the per-install baseline of task ids whose drift is accepted.
 *
 * A missing or unreadable file yields an empty set, so a first run reports
 * everything rather than silently passing. Failing open here would reproduce
 * the defect this module exists to catch.
 */
export function readAcceptanceDriftBaseline(baselinePath: string): ReadonlySet<string> {
  if (!existsSync(baselinePath)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(baselinePath, 'utf-8')) as { taskIds?: unknown };
    if (!Array.isArray(parsed.taskIds)) return new Set();
    return new Set(parsed.taskIds.filter((id): id is string => typeof id === 'string'));
  } catch {
    return new Set();
  }
}

/**
 * Write the baseline from a scan, accepting every current entry.
 *
 * @param scan - a completed scan; its entries become the accepted set.
 * @returns the number of ids recorded.
 */
export function writeAcceptanceDriftBaseline(scan: AcceptanceDriftScanResult): number {
  const taskIds = [...scan.entries].map((e) => e.taskId).sort();
  writeFileSync(
    scan.baselinePath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        note:
          'Acceptance drift accepted for these task ids (gh#1290). Any OTHER drifting task fails ' +
          '`cleo doctor acceptance-drift`, regardless of when it was created. Regenerate with ' +
          '`cleo doctor acceptance-drift --update-baseline`.',
        taskIds,
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
  return taskIds.length;
}

/** A row as returned by the scan query. */
interface ScanRow {
  readonly id: string;
  readonly type: string;
  readonly created_at: string | null;
  readonly json_n: number;
  readonly text_n: number;
  readonly child_n: number;
  readonly acceptance_json: string;
  readonly row_texts_json: string;
}

/** Narrow a column to `string`, or `null` when it is absent or another type. */
function columnAsStringOrNull(value: SQLOutputValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Narrow a numeric column, tolerating the `bigint` SQLite may return.
 *
 * `COUNT`/`SUM` come back as `number` for small results and `bigint` for large
 * ones, and `json_array_length` is an integer. Anything else is a column that
 * is not what this module thinks it is, which {@link toScanRow} rejects.
 */
function columnAsCount(value: SQLOutputValue | undefined): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return null;
}

/**
 * Convert one driver row into a {@link ScanRow}.
 *
 * Explicit rather than a cast. `node:sqlite` hands back
 * `Record<string, SQLOutputValue>`, and asserting that into a shaped interface
 * would compile while silently tolerating a column set that no longer matches —
 * in a module whose entire purpose is detecting exactly that kind of drift.
 *
 * @throws when a column is missing or has an unexpected type, so a query that
 *   drifts from this shape fails loudly at the first row instead of producing
 *   a scan full of zeroes that reads like a clean store.
 */
function toScanRow(record: Record<string, SQLOutputValue>): ScanRow {
  const id = columnAsStringOrNull(record['id']);
  const jsonN = columnAsCount(record['json_n']);
  const textN = columnAsCount(record['text_n']);
  const childN = columnAsCount(record['child_n']);
  const acceptanceJson = columnAsStringOrNull(record['acceptance_json']);
  const rowTextsJson = columnAsStringOrNull(record['row_texts_json']);

  // Name the offending column. An error that says only "the shape is wrong"
  // sends the reader to the SQL when the problem is one value in one row —
  // the failure describing the wrong thing with full confidence (ADR-092).
  const bad = [
    ['id', id],
    ['json_n', jsonN],
    ['text_n', textN],
    ['child_n', childN],
    ['acceptance_json', acceptanceJson],
    ['row_texts_json', rowTextsJson],
  ].find(([, value]) => value === null)?.[0];

  if (
    bad !== undefined ||
    id === null ||
    jsonN === null ||
    textN === null ||
    childN === null ||
    acceptanceJson === null ||
    rowTextsJson === null
  ) {
    throw new Error(
      `acceptance-drift: scan column "${String(bad)}" had an unexpected type ` +
        `(got ${typeof record[String(bad)]}) for task ${String(record['id'] ?? '<unknown>')}. ` +
        'The SQL and ScanRow have drifted apart.',
    );
  }

  return {
    id,
    // `type` is NULLABLE in practice: 174 of 5,068 rows in this store carry no
    // type at all. It is a reporting field here, not an input to the drift
    // classification, so a missing one must not abort a whole-store survey.
    type: columnAsStringOrNull(record['type']) ?? 'unknown',
    created_at: columnAsStringOrNull(record['created_at']),
    json_n: jsonN,
    text_n: textN,
    child_n: childN,
    acceptance_json: acceptanceJson,
    row_texts_json: rowTextsJson,
  };
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
  /** Whether persisted criterion text and ordering agree when assessed. */
  contentMatches?: boolean;
}): AcceptanceDriftKind | null {
  const { jsonCount, textRowCount, childRowCount } = row;
  const expected = textRowCount + childRowCount;

  // Nothing recorded anywhere — consistent.
  if (jsonCount === 0 && expected === 0) return null;

  // The live convention: the JSON column carries every criterion, text and
  // child projection alike. Measured at 607/608 for tasks created since the
  // convention settled in 2026-06.
  if (jsonCount === expected) return row.contentMatches === false ? 'content-mismatch' : null;

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
  const baselinePath = join(projectRoot, '.cleo', ACCEPTANCE_DRIFT_BASELINE_FILE);
  const baselined = readAcceptanceDriftBaseline(baselinePath);
  const empty: Readonly<Record<AcceptanceDriftKind, number>> = {
    'json-never-projected': 0,
    'rows-unreadable': 0,
    'legacy-children-omitted': 0,
    'count-mismatch': 0,
    'content-mismatch': 0,
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
      unbaselined: [],
      staleBaselineIds: [],
      baselinePath,
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
                COALESCE(SUM(CASE WHEN c.kind IN ('text', 'evidence_bound') THEN 1 ELSE 0 END), 0) AS text_n,
                COALESCE(SUM(CASE WHEN c.kind = 'child_task' THEN 1 ELSE 0 END), 0) AS child_n,
                CASE WHEN t.acceptance_json IS NULL OR t.acceptance_json IN ('', 'null')
                     THEN '[]' ELSE t.acceptance_json END AS acceptance_json,
                (SELECT json_group_array(text) FROM
                  (SELECT c2.text FROM main.tasks_task_acceptance_criteria c2
                   WHERE c2.task_id = t.id ORDER BY c2.ordinal)) AS row_texts_json
           FROM main.tasks_tasks t
           LEFT JOIN main.tasks_task_acceptance_criteria c ON c.task_id = t.id
          GROUP BY t.id`,
      )
      .all()
      .map(toScanRow);

    const entries: AcceptanceDriftEntry[] = [];
    const byKind: Record<AcceptanceDriftKind, number> = { ...empty };
    let rawDisagreements = 0;

    for (const row of rows) {
      const jsonCount = row.json_n;
      const textRowCount = row.text_n;
      const childRowCount = row.child_n;
      const totalRows = textRowCount + childRowCount;

      if (jsonCount !== totalRows) rawDisagreements += 1;

      // Validate persisted payloads rather than silently coercing malformed
      // records into empty arrays. The canonical formatter preserves structured
      // gates while comparing their serialized representation to row text.
      const legacy = acceptanceItemSchema
        .array()
        .parse(JSON.parse(row.acceptance_json))
        .map(acItemToText);
      const projected = acceptanceItemSchema
        .array()
        .parse(JSON.parse(row.row_texts_json))
        .map(acItemToText);
      const contentMatches =
        legacy.length === projected.length &&
        legacy.every((text, index) => text === projected[index]);
      const kind = classifyAcceptanceDrift({
        jsonCount,
        textRowCount,
        childRowCount,
        contentMatches,
      });
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
        // Fail CLOSED on a missing date: an unknown creation date must not
        // buy an exemption. Measured 0 null/empty in 5,068 rows, so this
        // guards a direction rather than a known victim.
        legacyEra:
          row.created_at !== null &&
          row.created_at !== '' &&
          row.created_at < ACCEPTANCE_CONVENTION_SETTLED_AT,
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
      unbaselined: entries.filter((e) => !baselined.has(e.taskId)),
      staleBaselineIds: [...baselined].filter((id) => !entries.some((e) => e.taskId === id)),
      baselinePath,
    };
  } finally {
    snapshot.close();
  }
}
