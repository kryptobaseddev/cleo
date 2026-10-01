/**
 * When a scoped `testsPassed` stops counting (owner decision D11150).
 *
 * A scoped run (`tool:test-affected`, a scope-aware `tool:test` that chose the
 * affected packages, or a targeted `test-run:` report) proves what it ran
 * before merge. Once the change has merged, only merged CI (`ci:<pr>`) or a
 * full `tool:test` proves `testsPassed`. A tree-bound `test-run:` also stops
 * counting as soon as the tree it ran on moves (T12965). This module
 * is the single place both rules live: `cleo done` planning and
 * `cleo complete` ask {@link testsPassedSupersededReason}, and they and a
 * scope-aware `tool:test` all judge the merge — and the PR whose CI proves
 * it — through {@link taskChangeMergeState} (T12959, T12656 AC2).
 *
 * @task T12656
 * @task T12959
 * @task T12960
 * @task T12965
 */

import type { ChangeSetMergeState, EvidenceAtom, TaskChangeSet } from '@cleocode/contracts';
import type {
  ChangeSetDeps,
  ChangeSetTask,
  CommitPr,
  PatchEquivalenceUnknown,
} from './change-set.js';

/** Whether the task's change has merged to the default branch. */
export type ChangeMergeState = ChangeSetMergeState;

/** A merge state and, when a lookup it needed failed, which one (T12959 review). */
export interface MergeVerdict {
  /** Merge state of the task's latest implementation. */
  state: ChangeMergeState;
  /**
   * Why a lookup failed — `gh` unreachable, or commits missing from the
   * local object store. With `state: 'unknown'` it is why the state is
   * unknown; with `state: 'merged'` and no PR named, why the PR that carries
   * the change is unknown.
   */
  lookupFailed?: string;
}

/** What a failed `gh` lookup means for the caller, and the first thing to check. */
const GH_UNREACHABLE = 'gh unreachable — check `gh auth status`';

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
 * @param lookupFailed - With `state: 'unknown'`, why (defaults to `gh` unreachable).
 * @returns The reason, or null.
 * @task T12656
 */
export function scopedRunSupersededReason(
  atoms: ReadonlyArray<EvidenceAtom>,
  state: ChangeMergeState,
  lookupFailed?: string,
): string | null {
  if (state === 'unmerged' || !isScopedOnly(atoms)) return null;
  return state === 'merged'
    ? 'testsPassed was recorded from a scoped run (affected packages or a targeted test-run); the merged change needs merged CI (ci:<pr>) or a full run (tool:test).'
    : `testsPassed was recorded from a scoped run (affected packages or a targeted test-run), which counts before merge only, and whether the change has merged cannot be determined (${lookupFailed ?? GH_UNREACHABLE}); retry, or record tool:test (or ci:<pr>).`;
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
 * @param probe - Lazy merge state (with why a lookup failed, when known) and
 *   current tree hash.
 * @returns The reason it no longer stands, or null.
 * @task T12656
 * @task T12965
 */
export async function testsPassedSupersededReason(
  atoms: ReadonlyArray<EvidenceAtom>,
  probe: {
    mergeState: () => Promise<ChangeMergeState | MergeVerdict> | ChangeMergeState | MergeVerdict;
    currentTree: () => Promise<string | null> | string | null;
  },
): Promise<string | null> {
  if (hasTreeBoundTestRun(atoms)) {
    const moved = testRunTreeMismatchReason(atoms, await probe.currentTree());
    if (moved) return moved;
  }
  if (!isScopedOnly(atoms)) return null;
  const merge = await probe.mergeState();
  const verdict = typeof merge === 'string' ? { state: merge } : merge;
  return scopedRunSupersededReason(atoms, verdict.state, verdict.lookupFailed);
}

/** Git and `gh` probes {@link taskChangeMergeState} uses; injectable for tests. */
export interface MergeProbeDeps {
  /**
   * Change-set I/O for the merged-PR lookup (tests inject `gh`). Its `viewPr`
   * also lists a PR's own commits for the containment check, and its
   * `listPrsForCommit` finds the PRs GitHub associates with a commit.
   */
  changeSet?: ChangeSetDeps;
  /** A change set already derived for this task (`cleo done` planning), so it is not derived twice. */
  derived?: TaskChangeSet;
  /**
   * Repository the implementation commits live in; defaults to the task's
   * change-set root (its worktree when one is registered, T12965 review).
   */
  executionRoot?: string;
  /**
   * Whether `sha` is on origin's default branch; defaults to
   * `git merge-base --is-ancestor`. A positive signal only: a local
   * `origin/<default>` can be stale, and a squash or rebase merge never makes
   * the recorded SHA an ancestor.
   */
  isLanded?: (root: string, sha: string) => boolean;
  /** Whether `ancestor` is contained in `descendant`; defaults to `git merge-base --is-ancestor`. */
  contains?: (root: string, ancestor: string, descendant: string) => boolean;
  /**
   * Whether `sha`'s patch is among `candidates`: null when git failed,
   * `{ missing }` when commits it needs are not local; defaults to `git patch-id`.
   */
  equivalent?: (
    root: string,
    sha: string,
    candidates: readonly string[],
  ) => boolean | null | PatchEquivalenceUnknown;
}

/** Where a task's change stands, and the PR whose CI would prove it. */
export interface TaskMergeInfo extends MergeVerdict {
  /** The derived change set, when one was derived. */
  changeSet: TaskChangeSet | null;
  /**
   * The merged PR that carries the latest implementation (`<n>` or
   * `<component>@<n>`), or null when none is known. Never a PR that merely
   * cites the task: its CI must have run the recorded commits.
   */
  prRef: string | null;
  /**
   * With `state: 'merged'`, no {@link prRef} and no `lookupFailed`: why no
   * merged PR is named — every lookup answered, and none carries the change.
   */
  unproven?: string;
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

/** A merged PR whose CI may have run the implementation commits. */
interface CarrierPr {
  prNumber: number;
  componentPrNumber?: number;
  mergeCommitSha?: string | null;
}

/** The probes {@link carriesAll} uses, defaults resolved. */
interface CarrierProbes {
  contains: NonNullable<MergeProbeDeps['contains']>;
  equivalent: NonNullable<MergeProbeDeps['equivalent']>;
  viewPr: NonNullable<ChangeSetDeps['viewPr']>;
}

/** The same commit, whichever side is abbreviated. */
function sameCommit(a: string, b: string): boolean {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
}

/** The first 12 characters of each commit, comma-separated. */
function shortShas(shas: readonly string[]): string {
  return shas.map((sha) => sha.slice(0, 12)).join(', ');
}

/**
 * Whether a merged PR carries every implementation commit, so its CI ran them
 * (T12959 review). A commit is carried when it is an ancestor of the PR's
 * merge commit, one of the PR's own commits as `gh` lists them (a squash or
 * rebase merge rewrites the SHAs; a component's commits count for its
 * integration PR), or a patch-equivalent of one of them (rebased before the
 * PR merged). A commit built on top of the merge came after it and is never
 * carried. `incomplete` names a lookup it needed that failed.
 */
async function carriesAll(
  root: string,
  pr: CarrierPr,
  commits: readonly string[],
  probes: CarrierProbes,
): Promise<{ carried: boolean; incomplete: string | null }> {
  const merge = pr.mergeCommitSha ?? null;
  let rest =
    merge === null ? [...commits] : commits.filter((sha) => !probes.contains(root, sha, merge));
  if (rest.length === 0) return { carried: true, incomplete: null };
  if (merge !== null && rest.some((sha) => probes.contains(root, merge, sha))) {
    return { carried: false, incomplete: null };
  }
  let incomplete: string | null = null;
  const own: string[] = [];
  for (const n of [pr.prNumber, pr.componentPrNumber]) {
    if (n === undefined) continue;
    const view = await probes.viewPr(n, root);
    if (view === null) incomplete ??= `gh pr view ${n} failed (${GH_UNREACHABLE})`;
    else own.push(...(view.commits ?? []));
  }
  rest = rest.filter((sha) => !own.some((oid) => sameCommit(oid, sha)));
  if (rest.length === 0) return { carried: true, incomplete: null };
  for (const sha of rest) {
    const equivalent = own.length > 0 ? probes.equivalent(root, sha, own) : false;
    if (equivalent === true) continue;
    if (equivalent === null) {
      incomplete ??= `git could not compare ${shortShas([sha])} with the commits of PR #${pr.prNumber}`;
    } else if (equivalent !== false) {
      incomplete ??= `commit(s) ${shortShas(equivalent.missing)} are not in the local object store — run \`git fetch\``;
    }
    return { carried: false, incomplete };
  }
  return { carried: true, incomplete: null };
}

/**
 * Merged PRs into the default branch that GitHub associates with every
 * commit, newest first — candidates only, which {@link carriesAll} then
 * checks. `failed` names a lookup that failed: a `gh` call, or the default
 * branch, which comes from origin's ref, else from `gh` (a PR merged into any
 * other branch, such as a stacked PR's base, never counts).
 */
async function githubCarrierCandidates(
  root: string,
  commits: readonly string[],
  list: NonNullable<ChangeSetDeps['listPrsForCommit']>,
  defaultBranch: () => Promise<string | null>,
): Promise<{ prs: CarrierPr[]; failed: string | null }> {
  const perCommit: Array<Map<number, CommitPr>> = [];
  for (const sha of commits) {
    const rows = await list(sha, root);
    if (rows === null) {
      return {
        prs: [],
        failed: `gh api commits/${shortShas([sha])}/pulls failed (${GH_UNREACHABLE})`,
      };
    }
    const merged = new Map(rows.filter((pr) => pr.mergedAt !== null).map((pr) => [pr.number, pr]));
    if (merged.size === 0) return { prs: [], failed: null };
    perCommit.push(merged);
  }
  const [first, ...others] = perCommit;
  const common = [...(first?.values() ?? [])].filter((pr) => others.every((m) => m.has(pr.number)));
  if (common.length === 0) return { prs: [], failed: null };
  const base = await defaultBranch();
  if (base === null) {
    return {
      prs: [],
      failed: `the default branch is unknown (no origin/HEAD, origin/main or origin/master, and gh repo view failed: ${GH_UNREACHABLE})`,
    };
  }
  return {
    prs: common
      .filter((pr) => pr.baseRefName === base)
      .sort((a, b) => (b.mergedAt ?? '').localeCompare(a.mergedAt ?? ''))
      .map((pr) => ({ prNumber: pr.number, mergeCommitSha: pr.mergeCommitSha ?? null })),
    failed: null,
  };
}

/**
 * Whether a task's LATEST implementation has merged, and through which PR —
 * the one function `cleo done` planning, `cleo complete` and a scope-aware
 * `tool:test` all ask (T12656 AC2).
 *
 * With recorded `commit:` atoms, the commits decide, never "any merged PR
 * that cites the task": the PR named is one that carries every commit (see
 * {@link carriesAll}) — a recorded `pr:` atom first (newest), then the PR the
 * change-set derivation found, then a merged PR into the default branch that
 * GitHub associates with the commits. Landing on the local `origin/<default>`
 * is a positive signal only (merged, but no PR proves it); its absence proves
 * nothing, since the ref may be stale and squash and rebase merges rewrite
 * SHAs. With no sign of a merge, the state is unmerged — or unknown when a
 * lookup it needed failed. A landed change with no carrier and a failed lookup
 * names that lookup (`lookupFailed`): the carrier is unknown, which is not
 * "no PR carries it" (`unproven`). Without commit atoms, the newest recorded
 * `pr:` atom, else the derivation, decides.
 *
 * @param task - The task whose change is examined.
 * @param storeRoot - CLEO store root.
 * @param deps - Change-set I/O and git/`gh` probes.
 * @returns The merge state, the PR, the change set when one was derived, and
 *   any lookup that failed.
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
  const cs = await import('./change-set.js');
  const derive = async (): Promise<TaskChangeSet> =>
    deps.derived ??
    (await cs.deriveTaskChangeSet({ task, storeRoot, cwd: storeRoot }, deps.changeSet));
  const failures: string[] = [];
  const derivedFailure = (changeSet: TaskChangeSet): void => {
    if (mergeStateOfChangeSet(changeSet) === 'unknown') {
      failures.push(`the merged-PR lookup failed (${GH_UNREACHABLE})`);
    }
  };
  const lookupFailed = (): Pick<MergeVerdict, 'lookupFailed'> =>
    failures.length > 0 ? { lookupFailed: [...new Set(failures)].join('; ') } : {};

  if (commits.length === 0) {
    const newest = prs[0];
    if (newest) return { state: 'merged', changeSet: null, prRef: prRefOf(newest) };
    const changeSet = await derive();
    derivedFailure(changeSet);
    return {
      state: mergeStateOfChangeSet(changeSet),
      changeSet,
      prRef: changeSetPrRef(changeSet),
      ...lookupFailed(),
    };
  }

  // T12965 review M2: the same root `cleo done` reads the change set from.
  const at = deps.executionRoot ?? cs.resolveChangeSetRoot(storeRoot, task.id).root;
  const probes: CarrierProbes = {
    contains: deps.contains ?? cs.isAncestorCommit,
    equivalent: deps.equivalent ?? cs.hasPatchEquivalent,
    viewPr: deps.changeSet?.viewPr ?? cs.defaultViewPr,
  };
  const carries = async (pr: CarrierPr): Promise<boolean> => {
    const r = await carriesAll(at, pr, commits, probes);
    if (r.incomplete !== null) failures.push(r.incomplete);
    return r.carried;
  };

  for (const pr of prs) {
    if (await carries(pr)) return { state: 'merged', changeSet: null, prRef: prRefOf(pr) };
  }
  const changeSet = await derive();
  derivedFailure(changeSet);
  const derivedRef = changeSetPrRef(changeSet);
  if (
    derivedRef !== null &&
    changeSet.prNumber !== undefined &&
    (await carries({
      prNumber: changeSet.prNumber,
      ...(changeSet.componentPrNumber !== undefined
        ? { componentPrNumber: changeSet.componentPrNumber }
        : {}),
      mergeCommitSha: changeSet.mergeCommitSha ?? null,
    }))
  ) {
    return { state: 'merged', changeSet, prRef: derivedRef };
  }
  // T12959 review: a PR GitHub associates with the commits is a candidate
  // only; it is named when it carries them, like every other candidate.
  const github = await githubCarrierCandidates(
    at,
    commits,
    deps.changeSet?.listPrsForCommit ?? cs.defaultListPrsForCommit,
    async () => {
      const ref = cs.resolveOriginDefault(at);
      if (ref !== null) return ref.replace(/^origin\//, '');
      const ask =
        deps.changeSet?.defaultBranch ??
        (await import('../release/ci-evidence.js')).ghDefaultBranch;
      return ask(at);
    },
  );
  if (github.failed !== null) failures.push(github.failed);
  for (const pr of github.prs) {
    if (await carries(pr)) return { state: 'merged', changeSet, prRef: prRefOf(pr) };
  }

  const isLanded = deps.isLanded ?? cs.isLandedOnOriginDefault;
  if (commits.every((sha) => isLanded(at, sha))) {
    // T12959 review: with a failed lookup the carrier is unknown, not absent.
    if (failures.length > 0) return { state: 'merged', changeSet, prRef: null, ...lookupFailed() };
    return {
      state: 'merged',
      changeSet,
      prRef: null,
      unproven:
        `implementation commit(s) ${shortShas(commits)} reached the default branch, but no merged PR is known to carry them` +
        (derivedRef !== null ? ` (PR #${derivedRef}, which cites ${task.id}, does not)` : ''),
    };
  }
  return {
    state: failures.length > 0 ? 'unknown' : 'unmerged',
    changeSet,
    prRef: null,
    ...lookupFailed(),
  };
}
