/**
 * When a scoped `testsPassed` stops counting (owner decision D11150).
 *
 * A scoped run (`tool:test-affected`, a scope-aware `tool:test` that chose the
 * affected packages, or a targeted `test-run:` report) proves what it ran
 * before merge. Once the change has merged, only merged CI (`ci:<pr>`) or a
 * full `tool:test` proves `testsPassed`. A tree-bound `test-run:` also stops
 * counting as soon as the tree it ran on moves (T12965). This module
 * is the single place both rules live: `cleo done` planning and
 * `cleo complete` ask {@link testsPassedSupersededReason}, and a scope-aware
 * `tool:test` asks {@link taskChangeMergeState} (T12959).
 *
 * @task T12656
 * @task T12959
 * @task T12960
 * @task T12965
 */

import type { ChangeSetMergeState, EvidenceAtom, TaskChangeSet } from '@cleocode/contracts';
import type { ChangeSetDeps, ChangeSetTask } from './change-set.js';

/** Whether the task's change has merged to the default branch. */
export type ChangeMergeState = ChangeSetMergeState;

/** A full (unscoped) tool run that actually executed. */
function isFullToolRun(a: EvidenceAtom): boolean {
  return a.kind === 'tool' && a.scope !== 'affected' && a.notApplicable !== true;
}

/**
 * Recorded `testsPassed` evidence whose only verification results are scoped:
 * affected-scope tool runs and targeted `test-run:` reports (no `ci:` and no
 * full `tool:` result).
 *
 * @param atoms - The gate's recorded atoms.
 * @returns True when every result atom is scoped.
 * @task T12656
 * @task T12965
 */
export function isScopedOnly(atoms: ReadonlyArray<EvidenceAtom>): boolean {
  const results = atoms.filter(
    (a) => a.kind === 'tool' || a.kind === 'test-run' || a.kind === 'ci',
  );
  return (
    results.length > 0 &&
    results.every((a) => (a.kind === 'tool' && a.scope === 'affected') || a.kind === 'test-run')
  );
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
 * Why a scoped-only `testsPassed` no longer stands, or null when it does.
 * Fails closed: a scoped result whose merge state is unknown does not stand
 * either, since a scoped run counts before merge ONLY.
 *
 * @param atoms - Recorded `testsPassed` atoms.
 * @param state - Merge state of the task's change.
 * @returns The reason, or null.
 * @task T12656
 */
export function scopedRunSupersededReason(
  atoms: ReadonlyArray<EvidenceAtom>,
  state: ChangeMergeState,
): string | null {
  if (state === 'unmerged' || !isScopedOnly(atoms)) return null;
  return state === 'merged'
    ? 'testsPassed was recorded from a scoped run (affected packages or a targeted test-run); the merged change needs merged CI (ci:<pr>) or a full run (tool:test).'
    : 'testsPassed was recorded from a scoped run (affected packages or a targeted test-run), which counts before merge only, and whether the change has merged cannot be determined (gh unreachable — check `gh auth status`); retry, or record tool:test (or ci:<pr>).';
}

/**
 * Why a recorded `testsPassed` resting on a tree-bound `test-run:` no longer
 * stands, or null when it does (T12965). A targeted report proves the tree it
 * ran on; once that content moved, it proves nothing about the code
 * being completed. A `ci:<pr>` or a full tool run in the same gate carries the
 * gate on its own, and atoms recorded before T12965 (no `treeHash`) are not
 * judged.
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
  if (atoms.some((a) => a.kind === 'ci' || isFullToolRun(a))) return null;
  const moved = atoms.filter(
    (a): a is Extract<EvidenceAtom, { kind: 'test-run' }> =>
      a.kind === 'test-run' && typeof a.treeHash === 'string' && a.treeHash !== current,
  );
  const first = moved[0];
  if (!first?.treeHash) return null;
  return current === null
    ? `testsPassed rests on test-run:${first.path}, bound to tree ${first.treeHash.slice(0, 12)}, and the current tree cannot be computed here (not a git checkout?); complete from the checkout the report ran in, or record ci:<pr> once the PR merges.`
    : `testsPassed rests on test-run:${first.path}, recorded on tree ${first.treeHash.slice(0, 12)}, but the tree is now ${current.slice(0, 12)}; the report no longer describes this code. Re-run the targeted tests and record a fresh test-run, or record ci:<pr> once the PR merges.`;
}

/**
 * Whether the recorded `testsPassed` atoms carry a tree-bound `test-run:`
 * that {@link testRunTreeMismatchReason} would judge, so callers compute the
 * current tree hash only when it matters.
 *
 * @param atoms - Recorded `testsPassed` atoms.
 * @returns True when a tree-bound test-run is present.
 * @task T12965
 */
export function hasTreeBoundTestRun(atoms: ReadonlyArray<EvidenceAtom>): boolean {
  return atoms.some((a) => a.kind === 'test-run' && typeof a.treeHash === 'string');
}

/**
 * The one rule for whether a recorded `testsPassed` still stands — shared by
 * `cleo done` planning and `cleo complete` (T12656 AC2). A moved tree under a
 * targeted test-run (T12965) is checked first, then a scoped-only result
 * after (or with unknown) merge (D11150). Each input is resolved lazily, only
 * when the recorded atoms make it relevant.
 *
 * @param atoms - Recorded `testsPassed` atoms.
 * @param probe - Lazy merge state and current tree hash.
 * @returns The reason it no longer stands, or null.
 * @task T12656
 * @task T12965
 */
export async function testsPassedSupersededReason(
  atoms: ReadonlyArray<EvidenceAtom>,
  probe: {
    mergeState: () => Promise<ChangeMergeState> | ChangeMergeState;
    currentTree: () => Promise<string | null> | string | null;
  },
): Promise<string | null> {
  if (hasTreeBoundTestRun(atoms)) {
    const moved = testRunTreeMismatchReason(atoms, await probe.currentTree());
    if (moved) return moved;
  }
  if (!isScopedOnly(atoms)) return null;
  return scopedRunSupersededReason(atoms, await probe.mergeState());
}

/** Git probes {@link taskChangeMergeState} uses; injectable for tests. */
export interface MergeProbeDeps {
  /** Change-set I/O for the merged-PR lookup (tests inject `gh`). */
  changeSet?: ChangeSetDeps;
  /** Repository the implementation commits live in; defaults to the evidence execution root. */
  executionRoot?: string;
  /** Whether `sha` is on origin's default branch; defaults to `git merge-base --is-ancestor`. */
  isLanded?: (root: string, sha: string) => boolean;
  /** Whether `ancestor` is contained in `descendant`; defaults to `git merge-base --is-ancestor`. */
  contains?: (root: string, ancestor: string, descendant: string) => boolean;
}

/** Where a task's change stands, and the PR whose CI would prove it. */
export interface TaskMergeInfo {
  /** Merge state of the task's LATEST implementation. */
  state: ChangeMergeState;
  /** The derived change set, when one was derived. */
  changeSet: TaskChangeSet | null;
  /**
   * The merged PR that contains the latest implementation (`<n>` or
   * `<component>@<n>`), or null when none is known.
   */
  prRef: string | null;
}

function prRefOf(pr: { prNumber: number; componentPrNumber?: number }): string {
  return pr.componentPrNumber !== undefined
    ? `${pr.componentPrNumber}@${pr.prNumber}`
    : String(pr.prNumber);
}

function changeSetPrRef(cs: TaskChangeSet): string | null {
  return cs.source === 'pr' && cs.prNumber !== undefined && cs.stackedOn === undefined
    ? prRefOf({
        prNumber: cs.prNumber,
        ...(cs.componentPrNumber !== undefined ? { componentPrNumber: cs.componentPrNumber } : {}),
      })
    : null;
}

/**
 * Whether a task's LATEST implementation has merged, and through which PR.
 *
 * Judged on the recorded `implemented` evidence first, never "any `pr:` atom
 * means merged": a `commit:` atom that has not reached origin's default branch
 * means the latest work is unmerged, whatever earlier PR merged. Otherwise
 * the newest merged `pr:` atom that contains every recorded commit is the PR.
 * Commits that all landed without a recorded PR still count as merged (fail
 * closed for scoped evidence); the change-set derivation `cleo done` uses then
 * looks for the PR. With no implementation atoms to judge, the derivation
 * decides.
 *
 * @param task - The task whose change is examined.
 * @param storeRoot - CLEO store root.
 * @param deps - Change-set I/O and git probes.
 * @returns The merge state, the PR, and the change set when one was derived.
 * @task T12959
 * @task T12960
 */
export async function taskChangeMergeState(
  task: ChangeSetTask,
  storeRoot: string,
  deps: MergeProbeDeps = {},
): Promise<TaskMergeInfo> {
  const implemented = task.verification?.evidence?.implemented?.atoms ?? [];
  const commits = implemented.flatMap((a) => (a.kind === 'commit' ? [a.sha] : []));
  const prs = implemented
    .filter((a): a is Extract<EvidenceAtom, { kind: 'pr' }> => a.kind === 'pr')
    .toSorted((a, b) => (b.mergedAt ?? '').localeCompare(a.mergedAt ?? ''));

  let rootCache: string | undefined;
  const root = async (): Promise<string> => {
    if (rootCache === undefined) {
      if (deps.executionRoot !== undefined) rootCache = deps.executionRoot;
      else {
        const { resolveEvidenceExecutionRoot } = await import('./evidence.js');
        rootCache = resolveEvidenceExecutionRoot(storeRoot);
      }
    }
    return rootCache;
  };
  const { isLandedOnOriginDefault, isAncestorCommit } = await import('./change-set.js');
  const isLanded = deps.isLanded ?? isLandedOnOriginDefault;
  const contains = deps.contains ?? isAncestorCommit;

  if (commits.length > 0) {
    const r = await root();
    if (commits.some((sha) => !isLanded(r, sha))) {
      return { state: 'unmerged', changeSet: null, prRef: null };
    }
  }
  const chosen =
    commits.length === 0
      ? prs[0]
      : await (async () => {
          const r = await root();
          return prs.find((pr) => commits.every((sha) => contains(r, sha, pr.mergeCommitSha)));
        })();
  if (chosen) return { state: 'merged', changeSet: null, prRef: prRefOf(chosen) };

  const { deriveTaskChangeSet } = await import('./change-set.js');
  const changeSet = await deriveTaskChangeSet({ task, storeRoot, cwd: storeRoot }, deps.changeSet);
  return {
    state: commits.length > 0 ? 'merged' : mergeStateOfChangeSet(changeSet),
    changeSet,
    prRef: changeSetPrRef(changeSet),
  };
}
