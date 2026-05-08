/**
 * Coordination parent detection and rollup evidence synthesis.
 *
 * A "coordination parent" is a task that:
 *   1. Has no files of its own (`files` is absent, null, or empty).
 *   2. Has at least one registered child.
 *   3. Has `noAutoComplete` unset or `false`.
 *
 * These tasks act purely as scope containers — their scope was delivered
 * entirely by their children (e.g. T1916/T1918/T1919 in T1910). Before T9040,
 * they required manual evidence atoms and stayed `pending` forever unless the
 * orchestrator performed an expensive workaround.
 *
 * This module provides:
 *   - {@link isCoordinationParent} — predicate used by the completion path.
 *   - {@link buildRollupEvidence} — synthesizes verification evidence by
 *     aggregating children's gate state.
 *
 * @task T9040
 */

import type { GateEvidence, Task, TaskVerification, VerificationGate } from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Determine whether a task is a "coordination parent".
 *
 * A coordination parent has NO own implementation files but DOES own children.
 * This pattern arises when a task was added as a scope container for a wave of
 * subtasks, with no code changes on the parent itself.
 *
 * Rules:
 *   - `task.files` is absent, `null`, or an empty array.
 *   - `childrenCount > 0` (caller must pass the actual children length).
 *   - `task.noAutoComplete` is NOT `true` (respects the existing opt-out flag).
 *
 * Both epic and non-epic tasks can be coordination parents. Epics already have
 * their own rollup path in `completeTask`; this helper is primarily used for
 * `type='task'` nodes that act as group containers within a larger epic.
 *
 * @param task - The task to test.
 * @param childrenCount - Number of registered children for the task.
 * @returns `true` when the task is a coordination parent.
 *
 * @task T9040
 */
export function isCoordinationParent(task: Task, childrenCount: number): boolean {
  if (task.noAutoComplete === true) return false;
  if (childrenCount === 0) return false;
  const hasOwnFiles = Array.isArray(task.files) && task.files.length > 0;
  return !hasOwnFiles;
}

/**
 * Standard verification gates synthesized during parent rollup.
 *
 * Order mirrors the canonical gate sequence from the verification module.
 */
const ROLLUP_GATES: ReadonlyArray<VerificationGate> = [
  'implemented',
  'testsPassed',
  'qaPassed',
  'cleanupDone',
  'securityPassed',
  'documented',
] as const;

/**
 * Synthesize a {@link TaskVerification} for a coordination parent by
 * aggregating the verification state of all non-cancelled children.
 *
 * Gate synthesis rules:
 *   - `implemented` — always `true` (children carried the scope).
 *   - `testsPassed`, `qaPassed`, `cleanupDone`, `securityPassed`, `documented`
 *     — `true` when ALL non-cancelled children have the gate set to `true`, OR
 *     when no child has any verification metadata (best-effort rollup for
 *     projects without strict enforcement).
 *   - `passed` — always `true` for a coordination parent whose children are all
 *     done/cancelled (the caller has already confirmed terminal state).
 *
 * The `evidence` block on each gate carries a `note` atom explaining that this
 * is a synthesized rollup, and a second `note` atom referencing the child IDs
 * that delivered the scope.
 *
 * @param parentId - ID of the coordination parent (used in evidence notes).
 * @param children - All registered children of the parent (including cancelled).
 * @returns A fully synthesized {@link TaskVerification} ready for upsert.
 *
 * @task T9040
 */
export function buildRollupEvidence(parentId: string, children: Task[]): TaskVerification {
  const nonCancelled = children.filter((c) => c.status !== 'cancelled');
  const childIds = nonCancelled.map((c) => c.id).join(',');
  const now = new Date().toISOString();

  /**
   * Return true when the given gate passes for ALL non-cancelled children.
   * Children without any verification record are treated as passing so that
   * coordination parents in non-enforcement projects can still roll up.
   */
  function childrenPassGate(gate: VerificationGate): boolean {
    if (nonCancelled.length === 0) return true;
    return nonCancelled.every((c) => {
      if (!c.verification) return true; // no verification → best-effort pass
      return c.verification.gates?.[gate] === true;
    });
  }

  /**
   * Build a single gate's evidence record with two note atoms:
   *   1. A note describing the rollup provenance.
   *   2. A note listing the child task IDs that delivered this gate.
   */
  function makeGateEvidence(gate: VerificationGate, passed: boolean): GateEvidence {
    return {
      atoms: [
        {
          kind: 'note',
          note: `coordination-rollup:${parentId}:${gate}=${String(passed)}`,
        },
        {
          kind: 'note',
          note: `linked_tasks:${childIds}`,
        },
      ],
      capturedAt: now,
      capturedBy: 'system:coordination-rollup',
    };
  }

  const gates: Partial<Record<VerificationGate, boolean>> = { implemented: true };
  const evidence: Partial<Record<VerificationGate, GateEvidence>> = {};

  // implemented is always true for a coordination parent
  evidence.implemented = makeGateEvidence('implemented', true);

  // All other standard gates: synthesize from children's state
  for (const gate of ROLLUP_GATES) {
    if (gate === 'implemented') continue;
    const passed = childrenPassGate(gate);
    gates[gate] = passed;
    evidence[gate] = makeGateEvidence(gate, passed);
  }

  return {
    round: 1,
    passed: true,
    gates: {
      implemented: true,
      testsPassed: gates.testsPassed ?? false,
      qaPassed: gates.qaPassed ?? false,
      cleanupDone: gates.cleanupDone ?? false,
      securityPassed: gates.securityPassed ?? false,
      documented: gates.documented ?? false,
    },
    evidence,
    lastAgent: null,
    lastUpdated: now,
    failureLog: [],
    initializedAt: now,
  } satisfies TaskVerification;
}
