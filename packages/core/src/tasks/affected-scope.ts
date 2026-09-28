/**
 * When an affected-scope `testsPassed` stops counting (owner decision D11150).
 *
 * A `tool:test-affected` run proves the packages a branch diff touches before
 * merge. Once the change has merged, only merged CI (`ci:<pr>`) or a full
 * `tool:test` proves `testsPassed`. This module is the single place that rule
 * lives: `cleo done` planning and `cleo complete` both ask it.
 *
 * @task T12656
 */

import type { EvidenceAtom, Task, TaskChangeSet } from '@cleocode/contracts';
import type { ChangeSetDeps } from './change-set.js';

/** Whether the task's change has merged to the default branch. */
export type ChangeMergeState = 'merged' | 'unmerged' | 'unknown';

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
 * The merge state a derived change set implies: a merged-PR change set is
 * merged; a failed merged-PR lookup leaves it unknown; otherwise unmerged.
 *
 * @param changeSet - Derived change set.
 * @returns The merge state.
 * @task T12656
 */
export function mergeStateOfChangeSet(
  changeSet: Pick<TaskChangeSet, 'source' | 'prDiscoveryFailed'>,
): ChangeMergeState {
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
    : 'testsPassed was recorded from an affected-scope run, which counts before merge only, and whether the change has merged cannot be determined; record ci:<pr> or tool:test.';
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
  const implemented = task.verification?.evidence?.implemented?.atoms ?? [];
  if (implemented.some((a) => a.kind === 'pr')) {
    return affectedScopeSupersededReason(atoms, 'merged');
  }
  const { deriveTaskChangeSet } = await import('./change-set.js');
  const changeSet = await deriveTaskChangeSet({ task, storeRoot, cwd: storeRoot }, deps);
  return affectedScopeSupersededReason(atoms, mergeStateOfChangeSet(changeSet));
}
