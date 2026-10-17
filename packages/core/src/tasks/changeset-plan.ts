/**
 * `cleo tasks changeset <id> [--test-plan]` — a task's change set and the
 * exact tests it owes, as data, for a goal runtime to act on (T13795).
 *
 * Nothing here is a second opinion: the change set and the testsPassed tool
 * runs and blockers come from {@link deriveTaskEvidence} (`cleo done --plan`),
 * the merged change from {@link taskChangeMergeState} (what `cleo complete`
 * judges), and the owed tests from {@link testRunRequirement}, the requirement
 * the `test-run:` binding judges a report against.
 *
 * @epic T13791
 * @task T13795
 */

import { execFileSync } from 'node:child_process';
import type {
  DonePlan,
  OwedTestFile,
  TaskChangeSet,
  TaskChangeSetReport,
  TaskTestPlan,
} from '@cleocode/contracts';
import { type EngineResult, engineSuccess } from '../engine-result.js';
import { cleoErrorToEngineResult } from '../errors-to-engine.js';
import { getProjectRoot } from '../paths.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { inPackageDir, listWorkspacePackages, scopedChangedPaths } from './affected-packages.js';
import { taskChangeMergeState } from './affected-scope.js';
import { type DeriveTaskEvidenceOptions, deriveTaskEvidence } from './done-plan.js';
import { changedTestFiles, testRunRequirement } from './test-run-binding.js';

/** Commits of a change set, oldest first. */
function changeCommits(cs: TaskChangeSet): string[] {
  if (cs.source === 'pr') return cs.mergeCommitSha ? [cs.mergeCommitSha] : [];
  if (cs.source !== 'branch' || !cs.mergeBase) return [];
  try {
    const out = execFileSync(
      'git',
      ['rev-list', '--reverse', `${cs.mergeBase}..${cs.commitSha ?? cs.headRef ?? 'HEAD'}`],
      { cwd: cs.executionRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** The changed paths enforcement judges, and from which root. */
interface JudgedChange {
  root: string;
  changed: string[] | null;
  merged: boolean;
}

/**
 * Before merge the binding judges the checkout's diff against the default
 * branch; after merge `cleo complete` judges the task's own part of the landed
 * change (`landing ?? changeSet`, scoped by `taskCarryScope`), its files only.
 */
async function judgedChange(
  taskId: string,
  storeRoot: string,
  cs: TaskChangeSet,
  opts: DeriveTaskEvidenceOptions,
): Promise<JudgedChange> {
  const task = await (await getTaskAccessor(storeRoot)).loadSingleTask(taskId);
  if (task) {
    const info = await taskChangeMergeState(task, storeRoot, {
      derived: cs,
      executionRoot: cs.executionRoot,
      ...(opts.deps ? { changeSet: opts.deps } : {}),
    });
    if (info.state === 'merged') {
      const target = info.landing ?? info.changeSet;
      return {
        root: target?.executionRoot ?? cs.executionRoot,
        changed: target ? target.files : null,
        merged: true,
      };
    }
  }
  return {
    root: cs.executionRoot,
    changed: scopedChangedPaths(cs.executionRoot)?.paths ?? null,
    merged: false,
  };
}

/** The tests a change owes, per the `test-run:` binding. */
function testPlanFor(judged: JudgedChange, plan: DonePlan): TaskTestPlan {
  const { root, changed, merged } = judged;
  const base = {
    changedPaths: changed,
    files: [] as OwedTestFile[],
    packages: [],
    untestedPackages: [],
    configPaths: [],
    typecheckDirs: [],
    merged,
    gatePassed: plan.gates.some((g) => g.gate === 'testsPassed' && g.passed),
    toolRuns: plan.toolRuns.filter((r) => r.gate === 'testsPassed'),
    blockers: plan.blockers.filter((b) => b.gate === 'testsPassed'),
  };
  if (changed === null || changed.length === 0) return { ...base, scope: 'none' };
  const need = testRunRequirement(root, changed);
  if (need.kind === 'full') {
    return { ...base, scope: 'full', reason: need.reason, configPaths: need.configPaths };
  }
  const changedTests = changedTestFiles(root, changed);
  const files: OwedTestFile[] = need.outsideTests.map((file) => ({
    file,
    reason: 'test file outside every workspace package, under a changed top-level directory',
  }));
  // Merged: complete requires every test file the change adds or edits (T13623).
  const every = merged ? changedTests : need.everyChangedTest;
  const why = merged
    ? 'test file the merged change adds or edits'
    : need.standalone
      ? 'test file the change adds or edits in a single-package project'
      : 'test file the change adds or edits, while dependents are left to a typecheck';
  for (const file of every) {
    if (!files.some((f) => f.file === file)) files.push({ file, reason: why });
  }
  const workspace = listWorkspacePackages(root);
  return {
    ...base,
    scope: 'targeted',
    files,
    packages: need.required.map((name) => {
      const dir = workspace.find((p) => p.name === name)?.dir ?? '';
      return {
        name,
        reason: need.direct.includes(name) ? 'changed' : 'depends on a changed package',
        changedTestFiles: changedTests.filter((f) => inPackageDir(f, dir)),
      };
    }),
    untestedPackages: need.untestedPackages,
    configPaths: need.configPaths,
    typecheckDirs: need.typecheckDirs,
  };
}

/**
 * Report a task's change set, its commits and, with `testPlan`, the tests it
 * owes. Read-only: runs no tool and writes nothing.
 *
 * @param taskId - Task id.
 * @param opts - The `cleo done --plan` options, plus `testPlan`.
 * @returns The report, or the planner's refusal.
 * @example
 * ```ts
 * const r = await planTaskChangeSet('T123', { testPlan: true });
 * if (r.success) r.data.testPlan?.files; // exact test files owed
 * ```
 */
export async function planTaskChangeSet(
  taskId: string,
  opts: DeriveTaskEvidenceOptions & { testPlan?: boolean } = {},
): Promise<EngineResult<TaskChangeSetReport>> {
  try {
    const { testPlan, ...planOpts } = opts;
    const plan = await deriveTaskEvidence(taskId, planOpts);
    const cs = plan.changeSet;
    const storeRoot = planOpts.projectRoot ?? getProjectRoot();
    return engineSuccess({
      taskId,
      changeSet: cs,
      commits: changeCommits(cs),
      ...(testPlan
        ? { testPlan: testPlanFor(await judgedChange(taskId, storeRoot, cs, planOpts), plan) }
        : {}),
    });
  } catch (err) {
    return cleoErrorToEngineResult<TaskChangeSetReport>(
      err,
      'E_CHANGESET_FAILED',
      'cleo tasks changeset failed',
    );
  }
}
