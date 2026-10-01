/**
 * When an affected-scope `testsPassed` stops counting (owner decision D11150).
 *
 * A `tool:test-affected` run proves the packages a branch diff touches before
 * merge. Once the change has merged, only merged CI (`ci:<pr>`) or a full
 * `tool:test` proves `testsPassed`. This module is the single place that rule
 * lives: `cleo done` planning and `cleo complete` both ask it. It also holds
 * the sibling rule for tree-bound `test-run:` reports (T12965) and the merge
 * state a scope-aware `tool:test` consults (T12959).
 *
 * @task T12656
 * @task T12959
 * @task T12965
 */

import type { ChangeSetMergeState, EvidenceAtom, Task, TaskChangeSet } from '@cleocode/contracts';
import type { ChangeSetDeps, ChangeSetTask } from './change-set.js';

/** Whether the task's change has merged to the default branch. */
export type ChangeMergeState = ChangeSetMergeState;

/**
 * Recorded `testsPassed` evidence whose only verification result is an
 * affected-scope run (no `ci:`, `test-run:` or full `tool:` result).
 *
 * @param atoms - The gate's recorded atoms.
 * @returns True when every result atom is a `scope: 'affected'` tool run.
 * @task T12656
 */
export function isAffectedOnly(atoms: ReadonlyArray<EvidenceAtom>): boolean {
  const results = atoms.filter(
    (a) => a.kind === 'tool' || a.kind === 'test-run' || a.kind === 'ci',
  );
  return results.length > 0 && results.every((a) => a.kind === 'tool' && a.scope === 'affected');
}

/**
 * The merge state a derived change set implies. What the PR lookup found
 * decides (`mergeState`), never `source` alone: a merged PR whose `pr:`
 * check was refused falls back to the task branch, which outlives a squash
 * merge (T12656 review HIGH). Otherwise a merged-PR change set is merged, a
 * failed merged-PR lookup unknown, anything else unmerged.
 *
 * @param changeSet - Derived change set.
 * @returns The merge state.
 * @task T12656
 */
export function mergeStateOfChangeSet(
  changeSet: Pick<TaskChangeSet, 'source' | 'prDiscoveryFailed' | 'mergeState'>,
): ChangeMergeState {
  if (changeSet.mergeState) return changeSet.mergeState;
  if (changeSet.source === 'pr') return 'merged';
  return changeSet.prDiscoveryFailed === true ? 'unknown' : 'unmerged';
}

/**
 * Why a recorded `testsPassed` no longer stands, or null when it does.
 * Fails closed: an affected-only result whose merge state is unknown does not
 * stand either, since a scoped run counts before merge ONLY.
 *
 * @param atoms - Recorded `testsPassed` atoms.
 * @param state - Merge state of the task's change.
 * @returns The reason, or null.
 * @task T12656
 */
export function affectedScopeSupersededReason(
  atoms: ReadonlyArray<EvidenceAtom>,
  state: ChangeMergeState,
): string | null {
  if (state === 'unmerged' || !isAffectedOnly(atoms)) return null;
  return state === 'merged'
    ? 'testsPassed was recorded from an affected-scope run; the merged change needs merged CI (ci:<pr>) or a full run (tool:test).'
    : 'testsPassed was recorded from an affected-scope run, which counts before merge only, and whether the change has merged cannot be determined because gh was unreachable (check `gh auth status`); retry, or record tool:test (or ci:<pr>).';
}

/**
 * Whether a task's change has merged, as cheaply as it can be known: a
 * recorded `pr:` implemented atom proves the merge on its own; otherwise the
 * change set is derived (the merged-PR lookup `cleo done` planning uses).
 *
 * @param task - The task whose change is examined.
 * @param storeRoot - CLEO store root.
 * @param deps - Change-set I/O (tests inject `gh`).
 * @returns The merge state, and the derived change set when one was derived.
 * @task T12959
 * @task T12960
 */
export async function taskChangeMergeState(
  task: ChangeSetTask,
  storeRoot: string,
  deps?: ChangeSetDeps,
): Promise<{ state: ChangeMergeState; changeSet: TaskChangeSet | null }> {
  const implemented = task.verification?.evidence?.implemented?.atoms ?? [];
  if (implemented.some((a) => a.kind === 'pr')) return { state: 'merged', changeSet: null };
  const { deriveTaskChangeSet } = await import('./change-set.js');
  const changeSet = await deriveTaskChangeSet({ task, storeRoot, cwd: storeRoot }, deps);
  return { state: mergeStateOfChangeSet(changeSet), changeSet };
}

/**
 * The same rule for a stored task, deriving the merge state only when the
 * recorded `testsPassed` is affected-only (so ordinary completions pay
 * nothing). A recorded `pr:` implemented atom proves the merge on its own.
 *
 * @param task - The task being completed.
 * @param storeRoot - CLEO store root.
 * @param deps - Change-set I/O (tests inject `gh`).
 * @returns The reason `testsPassed` no longer stands, or null.
 * @task T12656
 */
export async function taskAffectedScopeSupersededReason(
  task: Task,
  storeRoot: string,
  deps?: ChangeSetDeps,
): Promise<string | null> {
  const atoms = task.verification?.evidence?.testsPassed?.atoms ?? [];
  if (!isAffectedOnly(atoms)) return null;
  const { state } = await taskChangeMergeState(task, storeRoot, deps);
  return affectedScopeSupersededReason(atoms, state);
}

/**
 * Why a recorded `testsPassed` resting on a tree-bound `test-run:` no longer
 * stands, or null when it does (T12965). A targeted report proves the tree it
 * ran on; once the tracked content moved, it proves nothing about the code
 * being completed. Merged CI (`ci:<pr>`) in the same gate supersedes it, and
 * atoms recorded before T12965 (no `treeHash`) are not judged.
 *
 * @param atoms - Recorded `testsPassed` atoms.
 * @param current - The current tree hash of the execution root, or null when
 *   it cannot be computed (not a git checkout, or git failed).
 * @returns The reason, or null.
 * @task T12965
 */
export function testRunTreeMismatchReason(
  atoms: ReadonlyArray<EvidenceAtom>,
  current: string | null,
): string | null {
  if (atoms.some((a) => a.kind === 'ci')) return null;
  const bound = atoms.filter(
    (a): a is Extract<EvidenceAtom, { kind: 'test-run' }> =>
      a.kind === 'test-run' && typeof a.treeHash === 'string',
  );
  const moved = bound.filter((a) => a.treeHash !== current);
  if (moved.length === 0) return null;
  const first = moved[0]!;
  return current === null
    ? `testsPassed rests on test-run:${first.path}, bound to tree ${first.treeHash!.slice(0, 12)}, and the current tree cannot be computed here (not a git checkout?); complete from the checkout the report ran in, or record ci:<pr> once the PR merges.`
    : `testsPassed rests on test-run:${first.path}, recorded on tree ${first.treeHash!.slice(0, 12)}, but the tracked tree is now ${current.slice(0, 12)}; the report no longer describes this code. Re-run the targeted tests and record a fresh test-run, or record ci:<pr> once the PR merges.`;
}
