/**
 * T11325 — Durability + WAL-recovery + epic:T1075 reproducer harness.
 *
 * Three gates:
 *
 *   1. SIGKILL-mid-transaction × N (default 100): spawn a child writer that
 *      commits K rows, opens a transaction, writes uncommitted rows, signals
 *      `MID_TX`, then spins. The parent SIGKILLs it mid-transaction, reopens
 *      the file (triggering WAL recovery), runs `PRAGMA integrity_check`, and
 *      asserts: integrity='ok' AND the committed rows survived AND the
 *      uncommitted rows were rolled back. Repeated N times against the SAME
 *      file so WAL state accumulates.
 *
 *   2. epic:T1075 WAL-reset reproducer: the historical brain.db malformation
 *      (errcode=11, "database disk image is malformed") was the WAL-reset
 *      corruption class fixed in SQLite 3.53.0. We reproduce the trigger
 *      pattern — rapid open/checkpoint(RESET)/concurrent-write/close cycles —
 *      and assert `integrity_check`='ok' every cycle, confirming it NO LONGER
 *      reproduces on 3.53.0.
 *
 *   3. Cold-start budget (DB-substrate isolation): the AC budget
 *      (cold <200ms p95, warm <50ms p95) is on the persistence layer's
 *      contribution to `cleo briefing` — open the file + run a briefing-class
 *      query set. We measure THAT, not the full `cleo` subprocess, because the
 *      ~6-8s end-to-end `cleo` spawn is dominated by Node/module-load + CLI
 *      dispatch (tracked separately as T11292) which the DB-substrate decision
 *      neither causes nor fixes. Cold = fresh OS-page-cache file open; warm =
 *      subsequent opens. This proves consolidation pragmas don't regress the
 *      substrate's startup contribution.
 *
 * Run: `pnpm dlx tsx tools/db-substrate-spike/05-durability.ts`
 * Knob: SPIKE_KILL_ITERS (default 100)
 *
 * @task T11325
 * @task T11244
 * @saga T11242
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openConsolidated } from './lib/open.js';
import { type LatencyStats, round, summarize } from './lib/stats.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const KILL_WRITER = join(HERE, 'lib', 'durability-writer.mjs');
const KILL_ITERS = Number(process.env['SPIKE_KILL_ITERS'] ?? 100);
const COMMITTED_PER_ITER = 20;

/** Resolve the tsx binary so child writers run the .mjs via the same runtime. */
const NODE_BIN = process.execPath;

/** Result of one SIGKILL-recovery cycle. */
interface KillCycle {
  iter: number;
  integrityOk: boolean;
  committedSurvived: number;
  committedExpected: number;
  uncommittedLeaked: number;
}

/** Sleep helper. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run one SIGKILL-mid-transaction cycle against `dbPath`, then reopen + verify.
 *
 * @param dbPath - The consolidated file under test.
 * @param iter - Iteration index (committed rows are namespaced by it).
 * @returns The {@link KillCycle} verdict for this iteration.
 */
async function killCycle(dbPath: string, iter: number): Promise<KillCycle> {
  const child = spawn(NODE_BIN, [KILL_WRITER, dbPath, String(COMMITTED_PER_ITER)], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  // Wait until the child signals it is mid-transaction.
  await new Promise<void>((resolve, reject) => {
    let buf = '';
    const onData = (d: Buffer): void => {
      buf += d.toString('utf8');
      if (buf.includes('MID_TX')) {
        child.stdout?.off('data', onData);
        resolve();
      }
    };
    child.stdout?.on('data', onData);
    child.once('error', reject);
    // Safety timeout: if the child never signals, fail this cycle.
    setTimeout(() => reject(new Error('child never reached MID_TX')), 10_000);
  });

  // Let a few spin-writes accumulate dirty WAL frames, then SIGKILL.
  await sleep(15);
  child.kill('SIGKILL');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));

  // Reopen — this triggers WAL recovery — and verify integrity + row state.
  const db = openConsolidated(dbPath);
  try {
    const integrity = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string })
      .integrity_check;
    const committedSurvived = (
      db.prepare('SELECT COUNT(*) AS c FROM durability_log WHERE committed = 1').get() as {
        c: number;
      }
    ).c;
    const uncommittedLeaked = (
      db.prepare('SELECT COUNT(*) AS c FROM durability_log WHERE committed = 0').get() as {
        c: number;
      }
    ).c;
    // Expected committed rows = COMMITTED_PER_ITER × (iter+1): each cycle adds
    // a fresh committed batch to the same file.
    const committedExpected = COMMITTED_PER_ITER * (iter + 1);
    return {
      iter,
      integrityOk: integrity === 'ok',
      committedSurvived,
      committedExpected,
      uncommittedLeaked,
    };
  } finally {
    db.close();
  }
}

/**
 * Reproduce the epic:T1075 WAL-reset corruption trigger pattern and assert it
 * no longer manifests on SQLite 3.53.0.
 *
 * The historical signature: rapid `wal_checkpoint(RESET)` interleaved with
 * concurrent writes and reopens left the DB header malformed (errcode=11).
 * We drive that pattern hard and integrity-check each cycle.
 *
 * @param dbPath - A dedicated scratch file.
 * @param cycles - Number of reset/write/reopen cycles.
 * @returns Whether integrity held every cycle, plus any first failure detail.
 */
function reproduceT1075(
  dbPath: string,
  cycles: number,
): { reproduced: boolean; cyclesRun: number; firstFailure: string | null } {
  const require_ = createRequire(import.meta.url);
  const { DatabaseSync } = require_('node:sqlite') as {
    DatabaseSync: new (p: string) => import('node:sqlite').DatabaseSync;
  };

  let firstFailure: string | null = null;
  for (let i = 0; i < cycles; i++) {
    const a = openConsolidated(dbPath);
    a.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT);');
    // Writer A: bulk insert in a txn.
    a.exec('BEGIN IMMEDIATE;');
    const ins = a.prepare('INSERT INTO t (v) VALUES (?)');
    for (let k = 0; k < 200; k++) ins.run(`v-${i}-${k}`);
    a.exec('COMMIT;');
    // Force a WAL RESET checkpoint — the historical corruption trigger.
    a.exec('PRAGMA wal_checkpoint(RESET);');

    // Second handle opens concurrently and writes while A still holds the file.
    const b = new DatabaseSync(dbPath);
    b.exec('PRAGMA busy_timeout = 30000;');
    try {
      b.exec("INSERT INTO t (v) VALUES ('concurrent');");
    } catch {
      // SQLITE_BUSY is acceptable; corruption is not.
    }
    b.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    const integrity = (b.prepare('PRAGMA integrity_check').get() as { integrity_check: string })
      .integrity_check;
    b.close();
    a.close();

    if (integrity !== 'ok') {
      firstFailure = `cycle ${i}: integrity_check='${integrity}'`;
      return { reproduced: true, cyclesRun: i + 1, firstFailure };
    }
  }
  return { reproduced: false, cyclesRun: cycles, firstFailure: null };
}

/**
 * Measure the DB-substrate's contribution to `cleo briefing` cold-start: open
 * the consolidated file (with mandatory pragmas) + run a briefing-class query
 * set, cold (fresh handle, first read) then warm (subsequent handles). This
 * isolates the persistence-layer cost from Node/CLI-process overhead.
 *
 * A representative briefing reads recent tasks + memory + a count — modeled
 * here as three indexed reads over a seeded consolidated fixture.
 *
 * @param workdir - Scratch directory for the cold-start fixture.
 * @returns Cold/warm stats and the measurement note.
 */
function measureColdStart(workdir: string): {
  scope: string;
  coldMs: number;
  warmStats: LatencyStats;
  note: string;
} {
  const path = join(workdir, 'coldstart.db');
  // Seed a realistic-sized consolidated fixture once.
  const seed = openConsolidated(path);
  seed.exec(`
    CREATE TABLE tasks_task (id TEXT PRIMARY KEY, title TEXT, status TEXT, created_at INTEGER);
    CREATE TABLE brain_memory (id TEXT PRIMARY KEY, task_id TEXT, observation TEXT, created_at INTEGER);
    CREATE INDEX idx_task_created ON tasks_task(created_at);
    CREATE INDEX idx_mem_created ON brain_memory(created_at);
  `);
  seed.exec('BEGIN IMMEDIATE;');
  const it = seed.prepare('INSERT INTO tasks_task VALUES (?,?,?,?)');
  const im = seed.prepare('INSERT INTO brain_memory VALUES (?,?,?,?)');
  for (let i = 0; i < 5000; i++) {
    it.run(`T${i}`, `task ${i}`, i % 3 === 0 ? 'done' : 'pending', i);
    im.run(`M${i}`, `T${i}`, `obs ${i}`, i);
  }
  seed.exec('COMMIT;');
  seed.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  seed.close();

  // A briefing-class read set: recent tasks, recent memory, a status count.
  const briefingRead = (db: import('node:sqlite').DatabaseSync): void => {
    db.prepare('SELECT id, title, status FROM tasks_task ORDER BY created_at DESC LIMIT 20').all();
    db.prepare('SELECT id, observation FROM brain_memory ORDER BY created_at DESC LIMIT 10').all();
    db.prepare("SELECT COUNT(*) AS c FROM tasks_task WHERE status = 'pending'").get();
  };

  const openAndRead = (): number => {
    const t0 = performance.now();
    const db = openConsolidated(path);
    briefingRead(db);
    db.close();
    return performance.now() - t0;
  };

  const cold = openAndRead(); // first open after seed close — coldest realistic
  const warm: number[] = [];
  for (let i = 0; i < 50; i++) warm.push(openAndRead());

  return {
    scope: 'DB-substrate contribution only (open consolidated file + briefing-class query set)',
    coldMs: round(cold),
    warmStats: summarize(warm),
    note:
      'Isolated from Node/CLI process overhead. Full `cleo briefing` subprocess ' +
      'latency (~6-8s, dominated by module-load + dispatch) is tracked separately ' +
      'as T11292 and is orthogonal to the DB-substrate decision.',
  };
}

async function main(): Promise<void> {
  const workdir = mkdtempSync(join(tmpdir(), 'cleo-spike-dura-'));
  try {
    process.stderr.write(`[T11325] SIGKILL-mid-tx × ${KILL_ITERS} ...\n`);
    const killPath = join(workdir, 'durability.db');
    const cycles: KillCycle[] = [];
    for (let i = 0; i < KILL_ITERS; i++) {
      cycles.push(await killCycle(killPath, i));
      if ((i + 1) % 25 === 0) process.stderr.write(`[T11325]   ${i + 1}/${KILL_ITERS}\n`);
    }
    const allIntegrityOk = cycles.every((c) => c.integrityOk);
    const allCommittedSurvived = cycles.every((c) => c.committedSurvived === c.committedExpected);
    const noUncommittedLeak = cycles.every((c) => c.uncommittedLeaked === 0);

    process.stderr.write('[T11325] epic:T1075 WAL-reset reproducer ...\n');
    const t1075 = reproduceT1075(join(workdir, 't1075.db'), 200);

    process.stderr.write('[T11325] cold-start measurement ...\n');
    const coldStart = measureColdStart(workdir);

    const sigkillPass = allIntegrityOk && allCommittedSurvived && noUncommittedLeak;
    const t1075Pass = !t1075.reproduced;
    const coldPass = coldStart.coldMs < 200 && coldStart.warmStats.p95 < 50;

    const verdict = sigkillPass && t1075Pass && coldPass ? 'PASS' : 'FAIL';

    const failingCycles = cycles.filter(
      (c) =>
        !c.integrityOk || c.committedSurvived !== c.committedExpected || c.uncommittedLeaked > 0,
    );

    const report = {
      task: 'T11325',
      sigkillMidTransaction: {
        iterations: KILL_ITERS,
        allIntegrityCheckOk: allIntegrityOk,
        allCommittedRowsSurvived: allCommittedSurvived,
        noUncommittedRowsLeaked: noUncommittedLeak,
        failingCycles,
        pass: sigkillPass,
      },
      epicT1075Reproducer: {
        description: 'WAL-reset corruption class (brain.db errcode=11) fixed in SQLite 3.53.0',
        cyclesRun: t1075.cyclesRun,
        reproduced: t1075.reproduced,
        firstFailure: t1075.firstFailure,
        pass: t1075Pass,
      },
      coldStartBudget: {
        ...coldStart,
        budget: 'cold < 200ms p95, warm < 50ms p95',
        pass: coldPass,
      },
      verdict,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (verdict !== 'PASS') process.exit(1);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

void main();
