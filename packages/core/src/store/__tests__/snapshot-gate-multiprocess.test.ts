/**
 * Real multi-process tests for the T12508 snapshot gate.
 *
 * Vitest module mocks cannot prove a cross-process property, so these tests
 * spawn separate `node` processes that import the COMPILED modules from
 * `packages/core/dist/` (build first). Every child waits on a start barrier
 * (a file the parent creates once all children report ready) so the requests
 * genuinely race.
 *
 * 1. Lock: children request DIFFERENT prefixes, so neither the debounce nor
 *    coverage applies and only the lock can serialise them. Each child that
 *    runs a snapshot logs start/end times; no two intervals may overlap.
 *    `routine` losers report `in-flight`; `required` children all wait and run.
 * 2. Burst: children run the real `vacuumIntoBackupAll` against one real
 *    project `cleo.db` — once as per-write (`routine`) checkpoints and once as
 *    session ends (`required`). Each burst must admit exactly one `tasks`
 *    snapshot.
 *
 * @task T12508
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_PKG_ROOT = resolve(__dirname, '..', '..', '..');
const GATE_DIST = resolve(CORE_PKG_ROOT, 'dist', 'store', 'snapshot-gate.js');
const BACKUP_DIST = resolve(CORE_PKG_ROOT, 'dist', 'store', 'sqlite-backup.js');
const SQLITE_DIST = resolve(CORE_PKG_ROOT, 'dist', 'store', 'sqlite.js');

/** Number of racing processes per test. */
const N = 4;

/**
 * Shared child preamble: signal readiness, then wait for the start barrier.
 * `READY_DIR` and `GO_FILE` are injected by {@link runRacingChildren}.
 */
const BARRIER = `
  const fs = require('node:fs');
  const path = require('node:path');
  fs.writeFileSync(path.join(process.env.READY_DIR, String(process.pid)), '');
  const waitForGo = () => new Promise((res) => {
    const tick = () => (fs.existsSync(process.env.GO_FILE) ? res() : setTimeout(tick, 5));
    tick();
  });
`;

/** Gate outcome as serialised by a child (`SnapshotGateResult`). */
interface GateResult {
  readonly snapshotted: string[];
  readonly absent: string[];
  readonly failed: string[];
  readonly skipped: string | null;
}

/** Result of one child process. */
interface ChildOutcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Spawn `scripts.length` children, release them together once all are ready,
 * and collect their outcomes.
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

/**
 * These tests exercise the COMPILED modules. Without a build there is nothing
 * to spawn, so they are skipped with this reason rather than failing on a
 * missing file. CI builds before testing.
 */
const DIST_MISSING = ![GATE_DIST, BACKUP_DIST, SQLITE_DIST].every((p) => existsSync(p));
if (DIST_MISSING) {
  process.stderr.write(
    'snapshot-gate-multiprocess: SKIPPED — packages/core/dist is not built ' +
      '(run `pnpm --filter @cleocode/core run build`).\n',
  );
}

describe.skipIf(DIST_MISSING)('snapshot gate — real multi-process (T12508)', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'cleo-t12508-mp-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  /**
   * Race N children on DIFFERENT prefixes (no debounce or coverage applies)
   * and return their results plus the recorded snapshot intervals.
   */
  async function raceDistinctPrefixes(mode: 'routine' | 'required'): Promise<{
    results: Array<{ snapshotted: string[]; skipped: string | null }>;
    intervals: Array<{ start: number; end: number }>;
  }> {
    expect(existsSync(GATE_DIST)).toBe(true);
    const backupDir = join(workDir, 'backups');
    mkdirSync(backupDir, { recursive: true });
    const statePath = join(workDir, 'state.db');
    const seed = new DatabaseSync(statePath);
    seed.exec('CREATE TABLE tasks_schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    seed.close();
    const logPath = join(workDir, 'intervals.log');

    const scripts = Array.from(
      { length: N },
      (_, i) => `
      (async () => {
        const { DatabaseSync } = require('node:sqlite');
        const { runGatedSnapshot } = await import(${JSON.stringify(pathToFileURL(GATE_DIST).href)});
        const db = new DatabaseSync(${JSON.stringify(statePath)});
        db.exec('PRAGMA busy_timeout = 10000');
        await waitForGo();
        const r = await runGatedSnapshot(
          {
            backupDir: ${JSON.stringify(backupDir)},
            stateDb: db,
            prefixes: ['p${i}'],
            mode: ${JSON.stringify(mode)},
          },
          async () => {
            const start = Date.now();
            await new Promise((res) => setTimeout(res, 1000));
            fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ start, end: Date.now() }) + '\\n');
            return 'written';
          },
        );
        db.close();
        process.stdout.write(JSON.stringify(r));
      })().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(2); });
    `,
    );

    const outcomes = await runRacingChildren(scripts, process.env, workDir);
    for (const o of outcomes) {
      if (o.code !== 0) throw new Error(`child failed (${o.code}): ${o.stderr}`);
    }
    const intervals: Array<{ start: number; end: number }> = readFileSync(logPath, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .sort((a: { start: number }, b: { start: number }) => a.start - b.start);
    return { results: outcomes.map((o) => JSON.parse(o.stdout)), intervals };
  }

  /** Assert no two snapshot intervals overlap. */
  function expectNoOverlap(intervals: Array<{ start: number; end: number }>): void {
    for (let i = 1; i < intervals.length; i++) {
      const prev = intervals[i - 1];
      const cur = intervals[i];
      if (prev && cur) expect(cur.start).toBeGreaterThanOrEqual(prev.end);
    }
  }

  it('routine: at most one snapshot in flight across processes; losers skip as in-flight', async () => {
    const { results, intervals } = await raceDistinctPrefixes('routine');
    const ran = results.filter((r) => r.snapshotted.length > 0);
    const inFlight = results.filter((r) => r.skipped === 'in-flight');
    expect(ran.length).toBeGreaterThanOrEqual(1);
    // Every child was released at once and each snapshot takes 1 s, so the
    // losers of the race must have found the lock held.
    expect(inFlight.length).toBeGreaterThanOrEqual(1);
    expect(ran.length + inFlight.length).toBe(N);
    expect(intervals).toHaveLength(ran.length);
    expectNoOverlap(intervals);
  }, 120_000);

  it('required: every process waits for the lock and runs, one at a time', async () => {
    const { results, intervals } = await raceDistinctPrefixes('required');
    expect(results.every((r) => r.snapshotted.length === 1)).toBe(true);
    expect(intervals).toHaveLength(N);
    expectNoOverlap(intervals);
  }, 120_000);

  /**
   * Race N children calling the real `vacuumIntoBackupAll` on one real
   * project store. Returns each child's gate result and the tasks snapshots.
   */
  async function burstVacuumIntoBackupAll(
    mode: 'routine' | 'required',
  ): Promise<{ results: Array<GateResult | null>; tasksSnapshots: string[] }> {
    expect(existsSync(BACKUP_DIST)).toBe(true);
    const projectRoot = join(workDir, 'project');
    const cleoDir = join(projectRoot, '.cleo');
    const cleoHome = join(workDir, 'cleo-home');
    mkdirSync(cleoDir, { recursive: true });
    mkdirSync(cleoHome, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLEO_HOME: cleoHome,
      CLEO_DIR: cleoDir,
      XDG_DATA_HOME: cleoHome,
    };

    // Create and migrate the project store once, so the racing children
    // measure the gate and not concurrent first-time migration.
    const init = spawnSync(
      process.execPath,
      [
        '-e',
        `import(${JSON.stringify(pathToFileURL(SQLITE_DIST).href)})
           .then((m) => m.getDb(${JSON.stringify(projectRoot)}))
           .then(() => process.exit(0))
           .catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(2); });`,
      ],
      { env, encoding: 'utf-8', timeout: 60_000 },
    );
    if (init.status !== 0) throw new Error(`init failed (${init.status}): ${init.stderr}`);

    // Every session in the burst ended (its last write happened) before any
    // snapshot started: each request saw generation 0 (a fresh store), so the
    // first snapshot (generation 1) covers all of them.
    const seenGeneration = 0;
    const script = `
      (async () => {
        const mod = await import(${JSON.stringify(pathToFileURL(BACKUP_DIST).href)});
        await waitForGo();
        // A caller-supplied force flag must be ignored (T12508: no bypass).
        const opts = {
          cwd: ${JSON.stringify(projectRoot)},
          force: true,
          mode: ${JSON.stringify(mode)},
          seenGeneration: ${seenGeneration},
        };
        const r = await mod.vacuumIntoBackupAll(opts);
        process.stdout.write(JSON.stringify(r));
        process.exit(0);
      })().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(2); });
    `;
    const outcomes = await runRacingChildren(
      Array.from({ length: N }, () => script),
      env,
      workDir,
    );
    for (const o of outcomes) {
      if (o.code !== 0) throw new Error(`child failed (${o.code}): ${o.stderr}`);
    }
    const tasksSnapshots = readdirSync(join(cleoDir, 'backups', 'sqlite')).filter((f) =>
      /^tasks-\d{8}-\d{6}\.db$/.test(f),
    );
    return { results: outcomes.map((o) => JSON.parse(o.stdout)), tasksSnapshots };
  }

  // Count admissions, not files: snapshots taken in the same second share a
  // filename, so a file count alone cannot tell one snapshot from four.

  it('a burst of per-write (routine) checkpoints across processes produces one snapshot', async () => {
    const { results, tasksSnapshots } = await burstVacuumIntoBackupAll('routine');
    const admitted = results.filter((r) => r?.snapshotted.includes('tasks'));
    expect(admitted).toHaveLength(1);
    for (const r of results) {
      if (!r?.snapshotted.includes('tasks')) {
        // Deterministic since NEW-2: absent databases (llmtxt,
        // signaldock-project) are recorded as satisfied, so a late caller is
        // debounced instead of taking the lock for them.
        expect(['in-flight', 'debounced']).toContain(r?.skipped);
      }
      expect(r?.failed).toEqual([]);
    }
    expect(tasksSnapshots).toHaveLength(1);
  }, 180_000);

  it('a burst of session ends (required) across processes produces one snapshot', async () => {
    const { results, tasksSnapshots } = await burstVacuumIntoBackupAll('required');
    const admitted = results.filter((r) => r?.snapshotted.includes('tasks'));
    expect(admitted).toHaveLength(1);
    // Every other session end waited for the lock and found tasks covered by
    // the snapshot that started after its request — neither re-run nor lost.
    for (const r of results) {
      if (r?.snapshotted.includes('tasks')) continue;
      expect(r?.skipped).toBe('covered');
    }
    expect(tasksSnapshots).toHaveLength(1);
  }, 180_000);
});
