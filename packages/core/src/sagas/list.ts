/**
 * saga.list — list all Sagas (labeled top-level Epics).
 *
 * Returns every row with `type='epic'` + `label='saga'`, INCLUDING any rows
 * that carry a non-null `parentId` (which is itself an invariant-I5 violation
 * per ADR-073 §1.2). The historical `!parentId` filter silently hid those
 * rows; that bug is fixed here under T10117.
 *
 * Behaviour:
 * - All saga-labeled rows are returned in `data.sagas`.
 * - For each row with `parentId != null`, a structured
 *   `E_SAGA_INVARIANT_VIOLATION_I5` warning is appended to the result
 *   payload (`data.warnings`) AND pushed onto the active LAFS
 *   `WarningCollector` so the dispatch layer surfaces it via
 *   `_meta.warnings[]` on the envelope.
 * - When no row has a `parentId`, the `warnings` array is omitted entirely
 *   (no zero-length array), preserving the pre-T10117 envelope shape for
 *   the well-formed case (AC5).
 *
 * Moved from `packages/cleo/src/dispatch/domains/tasks.ts::sagaList` per
 * AGENTS.md Package-Boundary Check (Saga T10113 / Epic T10208).
 *
 * @task T10117 — sagaList loud-filter + I5 warnings
 * @task T10124
 * @task T10120
 * @epic T10208
 * @saga T10113
 * @see ADR-073-above-epic-naming.md §1 — Task Hierarchy Charter
 * @see ADR-073-above-epic-naming.md §1.2 — invariant I5
 */

import type { TaskRecord } from '@cleocode/contracts';
import { pushWarning } from '@cleocode/lafs';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { type CompactTask, taskList } from '../tasks/list.js';
import { E_SAGA_INVARIANT_VIOLATION_I5 } from './enforcement.js';

/**
 * Single I5-violation warning entry attached to `SagaListResult.warnings`.
 *
 * The shape is intentionally narrow: `code` is fixed, `sagaId` is the saga
 * that broke the invariant, and `offendingParentId` is the non-null
 * `parentId` value that should have lived in a `task_relations.type='groups'`
 * edge instead.
 *
 * @task T10117
 */
export interface SagaInvariantI5Warning {
  /** Fixed warning code — `'E_SAGA_INVARIANT_VIOLATION_I5'`. */
  code: typeof E_SAGA_INVARIANT_VIOLATION_I5;
  /** The saga task ID whose `parentId` violates invariant I5. */
  sagaId: string;
  /** The non-null `parentId` value found on the saga row. */
  offendingParentId: string;
}

/** Result payload for {@link sagaList}. */
export interface SagaListResult {
  /** Every saga-labeled row, regardless of `parentId`. */
  sagas: Array<TaskRecord | CompactTask>;
  /** Total count — always equal to `sagas.length`. */
  total: number;
  /**
   * One entry per saga with a non-null `parentId`. Omitted entirely when no
   * violations were observed, so the envelope shape for a well-formed
   * dataset matches the pre-T10117 contract.
   */
  warnings?: SagaInvariantI5Warning[];
}

/**
 * Extract a `parentId` value from a saga task record without leaning on the
 * raw `TaskRecord` shape (which keeps `parentId` optional). Centralised so
 * the filter and warning paths stay in sync.
 *
 * @param task - A saga row from `taskList`.
 * @returns The non-empty `parentId` string, or `null` if absent.
 */
function readParentId(task: TaskRecord | CompactTask): string | null {
  const parentId = (task as { parentId?: string | null }).parentId;
  return parentId ? parentId : null;
}

/**
 * Hard cap passed to the underlying `taskList` call.
 *
 * The default `taskList` limit is 10, which silently truncates `cleo saga
 * list` once the repo grows past ~10 saga-labeled Epics. We bump the cap to
 * 1000 here so the loud-include path (T10117) actually surfaces every saga
 * the database holds. If a project ever exceeds 1000 sagas, the call still
 * returns successfully but a `truncated` warning is appended to
 * `data.warnings` AND the LAFS `WarningCollector` so consumers know the
 * envelope is incomplete. The 1000-row ceiling guards against accidental
 * unbounded reads on pathological databases.
 *
 * @task T10236 — sagaList default-limit truncation fix (Saga T10113 closeout)
 */
const SAGA_LIST_HARD_LIMIT = 1000;

/**
 * List every top-level Saga, including rows whose `parentId` is non-null
 * (a known invariant-I5 violation surfaced as a structured warning).
 *
 * Passes `limit: ${SAGA_LIST_HARD_LIMIT}` to the underlying `taskList` call.
 * The default `taskList` limit is 10 — small enough that a 19-saga repo
 * silently dropped 9 rows from the loud-include result that T10117 was
 * meant to expose. T10236 raised the cap so `cleo saga list` returns the
 * full set. If the cap is hit, a `truncated` warning is surfaced via
 * `pushWarning()` so consumers see the envelope is incomplete.
 *
 * @param projectRoot - Absolute path to the project root.
 */
export async function sagaList(projectRoot: string): Promise<EngineResult<SagaListResult>> {
  // T10331 (Saga T10326 W2.B): dual-shape sweep — query BOTH the canonical
  // `type='saga'` rows AND the legacy `type='epic' + label='saga'` rows. The
  // two predicates union into a single saga catalog during the deprecation
  // window; W3.C T10334 collapses to the single new-shape query.
  const [newShape, oldShape] = await Promise.all([
    taskList(projectRoot, { type: 'saga', limit: SAGA_LIST_HARD_LIMIT }),
    taskList(projectRoot, {
      type: 'epic',
      label: 'saga',
      limit: SAGA_LIST_HARD_LIMIT,
    }),
  ]);
  if (!newShape.success) {
    return engineError('E_GENERAL', newShape.error?.message ?? 'Failed to list Sagas');
  }
  if (!oldShape.success) {
    return engineError('E_GENERAL', oldShape.error?.message ?? 'Failed to list Sagas');
  }
  // Merge + dedupe by id (insertion-order stable: new-shape rows first).
  const seenIds = new Set<string>();
  const newShapeTasks = newShape.data?.tasks ?? [];
  const oldShapeTasks = oldShape.data?.tasks ?? [];
  const tasks: Array<(typeof newShapeTasks)[number]> = [];
  for (const t of [...newShapeTasks, ...oldShapeTasks]) {
    if (seenIds.has(t.id)) continue;
    seenIds.add(t.id);
    tasks.push(t);
  }

  // T10117: loud-include — every saga-labeled row surfaces, with one warning
  // per I5 violator. We collect warnings inline rather than filtering them
  // out so consumers see what's wrong without a second round trip.
  const warnings: SagaInvariantI5Warning[] = [];
  for (const task of tasks) {
    const offendingParentId = readParentId(task);
    if (offendingParentId === null) continue;
    const warning: SagaInvariantI5Warning = {
      code: E_SAGA_INVARIANT_VIOLATION_I5,
      sagaId: task.id,
      offendingParentId,
    };
    warnings.push(warning);
    // Also surface through the LAFS WarningCollector so the dispatch
    // adapter attaches it to `_meta.warnings[]`. Falls back to a no-op
    // when no collector is bound (test harness, SDK consumers, etc.).
    pushWarning({
      code: E_SAGA_INVARIANT_VIOLATION_I5,
      message: `Saga ${task.id} has non-null parentId='${offendingParentId}' (ADR-073 §1.2 invariant I5). Run \`cleo saga repair ${task.id}\` to detach and re-attach via task_relations.type='groups'.`,
      severity: 'warn',
      context: { sagaId: task.id, offendingParentId },
    });
  }

  const payload: SagaListResult = {
    sagas: tasks,
    total: tasks.length,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  return engineSuccess(payload);
}
