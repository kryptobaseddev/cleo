/**
 * Optimistic concurrency across REAL processes (T12503 AC3).
 *
 * `update-concurrency.test.ts` simulates a second writer by interleaving
 * inside one process. That cannot prove the property that matters: two
 * separate `cleo update` processes, each with its own SQLite connection, never
 * lose each other's writes. These tests spawn separate `node` processes that
 * import the COMPILED `updateTask` from `packages/core/dist/` (build first),
 * point them at one scratch project, and release them together from a start
 * barrier so the writes genuinely race.
 *
 * 1. Parallel `--add-labels`: each process adds its own labels one call at a
 *    time. Every label from every process must survive.
 * 2. Guarded writers: both processes read version v and write a different
 *    title with `expectedUpdatedAt: v`. Exactly one commits; the other is
 *    refused with `E_CONFLICT` (exit code 23) carrying the winner's version,
 *    and the stored row is the winner's write.
 *
 * @task T12503
 * @epic T12497
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ExitCode } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { resetDbState } from '../../store/sqlite.js';
import { taskVersion } from '../../store/task-version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_PKG_ROOT = resolve(__dirname, '..', '..', '..');
const UPDATE_DIST = resolve(CORE_PKG_ROOT, 'dist', 'tasks', 'update.js');
const ACCESSOR_DIST = resolve(CORE_PKG_ROOT, 'dist', 'store', 'data-accessor.js');

/**
 * These tests exercise the COMPILED module. Without a build there is nothing
 * to spawn, so they are skipped with this reason rather than failing on a
 * missing file. CI builds before testing.
 */
const DIST_MISSING = ![UPDATE_DIST, ACCESSOR_DIST].every((p) => existsSync(p));
if (DIST_MISSING) {
  process.stderr.write(
    'update-concurrency-multiprocess: SKIPPED — packages/core/dist is not built ' +
      '(run `pnpm --filter @cleocode/core run build`).\n',
  );
}

/** Child preamble: signal readiness, then wait for the start barrier. */
const BARRIER = `
  const fs = require('node:fs');
  const path = require('node:path');
  fs.writeFileSync(path.join(process.env.READY_DIR, String(process.pid)), '');
  const waitForGo = () => new Promise((res) => {
    const tick = () => (fs.existsSync(process.env.GO_FILE) ? res() : setTimeout(tick, 2));
    tick();
  });
`;

/** Result of one child process. */
interface ChildOutcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Spawn one child per script, release them together once all are ready, and
 * collect their outcomes.
 */
async function runRacingChildren(
  scripts: readonly string[],
  env: NodeJS.ProcessEnv,
  workDir: string,
): Promise<ChildOutcome[]> {
  const readyDir = join(workDir, 'ready');
  const goFile = join(workDir, 'go');
  mkdirSync(readyDir, { recursive: true });

  const children: ChildProcess[] = [];
  const outcomes = scripts.map(
    (script) =>
      new Promise<ChildOutcome>((res) => {
        const child = spawn(process.execPath, ['-e', BARRIER + script], {
          // Run inside the scratch project so nothing can resolve the repo checkout.
          cwd: workDir,
          env: { ...env, READY_DIR: readyDir, GO_FILE: goFile },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        children.push(child);
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (d: Buffer) => {
          stdout += d.toString();
        });
        child.stderr?.on('data', (d: Buffer) => {
          stderr += d.toString();
        });
        child.on('close', (code) => res({ code, stdout, stderr }));
      }),
  );

  const deadline = Date.now() + 60_000;
  while (readdirSync(readyDir).length < scripts.length) {
    if (Date.now() > deadline) {
      for (const c of children) c.kill();
      throw new Error('children never became ready');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  writeFileSync(goFile, '');
  return Promise.all(outcomes);
}

/** The last JSON line a child printed to stdout. */
function lastJson(outcome: ChildOutcome): { ok: boolean; code?: number; details?: object } {
  const lines = outcome.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1] ?? '{}');
}

describe.skipIf(DIST_MISSING)('updateTask optimistic concurrency — real processes (T12503)', () => {
  let env: TestDbEnv;
  let childEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    env = await createTestDb();
    await seedTasks(env.accessor, [
      {
        id: 'T001',
        title: 'Target',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);
    childEnv = {
      ...process.env,
      CLEO_DIR: env.cleoDir,
      CLEO_HOME: join(env.tempDir, '.cleo-home'),
    };
  });

  afterEach(async () => {
    resetDbState();
    await env.cleanup();
  });

  /**
   * A child script that runs `body` (with `updateTask` in scope) after the
   * barrier. The store is opened BEFORE the barrier: opening costs ~100 ms
   * against ~1 ms per write, so without the warm-up one child would finish
   * most of its writes before the other started and nothing would race.
   */
  function childScript(body: string): string {
    return `
      (async () => {
        const { updateTask } = await import(${JSON.stringify(pathToFileURL(UPDATE_DIST).href)});
        const { getTaskAccessor } = await import(${JSON.stringify(pathToFileURL(ACCESSOR_DIST).href)});
        const projectRoot = ${JSON.stringify(env.tempDir)};
        await (await getTaskAccessor(projectRoot)).loadSingleTask('T001');
        await waitForGo();
        ${body}
      })().then(
        () => process.exit(0),
        (e) => { process.stderr.write(String((e && e.stack) || e)); process.exit(2); },
      );
    `;
  }

  it('parallel --add-labels from two processes loses nothing', async () => {
    const PER_PROCESS = 20;
    const scripts = ['a', 'b'].map((p) =>
      childScript(`
        for (let k = 0; k < ${PER_PROCESS}; k++) {
          await updateTask({ taskId: 'T001', addLabels: ['${p}-' + k] }, projectRoot);
        }
        process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
      `),
    );
    const outcomes = await runRacingChildren(scripts, childEnv, env.tempDir);
    for (const o of outcomes) {
      if (o.code !== 0) throw new Error(`child failed (${o.code}): ${o.stderr}`);
    }

    resetDbState();
    const { createSqliteDataAccessor } = await import('../../store/sqlite-data-accessor.js');
    const fresh = await createSqliteDataAccessor(env.tempDir);
    try {
      const task = await fresh.loadSingleTask('T001');
      const expected = ['a', 'b'].flatMap((p) =>
        Array.from({ length: PER_PROCESS }, (_, k) => `${p}-${k}`),
      );
      expect([...(task?.labels ?? [])].sort()).toEqual(expected.sort());
    } finally {
      await fresh.close();
    }
  }, 120_000);

  it('two processes guarded on the same version: one commits, the other gets E_CONFLICT', async () => {
    const v = taskVersion(await env.accessor.loadSingleTask('T001'));
    const scripts = ['a', 'b'].map((p) =>
      childScript(`
        try {
          await updateTask(
            { taskId: 'T001', title: 'from-${p}', expectedUpdatedAt: ${JSON.stringify(v)} },
            projectRoot,
          );
          process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
        } catch (e) {
          process.stdout.write(
            JSON.stringify({ ok: false, code: e.code, details: e.details }) + '\\n',
          );
        }
      `),
    );
    const outcomes = await runRacingChildren(scripts, childEnv, env.tempDir);
    for (const o of outcomes) {
      if (o.code !== 0) throw new Error(`child failed (${o.code}): ${o.stderr}`);
    }
    const results = outcomes.map(lastJson);
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]?.code).toBe(ExitCode.VERSION_CONFLICT);

    resetDbState();
    const { createSqliteDataAccessor } = await import('../../store/sqlite-data-accessor.js');
    const fresh = await createSqliteDataAccessor(env.tempDir);
    try {
      const stored = await fresh.loadSingleTask('T001');
      const winnerTitle = results[0]?.ok ? 'from-a' : 'from-b';
      expect(stored?.title).toBe(winnerTitle);
      expect(losers[0]?.details).toMatchObject({
        expected: v,
        currentVersion: taskVersion(stored),
        current: { title: winnerTitle },
      });
    } finally {
      await fresh.close();
    }
  }, 120_000);
});
