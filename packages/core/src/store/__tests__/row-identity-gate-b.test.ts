/**
 * Gate B for row identity on fixture stores, in CI (T12802).
 *
 * Gate B was run by hand on scratch copies of four real stores (cleocode,
 * llmtxt, axiom-app, cleo-nexus). This file folds that run into CI, on
 * fixture stores shaped like them, so it keeps passing before
 * `CLEO_ROW_UID_FILL` defaults on. Each fixture is built through the runtime
 * path, then:
 *
 *   - **replay:** the baseline is a store built with row uids OFF: no
 *     trigger and no fill ever ran on it. Its copy without the identity layer
 *     (the store before the uid migration) replays the migrated, filled copy
 *     with `--omit-row-identity`, so the fill changes no replicated value. A
 *     baseline the fill had already run on would hide such a change (a fill
 *     that normalises `created_at` passed); a test injects exactly that;
 *   - **determinism:** two independent migrations fingerprint identically
 *     WITH identity hashed, and equal the store filled as its rows were
 *     written. That includes history and binding rows written before their
 *     criterion existed, which the v1 recipe (`@refFp`) filled differently;
 *   - **9.25 refill:** a copy filled with the v1 recipe refills to the same
 *     identity as a fresh fill, changing nothing else;
 *   - **llmtxt shape:** no `project-id` file (its audit events only in the
 *     bare `audit_log`). The comparator fails closed without a project id,
 *     and PASSES with a project-id stub beside the copies, as the manual run
 *     used.
 *
 * The scripts run as child processes, exactly as an operator runs them.
 *
 * @task T12802
 * @epic T12323
 */

// Row uids are opt-in (T12341); these tests exercise them.
process.env.CLEO_ROW_UID_FILL = '1';

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { _resetDualScopeDbCache, openDualScopeDb } from '../dual-scope-db.js';
import {
  prepareRowIdentity,
  preReleaseBirthFp,
  ROW_IDENTITY,
  ROW_IDENTITY_RECIPE,
  ROW_IDENTITY_RECIPE_KEY,
  ROW_IDENTITY_RECIPE_V1,
  type RowIdentityWriters,
  registerRowIdentityWriters,
  rowIdentityColumns,
  v1ReleaseBirthFp,
} from '../row-identity.js';
import { ROW_IDENTITY_TABLES } from '../row-identity-registry.js';
import { getDb } from '../sqlite.js';
import {
  clearAcUidGraveyardNative,
  clearBirthFpNative,
  fillIdentityColumnNative,
  relinkAcUidNative,
  writeRowIdentityMetaNative,
} from '../sqlite-data-accessor.js';

/** The writers the chokepoint registers (store/sqlite-data-accessor.ts). */
const CHOKEPOINT_WRITERS: RowIdentityWriters = {
  relinkAcUidNative,
  clearAcUidGraveyardNative,
  writeRowIdentityMetaNative,
  fillIdentityColumnNative,
  clearBirthFpNative,
};

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const FINGERPRINT = join(REPO_ROOT, 'scripts', 'fingerprint-store.mjs');
const COMPARE = join(REPO_ROOT, 'scripts', 'compare-fingerprints.mjs');
const UID_MIGRATION = join(
  REPO_ROOT,
  'packages/core/migrations/drizzle-cleo-project/20260928120000_t12341-row-uids/migration.sql',
);

/** The stub the manual llmtxt run placed beside its copies (a valid portable id). */
const STUB_PROJECT_ID = 'dfd4e5d8-080f-7449-81cd-ff8dcef1049c';
const FIXTURE_PROJECT_ID = 'c0ffee000002';

type Shape = 'cleocode' | 'llmtxt';

let testRoot: string;
let keyFile: string;
/** Built with row uids ON: triggers and fills ran as the rows were written. */
const source = {} as Record<Shape, string>;
/** Built with row uids OFF: no trigger, no fill. The replay baseline. */
const unfilled = {} as Record<Shape, string>;

/**
 * Seed a fixture shaped like the real stores Gate B ran on. `fillBetween`
 * runs an open's fill between the writes (row uids on only).
 */
function seed(native: DatabaseSync, shape: Shape, fillBetween: boolean): void {
  native.exec(`
    INSERT INTO tasks_tasks (id, title, type, status, created_at) VALUES
      ('T1', 'Epic', 'epic', 'pending', '2026-09-01T09:00:00.000Z'),
      ('T2', 'First', 'task', 'pending', '2026-09-01 09:05:00'),
      ('T3', 'Second', 'task', 'pending', '2026-09-02T10:00:00.000Z'),
      ('T4', 'Sub', 'subtask', 'pending', '2026-09-03 11:00:00');
    UPDATE tasks_tasks SET parent_id = 'T1' WHERE id IN ('T2', 'T3');
    UPDATE tasks_tasks SET parent_id = 'T3' WHERE id = 'T4';
    INSERT INTO tasks_task_dependencies (task_id, depends_on) VALUES ('T3', 'T2'), ('T4', 'T2');

    -- History and a binding written BEFORE their criterion existed: the v1
    -- recipe hashed the criterion's fingerprint, so their value depended on
    -- when the fill ran.
    INSERT INTO tasks_task_acceptance_criteria_history (ac_id, previous_text, reason, recorded_at)
      VALUES ('ac-t3-1', 'tests', 'edit', '2026-09-02 10:01:00');
    INSERT INTO tasks_evidence_ac_bindings (id, evidence_atom_id, ac_id, binding_type, created_at)
      VALUES ('b-1', 'tool:test', 'ac-t3-1', 'satisfies', '2026-09-02 10:02:00');
    -- A binding whose criterion never exists here (dangling), and a task whose
    -- birth passes the store's GLOB but does not parse.
    INSERT INTO tasks_evidence_ac_bindings (id, evidence_atom_id, ac_id, binding_type, created_at)
      VALUES ('b-dangling', 'tool:test', 'ac-gone', 'direct', '2026-09-02 10:02:30');
    INSERT INTO tasks_tasks (id, title, type, status, priority, created_at)
      VALUES ('T5', 'Odd birth', 'task', 'pending', 'high', '2026-02-30 25:61:00');
  `);
  // An open between the writes fills those rows while their criterion is absent.
  if (fillBetween) prepareRowIdentity(native, 'project');
  native.exec(`
    -- The same criterion text on two tasks, and two criteria on one task.
    INSERT INTO tasks_task_acceptance_criteria (id, task_id, ordinal, text, kind, source_key, created_at) VALUES
      ('ac-t2-1', 'T2', 1, 'tests pass', 'text', 'text:1:a', '2026-09-01 09:06:00'),
      ('ac-t3-1', 'T3', 1, 'tests pass', 'text', 'text:1:a', '2026-09-02 10:00:30'),
      ('ac-t3-2', 'T3', 2, 'docs updated', 'text', 'text:2:b', '2026-09-02T10:00:31.000Z');
    INSERT INTO tasks_task_acceptance_criteria_history (ac_id, previous_text, reason, recorded_at)
      VALUES ('ac-t3-2', 'docs', 'edit', '2026-09-02 10:03:00'),
             ('ac-t3-2', 'docs', 'edit', '2026-09-02 10:04:00');
    INSERT INTO tasks_evidence_ac_bindings (id, evidence_atom_id, ac_id, binding_type, created_at) VALUES
      ('b-2', 'tool:test', 'ac-t2-1', 'satisfies', '2026-09-01 09:07:00'),
      ('b-3', 'files:docs/a.md', 'ac-t3-2', 'direct', '2026-09-02 10:05:00');

    INSERT INTO tasks_sessions (id, name, status, started_at) VALUES
      ('ses-1', 'first', 'ended', '2026-09-01 08:00:00'),
      ('ses-2', 'second', 'active', '2026-09-02T08:00:00.000Z');
  `);
  // llmtxt kept its audit events only in the bare twin; cleocode in both.
  const audit = shape === 'llmtxt' ? ['audit_log'] : ['audit_log', 'tasks_audit_log'];
  for (const table of audit) {
    native.exec(`INSERT INTO ${table} (id, timestamp, action, task_id) VALUES
      ('${table}-1', '2026-09-01 09:00:00', 'task_created', 'T1'),
      ('${table}-2', '2026-09-01 09:05:00', 'add', 'T2')`);
  }
}

/** Open a copy for a raw change, with foreign keys off so the change stays targeted. */
function openRaw(file: string): DatabaseSync {
  return new DatabaseSync(file, { enableForeignKeyConstraints: false });
}

/** Copy a fixture store into its own directory, with or without a project-id file beside it. */
function copyStore(
  shape: Shape,
  label: string,
  projectId: string | null,
  from: Record<Shape, string> = source,
): string {
  const dir = join(testRoot, shape, label);
  mkdirSync(dir, { recursive: true });
  if (projectId) writeFileSync(join(dir, 'project-id'), `${projectId}\n`);
  const file = join(dir, 'cleo.db');
  copyFileSync(from[shape], file);
  return file;
}

/** The project id each shape compares with: llmtxt has none, so its copies carry the stub. */
const projectIdOf = (shape: Shape, stub = true) =>
  shape === 'llmtxt' ? (stub ? STUB_PROJECT_ID : null) : FIXTURE_PROJECT_ID;

/**
 * A copy of the UNFILLED store as it was before the uid migration: no
 * identity columns, tables or trigger, and no fill ever ran on its values.
 */
function preMigrationCopy(shape: Shape, label: string, stub = true): string {
  const file = copyStore(shape, label, projectIdOf(shape, stub), unfilled);
  const conn = openRaw(file);
  conn.exec('DROP TRIGGER IF EXISTS trg_tasks_ac_uid_graveyard');
  for (const table of ROW_IDENTITY_TABLES.project) conn.exec(`DROP TABLE IF EXISTS "${table}"`);
  for (const spec of ROW_IDENTITY.project) {
    if (ROW_IDENTITY_TABLES.project.includes(spec.table)) continue;
    conn.exec(`DROP INDEX IF EXISTS "uq_${spec.table}_uid"`);
    for (const column of rowIdentityColumns('project', spec.table)) {
      conn.exec(`DROP INDEX IF EXISTS "idx_${spec.table}_${column}"`);
      conn.exec(`ALTER TABLE "${spec.table}" DROP COLUMN "${column}"`);
    }
  }
  conn.close();
  return file;
}

/** Apply the uid migration's SQL, then the open pass, as the first open of this build does. */
function migrate(file: string): void {
  const conn = openRaw(file);
  try {
    for (const stmt of readFileSync(UID_MIGRATION, 'utf8').split('--> statement-breakpoint')) {
      conn.exec(stmt);
    }
    expect(prepareRowIdentity(conn, 'project')?.filled.tasks_tasks).toBeGreaterThan(0);
  } finally {
    conn.close();
  }
}

/** Fingerprint one store; returns the fingerprint path. */
function fingerprint(
  file: string,
  label: string,
  role: 'source' | 'replica',
  omitIdentity = false,
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
      ...(omitIdentity ? ['--omit-row-identity'] : []),
    ],
    { encoding: 'utf8' },
  );
  return out;
}

/** Run the comparator in replay mode; returns its exit code and stdout. */
function replay(sourceFp: string, replicaFp: string) {
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

function expectPass(r: { code: number; out: string }): void {
  expect(r.out).toContain('PASS (replay)');
  expect(r.code).toBe(0);
}

/**
 * Build one fixture store through the runtime path and return a VACUUM copy.
 * `fill` false builds with row uids OFF: no uid trigger is armed and no fill
 * runs, so its values are exactly what was written (the replay baseline).
 */
async function buildFixture(shape: Shape, fill: boolean, label: string): Promise<string> {
  const projectDir = join(testRoot, `${shape}-${label}-project`);
  mkdirSync(join(projectDir, '.cleo'), { recursive: true });
  process.env.CLEO_ROW_UID_FILL = fill ? '1' : '0';
  try {
    const handle = await openDualScopeDb('project', projectDir);
    await getDb(projectDir);
    const native = handle.db.$client;
    seed(native, shape, fill);
    // The next open fills what the insert triggers left (birth fingerprints).
    if (fill) prepareRowIdentity(native, 'project');
    const out = join(testRoot, `${shape}-${label}.db`);
    native.exec(`VACUUM INTO '${out.replaceAll("'", "''")}'`);
    return out;
  } finally {
    _resetDualScopeDbCache();
    process.env.CLEO_ROW_UID_FILL = '1';
    // llmtxt has no project-id file.
    if (shape === 'llmtxt') rmSync(join(projectDir, '.cleo', 'project-id'), { force: true });
  }
}

beforeAll(async () => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  testRoot = join(tmpdir(), `gate-b-uid-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(testRoot, 'cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(testRoot, 'cleo'));
  keyFile = join(`${testRoot}-keys`, 'comparison.key');
  mkdirSync(`${testRoot}-keys`, { recursive: true });
  writeFileSync(keyFile, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });

  for (const shape of ['cleocode', 'llmtxt'] as const) {
    unfilled[shape] = await buildFixture(shape, false, 'unfilled');
    source[shape] = await buildFixture(shape, true, 'source');
  }
}, 300_000);

afterAll(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(testRoot, { recursive: true, force: true });
  rmSync(`${testRoot}-keys`, { recursive: true, force: true });
});

describe.each([
  'cleocode',
  'llmtxt',
] as const)('Gate B on the %s-shaped fixture (T12802)', (shape) => {
  it('the fixture carries every minted table the recipe covers', () => {
    const conn = new DatabaseSync(source[shape], { readOnly: true });
    try {
      for (const spec of ROW_IDENTITY.project.filter((s) => s.kind === 'minted')) {
        const n = conn.prepare(`SELECT count(*) AS n FROM "${spec.table}"`).get() as { n: number };
        expect(n.n, spec.table).toBeGreaterThan(0);
      }
      expect(
        conn
          .prepare('SELECT value FROM tasks_row_identity_meta WHERE key = ?')
          .get(ROW_IDENTITY_RECIPE_KEY),
      ).toEqual({ value: ROW_IDENTITY_RECIPE });
    } finally {
      conn.close();
    }
  });

  it('replay: the migration and fill change no replicated value (--omit-row-identity)', () => {
    const pre = preMigrationCopy(shape, 'pre');
    const post = preMigrationCopy(shape, 'post');
    migrate(post);
    expectPass(
      replay(
        fingerprint(pre, `${shape}-pre`, 'source'),
        fingerprint(post, `${shape}-post-omit`, 'replica', true),
      ),
    );
  });

  it('a fill that changes a replicated value FAILS replay: the baseline is never filled', async () => {
    // The unfilled baseline really is unfilled, and has values a fill could touch.
    const conn = new DatabaseSync(unfilled[shape], { readOnly: true });
    try {
      expect(
        conn.prepare('SELECT count(*) AS n FROM tasks_tasks WHERE uid IS NOT NULL').get(),
      ).toEqual({ n: 0 });
      expect(
        conn.prepare("SELECT count(*) AS n FROM tasks_tasks WHERE created_at LIKE '% %'").get(),
      ).not.toEqual({ n: 0 });
    } finally {
      conn.close();
    }
    // A mutant build whose fill also normalises created_at (' ' -> 'T'), a
    // replicated value. Every store below is built and filled by it.
    registerRowIdentityWriters({
      ...CHOKEPOINT_WRITERS,
      fillIdentityColumnNative(db, table, column, valueSql, rowid) {
        db.exec(
          "UPDATE tasks_tasks SET created_at = replace(created_at, ' ', 'T') WHERE created_at LIKE '% %'",
        );
        return fillIdentityColumnNative(db, table, column, valueSql, rowid);
      },
    });
    const saved = { unfilled: unfilled[shape], source: source[shape] };
    try {
      unfilled[shape] = await buildFixture(shape, false, 'mutant-unfilled');
      source[shape] = await buildFixture(shape, true, 'mutant-source');
      const pre = preMigrationCopy(shape, 'pre-mutant');
      const post = preMigrationCopy(shape, 'post-mutant');
      migrate(post);
      const r = replay(
        fingerprint(pre, `${shape}-pre-mutant`, 'source'),
        fingerprint(post, `${shape}-post-mutant`, 'replica', true),
      );
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('tasks_tasks');
    } finally {
      registerRowIdentityWriters(CHOKEPOINT_WRITERS);
      unfilled[shape] = saved.unfilled;
      source[shape] = saved.source;
    }
  });

  it('determinism: two migrations agree with identity hashed, and equal the store filled as it was written', () => {
    const one = preMigrationCopy(shape, 'one');
    const two = preMigrationCopy(shape, 'two');
    migrate(one);
    migrate(two);
    const oneFp = fingerprint(one, `${shape}-one`, 'source');
    expectPass(replay(oneFp, fingerprint(two, `${shape}-two`, 'replica')));
    const written = copyStore(shape, 'written', projectIdOf(shape));
    expectPass(replay(oneFp, fingerprint(written, `${shape}-written`, 'replica')));
  });

  it('9.25 refill: a v1-filled copy refills to the fresh identity, changing nothing else', () => {
    const v1 = copyStore(shape, 'v1', projectIdOf(shape));
    const conn = openRaw(v1);
    try {
      let changed = 0;
      for (const table of [
        'tasks_task_acceptance_criteria_history',
        'tasks_evidence_ac_bindings',
      ]) {
        const set = conn.prepare(`UPDATE "${table}" SET birth_fp = ? WHERE rowid = ?`);
        for (const row of conn.prepare(`SELECT rowid AS r, * FROM "${table}"`).all() as Array<
          Record<string, string | null> & { r: number }
        >) {
          const fp = v1ReleaseBirthFp(conn, table, row);
          if (fp !== null && fp !== row.birth_fp) changed++;
          set.run(fp, row.r);
        }
      }
      // The written-before-criterion rows are where v1 differed.
      expect(changed).toBeGreaterThan(0);
      conn
        .prepare('UPDATE tasks_row_identity_meta SET value = ? WHERE key = ?')
        .run(ROW_IDENTITY_RECIPE_V1, ROW_IDENTITY_RECIPE_KEY);
    } finally {
      conn.close();
    }
    const before = fingerprint(v1, `${shape}-v1-before`, 'source', true);
    const refill = openRaw(v1);
    try {
      expect(prepareRowIdentity(refill, 'project')?.refill).toBe('cleared');
    } finally {
      refill.close();
    }
    expectPass(replay(before, fingerprint(v1, `${shape}-v1-after-omit`, 'replica', true)));
    const fresh = copyStore(shape, 'fresh', projectIdOf(shape));
    expectPass(
      replay(
        fingerprint(fresh, `${shape}-fresh`, 'source'),
        fingerprint(v1, `${shape}-v1-after`, 'replica'),
      ),
    );
  });

  it('pre-release refill: a copy with pre-release fingerprints refills to the fresh identity, changing nothing else', () => {
    const stale = copyStore(shape, 'prerelease', projectIdOf(shape));
    const conn = openRaw(stale);
    try {
      const set = conn.prepare('UPDATE tasks_tasks SET birth_fp = ? WHERE rowid = ?');
      for (const row of conn.prepare('SELECT rowid AS r, * FROM tasks_tasks').all() as Array<
        Record<string, string | null> & { r: number }
      >) {
        set.run(preReleaseBirthFp(conn, 'tasks_tasks', row), row.r);
      }
      conn
        .prepare('DELETE FROM tasks_row_identity_meta WHERE key = ?')
        .run(ROW_IDENTITY_RECIPE_KEY);
    } finally {
      conn.close();
    }
    const before = fingerprint(stale, `${shape}-prerelease-before`, 'source', true);
    const refill = openRaw(stale);
    try {
      expect(prepareRowIdentity(refill, 'project')?.refill).toBe('cleared');
    } finally {
      refill.close();
    }
    expectPass(
      replay(before, fingerprint(stale, `${shape}-prerelease-after-omit`, 'replica', true)),
    );
    const fresh = copyStore(shape, 'fresh-pr', projectIdOf(shape));
    expectPass(
      replay(
        fingerprint(fresh, `${shape}-fresh-pr`, 'source'),
        fingerprint(stale, `${shape}-prerelease-after`, 'replica'),
      ),
    );
  });
});

describe('Gate B on the llmtxt-shaped fixture: the project-id stub (T12802)', () => {
  it('without a project id the comparator fails closed; with the stub it passes', () => {
    expect(existsSync(join(testRoot, 'llmtxt-project', '.cleo', 'project-id'))).toBe(false);
    const pre = preMigrationCopy('llmtxt', 'pre-nostub', false);
    const post = preMigrationCopy('llmtxt', 'post-nostub', false);
    migrate(post);
    const closed = replay(
      fingerprint(pre, 'llmtxt-pre-nostub', 'source'),
      fingerprint(post, 'llmtxt-post-nostub', 'replica', true),
    );
    expect(closed.code).not.toBe(0);
    const preStub = preMigrationCopy('llmtxt', 'pre-stub');
    const postStub = preMigrationCopy('llmtxt', 'post-stub');
    migrate(postStub);
    expectPass(
      replay(
        fingerprint(preStub, 'llmtxt-pre-stub', 'source'),
        fingerprint(postStub, 'llmtxt-post-stub', 'replica', true),
      ),
    );
  });
});
