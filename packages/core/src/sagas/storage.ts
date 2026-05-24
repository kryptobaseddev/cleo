/**
 * Saga storage helpers — direct DataAccessor reads scoped to the Saga model.
 *
 * Lives in `packages/core/src/sagas/` so the dispatch layer (and any other
 * Saga-aware caller) imports a single helper rather than re-deriving the
 * label / relation-type / member-walk logic locally.
 *
 * Moved from `packages/core/src/tasks/list.ts` (where it shipped as a
 * file-local `resolveSagaMemberIds`) per Saga T10113 / Epic T10208.
 *
 * @task T10123
 * @task T10120
 * @task T10116 — `findSagasGroupingTask` + `buildSagaAutoCloseEvidence`
 *               helpers consumed by the saga auto-close branch in
 *               `tasks/complete.ts`.
 * @epic T10208
 * @epic T10210 — E-SAGA-AUTO-CLOSE
 * @see ADR-073-above-epic-naming.md §1
 */

import type { GateEvidence, Task, TaskVerification, VerificationGate } from '@cleocode/contracts';
import type { DataAccessor } from '../store/data-accessor.js';
import { SAGA_GROUPS_RELATION } from './constants.js';
import { isSagaShape } from './enforcement.js';

/**
 * Resolve Saga member Epic IDs through `task_relations.type='groups'` edges.
 *
 * Sagas (Epics with `labels` containing `'saga'`) hold their member Epics via
 * `task_relations.type='groups'` rows, not via the `parentId` column. This
 * helper loads the saga task, walks its populated `relates` array, and
 * returns the member task IDs in stable order.
 *
 * Reused by `listTasks` when `--parent` targets a Saga to mirror the
 * resolution `tasks.saga.members` performs at the dispatch layer (ADR-073).
 *
 * @param accessor - Data accessor backing the lookup.
 * @param sagaId - The Saga task ID (must have `labels.includes('saga')`).
 * @returns Member Epic IDs (deduplicated, insertion-order stable). Empty if
 *          the saga has no `groups` edges. `null` if no task with `sagaId`
 *          exists or the task is not labeled `'saga'`.
 *
 * @task T9658
 * @task T10123
 * @see ADR-073-above-epic-naming.md §1
 */
export async function resolveSagaMemberIds(
  accessor: DataAccessor,
  sagaId: string,
): Promise<string[] | null> {
  const sagaTask = await accessor.loadSingleTask(sagaId);
  if (!sagaTask) return null;
  // T10331 (Saga T10326 W2.B): dual-shape acceptance via isSagaShape.
  if (!isSagaShape(sagaTask)) return null;
  const seen = new Set<string>();
  const memberIds: string[] = [];
  for (const relation of sagaTask.relates ?? []) {
    if (relation.type !== SAGA_GROUPS_RELATION) continue;
    if (seen.has(relation.taskId)) continue;
    seen.add(relation.taskId);
    memberIds.push(relation.taskId);
  }
  return memberIds;
}

/**
 * Find every saga that groups the given task as a member.
 *
 * Walks the saga catalog (every row with `type='epic'` AND
 * `labels.includes('saga')`) and returns the subset whose populated
 * `relates` array contains a `task_relations.type='groups'` edge pointing
 * at `memberId`.
 *
 * Consumed by the saga auto-close branch in `tasks/complete.ts` — when a
 * task transitions to `done`, the completion path needs to know which
 * sagas (if any) should be considered for auto-close as a side-effect of
 * that transition. The returned sagas are loaded with their full
 * `relates` array so the caller can immediately resolve their member IDs
 * without a second round-trip.
 *
 * Implementation notes:
 *   - Uses `queryTasks({ type: 'epic', label: 'saga' })`, which already
 *     populates `relates` via `loadRelationsForTasks` in the SQLite
 *     accessor — no additional `loadSingleTask` calls per saga are
 *     needed.
 *   - Filters out any saga whose row no longer carries the `'saga'`
 *     label after rehydration (defence-in-depth — `queryTasks` is
 *     authoritative, but a future schema migration could relax the
 *     label index without notice).
 *
 * @param accessor - Data accessor backing the lookup.
 * @param memberId - Task ID to test for saga membership.
 * @returns Every saga grouping `memberId`, in stable saga-ID order.
 *
 * @task T10116
 * @epic T10210
 * @see ADR-073-above-epic-naming.md §1
 */
export async function findSagasGroupingTask(
  accessor: DataAccessor,
  memberId: string,
): Promise<Task[]> {
  // T10331 (Saga T10326 W2.B): dual-shape sweep — query BOTH the canonical
  // `type='saga'` rows AND the legacy `type='epic' + label='saga'` rows so
  // not-yet-migrated rows in long-lived sessions still surface during the
  // deprecation window. W3.C T10334 collapses to the single new-shape query.
  const [newShape, oldShape] = await Promise.all([
    accessor.queryTasks({ type: 'saga' }),
    accessor.queryTasks({ type: 'epic', label: 'saga' }),
  ]);
  const seenIds = new Set<string>();
  const matches: Task[] = [];
  for (const saga of [...newShape.tasks, ...oldShape.tasks]) {
    if (seenIds.has(saga.id)) continue;
    seenIds.add(saga.id);
    if (!isSagaShape(saga)) continue;
    const hasMemberEdge = (saga.relates ?? []).some(
      (relation) => relation.type === SAGA_GROUPS_RELATION && relation.taskId === memberId,
    );
    if (!hasMemberEdge) continue;
    matches.push(saga);
  }
  return matches;
}

/**
 * Standard verification gates synthesized when a saga auto-closes.
 *
 * Mirrors the canonical gate sequence used elsewhere (see
 * {@link buildRollupEvidence} in `coordination-parent.ts`). Saga members
 * are Epics, not subtasks — every gate is delivered by a member's own
 * completion chain, so the saga's rollup synthesizes a `note`-atom
 * envelope that names the closing event and points at ADR-073.
 */
const SAGA_AUTO_CLOSE_GATES: ReadonlyArray<VerificationGate> = [
  'implemented',
  'testsPassed',
  'qaPassed',
  'cleanupDone',
  'securityPassed',
  'documented',
] as const;

/**
 * Synthesize a {@link TaskVerification} envelope for an auto-closing saga.
 *
 * A saga's status flips to `done` as a side-effect of the last pending
 * member completing. Sagas never run their own evidence pipeline (their
 * scope is delivered by member Epics), so the auto-close path needs to
 * fabricate a verification record that:
 *
 *   1. Points back at the closing trigger
 *      (`note:saga-auto-close-via-completeTask`).
 *   2. Names every terminal member so an auditor can reconstruct the
 *      rollup without re-walking the relation table
 *      (`note:members:<csv>`).
 *   3. Cites the ADR that authorises the synthesis path
 *      (`note:adr:ADR-073 §1.2 invariants I3+I5`).
 *
 * Each standard gate receives the same three-atom envelope. `passed=true`
 * is set unconditionally — the caller has already verified that every
 * member is terminal (`done` or `cancelled`) before entering this path.
 *
 * @param sagaId - The saga task ID being auto-closed.
 * @param memberIds - Member Epic IDs that delivered the saga's scope
 *   (terminal or cancelled). Order is preserved verbatim in the `members`
 *   note atom so the audit row is stable across re-runs.
 * @param now - ISO-8601 timestamp captured by the caller (kept consistent
 *   with the rest of the completion path's `now` stamp).
 * @returns A fully-populated {@link TaskVerification} ready for upsert.
 *
 * @task T10116
 * @epic T10210
 * @see ADR-073-above-epic-naming.md §1.2
 */
export function buildSagaAutoCloseEvidence(
  sagaId: string,
  memberIds: readonly string[],
  now: string,
): TaskVerification {
  const memberCsv = memberIds.join(',');

  /**
   * Build the three-atom envelope shared by every gate. The atoms
   * preserve the closing event, the member rollup digest, and the ADR
   * citation so a future doctor audit can re-verify the synthesis.
   */
  function makeGateEvidence(gate: VerificationGate): GateEvidence {
    return {
      atoms: [
        { kind: 'note', note: `saga-auto-close-via-completeTask:${sagaId}:${gate}` },
        { kind: 'note', note: `members:${memberCsv}` },
        { kind: 'note', note: 'adr:ADR-073 §1.2 invariants I3+I5' },
      ],
      capturedAt: now,
      capturedBy: 'system:saga-auto-close',
    };
  }

  const evidence: Partial<Record<VerificationGate, GateEvidence>> = {};
  for (const gate of SAGA_AUTO_CLOSE_GATES) {
    evidence[gate] = makeGateEvidence(gate);
  }

  return {
    round: 1,
    passed: true,
    gates: {
      implemented: true,
      testsPassed: true,
      qaPassed: true,
      cleanupDone: true,
      securityPassed: true,
      documented: true,
    },
    evidence,
    lastAgent: null,
    lastUpdated: now,
    failureLog: [],
    initializedAt: now,
  } satisfies TaskVerification;
}
