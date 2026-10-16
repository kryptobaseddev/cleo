/**
 * `cleo tasks changeset <id> [--test-plan]` — a task's change set and the
 * exact tests it owes, as data, for a goal runtime to act on (T13795).
 *
 * Nothing here is a second opinion: the change set and the testsPassed tool
 * runs and blockers come from {@link deriveTaskEvidence} (`cleo done --plan`),
 * and the owed tests from {@link testRunRequirement}, the requirement the
 * `test-run:` binding judges a report against.
 *
 * @epic T13791
 * @task T13795
 */

import { execFileSync } from 'node:child_process';
import type { TaskChangeSet, TaskChangeSetReport, TaskTestPlan } from '@cleocode/contracts';
import { type EngineResult, engineSuccess } from '../engine-result.js';
import { cleoErrorToEngineResult } from '../errors-to-engine.js';
import { inPackageDir, listWorkspacePackages, scopedChangedPaths } from './affected-packages.js';
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

/** The tests a change owes, per the `test-run:` binding. */
function testPlanFor(
  cs: TaskChangeSet,
  plan: Awaited<ReturnType<typeof deriveTaskEvidence>>,
): TaskTestPlan {
  const root = cs.executionRoot;
  // A merged change is judged on its own files (T13623); otherwise the binding judges the checkout's diff.
  const changed =
    cs.source === 'pr'
      ? [...cs.files, ...cs.deletedFiles]
      : (scopedChangedPaths(root)?.paths ?? null);
  const tests = {
    gatePassed: plan.gates.some((g) => g.gate === 'testsPassed' && g.passed),
    toolRuns: plan.toolRuns.filter((r) => r.gate === 'testsPassed'),
    blockers: plan.blockers.filter(
      (b) => b.code === 'test-run-needed' || b.message.startsWith('testsPassed'),
    ),
  };
  if (changed === null || changed.length === 0) {
    return {
      changedPaths: changed,
      scope: 'none',
      files: [],
      packages: [],
      untestedPackages: [],
      ...tests,
    };
  }
  const need = testRunRequirement(root, changed);
  if (need.kind === 'full') {
    return {
      changedPaths: changed,
      scope: 'full',
      reason: need.reason,
      files: [],
      packages: [],
      untestedPackages: [],
      ...tests,
    };
  }
  const workspace = listWorkspacePackages(root);
  const changedTests = changedTestFiles(root, changed);
  return {
    changedPaths: changed,
    scope: 'targeted',
    files: [
      ...need.outsideTests.map((file) => ({
        file,
        reason: 'test file outside every workspace package, under a changed top-level directory',
      })),
      ...need.standaloneTests.map((file) => ({
        file,
        reason: 'test file the change adds or edits in a single-package project',
      })),
    ],
    packages: need.required.map((name) => {
      const dir = workspace.find((p) => p.name === name)?.dir ?? '';
      return {
        name,
        reason: need.direct.includes(name) ? 'changed' : 'depends on a changed package',
        changedTestFiles: changedTests.filter((f) => inPackageDir(f, dir)),
      };
    }),
    untestedPackages: need.untestedPackages,
    ...tests,
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
    return engineSuccess({
      taskId,
      changeSet: cs,
      commits: changeCommits(cs),
      ...(testPlan ? { testPlan: testPlanFor(cs, plan) } : {}),
    });
  } catch (err) {
    return cleoErrorToEngineResult<TaskChangeSetReport>(
      err,
      'E_CHANGESET_FAILED',
      'cleo tasks changeset failed',
    );
  }
}
