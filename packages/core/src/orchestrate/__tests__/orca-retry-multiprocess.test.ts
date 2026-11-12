/**
 * Orca retry fencing across REAL processes (T14494).
 *
 * `orca-worker-custody.test.ts` races two retries as promises in one process,
 * where one SQLite connection and one event loop order every write. This suite
 * runs two separate `node` processes, each with its own connection to one
 * temporary CLEO store, retrying the same failed Dispatch, released together
 * from a barrier file. Each child injects an Orca runner that answers from
 * recorded fixture replies and appends every `worker-start` to a shared launch
 * log, so no real Orca worker is ever started.
 *
 * Exactly one retry may reserve the successor and launch; the other must be
 * refused by a custody fence before it reaches Orca:
 * - free race: the two observations collide, and the observation CAS in
 *   `updateWorkerExecution` refuses the later writer;
 * - staged race: both processes finish their observation first (the second
 *   observing after the first), then enter the reservation together, so the
 *   predecessor check in `recordWorker`'s transaction (exact execution, then
 *   the `metadataJson` + `stoppedAt` CAS) decides between two live processes.
 *
 * The children import the COMPILED modules from `packages/core/dist/` and
 * `packages/adapters/dist/` (build first); without a build the suite is skipped
 * with a reason, as in `task-claims-multiprocess.test.ts`.
 *
 * @task T14494
 * @epic T14451
 */

import { type ChildProcess, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OrcaExecutionBackend } from '@cleocode/adapters/orca-execution';
import type { OrcaCommandResult, OrcaLaunch } from '@cleocode/contracts/orca-execution.js';
import {
  computeProjectHash,
  readDeclaredProjectIdentity,
  resolveTaskWorktreePath,
} from '@cleocode/paths';
import { acquireWorktreeTaskLock } from '@cleocode/worktree';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fixtureContext,
  fixtureLaunch,
  fixtureReleasedShow,
  fixtureRunner,
  fixtureShow,
  fixtureStart,
  orcaFixture,
  runOrcaFixture,
} from '../../../../adapters/src/__tests__/orca-execution-fixture.js';
import { requireSpawnSession } from '../../spawn/agent-identity.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { resetDbState } from '../../store/sqlite.js';
import { launchOrcaWorker } from '../orca-execution.js';
import { listWorkerRecords, type WorkerRecord } from '../worker-records.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGES_ROOT = resolve(__dirname, '..', '..', '..', '..');
const ORCA_EXECUTION_DIST = join(PACKAGES_ROOT, 'core', 'dist', 'orchestrate', 'orca-execution.js');
const ORCA_BACKEND_DIST = join(PACKAGES_ROOT, 'adapters', 'dist', 'orca-execution.js');

const DIST_MISSING = ![ORCA_EXECUTION_DIST, ORCA_BACKEND_DIST].every((p) => existsSync(p));
if (DIST_MISSING) {
  process.stderr.write(
    'orca-retry-multiprocess: SKIPPED — packages/core/dist or packages/adapters/dist is not built ' +
      '(run `pnpm --filter @cleocode/adapters... run build`).\n',
  );
}

/** Bound on each child's lifetime. */
const CHILD_TIMEOUT_MS = 45_000;

/** Bound on every barrier wait; below the lifetime so a stuck child reports its barrier. */
const BARRIER_TIMEOUT_MS = 20_000;

/**
 * Every refusal a losing retry may receive in a free race. Each is a
 * fail-closed custody fence raised before `worker-start`, never a raw SQLite or
 * runner error.
 */
const FENCE_REFUSAL =
  /^(Worker execution changed; reload the exact record before recovery\.|Worker execution reservation lost; no new operation is authorized\.|Orca predecessor changed; reload its exact worker record before retry\.|Orca retry reservation lost; no new launch is authorized\.|No open Orca worker record matches that id\.)$/;

/** The reservation fence in `recordWorker`: the predecessor moved under this retry. */
const RESERVATION_REFUSAL =
  'Orca predecessor changed; reload its exact worker record before retry.';

/** One child's exit and output. */
interface ChildOutcome {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The result a child prints after its retry. */
interface RetryResult {
  readonly ok: boolean;
  readonly pid: number;
  readonly role: string;
  readonly recordId?: string;
  readonly dispatchId?: string | null;
  readonly message?: string;
}

/** One `worker-start` the injected runner received. */
interface LaunchEntry {
  readonly pid: number;
  readonly args: readonly string[];
}

/**
 * Child program: load the compiled retry path, warm the store connection,
 * signal readiness, wait for the start barrier, then retry with an injected
 * runner that answers from recorded replies and logs every launch.
 *
 * With `ROLE` set (staged race), the observations are ordered: the `second`
 * child starts its retry only once the `first` child finished observing, and
 * each child, on its first post-observation command (preflight), marks itself
 * observed and waits until both are, so both enter the reservation together
 * holding different observations.
 */
const CHILD = `
  const fs = require('node:fs');
  const path = require('node:path');
  const { pathToFileURL } = require('node:url');
  const env = process.env;
  const responses = JSON.parse(fs.readFileSync(env.ORCA_RESPONSES, 'utf8'));
  const limit = Number(env.BARRIER_TIMEOUT_MS);
  const waitFor = (files) => new Promise((res, rej) => {
    const deadline = Date.now() + limit;
    const tick = () => {
      if (files.every((f) => fs.existsSync(f))) return res();
      if (Date.now() > deadline) return rej(new Error('barrier timeout: ' + files.join(', ')));
      setTimeout(tick, 2);
    };
    tick();
  });
  const marker = (role) => path.join(env.STAGE_DIR, role + '-observed');
  let observed = false;
  const runner = async (_executable, args) => {
    const key = ['account', 'terminal', 'agent-context', 'status', 'worktree'].includes(args[0])
      ? args[0]
      : args[1];
    if (env.ROLE && !observed && key !== 'worker-show') {
      observed = true;
      fs.writeFileSync(marker(env.ROLE), '');
      await waitFor([marker('first'), marker('second')]);
    }
    if (key === 'worker-start') {
      fs.appendFileSync(env.LAUNCH_LOG, JSON.stringify({ pid: process.pid, args }) + '\\n');
    }
    const reply = responses[key];
    if (!reply) throw new Error('Unexpected fixture command: ' + args.join(' '));
    return reply;
  };
  (async () => {
    const { retryOrcaWorker } = await import(pathToFileURL(env.ORCA_EXECUTION_DIST).href);
    const { OrcaExecutionBackend } = await import(pathToFileURL(env.ORCA_BACKEND_DIST).href);
    const { listWorkerRecords } = await import(
      pathToFileURL(path.join(path.dirname(env.ORCA_EXECUTION_DIST), 'worker-records.js')).href
    );
    await listWorkerRecords(env.PROJECT_ROOT);
    fs.writeFileSync(path.join(env.READY_DIR, String(process.pid)), '');
    await waitFor([env.GO_FILE]);
    const role = env.ROLE || 'free';
    if (role === 'second') await waitFor([marker('first')]);
    try {
      const record = await retryOrcaWorker(
        env.RECORD_ID,
        env.PROJECT_ROOT,
        new OrcaExecutionBackend(runner),
      );
      process.stdout.write(JSON.stringify({
        ok: true,
        pid: process.pid,
        role,
        recordId: record.recordId,
        dispatchId: record.execution ? record.execution.dispatchId : null,
      }) + '\\n');
    } catch (e) {
      process.stdout.write(JSON.stringify({
        ok: false,
        pid: process.pid,
        role,
        message: String((e && e.message) || e),
      }) + '\\n');
    }
  })().then(
    () => process.exit(0),
    (e) => { process.stderr.write(String((e && e.stack) || e)); process.exit(2); },
  );
`;

/** Spawn one child per env, release them together once all are ready, collect outcomes. */
async function raceChildren(
  childEnvs: readonly NodeJS.ProcessEnv[],
  workDir: string,
): Promise<ChildOutcome[]> {
  const readyDir = join(workDir, 'ready');
  const goFile = join(workDir, 'go');
  mkdirSync(readyDir, { recursive: true });
  const procs: ChildProcess[] = [];
  const outcomes = childEnvs.map(
    (env) =>
      new Promise<ChildOutcome>((res) => {
        const child = spawn(process.execPath, ['-e', CHILD], {
          cwd: workDir,
          env: {
            ...env,
            READY_DIR: readyDir,
            GO_FILE: goFile,
            BARRIER_TIMEOUT_MS: String(BARRIER_TIMEOUT_MS),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: CHILD_TIMEOUT_MS,
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
        child.on('close', (code, signal) => res({ code, signal, stdout, stderr }));
      }),
  );
  const deadline = Date.now() + CHILD_TIMEOUT_MS;
  while (readdirSync(readyDir).length < childEnvs.length) {
    if (Date.now() > deadline) {
      for (const c of procs) c.kill();
      throw new Error('children never became ready');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  writeFileSync(goFile, '');
  const settled = await Promise.all(outcomes);
  for (const o of settled) {
    if (o.code !== 0) {
      throw new Error(`child failed (code ${o.code}, signal ${o.signal}): ${o.stderr}`);
    }
  }
  return settled;
}

/** The last JSON line a child printed. */
function lastJson(outcome: ChildOutcome): RetryResult {
  const lines = outcome.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1] ?? '{}') as RetryResult;
}

/** Replies the injected child runner serves, keyed as the child dispatches them. */
async function recordedReplies(): Promise<Record<string, OrcaCommandResult>> {
  const argvByKey: Record<string, readonly string[]> = {
    account: ['account'],
    terminal: ['terminal'],
    'agent-context': ['agent-context'],
    status: ['status'],
    worktree: ['worktree'],
    'run-current': ['orchestration', 'run-current'],
    'worker-show': ['orchestration', 'worker-show'],
    'worker-start': ['orchestration', 'worker-start'],
  };
  const replies: Record<string, OrcaCommandResult> = {};
  for (const [key, argv] of Object.entries(argvByKey)) {
    replies[key] = await runOrcaFixture('orca', argv, '.');
  }
  return replies;
}

describe.skipIf(DIST_MISSING)('Orca retry reservation — real processes (T14494)', () => {
  let env: TestDbEnv;
  let launch: OrcaLaunch;

  beforeEach(async () => {
    vi.stubEnv('CLEO_ROOT', undefined);
    vi.stubEnv('CLEO_DIR', undefined);
    vi.stubEnv('CLEO_AGENT_ID', 'fixture-coordinator');
    env = await createTestDb();
    vi.stubEnv('CLEO_HOME', realpathSync(join(env.tempDir, '.cleo-home')));
    await seedTasks(env.accessor, [
      { id: 'T001', title: 'Canonical Orca assignment', status: 'pending', priority: 'medium' },
    ]);
    const session = await requireSpawnSession(env.tempDir, 'T001');
    if (!session.ok) throw new Error(session.message);
    const projectHash = computeProjectHash(env.tempDir);
    const worktreePath = resolveTaskWorktreePath(projectHash, 'T001');
    mkdirSync(worktreePath, { recursive: true });
    const lock = acquireWorktreeTaskLock({
      projectHash,
      taskId: 'T001',
      holder: { sessionId: session.identity.sessionId, agentId: session.identity.agentId },
    });
    launch = {
      ...fixtureLaunch,
      projectId: readDeclaredProjectIdentity(env.tempDir)?.projectId ?? 'missing-project',
      projectRoot: env.tempDir,
      projectHash,
      worktreePath,
      workerSessionId: session.identity.sessionId,
      agentId: session.identity.agentId,
      lockToken: lock.record.token,
    };
    orcaFixture.launch = launch;
    orcaFixture.show = fixtureShow();
    orcaFixture.helperShows = {};
    orcaFixture.capabilities = [
      'orchestration.contract.v1',
      'orchestration.worker-stop-helpers.v1',
    ];
    fixtureRunner.mockReset().mockImplementation(runOrcaFixture);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetDbState();
    await env.cleanup();
  });

  /**
   * Launch a failed, resource-released predecessor and stage the race inputs.
   * @param name - Race directory name under the temporary project.
   */
  async function prepareRace(name: string): Promise<{
    predecessor: WorkerRecord;
    childEnv: NodeJS.ProcessEnv;
    workDir: string;
    launchLog: string;
  }> {
    orcaFixture.start = fixtureStart('failed', 1);
    const predecessor = await launchOrcaWorker(
      launch,
      fixtureContext,
      new OrcaExecutionBackend(fixtureRunner),
    );
    expect(predecessor.execution).toMatchObject({ state: 'failed', dispatchId: 'ctx_fixture' });
    orcaFixture.show = fixtureReleasedShow();
    orcaFixture.start = fixtureStart('ready', 1, 'ctx_retry');
    const workDir = join(env.tempDir, name);
    const stageDir = join(workDir, 'stage');
    mkdirSync(stageDir, { recursive: true });
    const responsesFile = join(workDir, 'responses.json');
    const launchLog = join(workDir, 'launches.jsonl');
    writeFileSync(responsesFile, JSON.stringify(await recordedReplies()));
    writeFileSync(launchLog, '');
    return {
      predecessor,
      workDir,
      launchLog,
      childEnv: {
        ...process.env,
        PROJECT_ROOT: env.tempDir,
        RECORD_ID: predecessor.recordId,
        ORCA_RESPONSES: responsesFile,
        LAUNCH_LOG: launchLog,
        STAGE_DIR: stageDir,
        ORCA_EXECUTION_DIST,
        ORCA_BACKEND_DIST,
      },
    };
  }

  /** Assert one winner, one launch from the winner's process, and one open successor. */
  async function expectSingleReservation(
    results: readonly RetryResult[],
    launchLog: string,
    predecessor: WorkerRecord,
  ): Promise<{ winner: RetryResult; loser: RetryResult }> {
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const winner = winners[0] as RetryResult;
    const loser = losers[0] as RetryResult;
    expect(winner.dispatchId).toBe('ctx_retry');

    const launches = readFileSync(launchLog, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LaunchEntry);
    expect(launches).toHaveLength(1);
    expect(launches[0]?.pid).toBe(winner.pid);
    expect(launches[0]?.args).toContain('--retry-of');
    expect(launches[0]?.args).toContain('ctx_fixture');

    resetDbState();
    const records = await listWorkerRecords(env.tempDir);
    expect(records).toHaveLength(2);
    const open = records.filter((record) => record.stoppedAt === null);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      recordId: winner.recordId,
      execution: { state: 'ready', dispatchId: 'ctx_retry', retryOf: 'ctx_fixture' },
    });
    const previous = records.find((record) => record.recordId === predecessor.recordId);
    expect(previous?.stoppedAt).not.toBeNull();
    expect(previous?.execution).toMatchObject({ dispatchId: 'ctx_fixture', state: 'failed' });
    return { winner, loser };
  }

  it.each([
    1, 2, 3,
  ])('free race %i: two processes retry one Dispatch at once; exactly one reserves and launches', async (round) => {
    const { predecessor, childEnv, workDir, launchLog } = await prepareRace(`free-${round}`);
    const outcomes = await raceChildren([childEnv, childEnv], workDir);
    const { loser } = await expectSingleReservation(outcomes.map(lastJson), launchLog, predecessor);
    expect(loser.message).toMatch(FENCE_REFUSAL);
  }, 90_000);

  it('staged race: both processes observe, then reserve together; the stale reservation is refused', async () => {
    const { predecessor, childEnv, workDir, launchLog } = await prepareRace('staged');
    const outcomes = await raceChildren(
      [
        { ...childEnv, ROLE: 'first' },
        { ...childEnv, ROLE: 'second' },
      ],
      workDir,
    );
    const { winner, loser } = await expectSingleReservation(
      outcomes.map(lastJson),
      launchLog,
      predecessor,
    );
    // The second observation superseded the first, so only the second process
    // holds the predecessor's exact stored execution when both reserve.
    expect(winner.role).toBe('second');
    expect(loser.role).toBe('first');
    expect(loser.message).toBe(RESERVATION_REFUSAL);
  }, 90_000);
});
