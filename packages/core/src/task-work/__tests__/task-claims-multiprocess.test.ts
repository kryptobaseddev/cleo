/**
 * Leased claims across REAL processes (T12502 AC1).
 *
 * Two separate `node` processes, each bound to its own session through
 * `CLEO_SESSION_ID` and each with its own SQLite connection, run `startTask`
 * on the same task at the same instant (released together from a start
 * barrier). The claim is a compare-and-set inside the start's write
 * transaction, so exactly one start wins; the other is refused with
 * `E_TASK_CLAIMED` (exit code 35) naming the winner's session, and the stored
 * lease is the winner's. A read-then-write claim would let both succeed.
 *
 * The children import the COMPILED modules from `packages/core/dist/` (build
 * first); without a build the suite is skipped with a reason.
 *
 * @task T12502
 * @epic T12497
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ExitCode, type Session } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { resetDbState } from '../../store/sqlite.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_PKG_ROOT = resolve(__dirname, '..', '..', '..');
const TASK_WORK_DIST = resolve(CORE_PKG_ROOT, 'dist', 'task-work', 'index.js');
const ACCESSOR_DIST = resolve(CORE_PKG_ROOT, 'dist', 'store', 'data-accessor.js');

const DIST_MISSING = ![TASK_WORK_DIST, ACCESSOR_DIST].every((p) => existsSync(p));
if (DIST_MISSING) {
  process.stderr.write(
    'task-claims-multiprocess: SKIPPED — packages/core/dist is not built ' +
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

/** Spawn one child per (script, env), release them together, collect outcomes. */
async function runRacingChildren(
  children: ReadonlyArray<{ script: string; env: NodeJS.ProcessEnv }>,
  workDir: string,
): Promise<ChildOutcome[]> {
  const readyDir = join(workDir, 'ready');
  const goFile = join(workDir, 'go');
  mkdirSync(readyDir, { recursive: true });
  const procs: ChildProcess[] = [];
  const outcomes = children.map(
    ({ script, env }) =>
      new Promise<ChildOutcome>((res) => {
        const child = spawn(process.execPath, ['-e', BARRIER + script], {
          cwd: workDir,
          env: { ...env, READY_DIR: readyDir, GO_FILE: goFile },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        procs.push(child);
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
  while (readdirSync(readyDir).length < children.length) {
    if (Date.now() > deadline) {
      for (const c of procs) c.kill();
      throw new Error('children never became ready');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  writeFileSync(goFile, '');
  return Promise.all(outcomes);
}

/** The last JSON line a child printed. */
function lastJson(outcome: ChildOutcome): {
  ok: boolean;
  session?: string;
  code?: number;
  details?: { holder?: { sessionId?: string } };
} {
  const lines = outcome.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1] ?? '{}');
}

function session(id: string): Session {
  return {
    id,
    name: `session-${id}`,
    status: 'active',
    scope: { type: 'global' },
    taskWork: { taskId: null, setAt: null },
    startedAt: new Date().toISOString(),
  };
}

describe.skipIf(DIST_MISSING)('startTask claim CAS — real processes (T12502)', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    env = await createTestDb();
    await seedTasks(env.accessor, [
      { id: 'T001', title: 'Target', status: 'pending', priority: 'medium' },
    ]);
  });

  afterEach(async () => {
    resetDbState();
    await env.cleanup();
  });

  it('two sessions start the same task at once: exactly one wins, the other gets E_TASK_CLAIMED', async () => {
    const ROUNDS = 5;
    for (let round = 0; round < ROUNDS; round++) {
      const sessions = ['a', 'b'].map((p) => `ses_2026092900000${round}_${p.repeat(6)}`);
      for (const id of sessions) await env.accessor.upsertSingleSession(session(id));

      const children = sessions.map((sessionId) => ({
        env: {
          ...process.env,
          CLEO_DIR: env.cleoDir,
          CLEO_HOME: join(env.tempDir, '.cleo-home'),
          CLEO_SESSION_ID: sessionId,
          CLEO_AGENT_ID: '',
        },
        script: `
          (async () => {
            const { startTask } = await import(${JSON.stringify(pathToFileURL(TASK_WORK_DIST).href)});
            const { getTaskAccessor } = await import(${JSON.stringify(pathToFileURL(ACCESSOR_DIST).href)});
            const projectRoot = ${JSON.stringify(env.tempDir)};
            await (await getTaskAccessor(projectRoot)).loadSingleTask('T001');
            await waitForGo();
            try {
              await startTask('T001', projectRoot);
              process.stdout.write(JSON.stringify({ ok: true, session: process.env.CLEO_SESSION_ID }) + '\\n');
            } catch (e) {
              process.stdout.write(JSON.stringify({ ok: false, code: e.code, details: e.details }) + '\\n');
            }
          })().then(
            () => process.exit(0),
            (e) => { process.stderr.write(String((e && e.stack) || e)); process.exit(2); },
          );
        `,
      }));

      const outcomes = await runRacingChildren(children, join(env.tempDir, `round-${round}`));
      for (const o of outcomes) {
        if (o.code !== 0) throw new Error(`child failed (${o.code}): ${o.stderr}`);
      }
      const results = outcomes.map(lastJson);
      const winners = results.filter((r) => r.ok);
      const losers = results.filter((r) => !r.ok);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]?.code).toBe(ExitCode.TASK_CLAIMED);
      expect(losers[0]?.details?.holder?.sessionId).toBe(winners[0]?.session);

      resetDbState();
      const { createSqliteDataAccessor } = await import('../../store/sqlite-data-accessor.js');
      const fresh = await createSqliteDataAccessor(env.tempDir);
      try {
        const stored = await fresh.loadSingleTask('T001');
        expect(stored?.claim?.sessionId).toBe(winners[0]?.session);
        // Free the task for the next round.
        await fresh.unclaimTask('T001', { sessionId: null, force: true });
      } finally {
        await fresh.close();
      }
      resetDbState();
      const { getTaskAccessor } = await import('../../store/data-accessor.js');
      env.accessor = await getTaskAccessor(env.tempDir);
    }
  }, 240_000);
});
