/**
 * `cleo done --commit <sha>` (T13799): work that landed on the default branch
 * with no PR or branch citing the task closes through its verified commit; a
 * commit that is unknown, unlanded or empty is refused. A task whose
 * acceptance is only a REQ typed gate closes through cleo done.
 *
 * @task T13799
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { resetDbState } from '../../store/sqlite.js';
import { addTask } from '../add.js';
import type { ChangeSetDeps } from '../change-set.js';
import { deriveTaskEvidence, parseDoneOptions } from '../done-plan.js';
import { recordTaskDone } from '../done-record.js';
import { reqAdd } from '../req.js';
import { runToolCached } from '../tool-cache.js';
import { resolveToolCommand } from '../tool-resolver.js';
import { useRealToolRunner } from './real-tool-runner.js';

// Tiny real `node -e 0` tools run through CLEO's tool runner.
useRealToolRunner();

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
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
  const origin = `${root}-origin.git`;
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  git(['remote', 'add', 'origin', origin]);
  git(['push', '-q', '-u', 'origin', 'main']);
  git(['remote', 'set-head', 'origin', 'main']);
  writeFileSync(
    join(root, '.cleo', 'project-context.json'),
    JSON.stringify({
      primaryType: 'node',
      testing: { command: 'node -e 0' },
      lint: { command: 'node -e 0' },
      typecheck: { command: 'node -e 0' },
    }),
  );
});

afterEach(async () => {
  delete process.env['CLEO_DIR'];
  resetDbState();
  await env.cleanup();
  rmSync(`${root}-origin.git`, { recursive: true, force: true });
});

async function seed(acceptance: string[]): Promise<string> {
  const { task } = await addTask(
    { title: 'commit fixture', description: 'fixture', acceptance, skipContainmentInvariant: true },
    root,
    env.accessor,
  );
  return task.id;
}

/** A passing whole-suite tool:test cached for this tree (cleo done never launches one, T13647). */
async function cacheTestPass(): Promise<void> {
  const test = resolveToolCommand('test', root);
  if (!test.ok) throw new Error(test.reason);
  await runToolCached(test.command, root, { executionRoot: root, skipGlobalSemaphore: true });
}

/** Land a change on main that does not cite the task; returns its sha. */
function landUncited(): string {
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 2;\n');
  git(['commit', '-q', '-am', 'fix: change a']);
  git(['push', '-q', 'origin', 'main']);
  return git(['rev-parse', 'HEAD']);
}

describe('cleo done --commit (T13799)', () => {
  it('derives the change set from a landed commit no PR or branch cites', async () => {
    const id = await seed(['Change src/a.ts to return 2']);
    const sha = landUncited();
    const without = await deriveTaskEvidence(id, { projectRoot: root, cwd: root, deps });
    expect(without.changeSet.blockers.map((b) => b.code)).toContain('no-change-set');

    const plan = await deriveTaskEvidence(id, {
      projectRoot: root,
      cwd: root,
      deps,
      commit: sha.slice(0, 10),
    });
    expect(plan.changeSet).toMatchObject({ source: 'commit', commitSha: sha, files: ['src/a.ts'] });
    expect(plan.changeSet.implementedEvidence).toBe(`commit:${sha};files:src/a.ts`);
    expect(plan.blockers.map((b) => b.code)).not.toContain('no-change-set');
    expect(plan.blockers.map((b) => b.code)).not.toContain('checkout-required');
  });

  it('refuses a commit that does not exist, has not landed, or names no change', async () => {
    const id = await seed(['Change src/a.ts to return 2']);
    const why = async (commit: string) =>
      (
        await deriveTaskEvidence(id, { projectRoot: root, cwd: root, deps, commit })
      ).changeSet.blockers
        .map((b) => b.message)
        .join(' ');
    expect(await why('f'.repeat(40))).toMatch(/is not a commit/);
    git(['switch', '-q', '-c', 'side']);
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 9;\n');
    git(['commit', '-q', '-am', 'unlanded']);
    expect(await why(git(['rev-parse', 'HEAD']))).toMatch(/has not landed/);
    git(['switch', '-q', 'main']);
    git(['commit', '-q', '--allow-empty', '-m', 'empty']);
    git(['push', '-q', 'origin', 'main']);
    expect(await why(git(['rev-parse', 'HEAD']))).toMatch(/changes no file/);
    expect(parseDoneOptions(undefined, '3', 'abcdef1')).toMatchObject({ ok: false });
    expect(parseDoneOptions(undefined, undefined, 'not-a-sha')).toMatchObject({ ok: false });
  });

  it('records every gate through cleo done from the verified commit', async () => {
    const id = await seed(['Change src/a.ts to return 2']);
    const sha = landUncited();
    await cacheTestPass();
    const r = await recordTaskDone(id, {
      projectRoot: root,
      cwd: root,
      deps,
      commit: sha,
      satisfies: 'all',
    });
    if (!r.success) throw new Error(`${r.error.code}: ${r.error.message}`);
    const stored = (await env.accessor.loadSingleTask(id))?.verification?.evidence?.implemented;
    expect(stored?.atoms).toContainEqual(expect.objectContaining({ kind: 'commit', sha }));
  });

  it('a task whose acceptance is only a REQ typed gate closes via cleo done', async () => {
    const id = await seed(['placeholder']);
    await reqAdd(
      root,
      id,
      {
        kind: 'command',
        cmd: 'node',
        args: ['-e', '0'],
        req: 'REQ-T091-01',
        description: 'harness passes',
      },
      env.accessor,
    );
    // A REQ-only task: its acceptance holds just the typed gate.
    const task = await env.accessor.loadSingleTask(id);
    const gateOnly = (task?.acceptance ?? []).filter((a) => typeof a !== 'string');
    await env.accessor.updateTaskFields(id, { acceptanceJson: JSON.stringify(gateOnly) });
    // OCG T091's shape: the gate-only acceptance with no criterion rows at all.
    await env.accessor.transaction((tx) => tx.deleteAcRowsForTask(id));
    const sha = landUncited();
    await cacheTestPass();
    const r = await recordTaskDone(id, {
      projectRoot: root,
      cwd: root,
      deps,
      commit: sha,
      runTyped: true,
    });
    if (!r.success) throw new Error(`${r.error.code}: ${r.error.message}`);
    // The gate ran once, its result is recorded, and it links to the AC.
    expect(r.data.typedGateCount).toBe(1);
    expect(r.data.plan.acMapping).toEqual([
      expect.objectContaining({ alias: 'AC1', mapped: true, basis: 'typed-gate' }),
    ]);
    const stored = (await env.accessor.loadSingleTask(id))?.verification;
    expect(stored?.gateResults?.map((g) => g.result)).toEqual(['pass']);
    const [row] = await env.accessor.getAcRows(id);
    expect(stored?.evidence?.testsPassed?.scope?.criteria?.map((c) => c.criterionId)).toEqual([
      row?.id,
    ]);
  });
});
