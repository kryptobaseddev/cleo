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
  writeFileSync(join(root, '.gitignore'), '.cleo/\n.cleo-home/\n');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'solo', scripts: { test: 'vitest run' } }),
  );
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'src', 'a.test.ts'), 'export {};\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
  const origin = `${root}-origin.git`;
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  git(['remote', 'add', 'origin', origin]);
  git(['push', '-q', '-u', 'origin', 'main']);
  git(['remote', 'set-head', 'origin', 'main']);
  writeFileSync(
    join(root, '.cleo', 'project-context.json'),
    JSON.stringify({ primaryType: 'node', testing: { command: 'node -e 0' } }),
  );
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
