/**
 * Real multi-process tests for the T12508 snapshot gate.
 *
 * Vitest module mocks cannot prove a cross-process property, so these tests
 * spawn separate `node` processes that import the COMPILED modules from
 * `packages/core/dist/` (build first). Every child waits on a start barrier
 * (a file the parent creates once all children report ready) so the requests
 * genuinely race.
 *
 * 1. Lock: children request DIFFERENT prefixes, so the per-prefix debounce
 *    never applies and only the lock can serialise them. Each child that runs
 *    a snapshot logs start/end times; no two intervals may overlap, and the
 *    children that lose the race report `in-flight`.
 * 2. Debounce: children run the real `vacuumIntoBackupAll` against one real
 *    project `cleo.db`. The burst must produce exactly one `tasks-*.db`.
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

describe('snapshot gate — real multi-process (T12508)', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'cleo-t12508-mp-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('at most one snapshot is in flight per project across processes', async () => {
    expect(existsSync(GATE_DIST)).toBe(true);
    const backupDir = join(workDir, 'backups');
    mkdirSync(backupDir, { recursive: true });
    const statePath = join(workDir, 'state.db');
    const seed = new DatabaseSync(statePath);
    seed.exec('CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
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
          { backupDir: ${JSON.stringify(backupDir)}, stateDb: db, prefixes: ['p${i}'] },
          async () => {
            const start = Date.now();
            await new Promise((res) => setTimeout(res, 1500));
            fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ start, end: Date.now() }) + '\\n');
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

    const results: Array<{ snapshotted: string[]; skipped: string | null }> = outcomes.map((o) =>
      JSON.parse(o.stdout),
    );
    const ran = results.filter((r) => r.snapshotted.length > 0);
    const inFlight = results.filter((r) => r.skipped === 'in-flight');
    expect(ran.length).toBeGreaterThanOrEqual(1);
    // Every child was released at once and each snapshot takes 1.5 s, so the
    // losers of the race must have found the lock held.
    expect(inFlight.length).toBeGreaterThanOrEqual(1);
    expect(ran.length + inFlight.length).toBe(N);

    const intervals: Array<{ start: number; end: number }> = readFileSync(logPath, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .sort((a: { start: number }, b: { start: number }) => a.start - b.start);
    expect(intervals).toHaveLength(ran.length);
    for (let i = 1; i < intervals.length; i++) {
      const prev = intervals[i - 1];
      const cur = intervals[i];
      if (prev && cur) expect(cur.start).toBeGreaterThanOrEqual(prev.end);
    }
  }, 120_000);

  it('a burst of session-end snapshots across processes produces one snapshot', async () => {
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

    const script = `
      (async () => {
        const mod = await import(${JSON.stringify(pathToFileURL(BACKUP_DIST).href)});
        await waitForGo();
        // A caller-supplied force flag must be ignored (T12508: no bypass).
        const opts = { cwd: ${JSON.stringify(projectRoot)}, force: true };
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

    // Count admissions, not files: snapshots taken in the same second share a
    // filename, so a file count alone cannot tell one snapshot from four.
    const results: Array<{ snapshotted: string[]; skipped: string | null } | null> = outcomes.map(
      (o) => JSON.parse(o.stdout),
    );
    const admitted = results.filter((r) => r?.snapshotted.includes('tasks'));
    expect(admitted).toHaveLength(1);
    for (const r of results) {
      if (!r?.snapshotted.includes('tasks')) {
        expect(['in-flight', 'debounced']).toContain(r?.skipped);
      }
    }

    const tasksSnapshots = readdirSync(join(cleoDir, 'backups', 'sqlite')).filter((f) =>
      /^tasks-\d{8}-\d{6}\.db$/.test(f),
    );
    expect(tasksSnapshots).toHaveLength(1);
  }, 180_000);
});
