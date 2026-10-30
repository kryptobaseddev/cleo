/**
 * When a scoped `testsPassed` stops counting (owner decision D11150).
 *
 * A scoped run (`tool:test-affected`, a scope-aware `tool:test` that chose the
 * affected packages, or a targeted `test-run:` report) proves what it ran
 * before merge. Once the change has merged, only merged CI (`ci:<pr>`) or a
 * full `tool:test` proves `testsPassed` — unless the scoped result is pinned
 * to a tree whose copy of every file the change touched equals the merge
 * commit's, so the merged change is the one it tested (T13495). A tree-bound `test-run:` also stops
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

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ChangeSetMergeState, EvidenceAtom, TaskChangeSet } from '@cleocode/contracts';
import { discoveryEnv } from '../git/work-tree.js';
import { cleoConfigSchemaFor, listWorkspacePackages } from './affected-packages.js';
import type {
  ChangeSetDeps,
  ChangeSetTask,
  CommitPr,
  PatchEquivalenceUnknown,
} from './change-set.js';
import {
  QA_RUN_KINDS,
  qaRunCoverage,
  qaRunUnionGapReason,
  typecheckCoverageGap,
} from './qa-run-binding.js';
import { changedTestFiles, testRunCoversChange } from './test-run-binding.js';
import { canonicalToolName } from './tool-resolver.js';

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
  return (
    a.kind === 'tool' &&
    a.scope !== 'affected' &&
    a.notApplicable !== true &&
    !isTreePinnedTool(a) &&
    !isQaTool(a)
  );
}

/**
 * A typecheck or lint `tool:` result recorded beside a test-run (T13783): it
 * covers dependents left to a typecheck, and is never a test run itself, so it
 * neither carries testsPassed alone nor exempts the rest from supersession.
 */
function isQaTool(a: EvidenceAtom): boolean {
  if (a.kind !== 'tool') return false;
  const tool = canonicalToolName(a.tool);
  return tool === 'typecheck' || tool === 'lint';
}

/**
 * A `tool:` result that speaks only for the change it judged: not applicable
 * for a non-code-only change (T13745), or CLEO's schema check of changed CLEO
 * config (T13758). A moved tree voids it.
 */
function isTreePinnedTool(a: EvidenceAtom): boolean {
  return a.kind === 'tool' && (a.nonCodeChange === true || a.configSchema !== undefined);
}

/**
 * A `tool:` result that holds only for the tree it was recorded on: an
 * affected-scope run, or a tree-pinned result ({@link isTreePinnedTool}).
 */
function isTreeScopedTool(a: EvidenceAtom): boolean {
  return a.kind === 'tool' && (a.scope === 'affected' || isTreePinnedTool(a));
}

/** A result pinned to the tree it ran on: a test-run, or a tree-pinned `tool:` (T13745, T13758). */
function isTreeBoundResult(
  a: EvidenceAtom,
): a is Extract<EvidenceAtom, { kind: 'test-run' | 'tool' }> & { treeHash: string } {
  return (
    (a.kind === 'test-run' || (a.kind === 'tool' && isTreePinnedTool(a))) &&
    typeof a.treeHash === 'string'
  );
}

/** Why a tree-pinned `tool:` result no longer stands for `gate`, or null (T13745, T13758). */
function treePinnedToolReason(
  atoms: ReadonlyArray<EvidenceAtom>,
  current: string | null,
  gate: 'testsPassed' | 'qaPassed',
): string | null {
  const first = atoms
    .filter(isTreeBoundResult)
    .find((a) => a.kind === 'tool' && a.treeHash !== current);
  if (!first || first.kind !== 'tool') return null;
  const what = first.configSchema
    ? `CLEO's schema check of ${first.configSchema.join(', ')}`
    : `tool:${first.tool} recorded not applicable for a non-code-only change`;
  return `${gate} rests on ${what} on tree ${first.treeHash.slice(0, 12)}, but the tree is now ${current === null ? 'unknown' : current.slice(0, 12)}; the change may have moved on. Re-verify ${gate} against the current change.`;
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
    (a) => (a.kind === 'tool' && !isQaTool(a)) || a.kind === 'test-run' || a.kind === 'ci',
  );
  return results.length > 0 && results.every((a) => isTreeScopedTool(a) || a.kind === 'test-run');
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
 * @param notCarried - Why the scoped result did not carry across the merge.
 * @param ciRemedy - With `state: 'merged'`, the `evidence.ciSatisfies` block a
 *   project with workflows but no opt-in should add (T13096).
 * @returns The reason, or null.
 * @task T12656
 * @task T13096
 */
export function scopedRunSupersededReason(
  atoms: ReadonlyArray<EvidenceAtom>,
  state: ChangeMergeState,
  lookupFailed?: string,
  notCarried?: string,
  ciRemedy?: string | null,
): string | null {
  if (state === 'unmerged' || !isScopedOnly(atoms)) return null;
  return state === 'merged'
    ? `testsPassed was recorded from a scoped run (affected packages or a targeted test-run), and it does not carry across the merge${notCarried ? ` because ${notCarried}` : ''}; the merged change needs merged CI (ci:<pr>, with evidence.ciSatisfies) or a full run (tool:test).${ciRemedy ? ` ${ciRemedy}` : ''}`
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
 * @param scope - The root and current change to compare over (T13784): a
 *   moved report still stands while the change's files, the test files it
 *   ran and their test inputs are byte-identical; without it any moved
 *   tree refuses.
 * @returns The reason, or null.
 * @task T12965
 * @task T13784
 */
export function testRunTreeMismatchReason(
  atoms: ReadonlyArray<EvidenceAtom>,
  current: string | null,
  scope?: QaRunCarryScope,
): string | null {
  if (atoms.some((a) => a.kind === 'ci' || isFullToolRun(a))) return null;
  // T13745, T13758: a tree-pinned tool: held for that tree's change alone.
  if (atoms.filter(isTreeBoundResult).some((a) => a.kind === 'tool' && a.treeHash !== current))
    return treePinnedToolReason(atoms, current, 'testsPassed');
  for (const a of atoms) {
    if (a.kind !== 'test-run' || typeof a.treeHash !== 'string') continue;
    const why = testRunUnseenChangeReason(a, a.treeHash, current, scope);
    if (why) return why;
  }
  return null;
}

/** Whether `paths` are byte-identical between two trees or commits; null when git cannot say. */
function sameOver(
  root: string,
  from: string,
  to: string,
  paths: readonly string[],
): boolean | null {
  try {
    execFileSync('git', ['diff', '--quiet', '--no-renames', from, to, '--', ...paths], {
      cwd: root,
      stdio: 'ignore',
    });
    return true;
  } catch (err) {
    return (err as { status?: number }).status === 1 ? false : null;
  }
}

/**
 * Why a tree-bound test-run no longer speaks for the change, or null (T12965,
 * narrowed by T13784). The report describes the tree it ran on; it still
 * stands while what it did not see — the tree moving after verify, and
 * commits that landed on the default branch between the run and verify
 * (`runHeadSha`) — leaves the change's own files (`scope.changed`), the test
 * files it ran and their test inputs ({@link testRunInputPaths}) byte-identical. Unrelated paths
 * moving on main do not stale it. Fails closed: no scope, a capped test-file
 * list, or a git failure each refuse.
 */
function testRunUnseenChangeReason(
  run: Extract<EvidenceAtom, { kind: 'test-run' }>,
  tree: string,
  current: string | null,
  scope: QaRunCarryScope | undefined,
): string | null {
  const label = `test-run:${run.path}`;
  const redo =
    'Re-run the targeted tests and record a fresh test-run, or record ci:<pr> once the PR merges.';
  const pairs: Array<[string, string, string]> = [];
  if (tree !== current) {
    if (current === null)
      return `testsPassed rests on ${label}, bound to tree ${tree.slice(0, 12)}, and the current tree cannot be computed here (not a git checkout?); complete from the checkout the report ran in, or record ci:<pr> once the PR merges.`;
    pairs.push([
      tree,
      current,
      `the tree it was recorded on (${tree.slice(0, 12)}) and now (${current.slice(0, 12)})`,
    ]);
  }
  if (run.runHeadSha && run.headSha && run.runHeadSha !== run.headSha)
    pairs.push([
      run.runHeadSha,
      run.headSha,
      `HEAD as of the run (${run.runHeadSha.slice(0, 12)}) and at verify (${run.headSha.slice(0, 12)})`,
    ]);
  const first = pairs[0];
  if (!first) return null;
  const moved =
    tree !== current && current !== null
      ? `testsPassed rests on ${label}, recorded on tree ${tree.slice(0, 12)}, but the tree is now ${current.slice(0, 12)}; the report no longer describes this code. ${redo}`
      : `testsPassed rests on ${label}, which did not see the commits between ${first[2]}, and the change they may touch is not known here. ${redo}`;
  const paths = scope === undefined ? null : testRunScopePaths(run, scope);
  if (scope === undefined || paths === null) return moved;
  for (const [from, to, between] of pairs) {
    const same = sameOver(scope.root, from, to, paths);
    if (same === null) return moved;
    if (!same)
      return `testsPassed rests on ${label}, but the change's files, the test files it ran or their test inputs (configs, manifests, setup files) differ between ${between}${differingPaths(scope.root, from, to, paths)}. ${redo}`;
  }
  return null;
}

/**
 * Root-level files a typecheck or lint reads beyond the roots it was given
 * (compiler and linter configs, the shared base tsconfig, the lockfile): a
 * change to any of them refuses an earlier-tree carry (T13644).
 */
const QA_RUN_SHARED_INPUTS = [
  'tsconfig*.json',
  'biome.json',
  'biome.jsonc',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
];

/** Test runner configs, at the root and in every directory above a file (T13784). */
const TEST_RUNNER_CONFIGS = ['vitest.config.*', 'vitest.workspace.*', 'jest.config.*'];

/**
 * Test-style setup file names (`setupFiles`/`globalSetup` conventions), so an
 * ordinary source such as `setup-wizard.ts` is not a test input.
 */
const SETUP_FILE_NAMES = [
  'setup.*',
  '*.setup.*',
  'setup-tests.*',
  'setupTests.*',
  'test-setup.*',
  'global-setup.*',
  'setup-global.*',
];

/**
 * Pathspecs of the inputs a test run reads beyond the files it names
 * (T13784, review of #2295): the QA shared inputs, runner configs and this
 * repo's shared setup (`vitest.setup.*`, `vitest.memory-safe.*`) at the root;
 * in every directory above a changed or run file its `package.json`,
 * `tsconfig*.json` and runner configs; and the test-style setup files
 * ({@link SETUP_FILE_NAMES}) from each file's owning package (its nearest
 * directory with a `package.json`) down. Scoped so another package's manifest
 * or setup file moving on main does not stale the run. A module the tests
 * import but the change does not touch is not an input here — the same
 * file-scoped limit as the byte-identity carry.
 */
function testRunInputPaths(root: string, files: readonly string[]): string[] {
  const dirs = new Set<string>();
  const owners = new Set<string>();
  for (const file of files) {
    const parts = file.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    let owner = '';
    for (let i = parts.length; i >= 1; i--) {
      const dir = parts.slice(0, i).join('/');
      if (existsSync(join(root, dir, 'package.json'))) {
        owner = dir;
        break;
      }
    }
    owners.add(owner);
  }
  return [
    ...QA_RUN_SHARED_INPUTS,
    ...TEST_RUNNER_CONFIGS,
    'vitest.setup.*',
    'vitest.memory-safe.*',
    ...[...dirs].flatMap((d) => [
      `${d}/package.json`,
      `${d}/tsconfig*.json`,
      ...TEST_RUNNER_CONFIGS.map((c) => `${d}/${c}`),
    ]),
    ...[...owners].flatMap((d) =>
      SETUP_FILE_NAMES.map((n) => `:(glob)${d === '' ? '' : `${d}/`}**/${n}`),
    ),
  ];
}

/**
 * Everything a targeted `test-run:` result depends on over `scope`
 * (T13784): the change's files, the test files it ran and their test inputs.
 * Null when the run's test-file list was capped, so its scope is not known.
 * The one rule for an earlier-tree carry and a carry across the merge (T14071).
 */
function testRunScopePaths(
  run: Extract<EvidenceAtom, { kind: 'test-run' }>,
  scope: QaRunCarryScope,
): string[] | null {
  const testFiles = run.testFiles ?? [];
  if ((run.testFileCount ?? testFiles.length) > testFiles.length) return null;
  return [
    ...new Set([
      ...scope.changed,
      ...testFiles,
      ...testRunInputPaths(scope.root, [...scope.changed, ...testFiles]),
    ]),
  ];
}

/** Everything a `qa-run:` receipt depends on over `scope` (T13644): its roots, the change and the shared tool configs. */
function qaRunScopePaths(
  run: Extract<EvidenceAtom, { kind: 'qa-run' }>,
  scope: QaRunCarryScope,
): string[] {
  return [
    ...new Set([
      ...run.roots.map((r) => (r === '' ? '.' : r)),
      ...scope.changed,
      ...QA_RUN_SHARED_INPUTS,
    ]),
  ];
}

/**
 * Everything a scoped `tool:` result (`tool:test-affected`) depends on over
 * `scope` (T14071): the change, the directories of the packages it tested and
 * the test inputs of the change.
 */
function scopedToolScopePaths(
  tool: Extract<EvidenceAtom, { kind: 'tool' }>,
  scope: QaRunCarryScope,
): string[] {
  // A tree-pinned check (config-schema, T13758) speaks for the change alone.
  if (tool.scope !== 'affected') return [...scope.changed];
  const tested = new Set(tool.affectedPackages ?? []);
  const dirs = listWorkspacePackages(scope.root)
    .filter((p) => tested.has(p.name))
    .map((p) => (p.dir === '' ? '.' : p.dir));
  return [...new Set([...scope.changed, ...dirs, ...testRunInputPaths(scope.root, scope.changed)])];
}

/** What an earlier-tree qa-run receipt is compared over (T13644). */
export interface QaRunCarryScope {
  /** The execution root both trees are compared in. */
  root: string;
  /** The task's current changed and deleted files. */
  changed: readonly string[];
}

/**
 * Why a recorded `qaPassed` resting on a tree-bound `qa-run:` receipt no
 * longer stands, or null when it does (T13427): a receipt proves the tree it
 * ran on. A `ci:<pr>` in the gate carries it on its own; atoms with no
 * `treeHash` (no git checkout at verify time) are not judged. Given a carry
 * scope, a receipt recorded on an earlier tree carries when its checked
 * `roots`, the task's current changed files and the shared tool inputs are
 * all byte-identical at the current tree (T13644): a file the change gained
 * after the receipt differs, so coverage cannot silently lapse. Otherwise the
 * refusal names the paths that differ.
 *
 * @param atoms - Recorded `qaPassed` atoms.
 * @param current - The current tree hash, or null when it cannot be computed.
 * @param scope - The root and current change to compare over; without it any
 *   moved tree refuses.
 * @returns The reason, or null.
 * @task T13427
 * @task T13644
 */
export function qaRunTreeMismatchReason(
  atoms: ReadonlyArray<EvidenceAtom>,
  current: string | null,
  scope?: QaRunCarryScope,
): string | null {
  if (atoms.some((a) => a.kind === 'ci')) return null;
  for (const a of atoms) {
    if (a.kind !== 'qa-run' || typeof a.treeHash !== 'string' || a.treeHash === current) continue;
    const label = `qa-run:${a.path}`;
    const tree = a.treeHash.slice(0, 12);
    if (current === null)
      return `qaPassed rests on ${label}, bound to tree ${tree}, and the current tree cannot be computed here (not a git checkout?); complete from the checkout the check ran in, or record ci:<pr> once the PR merges.`;
    const redo =
      'Re-run the check and record a fresh qa-run, or record ci:<pr> once the PR merges.';
    const moved = `qaPassed rests on ${label}, recorded on tree ${tree}, but the tree is now ${current.slice(0, 12)}; the receipt no longer describes this code. ${redo}`;
    if (scope === undefined) return moved;
    const paths = qaRunScopePaths(a, scope);
    try {
      execFileSync(
        'git',
        ['diff', '--quiet', '--no-renames', a.treeHash, current, '--', ...paths],
        {
          cwd: scope.root,
          stdio: 'ignore',
        },
      );
      continue;
    } catch (err) {
      // git could not compare the trees (an object pruned, not a checkout): fail closed.
      if ((err as { status?: number }).status !== 1) return moved;
    }
    return `qaPassed rests on ${label}, recorded on tree ${tree}, but its checked roots, the change's files or the shared tool configs differ in the current tree ${current.slice(0, 12)}${differingPaths(scope.root, a.treeHash, current, paths)}. ${redo}`;
  }
  return null;
}

/**
 * The carry scope of a moved receipt, from the merge verdict the caller
 * already resolves: the task's derived change set and, once merged, its
 * landed carry target. Undefined (refuse) when neither is known.
 */
async function qaRunCarryScope(
  probe: Parameters<typeof testsPassedSupersededReason>[1],
): Promise<QaRunCarryScope | undefined> {
  const merge = await probe.mergeState();
  if (typeof merge === 'string') return undefined;
  const sets = [merge.landing, merge.changeSet].filter(
    (s): s is LandedCarryTarget => s !== null && s !== undefined,
  );
  const first = sets[0];
  if (!first) return undefined;
  return {
    root: first.executionRoot,
    changed: [...new Set(sets.flatMap((s) => [...s.files, ...s.deletedFiles]))],
  };
}

/**
 * Whether recorded `qaPassed` atoms carry a tree-bound `qa-run:`, so callers
 * compute the current tree hash only when it matters.
 *
 * @param atoms - Recorded `qaPassed` atoms.
 * @returns True when a tree-bound qa-run is present.
 * @task T13427
 */
export function hasTreeBoundQaRun(atoms: ReadonlyArray<EvidenceAtom>): boolean {
  return atoms.some((a) => a.kind === 'qa-run' && typeof a.treeHash === 'string');
}

/**
 * Why a test-run, qa-run or scoped `tool:test` result no longer stands because
 * a file it set aside as untracked is now tracked (T14000, T14125), or null. The tree
 * hash includes untracked files, so committing one moves nothing the tree
 * check sees: without this, a run that never covered the file would carry it
 * (the review of #2302 hazard).
 *
 * The tracked list is read once (`git ls-files -z`, no pathspecs, so no argv
 * limit and no glob matching of names like `routes/[id]/+page.svelte`) and
 * compared literally. It fails closed: when git cannot answer, the run is
 * refused as stale.
 *
 * @param atoms - Recorded gate atoms.
 * @param root - The bound checkout, lazily; null result when absent.
 * @returns The reason, or null.
 * @task T14000
 */
export function setAsideJoinedReason(
  atoms: ReadonlyArray<EvidenceAtom>,
  root: (() => string) | undefined,
): string | null {
  const runs = atoms.filter(
    (a): a is Extract<EvidenceAtom, { kind: 'test-run' | 'qa-run' | 'tool' }> =>
      (a.kind === 'test-run' || a.kind === 'qa-run' || a.kind === 'tool') &&
      (a.untrackedSetAside?.length ?? 0) > 0,
  );
  const label = (run: (typeof runs)[number]): string =>
    run.kind === 'tool' ? `tool:${run.tool}` : `${run.kind}:${run.path}`;
  const first = runs[0];
  if (first === undefined || root === undefined) return null;
  const cwd = root();
  let tracked: Set<string>;
  try {
    tracked = new Set(
      execFileSync('git', ['-c', 'core.quotePath=false', 'ls-files', '-z'], {
        cwd,
        encoding: 'utf-8',
        env: discoveryEnv(),
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 256 * 1024 * 1024,
      })
        .split('\0')
        .filter(Boolean),
    );
  } catch {
    return (
      `${label(first)} set untracked files aside, and git cannot list the tracked ` +
      `files in ${cwd} to check whether one was since committed. Re-run and record a fresh result.`
    );
  }
  for (const run of runs) {
    const joined = (run.untrackedSetAside ?? []).filter((path) => tracked.has(path));
    if (joined.length > 0) {
      const named = `${joined.slice(0, 5).join(', ')}${joined.length > 5 ? ', …' : ''}`;
      return (
        `${label(run)} was recorded while ${named} ${joined.length === 1 ? 'was' : 'were'} ` +
        'untracked and outside the change, so the run never judged it; it is now tracked. ' +
        'Re-run and record a fresh result. Stage a new file (git add, or git add -N) before ' +
        'the run so it counts as the change (T14125).'
      );
    }
  }
  return null;
}

/**
 * The one rule for whether a recorded `qaPassed` still stands — shared by
 * `cleo done` planning and `cleo complete`, like
 * {@link testsPassedSupersededReason}. A moved tree under a qa-run receipt
 * (T13427) is checked first; a receipt whose checked roots, current changed
 * files and shared tool configs are byte-identical at the current tree
 * carries (T13644). Then, once the change has merged, a gate resting
 * on qa-run receipts alone (no `ci:<pr>`, no whole-project `tool:` run) stands
 * only when the receipts carry across the merge byte for byte (T13495), or
 * were recorded on the default branch after the merge, on the current tree,
 * covering the change (T13644, extending the T13673 owner decision): the
 * stand-in holds whatever the merge's own CI concluded.
 *
 * @param atoms - Recorded `qaPassed` atoms.
 * @param probe - Lazy merge state and current tree hash, as for testsPassed.
 * @returns The reason it no longer stands, or null.
 * @task T13427
 * @task T13644
 */
export async function qaPassedSupersededReason(
  atoms: ReadonlyArray<EvidenceAtom>,
  probe: Parameters<typeof testsPassedSupersededReason>[1],
): Promise<string | null> {
  const joined = setAsideJoinedReason(atoms, probe.root);
  if (joined) return joined;
  // T13758: CLEO's schema check of changed CLEO config holds for its tree alone.
  if (atoms.some(isTreePinnedTool)) {
    const pinned = treePinnedToolReason(atoms, await probe.currentTree(), 'qaPassed');
    if (pinned) return pinned;
  }
  if (hasTreeBoundQaRun(atoms)) {
    const current = await probe.currentTree();
    const unscoped = qaRunTreeMismatchReason(atoms, current);
    // T13644: a moved receipt may still carry; compare it over the current change.
    const moved =
      unscoped && current !== null
        ? qaRunTreeMismatchReason(atoms, current, await qaRunCarryScope(probe))
        : unscoped;
    if (moved) return moved;
  }
  if (
    !atoms.some((a) => a.kind === 'qa-run') ||
    atoms.some((a) => a.kind === 'ci' || (a.kind === 'tool' && !a.configSchema))
  )
    return null;
  const merge = await probe.mergeState();
  const verdict = typeof merge === 'string' ? { state: merge } : merge;
  if (verdict.state !== 'merged') return null;
  const target = verdict.landing ?? verdict.changeSet ?? null;
  const carried = scopedRunCarriedAcrossMerge(atoms, target);
  if (carried.ok) return null;
  const landed = probe.landed ?? (await import('./change-set.js')).isLandedOnOriginDefault;
  const stands = scopedRunStandsAfterRedCi(
    atoms,
    target,
    await probe.currentTree(),
    landed,
    'qaPassed',
  );
  if (stands.ok) return null;
  return (
    `qaPassed rests on qa-run receipts and the change has merged, but ${carried.why}, and no ` +
    `qa-run on main after the merge stands in (${stands.why}). Record ci:<pr>, or on the default ` +
    `branch run typecheck and lint over the change's roots and record a qa-run for each.`
  );
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
  return atoms.some(isTreeBoundResult);
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
    mergeState: () => Promise<ChangeMergeState | MergedVerdict> | ChangeMergeState | MergedVerdict;
    currentTree: () => Promise<string | null> | string | null;
    /**
     * Whether a commit has landed on origin's default branch (the later-main
     * stand-in, T13673); defaults to `isLandedOnOriginDefault`.
     */
    landed?: (root: string, sha: string) => boolean;
    /**
     * The bound checkout, for the set-aside check (T14000): a run recorded
     * while a file was untracked and outside the change stops standing once
     * that file is tracked. Skipped when absent.
     */
    root?: () => string;
    /**
     * The `evidence.ciSatisfies` remedy named when a merged scoped run does not
     * stand (T13096); defaults to `ciSatisfiesRemedy` of the bound checkout.
     */
    ciRemedy?: () => Promise<string | null>;
  },
): Promise<string | null> {
  const joined = setAsideJoinedReason(atoms, probe.root);
  if (joined) return joined;
  if (hasTreeBoundTestRun(atoms)) {
    const current = await probe.currentTree();
    const unscoped = testRunTreeMismatchReason(atoms, current);
    // T13784: a moved report still stands while the change's own files did not move.
    const moved =
      unscoped && current !== null
        ? testRunTreeMismatchReason(atoms, current, await qaRunCarryScope(probe))
        : unscoped;
    if (moved) return moved;
  }
  if (!isScopedOnly(atoms)) return null;
  const merge = await probe.mergeState();
  const verdict = typeof merge === 'string' ? { state: merge } : merge;
  // T13495: a tree-pinned scoped result carries across the merge when the
  // change it tested reached the default branch byte for byte.
  if (verdict.state === 'merged') {
    // T13655: the carry target, scoped to the task by the one rule; a derived
    // change set stands in only when no target could be read. T13608: a
    // fast-forward or direct landing is judged against the landed commit.
    const target = verdict.landing ?? verdict.changeSet ?? null;
    const carried = scopedRunCarriedAcrossMerge(atoms, target);
    if (carried.ok) return null;
    // T13673 (owner decision 2026-10-13): a targeted test-run recorded on a
    // main commit that descends from the merge, on the current tree, covering
    // the task's change, stands in for any merged change, whatever the merge's
    // own CI concluded. Byte identity stays the rule for every other run.
    const landed = probe.landed ?? (await import('./change-set.js')).isLandedOnOriginDefault;
    const stands = scopedRunStandsAfterRedCi(atoms, target, await probe.currentTree(), landed);
    if (stands.ok) return null;
    // T13096: a project with workflows but no ciSatisfies is told the block to add.
    const ciRemedy = probe.ciRemedy
      ? await probe.ciRemedy()
      : probe.root
        ? await (await import('../release/ci-evidence.js')).ciSatisfiesRemedy(probe.root())
        : null;
    return scopedRunSupersededReason(
      atoms,
      verdict.state,
      verdict.lookupFailed,
      `${carried.why}, and no test-run on main after the merge stands in (${stands.why})`,
      ciRemedy,
    );
  }
  return scopedRunSupersededReason(atoms, verdict.state, verdict.lookupFailed);
}

/**
 * Whether every scoped result in `atoms` was recorded on a tree whose copy of
 * the result's whole scope equals the merge commit's (T13495, narrowed by
 * D11205 / T14071): the change's files and deleted files, plus what the result
 * depends on — a test-run's test files and their test inputs (root configs,
 * lockfile, runner configs and setup files), a qa-run's roots and shared tool
 * configs, a `tool:test-affected` run's tested package directories. The same
 * per-result scope as the earlier-tree carry (T13784). Then the merged code is
 * the code the run tested, so its result still stands. Fails closed — no merge
 * commit, no changed paths, a result with no tree pin, a capped test-file list,
 * or a git failure each say why the result does not carry; a differing scope
 * names its first changed file and the routes that still prove the change.
 *
 * @param atoms - Recorded `testsPassed` atoms, or `qaPassed` qa-run receipts (T13644).
 * @param changeSet - The merged change set (its merge commit, files and root).
 * @returns `ok`, or why the scoped result does not carry across the merge.
 * @task T13495
 */
export function scopedRunCarriedAcrossMerge(
  atoms: ReadonlyArray<EvidenceAtom>,
  changeSet: Pick<
    TaskChangeSet,
    'mergeCommitSha' | 'files' | 'deletedFiles' | 'executionRoot'
  > | null,
): { ok: true } | { ok: false; why: string } {
  const merge = changeSet?.mergeCommitSha;
  if (!changeSet || !merge) return { ok: false, why: 'the merge commit is not known here' };
  const paths = [...new Set([...changeSet.files, ...changeSet.deletedFiles])];
  if (paths.length === 0) return { ok: false, why: 'the merged change lists no files to compare' };
  const scoped = atoms.filter(
    (a) => a.kind === 'test-run' || a.kind === 'qa-run' || isTreeScopedTool(a),
  );
  // Review of #2302: config-schema speaks for CLEO config alone; the change's
  // other files need a result of their own to carry.
  const code = paths.filter((p) => cleoConfigSchemaFor(p) === null);
  if (code.length > 0 && scoped.every((a) => a.kind === 'tool' && a.configSchema !== undefined))
    return {
      ok: false,
      why: `tool:config-schema checks only CLEO config, and nothing else covers the change's other file(s) ${code.slice(0, 5).join(', ')}${code.length > 5 ? ', …' : ''}`,
    };
  for (const atom of scoped) {
    // T13781: a config-schema result judged at a merged commit carries while
    // its files are unchanged at the merge.
    if (atom.kind === 'tool' && atom.configSchemaCommit) {
      const why = configSchemaCommitDiffers(atom, merge, changeSet.executionRoot);
      if (why) return { ok: false, why };
      continue;
    }
    const tree = 'treeHash' in atom && typeof atom.treeHash === 'string' ? atom.treeHash : null;
    if (tree === null)
      return { ok: false, why: 'the scoped result has no recorded tree to compare with the merge' };
    const scope: QaRunCarryScope = { root: changeSet.executionRoot, changed: paths };
    const scopePaths =
      atom.kind === 'test-run'
        ? testRunScopePaths(atom, scope)
        : atom.kind === 'qa-run'
          ? qaRunScopePaths(atom, scope)
          : atom.kind === 'tool'
            ? scopedToolScopePaths(atom, scope)
            : paths;
    if (scopePaths === null)
      return {
        ok: false,
        why: `the scoped run's test-file list was capped, so the scope it tested is not known; ${MERGE_CARRY_ROUTES}`,
      };
    const same = sameOver(changeSet.executionRoot, tree, merge, scopePaths);
    if (same === null)
      return {
        ok: false,
        why: `git could not compare the recorded tree ${tree.slice(0, 12)} with merge commit ${merge.slice(0, 12)}`,
      };
    if (!same) {
      // The differing paths are listed first-changed first (D11205).
      const differing = differingPaths(changeSet.executionRoot, tree, merge, scopePaths);
      return {
        ok: false,
        why: `the change's files at merge commit ${merge.slice(0, 12)} differ from the tree the scoped run tested (${tree.slice(0, 12)}), counting its whole scope (the test files it ran and their inputs)${differing}; ${MERGE_CARRY_ROUTES}`,
      };
    }
  }
  return { ok: true };
}

/**
 * Why the CLEO config of a merged change is not spoken for (T13778): no
 * `tool:config-schema` result validated a path, or the one that did ran on
 * another tree, or validated a commit whose copy differs at the merge. Null
 * when every path is covered.
 */
function mergedConfigGap(
  atoms: ReadonlyArray<EvidenceAtom>,
  configPaths: readonly string[],
  merge: string,
  root: string,
  current: string | null,
): string | null {
  for (const path of configPaths) {
    const schema = atoms.find(
      (a): a is Extract<EvidenceAtom, { kind: 'tool' }> =>
        a.kind === 'tool' && (a.configSchema ?? []).includes(path),
    );
    if (!schema)
      return `the merged change also edits CLEO config ${path}, and no tool:config-schema validated it`;
    const differs = schema.configSchemaCommit
      ? configSchemaCommitDiffers(schema, merge, root)
      : schema.treeHash !== current
        ? `tool:config-schema ran on tree ${schema.treeHash?.slice(0, 12) ?? 'unknown'}, but the tree is now ${current?.slice(0, 12) ?? 'unknown'}`
        : null;
    if (differs) return differs;
  }
  return null;
}

/**
 * Why a commit-anchored `tool:config-schema` result does not speak for the
 * merge (T13781): its config files differ between the commit it validated
 * and the merge commit, or git cannot compare them. Null when identical.
 */
function configSchemaCommitDiffers(
  atom: Extract<EvidenceAtom, { kind: 'tool' }>,
  merge: string,
  root: string,
): string | null {
  const at = atom.configSchemaCommit!;
  try {
    execFileSync('git', ['diff', '--quiet', at, merge, '--', ...(atom.configSchema ?? [])], {
      cwd: root,
      stdio: 'ignore',
    });
    return null;
  } catch (err) {
    return (err as { status?: number }).status === 1
      ? `CLEO config validated at ${at.slice(0, 12)} differs at merge commit ${merge.slice(0, 12)}`
      : `git could not compare the config validated at ${at.slice(0, 12)} with merge commit ${merge.slice(0, 12)}`;
  }
}

/** `: a, b, …` naming the compared paths that differ, or '' when git cannot say (T13637). */
/**
 * The routes that still prove a merged change whose scoped run does not carry
 * (D11205): a covering test-run on main after the merge (T13673), or a full run.
 */
const MERGE_CARRY_ROUTES =
  'record a test-run on the default branch after the merge that covers the change (T13673), or tool:test';

function differingPaths(root: string, tree: string, merge: string, paths: string[]): string {
  try {
    const out = execFileSync(
      'git',
      ['diff', '--name-only', '--no-renames', tree, merge, '--', ...paths],
      { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const names = out.split('\n').filter(Boolean);
    return names.length === 0
      ? ''
      : `: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}`;
  } catch {
    return '';
  }
}

/**
 * Whether a targeted `test-run:` recorded on the default branch after the
 * change merged stands in for merged CI that concluded without proving the
 * change — red, or its required jobs skipped (T13623). The run tested the
 * merged code as it is now, so it speaks for the change when CI on the merge
 * commit cannot. Fails closed, and only `test-run:` reports qualify, because
 * only they name the test files they ran:
 *  - the merge commit is known, and the change lists files;
 *  - every report carries the HEAD and tree it was bound to, that HEAD
 *    descends from the merge commit AND has landed on origin's default
 *    branch (a branch that merged main and added its own fix proves nothing
 *    about main, T13627), and the tree is still the current one (a report
 *    that predates a later edit of any file is refused);
 *  - the reports together cover the change's own files the way a
 *    pre-merge report must cover a branch ({@link testRunCoversChange}), and
 *    ran every test file the change added or edited that still exists.
 *
 * @param atoms - Recorded `testsPassed` atoms, or `qaPassed` atoms with `gate`.
 * @param changeSet - The merged change set (its merge commit, files and root).
 * @param current - The current tree hash of that root, or null.
 * @param landed - Whether a commit has landed on origin's default branch
 *   (`isLandedOnOriginDefault`; passed in so this module keeps loading
 *   change-set lazily).
 * @param gate - `qaPassed` judges `qa-run:` receipts instead (T13644): a
 *   typecheck and a lint, each bound like a test-run, whose roots together
 *   cover the change by the verify-time coverage rule ({@link qaRunCoverage}).
 * @returns `ok`, or why the recorded run does not stand in.
 * Since T13673 (owner decision 2026-10-13) the same stand-in applies to every
 * merged change, whatever its CI concluded: {@link testsPassedSupersededReason}
 * asks it whenever byte-identity carry fails, so `cleo done --plan` and
 * `cleo complete` accept it alike.
 *
 * @task T13623
 * @task T13627
 * @task T13673
 * @task T13644
 */
export function scopedRunStandsAfterRedCi(
  atoms: ReadonlyArray<EvidenceAtom>,
  changeSet:
    | (Pick<TaskChangeSet, 'mergeCommitSha' | 'files' | 'executionRoot'> &
        Partial<Pick<TaskChangeSet, 'deletedFiles'>>)
    | null,
  current: string | null,
  landed: (root: string, sha: string) => boolean,
  gate: 'testsPassed' | 'qaPassed' = 'testsPassed',
): { ok: true; manifestScoped?: string[] } | { ok: false; why: string } {
  const merge = changeSet?.mergeCommitSha;
  if (!changeSet || !merge) return { ok: false, why: 'the merge commit is not known here' };
  if (changeSet.files.length === 0)
    return { ok: false, why: 'the merged change lists no files to cover' };
  const qa = gate === 'qaPassed';
  const runs = atoms.filter(
    (a): a is Extract<EvidenceAtom, { kind: 'test-run' | 'qa-run' }> =>
      a.kind === (qa ? 'qa-run' : 'test-run'),
  );
  if (
    runs.length === 0 ||
    atoms.some((a) => a.kind === 'tool' && !a.configSchema && (qa || a.scope === 'affected'))
  )
    return {
      ok: false,
      why: qa
        ? 'only qa-run receipts, which name the roots they checked, can stand in'
        : 'only test-run reports, which name the test files they ran, can stand in',
    };
  const root = changeSet.executionRoot;
  for (const run of runs) {
    const label = `${run.kind}:${run.path}`;
    if (!run.headSha || !run.treeHash)
      return { ok: false, why: `${label} records no HEAD and tree to judge` };
    // T13784: a test-run stands while what moved since it ran leaves the
    // change's own files and the tests it ran untouched; a qa-run needs the tree.
    const unseen =
      run.kind === 'test-run'
        ? testRunUnseenChangeReason(run, run.treeHash, current, {
            root,
            changed: [...changeSet.files, ...(changeSet.deletedFiles ?? [])],
          })
        : run.treeHash !== current
          ? `${label} ran on tree ${run.treeHash.slice(0, 12)}, but the tree is now ${current?.slice(0, 12) ?? 'unknown'}`
          : null;
    if (unseen) return { ok: false, why: unseen };
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', merge, run.headSha], {
        cwd: root,
        stdio: 'ignore',
      });
    } catch {
      return {
        ok: false,
        why: `${label} was recorded at ${run.headSha.slice(0, 12)}, which does not descend from merge commit ${merge.slice(0, 12)}`,
      };
    }
    if (!landed(root, run.headSha))
      return {
        ok: false,
        why: `${label} was recorded at ${run.headSha.slice(0, 12)}, which is not on origin's default branch; run it on the default branch`,
      };
  }
  if (qa) {
    const receipts = runs.filter(
      (r): r is Extract<EvidenceAtom, { kind: 'qa-run' }> => r.kind === 'qa-run',
    );
    const missing = QA_RUN_KINDS.filter((k) => !receipts.some((r) => r.check === k));
    if (missing.length > 0)
      return { ok: false, why: `no qa-run ${missing.join(' or ')} receipt is on record` };
    const bound = [];
    for (const r of receipts) {
      const cover = qaRunCoverage(r.check, r.roots, root, changeSet.files);
      if (!cover.ok) return { ok: false, why: cover.reason };
      const configGap = mergedConfigGap(atoms, cover.configPaths ?? [], merge, root, current);
      if (configGap) return { ok: false, why: configGap };
      bound.push({ check: r.check, roots: r.roots, ...cover });
    }
    const gap = qaRunUnionGapReason(bound);
    return gap === null ? { ok: true } : { ok: false, why: gap };
  }
  const ran = [...new Set(runs.flatMap((r) => (r.kind === 'test-run' ? (r.testFiles ?? []) : [])))];
  // T14163: after the merge, a manifest-only workspace change is scoped by
  // the lockfile importers it touched.
  const covered = testRunCoversChange(root, changeSet.files, ran, { mergeCommit: merge });
  if (!covered.ok) return { ok: false, why: covered.reason };
  const configGap = mergedConfigGap(atoms, covered.configPaths ?? [], merge, root, current);
  if (configGap) return { ok: false, why: configGap };
  // T13783: dependents left to a typecheck need one on the current tree.
  const typecheckGap = typecheckCoverageGap(
    atoms.filter((a) => a.kind !== 'qa-run' || a.treeHash === current),
    covered.typecheckDirs ?? [],
  );
  if (typecheckGap) return { ok: false, why: typecheckGap };
  const unrun = changedTestFiles(root, changeSet.files).filter((f) => !ran.includes(f));
  if (unrun.length > 0)
    return {
      ok: false,
      why: `the test-run did not run the change's test file(s) ${unrun.slice(0, 5).join(', ')}${unrun.length > 5 ? ', …' : ''}`,
    };
  return covered.manifestScoped !== undefined
    ? { ok: true, manifestScoped: covered.manifestScoped }
    : { ok: true };
}

/**
 * A merge verdict, with the merged change set when the caller derived one
 * ({@link TaskMergeInfo} carries it), so a scoped result can be compared with
 * the merge commit (T13495).
 */
export type MergedVerdict = MergeVerdict & {
  changeSet?: TaskChangeSet | null;
  landing?: LandedCarryTarget | null;
};

/**
 * What a scoped result is compared with when the change landed on the default
 * branch with no merge commit (fast-forward or direct push, T13608): the newest
 * landed implementing commit, and every file the implementing commits changed.
 */
export type LandedCarryTarget = Pick<
  TaskChangeSet,
  'mergeCommitSha' | 'files' | 'deletedFiles' | 'executionRoot'
>;

/**
 * The carry target of commits that reached the default branch themselves.
 * Fails closed: no single newest commit, or a git failure, gives `null`.
 *
 * @param root - Repository the commits live in.
 * @param commits - The task's implementing commits, all landed.
 * @param contains - Whether `ancestor` is contained in `descendant`.
 * @returns The newest commit and the files the commits changed, or null.
 * @task T13608
 */
export function landedCarryTarget(
  root: string,
  commits: readonly string[],
  contains: (root: string, ancestor: string, descendant: string) => boolean,
): LandedCarryTarget | null {
  const newest = commits.find((c) => commits.every((o) => o === c || contains(root, o, c)));
  if (!newest) return null;
  const files = new Set<string>();
  try {
    for (const sha of commits) {
      const out = execFileSync(
        'git',
        ['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '--root', sha],
        { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      for (const line of out.split('\n')) if (line) files.add(line);
    }
  } catch {
    return null;
  }
  return { mergeCommitSha: newest, files: [...files], deletedFiles: [], executionRoot: root };
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
  /**
   * The carry target when no derived change set gives one: the commits landed
   * with no merge commit (T13608), or a recorded `pr:` atom named the merge
   * (T13634).
   */
  landing?: LandedCarryTarget | null;
}

/**
 * The carry target of a merge commit: the commit and every file it changed
 * against its first parent, which for a squash or merge commit is exactly the
 * PR's change (T13636). Fails closed: an unknown commit, a root commit, a git
 * failure or an empty diff gives null.
 *
 * @param root - Repository the merge commit lives in.
 * @param merge - The merge (or squash) commit.
 * @returns The commit and the files it changed and deleted, or null.
 * @task T13636
 * @task T13637
 */
export function mergeCarryTarget(
  root: string,
  merge: string | null | undefined,
): LandedCarryTarget | null {
  if (!merge) return null;
  let out: string;
  try {
    out = execFileSync('git', ['diff', '--name-status', '--no-renames', `${merge}^1`, merge], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  const files: string[] = [];
  const deletedFiles: string[] = [];
  for (const line of out.split('\n')) {
    const [status, path] = line.split('\t');
    if (!status || !path) continue;
    (status === 'D' ? deletedFiles : files).push(path);
  }
  if (files.length + deletedFiles.length === 0) return null;
  return { mergeCommitSha: merge, files, deletedFiles, executionRoot: root };
}

/**
 * The carry target a recorded `pr:` atom names: its merge commit and the files
 * the PR changed — its own inventory, else the merge commit's real diff (never
 * the task's `files:` atoms, which may list fewer files, T13636). Without a
 * merge commit or any file there is nothing to compare, so null (T13634).
 */
function prCarryTarget(
  pr: Extract<EvidenceAtom, { kind: 'pr' }>,
  root: string,
): LandedCarryTarget | null {
  if (!pr.mergeCommitSha) return null;
  if (!pr.changedPaths) return mergeCarryTarget(root, pr.mergeCommitSha);
  const deletedFiles = pr.deletedPaths ?? [];
  if (pr.changedPaths.length + deletedFiles.length === 0) return null;
  return {
    mergeCommitSha: pr.mergeCommitSha,
    files: pr.changedPaths,
    deletedFiles,
    executionRoot: root,
  };
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

  // T12965 review M2: the same root `cleo done` reads the change set from.
  const at = deps.executionRoot ?? cs.resolveChangeSetRoot(storeRoot, task.id).root;
  // T13655: every carry target is scoped by the one rule (the task's own
  // commits plus its declared files), so planning and completion agree.
  const own = (target: LandedCarryTarget | null): LandedCarryTarget | null =>
    cs.taskCarryScope(target, task, commits);
  // The carry target of a derived change set: its carrier's whole merge, scoped.
  const ofDerived = (changeSet: TaskChangeSet): LandedCarryTarget | null =>
    own(mergeCarryTarget(at, changeSet.mergeCommitSha));

  if (commits.length === 0) {
    const newest = prs[0];
    if (newest)
      return {
        state: 'merged',
        changeSet: null,
        prRef: prRefOf(newest),
        landing: own(prCarryTarget(newest, at)),
      };
    const changeSet = await derive();
    derivedFailure(changeSet);
    return {
      state: mergeStateOfChangeSet(changeSet),
      changeSet,
      prRef: changeSetPrRef(changeSet),
      landing: ofDerived(changeSet),
      ...lookupFailed(),
    };
  }

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
    if (await carries(pr))
      return {
        state: 'merged',
        changeSet: null,
        prRef: prRefOf(pr),
        landing: own(prCarryTarget(pr, at)),
      };
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
    return { state: 'merged', changeSet, prRef: derivedRef, landing: ofDerived(changeSet) };
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
    // T13637: a commit-backed GitHub carrier names its merge commit, so a
    // scoped run can be compared with the change that merged.
    if (await carries(pr))
      return {
        state: 'merged',
        changeSet,
        prRef: prRefOf(pr),
        landing: own(mergeCarryTarget(at, pr.mergeCommitSha)),
      };
  }

  const isLanded = deps.isLanded ?? cs.isLandedOnOriginDefault;
  if (commits.every((sha) => isLanded(at, sha))) {
    const landing = own(landedCarryTarget(at, commits, probes.contains));
    // T12959 review: with a failed lookup the carrier is unknown, not absent.
    if (failures.length > 0)
      return { state: 'merged', changeSet, prRef: null, landing, ...lookupFailed() };
    return {
      state: 'merged',
      changeSet,
      prRef: null,
      landing,
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
