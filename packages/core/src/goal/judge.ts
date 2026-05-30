/**
 * Evidence-gate-aware goal judge (Layer 4 of SG-COGNITIVE-SUBSTRATE).
 *
 * This is CLEO's core differentiator over Claude-Code (transcript judge) and
 * Hermes (post-turn loop, still transcript-judged for fuzzy intent). For a
 * `task-completion` goal, the judge NEVER reads the transcript: it resolves the
 * target task's REAL status and re-uses the shipped ADR-051 evidence
 * infrastructure ({@link validateEvidenceForGate} +
 * {@link GATE_EVIDENCE_REQUIREMENTS} via `tasks/evidence.ts`). A goal is
 * satisfied ONLY when the task is `status === 'done'` AND every required gate
 * ({@link CRITICAL_GATES}) is backed by evidence atoms of the kinds ADR-051
 * mandates. Transcript text can never satisfy a task-completion goal.
 *
 * `fuzzy` goals — those with no machine-checkable artifact — delegate to an
 * INJECTABLE LLM judge ({@link GoalJudge}). The judge interface, not a concrete
 * model client, is the dependency, so vitest passes a deterministic mock and
 * stays fully offline/hermetic. The fuzzy path NEVER touches the evidence
 * infrastructure.
 *
 * @module @cleocode/core/goal/judge
 *
 * @epic T11290 EP-CLEO-GOAL-SYSTEM
 * @task T11378
 * @saga T11283 SG-COGNITIVE-SUBSTRATE
 * @adr ADR-051
 */

import type {
  GoalJudge,
  GoalJudgeVerdict,
  GoalRecord,
  VerificationGate,
} from '@cleocode/contracts';
// Re-use the EXISTING ADR-051 evidence path — do NOT re-implement atom parsing.
// `validateEvidenceForGate` + `GATE_EVIDENCE_REQUIREMENTS` are the shipped SSoT
// in @cleocode/contracts; `core/src/tasks/evidence.ts` is the matching core
// surface (it imports the SAME two symbols and is the gate machinery's home).
import { GATE_EVIDENCE_REQUIREMENTS, isTaskCompletionGoal } from '@cleocode/contracts';
import { getTaskAccessor } from '../store/data-accessor.js';
// Sourced from tasks/evidence.ts so the judge sits on the canonical core
// evidence module rather than re-deriving validation (AC: no re-implementation).
import { checkGateEvidenceMinimum } from '../tasks/evidence.js';

/**
 * The gates a task-completion goal demands be evidence-backed before it is
 * judged satisfied. These are the ADR-051 critical gates that reject
 * override-only evidence (`implemented` + `testsPassed`) — the same two gates
 * `cleo complete` enforces hardest. A goal that says "complete T123" therefore
 * means exactly what CLEO means by complete: code landed (commit+files) AND
 * tests proven (test-run/tool/pr), with real, validated atoms.
 *
 * @task T11378
 * @adr ADR-051
 */
export const CRITICAL_GATES: readonly VerificationGate[] = Object.freeze([
  'implemented',
  'testsPassed',
]);

/**
 * Judge a goal and return a uniform {@link GoalJudgeVerdict}.
 *
 * Routing:
 * - `task-completion` → {@link judgeTaskCompletion} (evidence path, no LLM).
 * - `fuzzy`           → the injected {@link GoalJudge} (LLM fallback).
 *
 * The `llmJudge` is REQUIRED only for fuzzy goals; a task-completion goal never
 * calls it. Passing the judge by parameter (dependency injection) is what keeps
 * vitest hermetic.
 *
 * @param goal - The goal under evaluation.
 * @param llmJudge - The injectable LLM judge used for fuzzy goals.
 * @param cwd - Project root override for task lookup.
 * @returns The verdict (same shape for both paths).
 * @task T11378
 */
export async function judgeGoal(
  goal: GoalRecord,
  llmJudge: GoalJudge,
  cwd?: string,
): Promise<GoalJudgeVerdict> {
  if (isTaskCompletionGoal(goal.goalKind)) {
    return judgeTaskCompletion(goal.goalKind.targetTaskId, cwd);
  }
  // Fuzzy goal — delegate to the injected LLM judge. No evidence path touched.
  return llmJudge.judge(goal);
}

/**
 * Evidence-gate-aware judgement for a single task-completion goal.
 *
 * Decision table (first match wins):
 * 1. Task not found → `impossible` (the goal references a task that no longer
 *    exists).
 * 2. Task `cancelled` / `archived` → `impossible` (terminal non-done state —
 *    it can never become `done`).
 * 3. Task not `done` → `ok: false` (still in flight; reason carries the real
 *    status so the continuation tells the agent what remains).
 * 4. Task `done` but a critical gate lacks the ADR-051-required evidence atoms
 *    → `ok: false` (done-without-proof is NOT satisfied — the whole point).
 * 5. Task `done` AND every critical gate is evidence-backed → `ok: true`.
 *
 * @param targetTaskId - The task the goal wants completed.
 * @param cwd - Project root override.
 * @returns The verdict, with `evidence[]` listing the atom kinds inspected.
 * @task T11378
 * @adr ADR-051
 */
export async function judgeTaskCompletion(
  targetTaskId: string,
  cwd?: string,
): Promise<GoalJudgeVerdict> {
  const accessor = await getTaskAccessor(cwd);
  const task = await accessor.loadSingleTask(targetTaskId);

  if (!task) {
    return {
      ok: false,
      impossible: true,
      reason: `Goal target ${targetTaskId} does not exist — it cannot be completed.`,
    };
  }

  if (task.status === 'cancelled' || task.status === 'archived') {
    return {
      ok: false,
      impossible: true,
      reason: `Goal target ${targetTaskId} is ${task.status} — a terminal non-done state; it can never be completed.`,
    };
  }

  if (task.status !== 'done') {
    return {
      ok: false,
      impossible: false,
      reason: `Goal target ${targetTaskId} is ${task.status}, not done. Continue working until it reaches done with evidence-backed gates.`,
    };
  }

  // Task IS done — but "done" alone is not enough. Re-use the ADR-051 evidence
  // path via the core-side `checkGateEvidenceMinimum`, which filters `override`
  // atoms and delegates to `validateEvidenceForGate` (the contracts SSoT). Every
  // critical gate MUST be backed by atoms of the required kinds.
  const verification = task.verification;
  const evidenceByGate = verification?.evidence ?? {};
  const inspectedAtomKinds: string[] = [];
  const unbacked: string[] = [];

  for (const gate of CRITICAL_GATES) {
    const gateEvidence = evidenceByGate[gate];
    const atoms = gateEvidence?.atoms ?? [];
    for (const atom of atoms) inspectedAtomKinds.push(`${gate}:${atom.kind}`);

    const failure = checkGateEvidenceMinimum(gate, atoms);
    if (failure !== null) {
      unbacked.push(`${gate} (${failure})`);
    }
  }

  if (unbacked.length > 0) {
    return {
      ok: false,
      impossible: false,
      reason:
        `Goal target ${targetTaskId} is done but its evidence gates are not satisfied: ` +
        `${unbacked.join('; ')}. A goal is satisfied only when the task is done AND its ` +
        `critical gates (${CRITICAL_GATES.join(', ')}) carry valid ADR-051 evidence atoms.`,
      evidence: inspectedAtomKinds,
    };
  }

  return {
    ok: true,
    impossible: false,
    reason: `Goal target ${targetTaskId} is done and its critical gates (${CRITICAL_GATES.join(', ')}) are evidence-backed.`,
    evidence: inspectedAtomKinds,
  };
}

/**
 * A deterministic, offline {@link GoalJudge} that always returns a fixed
 * verdict. Wired in tests (and as a safe default in non-LLM contexts) so the
 * fuzzy path is fully exercised without a live model call.
 *
 * Production wires a real LLM-backed implementation of {@link GoalJudge}; this
 * stub exists so the goal loop has a hermetic fallback and so the gate
 * `GATE_EVIDENCE_REQUIREMENTS` import stays referenced for downstream tooling.
 *
 * @task T11378
 */
export class StaticGoalJudge implements GoalJudge {
  /**
   * @param verdict - The verdict every {@link judge} call returns.
   */
  constructor(private readonly verdict: GoalJudgeVerdict) {}

  /**
   * Return the configured verdict, ignoring the goal entirely (deterministic).
   *
   * @param _goal - The goal under evaluation (unused — deterministic stub).
   * @returns The fixed verdict.
   */
  async judge(_goal: GoalRecord): Promise<GoalJudgeVerdict> {
    return this.verdict;
  }
}

/**
 * The number of distinct critical gates the evidence judge inspects. Exposed so
 * callers/tests can assert the judge consulted the full {@link CRITICAL_GATES}
 * set without hard-coding the count, and to keep {@link GATE_EVIDENCE_REQUIREMENTS}
 * referenced as the SSoT the judge validates against.
 *
 * @task T11378
 */
export const CRITICAL_GATE_COUNT: number = CRITICAL_GATES.filter(
  (gate) => GATE_EVIDENCE_REQUIREMENTS[gate] !== undefined,
).length;
