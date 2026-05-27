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
import { isSagaShape } from './enforcement.js';

/**
 * Resolve Saga member Epic IDs through `parent_id` containment.
 *
 * After T10637 (E10.W5), Saga membership moved from
 * `task_relations.type='groups'` to `parent_id` containment. Member
 * Epics carry `parentId` pointing at the Saga. This helper queries
 * tasks with `parentId = sagaId` and returns their IDs.
 *
 * @param accessor - Data accessor backing the lookup.
 * @param sagaId - The Saga task ID (must have `type='saga'`).
 * @returns Member Epic IDs in stable order. Empty if no members.
 *          `null` if no task with `sagaId` exists or the task is not a saga.
 *
 * @task T10638 — E10.W5 switch to parent_id containment
 */
export async function resolveSagaMemberIds(
  accessor: DataAccessor,
  sagaId: string,
): Promise<string[] | null> {
  const sagaTask = await accessor.loadSingleTask(sagaId);
  if (!sagaTask) return null;
  if (!isSagaShape(sagaTask)) return null;
  const result = await accessor.queryTasks({ parentId: sagaId });
  return (result?.tasks ?? []).map((t) => t.id);
}

/**
 * Find every saga that contains the given task as a member via `parent_id`.
 *
 * Loads the task, checks if its `parentId` points to a saga (type='saga'),
 * and returns the saga task if so. After T10637, membership is via
 * `parent_id` containment rather than `task_relations.type='groups'`.
 *
 * Consumed by the saga auto-close branch in `tasks/complete.ts`.
 *
 * @param accessor - Data accessor backing the lookup.
 * @param memberId - Task ID to test for saga membership.
 * @returns The saga task containing `memberId`, or empty array.
 *
 * @task T10638 — E10.W5 switch to parent_id containment
 */
export async function findSagasGroupingTask(
  accessor: DataAccessor,
  memberId: string,
): Promise<Task[]> {
  const memberTask = await accessor.loadSingleTask(memberId);
  if (!memberTask?.parentId) return [];
  const parentTask = await accessor.loadSingleTask(memberTask.parentId);
  if (!parentTask || !isSagaShape(parentTask)) return [];
  return [parentTask];
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
