/**
 * `cleo tasks changeset --test-plan` (T13795): on a fixture task the change
 * set, commits and owed test files match what `cleo done --plan` and the
 * `test-run:` binding enforce.
 *
 * @task T13795
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { resetDbState } from '../../store/sqlite.js';
import { addTask } from '../add.js';
import { taskChangeMergeState } from '../affected-scope.js';
import type { ChangeSetDeps } from '../change-set.js';
import { planTaskChangeSet } from '../changeset-plan.js';
import { deriveTaskEvidence } from '../done-plan.js';
import { testRunCoversChange } from '../test-run-binding.js';

const deps: ChangeSetDeps = {
  listMergedPrs: async () => ({ ok: true, prs: [] }),
  listPrsForCommit: async () => [],
  listTaskDocs: async () => [],
  listTaskDecisions: async () => [],
  env: {},
};

let env: TestDbEnv;
let root: string;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf-8' }).trim();
}

beforeEach(async () => {
  env = await createTestDb();
  root = env.tempDir;
  process.env['CLEO_DIR'] = env.cleoDir;
  rmSync(join(root, '.git'), { recursive: true, force: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.com']);
  writeFileSync(join(root, '.gitignore'), '.cleo/*\n!.cleo/project-context.json\n.cleo-home/\n');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'solo', scripts: { test: 'vitest run' } }),
  );
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'src', 'a.test.ts'), 'export {};\n');
  writeFileSync(
    join(root, '.cleo', 'project-context.json'),
    JSON.stringify({ primaryType: 'node', testing: { command: 'node -e 0' } }),
  );
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
  const origin = `${root}-origin.git`;
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  git(['remote', 'add', 'origin', origin]);
  git(['push', '-q', '-u', 'origin', 'main']);
  git(['remote', 'set-head', 'origin', 'main']);
});

afterEach(async () => {
  delete process.env['CLEO_DIR'];
  resetDbState();
  await env.cleanup();
  rmSync(`${root}-origin.git`, { recursive: true, force: true });
});

describe('planTaskChangeSet --test-plan (T13795)', () => {
  it('lists commits, files and the exact test files owed, matching cleo done --plan', async () => {
    const { task } = await addTask(
      {
        title: 'changeset fixture',
        description: 'fixture',
        acceptance: ['Change src/a.ts'],
        skipContainmentInvariant: true,
      },
      root,
      env.accessor,
    );
    const id = task.id;
    git(['switch', '-q', '-c', `task/${id}`]);
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(root, 'src', 'b.test.ts'), 'export {};\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', `${id}: change a, add b test`]);
    const head = git(['rev-parse', 'HEAD']);

    const result = await planTaskChangeSet(id, {
      projectRoot: root,
      cwd: root,
      deps,
      testPlan: true,
    });
    if (!result.success) throw new Error(result.error.message);
    const report = result.data;
    expect(report.changeSet.source).toBe('branch');
    expect(report.commits).toEqual([head]);
    expect(report.changeSet.files.sort()).toEqual(['src/a.ts', 'src/b.test.ts']);

    const plan = report.testPlan;
    expect(plan?.scope).toBe('targeted');
    expect(plan?.files).toEqual([
      {
        file: 'src/b.test.ts',
        reason: 'test file the change adds or edits in a single-package project',
      },
    ]);
    expect(plan?.packages).toEqual([
      { name: 'solo', reason: 'changed', changedTestFiles: ['src/b.test.ts'] },
    ]);

    // Same verdict as cleo done --plan: the targeted test-run it asks for names the owed file.
    const done = await deriveTaskEvidence(id, { projectRoot: root, cwd: root, deps });
    const doneBlocker = done.blockers.find((b) => b.code === 'test-run-needed');
    expect(doneBlocker?.message).toMatch(/src\/b\.test\.ts/);
    expect(plan?.blockers).toContainEqual(doneBlocker);

    // And the binding: a report without the owed file is refused, one with it binds.
    const changed = plan?.changedPaths ?? [];
    expect(testRunCoversChange(root, changed, ['src/a.test.ts']).ok).toBe(false);
    expect(testRunCoversChange(root, changed, plan?.files.map((f) => f.file) ?? []).ok).toBe(true);
  });

  it('omits the test plan without --test-plan', async () => {
    const { task } = await addTask(
      {
        title: 'changeset fixture 2',
        description: 'fixture',
        acceptance: ['x'],
        skipContainmentInvariant: true,
      },
      root,
      env.accessor,
    );
    const result = await planTaskChangeSet(task.id, { projectRoot: root, cwd: root, deps });
    if (!result.success) throw new Error(result.error.message);
    expect(result.data.testPlan).toBeUndefined();
    expect(result.data.changeSet.source).toBe('none');
    expect(result.data.commits).toEqual([]);
  });
});

async function seed(title: string): Promise<string> {
  const { task } = await addTask(
    { title, description: 'fixture', acceptance: ['Change it'], skipContainmentInvariant: true },
    root,
    env.accessor,
  );
  return task.id;
}

/** Commit on task/<id> with the given writes; returns the head. */
function onTaskBranch(id: string, writes: Record<string, string>): string {
  git(['switch', '-q', '-c', `task/${id}`]);
  for (const [path, body] of Object.entries(writes)) writeFileSync(join(root, path), body);
  git(['add', '-A']);
  git(['commit', '-q', '-m', `${id}: change`]);
  return git(['rev-parse', 'HEAD']);
}

async function testPlanOf(id: string) {
  const result = await planTaskChangeSet(id, {
    projectRoot: root,
    cwd: root,
    deps,
    testPlan: true,
  });
  if (!result.success) throw new Error(result.error.message);
  return result.data.testPlan;
}

describe('planTaskChangeSet --test-plan matches enforcement (T13795 review)', () => {
  it('a merged change: the landed task files only, every changed test file owed', async () => {
    const id = await seed('merged fixture');
    writeFileSync(join(root, 'src', 'old.ts'), 'export {};\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'add old']);
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 3;\n');
    writeFileSync(join(root, 'src', 'a.test.ts'), 'export const t = 2;\n');
    rmSync(join(root, 'src', 'old.ts'));
    git(['add', '-A']);
    git(['commit', '-q', '-m', `${id}: land on main`]);
    const sha = git(['rev-parse', 'HEAD']);
    git(['push', '-q', 'origin', 'main']);
    const verification = {
      passed: false,
      round: 1,
      gates: { implemented: true },
      failureLog: [],
      lastAgent: null,
      lastUpdated: null,
      evidence: {
        implemented: {
          atoms: [{ kind: 'commit', sha, shortSha: sha.slice(0, 7) }],
          capturedAt: '2026-10-01T00:00:00Z',
          capturedBy: 'test',
        },
      },
    };
    await env.accessor.updateTaskFields(id, { verificationJson: JSON.stringify(verification) });
    const plan = await testPlanOf(id);
    expect(plan?.merged).toBe(true);
    // Exactly the paths cleo complete judges: the landed carry target's files.
    const task = await env.accessor.loadSingleTask(id);
    const info = task ? await taskChangeMergeState(task, root, { changeSet: deps }) : null;
    expect(info?.state).toBe('merged');
    expect(plan?.changedPaths).toEqual((info?.landing ?? info?.changeSet)?.files);
    expect(plan?.changedPaths).toEqual(expect.arrayContaining(['src/a.test.ts', 'src/a.ts']));
    expect(plan?.files).toEqual([
      { file: 'src/a.test.ts', reason: 'test file the merged change adds or edits' },
    ]);
  });

  it('a path outside every workspace package owes the test files under its directory', async () => {
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - pkgs/*\n');
    mkdirSync(join(root, 'pkgs', 'p'), { recursive: true });
    writeFileSync(join(root, 'pkgs', 'p', 'package.json'), JSON.stringify({ name: 'p' }));
    writeFileSync(join(root, 'pkgs', 'p', 'p.test.ts'), 'export {};\n');
    mkdirSync(join(root, 'tools'), { recursive: true });
    writeFileSync(join(root, 'tools', 'x.mjs'), 'export {};\n');
    writeFileSync(join(root, 'tools', 'x.test.mjs'), 'export {};\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'workspace']);
    git(['push', '-q', 'origin', 'main']);
    const id = await seed('outside fixture');
    onTaskBranch(id, { 'tools/x.mjs': 'export const x = 1;\n' });
    const plan = await testPlanOf(id);
    expect(plan?.scope).toBe('targeted');
    expect(plan?.files.map((f) => f.file)).toEqual(['tools/x.test.mjs']);
    expect(plan?.files[0]?.reason).toMatch(/outside every workspace package/);
    expect(testRunCoversChange(root, plan?.changedPaths ?? [], ['tools/x.test.mjs']).ok).toBe(true);
    expect(testRunCoversChange(root, plan?.changedPaths ?? [], []).ok).toBe(false);
  });

  it('a mixed change owes its code tests and leaves CLEO config to config-schema', async () => {
    const id = await seed('mixed fixture');
    onTaskBranch(id, {
      'src/a.ts': 'export const a = 2;\n',
      '.cleo/project-context.json': JSON.stringify({
        primaryType: 'node',
        testing: { command: 'node -e 1' },
      }),
    });
    const plan = await testPlanOf(id);
    expect(plan?.scope).toBe('targeted');
    expect(plan?.configPaths).toEqual(['.cleo/project-context.json']);
    expect(plan?.packages.map((p) => p.name)).toEqual(['solo']);
    const binding = testRunCoversChange(root, plan?.changedPaths ?? [], ['src/a.test.ts']);
    expect(binding.ok && binding.configPaths).toEqual(['.cleo/project-context.json']);
  });

  it('a config-only change owes no test file, only config-schema', async () => {
    const id = await seed('config fixture');
    onTaskBranch(id, {
      '.cleo/project-context.json': JSON.stringify({
        primaryType: 'node',
        testing: { command: 'node -e 1' },
      }),
    });
    const plan = await testPlanOf(id);
    expect(plan?.configPaths).toEqual(['.cleo/project-context.json']);
    expect(plan?.files).toEqual([]);
    expect(plan?.packages).toEqual([]);
    // The testsPassed blockers are chosen by gate, never by message text.
    expect(plan?.blockers.every((b) => b.gate === 'testsPassed')).toBe(true);
  });
});
