/**
 * Gate B for the change journal: replay from genesis and incremental (journal
 * spec S3 exit, §4.5; S3d, T12987).
 *
 * Each store is copied to scratch and opened through the chokepoint with
 * capture and seal on. Then:
 *
 *   1. **genesis:** a `VACUUM INTO` copy right after capture is enabled;
 *   2. workload A (captured inserts, updates, a label and a dependency),
 *      sealed;
 *   3. **checkpoint:** a second copy, and the last sealed `local_seq`;
 *   4. workload B (a delete, more updates, an UNCAPTURED edit that marks the
 *      table suspect, repaired by the repair diff), sealed;
 *   5. the reference applier replays EVERY sealed op onto the genesis copy,
 *      and the ops after the checkpoint onto the checkpoint copy;
 *   6. `fingerprint-store.mjs --canon-timestamps` fingerprints the source and
 *      both replays, and `compare-fingerprints.mjs --mode replay` must PASS.
 *
 * A negative control drops one op from the replay and must FAIL, so a PASS
 * is never vacuous.
 *
 * In CI the stores are fixtures shaped like the three release stores:
 * cleocode (labels, dependencies, relations, acceptance criteria), llmtxt (no
 * `project-id` file: the copies carry a stub, as the manual runs did) and
 * claude-todo (legacy `YYYY-MM-DD HH:MM:SS` timestamps, so the canonical
 * comparison is exercised). By hand, `scripts/sync-gate-b.mjs` runs the same
 * gate on `cleo backup add` snapshots of the real stores, through
 * `CLEO_SYNC_GATE_B_SNAPSHOTS=name=/abs/snapshot.db,...`; a snapshot is copied
 * to scratch first and never opened in place.
 *
 * The scripts run as child processes, exactly as an operator runs them.
 *
 * @task T12987
 * @epic T12323
 */

// Row uids are opt-in (T12341); sealing needs them.
process.env.CLEO_ROW_UID_FILL = '1';

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { _resetDualScopeDbCache, openDualScopeDb } from '../../dual-scope-db.js';
import { reconcileSupersededStores } from '../../exodus/index.js';
import { getDb } from '../../sqlite.js';
import { finishCaptureFrame, openCaptureFrame, setCaptureEnabled } from '../capture.js';
import { setSyncFlag } from '../flags.js';
import { repairSuspectTables } from '../repair.js';
import { sealPending } from '../sealer.js';
import { markSuspect } from '../structural.js';
import { lastLocalSeq, replaySealedOps, sealedOps } from './reference-applier.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../../..');
const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');
const FINGERPRINT = join(REPO_ROOT, 'scripts', 'fingerprint-store.mjs');
const COMPARE = join(REPO_ROOT, 'scripts', 'compare-fingerprints.mjs');
const REPLICA = '01929a3e-7f00-7000-8000-0000000000b0';
/** The project id every copy carries beside it (llmtxt has none of its own). */
const STUB_PROJECT_ID = 'dfd4e5d8-080f-7449-81cd-ff8dcef1049c';

let testRoot: string;
let keyFile: string;
let clock = 1_790_000_000_000;

const sql = (s: string) => `'${s.replaceAll("'", "''")}'`;

function vacuumInto(db: DatabaseSync, file: string): void {
  db.exec(`VACUUM INTO ${sql(file)}`);
}

/** A copy of `file` in its own directory, with the project-id stub beside it. */
function copyWithId(file: string, dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project-id'), `${STUB_PROJECT_ID}\n`);
  const out = join(dir, 'cleo.db');
  copyFileSync(file, out);
  return out;
}

function captured(db: DatabaseSync, statements: string): void {
  db.exec('BEGIN IMMEDIATE');
  const frame = openCaptureFrame(db, 'write', 'gate-b');
  db.exec(statements);
  finishCaptureFrame(db, frame);
  db.exec('COMMIT');
}

function uncaptured(db: DatabaseSync, statement: string): void {
  db.exec("INSERT INTO cleo_trigger_suspend (scope) VALUES ('capture')");
  db.exec(statement);
  db.exec('DELETE FROM cleo_trigger_suspend');
}

const seal = (db: DatabaseSync) => {
  for (;;) {
    const r = sealPending(db, {
      scope: 'project',
      replica: REPLICA,
      now: () => ++clock,
      env: {},
      allowUnreleased: true,
    });
    expect(r.pending).toEqual([]);
    expect(r.quarantined).toEqual([]);
    if (r.captures === 0) return;
  }
};

/** Up to `n` existing tasks that carry their identity (sealable without a fill). */
const existingTasks = (db: DatabaseSync, n: number) =>
  (
    db
      .prepare(
        `SELECT id FROM tasks_tasks WHERE uid IS NOT NULL AND birth_fp IS NOT NULL
         AND id NOT LIKE 'GB-%' ORDER BY id LIMIT ?`,
      )
      .all(n) as Array<{ id: string }>
  ).map((r) => r.id);

const insertTask = (id: string, title: string) =>
  `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp)
   VALUES (${sql(id)}, ${sql(title)}, 'task', 'pending', 'medium', ${sql(`gb-uid-${id}`)}, ${sql(`gb-fp-${id}`)});`;

/** Workload A: captured inserts, updates of existing rows, a label and a dependency. */
function workloadA(db: DatabaseSync): string[] {
  const old = existingTasks(db, 2);
  captured(
    db,
    [
      insertTask('GB-1', 'gate b one'),
      insertTask('GB-2', 'gate b two'),
      insertTask('GB-3', 'gate b three'),
      ...old.map((id) => `UPDATE tasks_tasks SET title = title || ' (A)' WHERE id = ${sql(id)};`),
      "INSERT INTO tasks_task_labels (task_id, label) VALUES ('GB-1', 'gate-b');",
      "INSERT INTO tasks_task_dependencies (task_id, depends_on) VALUES ('GB-2', 'GB-1');",
    ].join('\n'),
  );
  return old;
}

/** Workload B: a delete, updates, and an uncaptured edit the repair diff journals. */
function workloadB(db: DatabaseSync, old: readonly string[]): void {
  captured(
    db,
    [
      "DELETE FROM tasks_tasks WHERE id = 'GB-3';",
      "UPDATE tasks_tasks SET priority = 'high' WHERE id = 'GB-1';",
      "DELETE FROM tasks_task_labels WHERE task_id = 'GB-1' AND label = 'gate-b';",
      "INSERT INTO tasks_task_labels (task_id, label) VALUES ('GB-2', 'gate-b-2');",
    ].join('\n'),
  );
  // A row sealed in A, edited while capture is off (an older build, a
  // bracketed rewriter): only the repair diff can journal it.
  const target = old[0] ?? 'GB-2';
  uncaptured(db, `UPDATE tasks_tasks SET title = 'edited uncaptured' WHERE id = ${sql(target)}`);
  markSuspect(db, 'project', ['tasks_tasks']);
  const r = repairSuspectTables(db, {
    scope: 'project',
    replica: REPLICA,
    env: {},
    allowUnreleased: true,
    now: () => ++clock,
  });
  expect(r.tables.find((t) => t.table === 'tasks_tasks')?.reason ?? null).toBeNull();
}

interface Run {
  /** Existing (pre-workload) rows the workload updated. */
  readonly touchedExisting: number;
  readonly source: string;
  readonly genesis: string;
  readonly checkpoint: string;
  readonly checkpointSeq: number;
}

/** The store's tasks live only in the bare legacy `tasks` table. */
function legacyOnly(db: DatabaseSync): boolean {
  const has = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
    .get();
  if (!has) return false;
  const n = (t: string) => (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
  return n('tasks') > 0 && n('tasks_tasks') === 0;
}

/**
 * Steps 1–4 on a scratch store at `<projectDir>/.cleo/cleo.db` (a copy; never
 * a live store). It is opened the way the CLI opens a project: the canonical
 * open plus the tasks-family open (`getDb`), which migrates or rebuilds a
 * legacy store's bare tables, as a real legacy store (claude-todo) needs.
 */
async function runWorkload(name: string, projectDir: string): Promise<Run> {
  const dir = join(testRoot, name);
  let handle = await openDualScopeDb('project', projectDir);
  await getDb(projectDir);
  if (legacyOnly(handle.db.$client as DatabaseSync)) {
    // A legacy store (claude-todo) keeps its rows in the bare family: carry
    // them where the runtime reads them, as `cleo doctor superseded-store
    // --reconcile` does, before capture is enabled (spec §5.1).
    const receipt = await reconcileSupersededStores(projectDir);
    expect(receipt.outcome).not.toBe('refused');
    _resetDualScopeDbCache();
    handle = await openDualScopeDb('project', projectDir);
    await getDb(projectDir);
    expect(legacyOnly(handle.db.$client as DatabaseSync)).toBe(false);
  }
  const db = handle.db.$client as DatabaseSync;
  try {
    setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
    setSyncFlag(db, 'sync.seal', true, { schemaRoot: SYNC_SCHEMA, allowUnreleased: true });
    seal(db);
    const genesis = join(dir, 'genesis.db');
    vacuumInto(db, genesis);
    const old = workloadA(db);
    seal(db);
    const checkpoint = join(dir, 'checkpoint.db');
    vacuumInto(db, checkpoint);
    const checkpointSeq = lastLocalSeq(db);
    workloadB(db, old);
    seal(db);
    const source = join(dir, 'source.db');
    vacuumInto(db, source);
    return { touchedExisting: old.length, source, genesis, checkpoint, checkpointSeq };
  } finally {
    _resetDualScopeDbCache();
  }
}

/** Replay `ops` onto a copy of `base`; returns the replayed copy. */
function replayOnto(base: string, dir: string, ops: ReturnType<typeof sealedOps>): string {
  const file = copyWithId(base, dir);
  const db = new DatabaseSync(file);
  try {
    const r = replaySealedOps(db, 'project', ops);
    expect(r.missingRows).toBe(0);
    expect(r.unresolvedRefs).toBe(0);
  } finally {
    db.close();
  }
  return file;
}

function fingerprint(
  file: string,
  label: string,
  role: 'source' | 'replica',
  canon = true,
): string {
  const out = join(testRoot, 'fp', `${label}.fp.json`);
  mkdirSync(join(testRoot, 'fp'), { recursive: true });
  execFileSync(
    'node',
    [
      FINGERPRINT,
      '--db',
      file,
      '--label',
      label,
      '--out',
      out,
      '--role',
      role,
      '--key-file',
      keyFile,
      ...(canon ? ['--canon-timestamps'] : []),
    ],
    { encoding: 'utf8' },
  );
  return out;
}

function compare(sourceFp: string, replicaFp: string): { code: number; out: string } {
  try {
    const out = execFileSync(
      'node',
      [
        COMPARE,
        '--source',
        sourceFp,
        '--replica',
        replicaFp,
        '--mode',
        'replay',
        '--key-file',
        keyFile,
      ],
      { encoding: 'utf8' },
    );
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { code: err.status, out: err.stdout };
  }
}

/** What one Gate B run covered (printed for a real-store run, as its evidence). */
interface GateBSummary {
  readonly store: string;
  readonly tasks: number;
  readonly syncRows: number;
  readonly ops: number;
  readonly incrementalOps: number;
  readonly touchedExisting: number;
  readonly genesis: 'PASS';
  readonly incremental: 'PASS';
}

/** Steps 5–6, plus the negative control. */
function replayAndCompare(name: string, run: Run): GateBSummary {
  const dir = join(testRoot, name);
  const src = copyWithId(run.source, join(dir, 'source'));
  const srcDb = new DatabaseSync(src, { readOnly: true });
  const all = sealedOps(srcDb);
  const tail = sealedOps(srcDb, run.checkpointSeq);
  const count = (q: string) => (srcDb.prepare(q).get() as { n: number }).n;
  const tasks = count('SELECT count(*) AS n FROM tasks_tasks');
  const syncRows = count('SELECT count(*) AS n FROM _sync_row_meta');
  srcDb.close();
  expect(all.length).toBeGreaterThan(tail.length);
  expect(tail.some((o) => o.t === 'tasks_tasks' && o.o === 'U')).toBe(true);

  const sourceFp = fingerprint(src, `${name}-source`, 'source');
  const fromGenesis = replayOnto(run.genesis, join(dir, 'replay-genesis'), all);
  const fromCheckpoint = replayOnto(run.checkpoint, join(dir, 'replay-incremental'), tail);
  const genesis = compare(sourceFp, fingerprint(fromGenesis, `${name}-genesis`, 'replica'));
  expect(genesis.out, genesis.out).toContain('PASS (replay)');
  expect(genesis.code).toBe(0);
  const incremental = compare(
    sourceFp,
    fingerprint(fromCheckpoint, `${name}-incremental`, 'replica'),
  );
  expect(incremental.out, incremental.out).toContain('PASS (replay)');
  expect(incremental.code).toBe(0);

  // The two sides must agree on the timestamp mode.
  const mixed = compare(sourceFp, fingerprint(fromGenesis, `${name}-raw-stamps`, 'replica', false));
  expect(mixed.code).not.toBe(0);
  expect(mixed.out).toContain('timestamp modes differ');

  // Negative control: the repair op left out must fail the gate.
  const lossy = all.filter((o) => !(o.t === 'tasks_tasks' && o.a?.title === 'edited uncaptured'));
  expect(lossy.length).toBe(all.length - 1);
  const dropped = replayOnto(run.genesis, join(dir, 'replay-lossy'), lossy);
  const fail = compare(sourceFp, fingerprint(dropped, `${name}-lossy`, 'replica'));
  expect(fail.code).not.toBe(0);
  expect(fail.out).toContain('tasks_tasks');
  return {
    store: name,
    tasks,
    syncRows,
    ops: all.length,
    incrementalOps: tail.length,
    touchedExisting: run.touchedExisting,
    genesis: 'PASS',
    incremental: 'PASS',
  };
}

type Shape = 'cleocode' | 'llmtxt' | 'claude-todo';

/** Pre-sync rows, written before capture is enabled, shaped like `shape`. */
function seed(db: DatabaseSync, shape: Shape): void {
  const stamp = shape === 'claude-todo' ? '2026-03-04 05:06:07' : '2026-03-04T05:06:07.000Z';
  for (let i = 1; i <= 6; i++) {
    db.prepare(
      `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp, created_at, updated_at)
       VALUES (?, ?, 'task', 'pending', 'medium', ?, ?, ?, ?)`,
    ).run(`T${i}`, `seed ${i}`, `seed-uid-${i}`, `seed-fp-${i}`, stamp, stamp);
  }
  db.exec("INSERT INTO tasks_task_labels (task_id, label) VALUES ('T1', 'seed')");
  db.exec("INSERT INTO tasks_task_dependencies (task_id, depends_on) VALUES ('T2', 'T1')");
  if (shape === 'cleocode') {
    db.exec(
      "INSERT INTO tasks_task_relations (task_id, related_to, relation_type) VALUES ('T3', 'T4', 'blocks')",
    );
  }
}

/** A fixture store shaped like `shape`, as a file to copy. */
async function fixture(shape: Shape): Promise<string> {
  const projectDir = join(testRoot, `${shape}-fixture`);
  mkdirSync(join(projectDir, '.cleo'), { recursive: true });
  try {
    // The full runtime open, as row-identity-gate-b builds its fixtures.
    const handle = await openDualScopeDb('project', projectDir);
    await getDb(projectDir);
    seed(handle.db.$client as DatabaseSync, shape);
    const out = join(testRoot, `${shape}-fixture.db`);
    vacuumInto(handle.db.$client as DatabaseSync, out);
    return out;
  } finally {
    _resetDualScopeDbCache();
  }
}

/** `name=/abs/snapshot.db,...` from the environment (scripts/sync-gate-b.mjs). */
function snapshotsFromEnv(): Array<{ name: string; file: string }> {
  const raw = process.env.CLEO_SYNC_GATE_B_SNAPSHOTS ?? '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const at = s.indexOf('=');
      if (at <= 0) throw new Error(`CLEO_SYNC_GATE_B_SNAPSHOTS: expected name=/abs/path, got ${s}`);
      return { name: s.slice(0, at), file: s.slice(at + 1) };
    });
}

beforeAll(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'cleo-journal-gate-b-'));
  vi.stubEnv('CLEO_HOME', join(testRoot, 'cleo-home'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  mkdirSync(join(testRoot, 'cleo-home'), { recursive: true });
  keyFile = join(`${testRoot}-keys`, 'comparison.key');
  mkdirSync(`${testRoot}-keys`, { recursive: true });
  writeFileSync(keyFile, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
});

afterAll(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(testRoot, { recursive: true, force: true });
  rmSync(`${testRoot}-keys`, { recursive: true, force: true });
});

describe('journal Gate B on fixture stores (T12987)', () => {
  for (const shape of ['cleocode', 'llmtxt', 'claude-todo'] as const) {
    it(`${shape}: replay from genesis and incremental match the source`, async () => {
      const from = await fixture(shape);
      copyWithId(from, join(testRoot, shape, 'work', '.cleo'));
      replayAndCompare(shape, await runWorkload(shape, join(testRoot, shape, 'work')));
    }, 120_000);
  }
});

const snapshots = snapshotsFromEnv();
describe.runIf(snapshots.length > 0)('journal Gate B on real store snapshots (T12987)', () => {
  for (const { name, file } of snapshots) {
    it(`${name}: replay from genesis and incremental match the source`, async () => {
      const projectDir = join(testRoot, `real-${name}`, 'work');
      copyWithId(file, join(projectDir, '.cleo'));
      const summary = replayAndCompare(name, await runWorkload(`real-${name}`, projectDir));
      // The run's evidence: one JSON line on stdout.
      process.stdout.write(`GATE-B-SUMMARY ${JSON.stringify(summary)}\n`);
      expect(summary.touchedExisting).toBeGreaterThan(0);
    }, 1_800_000);
  }
});
