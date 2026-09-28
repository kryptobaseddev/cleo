/**
 * Gates B and C tooling — `scripts/fingerprint-store.mjs` and
 * `scripts/compare-fingerprints.mjs` against a real migrated store (T12332).
 *
 * A fresh project `cleo.db` is built through the runtime path (the dual-scope
 * chokepoint plus every lineage-running domain binder) and seeded with a small
 * task graph and three observations. It is copied with `VACUUM INTO`, and each
 * copy gets ONE targeted change. Every test below is paired with a mutation of
 * the scripts that turns it red (recorded in PR #1616, "Round 2"):
 *
 *   - replay: an untouched copy and a copy whose rows were re-inserted in a
 *     different physical order PASS; one changed row with the same row count,
 *     a lost row, a >2^53 integer off by one, and a syncing table present only
 *     on the replica FAIL;
 *   - replay: a copy that differs only in a `strip` column path PASSES (the
 *     hash covers the replicated projection);
 *   - merge: a lost row, a lost table's rows, and an emptied store FAIL (the
 *     source rows must be a subset of the replica rows); a replaced row
 *     version passes only when `--allow-deleted` accounts for it;
 *   - merge: a new dependency cycle (Gate C) and a new dangling reference FAIL;
 *     a dangling personal `tasks.session_id` is informational;
 *   - a check the source could not measure FAILS; an UNCLASSIFIED table FAILS;
 *   - fingerprinting writes nothing beside the store (also in a `chmod 555`
 *     directory), reads a live WAL through a snapshot, and refuses to write a
 *     fingerprint that contains the store path.
 *
 * The scripts run as real child processes, exactly as an operator runs them.
 *
 * @task T12332
 * @epic T12322
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bindConduitDomain } from '../conduit-sqlite.js';
import { _resetDualScopeDbCache, openDualScopeDb } from '../dual-scope-db.js';
import { getBrainDb } from '../memory-sqlite.js';
import { getNexusDb } from '../nexus-sqlite.js';
import { getDb } from '../sqlite.js';
import { classifyTable, isPortableTableClass } from '../table-classification.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const FINGERPRINT = join(REPO_ROOT, 'scripts', 'fingerprint-store.mjs');
const COMPARE = join(REPO_ROOT, 'scripts', 'compare-fingerprints.mjs');

/** One targeted change per copy of the source store. */
const MUTATIONS = {
  copy: '',
  lostRow: "DELETE FROM tasks_task_dependencies WHERE task_id = 'T3'",
  cycle: "INSERT INTO tasks_task_dependencies (task_id, depends_on) VALUES ('T2', 'T3')",
  changedRow: "UPDATE tasks_tasks SET title = 'Second, edited' WHERE id = 'T3'",
  reordered: `CREATE TEMP TABLE o AS SELECT * FROM brain_observations;
    DELETE FROM brain_observations;
    INSERT INTO brain_observations SELECT * FROM o ORDER BY id DESC;`,
  bigA: "UPDATE tasks_tasks SET position = 9007199254740993 WHERE id = 'T2'",
  bigB: "UPDATE tasks_tasks SET position = 9007199254740992 WHERE id = 'T2'",
  crossDevice: `UPDATE tasks_tasks SET verification_json =
    '{"evidence":{"implemented":{"atoms":[{"kind":"files","resolvedPath":"/home/other-device/src/a.ts"}]}}}'
    WHERE id = 'T2'`,
  replicaOnlyTable: 'DROP TABLE adr_relations',
  unclassified: 'CREATE TABLE zz_gate_a_probe (x TEXT)',
  dangling: "INSERT INTO tasks_task_dependencies (task_id, depends_on) VALUES ('T3', 'T999')",
  lostObservations: 'DELETE FROM brain_observations',
  emptied: '', // every syncing table emptied in beforeAll
  sessionMoved: "UPDATE tasks_tasks SET session_id = 'S-other-device' WHERE id = 'T2'",
  unmeasured: 'DROP TABLE tasks_task_dependencies',
} as const;
type StoreName = 'source' | keyof typeof MUTATIONS;

let testRoot: string;
const db = {} as Record<StoreName, string>;

interface TableFp {
  class: string;
  shareable: boolean;
  rows?: number;
  sha256?: string;
  columns?: string[];
  excludedColumns?: string[];
}
interface Fingerprint {
  store: string;
  vecLoaded: boolean;
  rowsFile: string | null;
  tables: Record<string, TableFp>;
  relationships: Record<string, { dangling?: number; informational?: boolean }>;
  invariants: Record<string, number>;
}

/** Fingerprint one store file; returns the parsed JSON, its path, and the sidecar. */
function fingerprintFile(dbFile: string, label: string) {
  const file = join(testRoot, `${label}.fp.json`);
  execFileSync('node', [FINGERPRINT, '--db', dbFile, '--label', label, '--out', file], {
    encoding: 'utf8',
  });
  const raw = readFileSync(file, 'utf8');
  return {
    fp: JSON.parse(raw) as Fingerprint,
    file,
    raw,
    rows: readFileSync(`${file}.rows`, 'utf8'),
  };
}
const fingerprint = (name: StoreName) => fingerprintFile(db[name], name);

/** Run the comparator; returns its exit code and stdout. */
function compare(source: string, replica: string, mode: 'replay' | 'merge', extra: string[] = []) {
  try {
    const out = execFileSync(
      'node',
      [COMPARE, '--source', source, '--replica', replica, '--mode', mode, ...extra],
      { encoding: 'utf8' },
    );
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { code: err.status, out: err.stdout };
  }
}
const cmp = (source: StoreName, replica: StoreName, mode: 'replay' | 'merge') =>
  compare(fingerprint(source).file, fingerprint(replica).file, mode);

/** Open a copy for a raw test mutation, with foreign keys off so a change stays targeted. */
function openRaw(file: string): DatabaseSync {
  return new DatabaseSync(file, { enableForeignKeyConstraints: false });
}

beforeAll(async () => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  testRoot = join(tmpdir(), `gate-bc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const projectDir = join(testRoot, 'project');
  mkdirSync(join(projectDir, '.cleo'), { recursive: true });
  mkdirSync(join(testRoot, 'cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(testRoot, 'cleo'));

  const handle = await openDualScopeDb('project', projectDir);
  await getDb(projectDir);
  await getBrainDb(projectDir);
  await getNexusDb(projectDir);
  await bindConduitDomain(projectDir);
  const native = handle.db.$client;

  // A small, rule-abiding task graph: epic T1 with tasks T2 and T3, T3 depends on T2.
  native.exec(`
    INSERT INTO tasks_tasks (id, title, type, status) VALUES ('T1', 'Epic', 'epic', 'pending');
    INSERT INTO tasks_tasks (id, title, type, status, parent_id, verification_json) VALUES ('T2', 'First', 'task', 'pending', 'T1',
      '{"evidence":{"implemented":{"atoms":[{"kind":"files","resolvedPath":"/Users/this-device/src/a.ts"}]}}}');
    INSERT INTO tasks_tasks (id, title, type, status, parent_id) VALUES ('T3', 'Second', 'task', 'pending', 'T1');
    INSERT INTO tasks_task_dependencies (task_id, depends_on) VALUES ('T3', 'T2');
    INSERT INTO brain_observations (id, type, title) VALUES ('O1', 'change', 'one'), ('O2', 'change', 'two'), ('O3', 'change', 'three');
  `);

  db.source = handle.dbPath;
  for (const name of Object.keys(MUTATIONS) as (keyof typeof MUTATIONS)[]) {
    db[name] = join(testRoot, `${name}.db`);
    native.exec(`VACUUM INTO '${db[name].replaceAll("'", "''")}'`);
  }
  // Close every handle so the source file is checkpointed before it is read.
  _resetDualScopeDbCache();

  for (const [name, sql] of Object.entries(MUTATIONS)) {
    if (!sql) continue;
    const conn = openRaw(db[name as StoreName]);
    conn.exec(sql);
    conn.close();
  }
  const emptied = openRaw(db.emptied);
  const tables = emptied
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%'",
    )
    .all() as { name: string }[];
  for (const { name } of tables) {
    const c = classifyTable('project', name);
    if ((c.kind === 'entry' || c.kind === 'pattern') && isPortableTableClass(c.class))
      emptied.exec(`DELETE FROM "${name}"`);
  }
  emptied.close();
}, 300_000);

afterAll(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(testRoot, { recursive: true, force: true });
});

describe('fingerprint-store', () => {
  it('classifies from the Gate A registry and hashes every syncing table', () => {
    const { fp, rows } = fingerprint('source');
    expect(fp.tables.tasks_tasks).toMatchObject({
      class: 'portable-project',
      shareable: true,
      rows: 3,
    });
    expect(fp.tables.tasks_tasks.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fp.tables._writer_leases).toMatchObject({ class: 'local-only', shareable: false });
    expect(fp.tables._writer_leases.sha256).toBeUndefined();
    const unclassified = Object.entries(fp.tables).filter(([, e]) => e.class === 'UNCLASSIFIED');
    expect(unclassified).toEqual([]);
    // vec0 is portable-personal; it must be hashed, not skipped.
    expect(fp.vecLoaded).toBe(true);
    expect(fp.tables.brain_embeddings?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fp.invariants).toMatchObject({ dependencyCycles: 0, containmentViolations: 0 });
    // One sidecar line per syncing row.
    expect(rows.split('\n').filter((l) => l.startsWith('tasks_tasks\t'))).toHaveLength(3);
  });

  it('hashes the replicated projection: secret, local-only and strip columns are left out', () => {
    const { fp } = fingerprint('source');
    expect(fp.tables.tasks_sessions.excludedColumns).toContain('owner_auth_token');
    expect(fp.tables.tasks_sessions.columns).not.toContain('owner_auth_token');
    expect(fp.tables.tasks_commits.excludedColumns).toContain('project_hash');
    expect(fp.tables.brain_observations.columns).not.toContain('tree_id');
    // A jsonPath strip keeps the column and removes only the path.
    expect(fp.tables.tasks_tasks.columns).toContain('verification_json');
  });

  it('never records a path', () => {
    for (const name of ['source', 'copy'] as const) {
      const { raw, fp, rows } = fingerprint(name);
      expect(fp.store).toBe(name);
      expect(fp.rowsFile).toBe(`${name}.fp.json.rows`);
      for (const text of [raw, rows]) {
        expect(text).not.toContain(testRoot);
        expect(text).not.toContain(tmpdir());
      }
    }
  });

  it('refuses to write a fingerprint that contains the store path', () => {
    const out = join(testRoot, 'leak.fp.json');
    let status = 0;
    let stderr = '';
    try {
      execFileSync(
        'node',
        [FINGERPRINT, '--db', db.copy, '--label', dirname(db.copy), '--out', out],
        { encoding: 'utf8', stdio: 'pipe' },
      );
    } catch (e) {
      const err = e as { status: number; stderr: string };
      status = err.status;
      stderr = err.stderr;
    }
    expect(status).not.toBe(0);
    expect(stderr).toContain('refusing to write a fingerprint that contains the store path');
    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.rows`)).toBe(false);
  });

  it('writes nothing beside the store, even in a chmod 555 directory', () => {
    for (const dirName of ['rw', 'ro']) {
      const dir = join(testRoot, dirName);
      mkdirSync(dir);
      const file = join(dir, 'cleo.db');
      copyFileSync(db.source, file);
      const before = readdirSync(dir).sort();
      expect(before).toEqual(['cleo.db']);
      if (dirName === 'ro') chmodSync(dir, 0o555);
      try {
        const { fp } = fingerprintFile(file, `store-${dirName}`);
        expect(fp.tables.tasks_tasks.sha256).toBe(
          fingerprint('source').fp.tables.tasks_tasks.sha256,
        );
        expect(readdirSync(dir).sort()).toEqual(before);
      } finally {
        chmodSync(dir, 0o755);
      }
    }
  });

  it('reads a live store with a non-empty WAL through a snapshot, without touching it', () => {
    const dir = join(testRoot, 'live');
    mkdirSync(dir);
    const file = join(dir, 'cleo.db');
    copyFileSync(db.source, file);
    const writer = openRaw(file);
    try {
      writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
      writer.exec(
        "INSERT INTO brain_observations (id, type, title) VALUES ('O4', 'change', 'four')",
      );
      const before = readdirSync(dir).sort();
      expect(before).toContain('cleo.db-wal');
      const { fp } = fingerprintFile(file, 'live');
      expect(fp.tables.brain_observations.rows).toBe(4);
      expect(readdirSync(dir).sort()).toEqual(before);
    } finally {
      writer.close();
    }
  });
});

describe('compare-fingerprints: replay (exact)', () => {
  it('a VACUUM INTO copy reproduces the source (PASS)', () => {
    const r = cmp('source', 'copy', 'replay');
    expect(r.out).toContain('PASS (replay)');
    expect(r.code).toBe(0);
  });

  it('rows re-inserted in a different physical order still PASS (order-independent digest)', () => {
    const order = (file: string) => {
      const conn = new DatabaseSync(file, { readOnly: true });
      // SELECT * scans the table itself, as the fingerprint does (SELECT id would read the PK index).
      const ids = (conn.prepare('SELECT * FROM brain_observations').all() as { id: string }[]).map(
        (r) => r.id,
      );
      conn.close();
      return ids;
    };
    expect(order(db.reordered)).not.toEqual(order(db.source));
    const r = cmp('source', 'reordered', 'replay');
    expect(r.out).toContain('PASS (replay)');
    expect(r.code).toBe(0);
  });

  it('one changed row with the same row count FAILS', () => {
    const r = cmp('source', 'changedRow', 'replay');
    expect(r.code).toBe(1);
    expect(r.out).toContain('GATE B FAIL tasks_tasks: content hash differs');
  });

  it('a lost row in a portable table FAILS', () => {
    const r = cmp('source', 'lostRow', 'replay');
    expect(r.code).toBe(1);
    expect(r.out).toContain('GATE B FAIL tasks_task_dependencies: rows 1 → 0');
  });

  it('an integer above 2^53 is hashed exactly', () => {
    const r = cmp('bigA', 'bigB', 'replay');
    expect(r.code).toBe(1);
    expect(r.out).toContain('GATE B FAIL tasks_tasks: content hash differs');
  });

  it('a strip column path that differs across devices still PASSES', () => {
    const r = cmp('source', 'crossDevice', 'replay');
    expect(r.out).toContain('PASS (replay)');
    expect(r.code).toBe(0);
  });

  it('a syncing table present only on the replica FAILS', () => {
    const r = cmp('replicaOnlyTable', 'source', 'replay');
    expect(r.code).toBe(1);
    expect(r.out).toContain('GATE B FAIL adr_relations: syncing table present only on replica');
  });
});

describe('compare-fingerprints: merge (source rows ⊆ replica rows)', () => {
  it('a faithful copy PASSES', () => {
    const r = cmp('source', 'copy', 'merge');
    expect(r.out).toContain('PASS (merge)');
    expect(r.code).toBe(0);
  });

  it('a lost row FAILS', () => {
    const r = cmp('source', 'lostRow', 'merge');
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      'GATE B FAIL tasks_task_dependencies: 1 source row(s) missing on replica and not in --allow-deleted',
    );
  });

  it('losing every brain_observations row FAILS', () => {
    const r = cmp('source', 'lostObservations', 'merge');
    expect(r.code).toBe(1);
    expect(r.out).toContain('GATE B FAIL brain_observations: 3 source row(s) missing');
  });

  it('a replica with every syncing row deleted FAILS', () => {
    const r = cmp('source', 'emptied', 'merge');
    expect(r.code).toBe(1);
    expect(r.out).toContain('GATE B FAIL tasks_tasks: 3 source row(s) missing');
  });

  it('a replaced row version passes only when --allow-deleted accounts for it', () => {
    const src = fingerprint('source');
    const rep = fingerprint('sessionMoved');
    const kept = new Set(rep.rows.split('\n'));
    const gone = src.rows.split('\n').filter((l) => l && !kept.has(l));
    expect(gone).toHaveLength(1);
    expect(gone[0]).toMatch(/^tasks_tasks\t[0-9a-f]{64}$/);

    const lossy = compare(src.file, rep.file, 'merge');
    expect(lossy.code).toBe(1);
    expect(lossy.out).toContain('GATE B FAIL tasks_tasks: 1 source row(s) missing');

    const allow = join(testRoot, 'allow-deleted.rows');
    writeFileSync(allow, `${gone[0]}\n`);
    const r = compare(src.file, rep.file, 'merge', ['--allow-deleted', allow]);
    expect(r.out).toContain('PASS (merge)');
    expect(r.code).toBe(0);
    // The personal session edge dangles on this replica, and is only reported.
    expect(rep.fp.relationships['tasks.session_id']).toMatchObject({
      informational: true,
      dangling: 1,
    });
    expect(r.out).toContain('note: tasks.session_id (informational): dangling 0 → 1');
  });

  it('a new dependency cycle FAILS Gate C', () => {
    const { fp } = fingerprint('cycle');
    expect(fp.invariants.dependencyCycles).toBeGreaterThan(0);
    const r = cmp('source', 'cycle', 'merge');
    expect(r.code).toBe(1);
    expect(r.out).toContain('GATE C FAIL dependencyCycles: 0 →');
  });

  it('a new dangling reference FAILS', () => {
    const r = cmp('source', 'dangling', 'merge');
    expect(r.code).toBe(1);
    expect(r.out).toContain('GATE B FAIL dependencies.depends_on: dangling 0 → 1');
  });
});

describe('compare-fingerprints: both modes', () => {
  it('an UNCLASSIFIED table FAILS Gate A', () => {
    const r = cmp('source', 'unclassified', 'replay');
    expect(r.code).toBe(1);
    expect(r.out).toContain('GATE A FAIL zz_gate_a_probe: unclassified on replica');
  });

  it('a check the source could not measure FAILS', () => {
    const r = cmp('unmeasured', 'unmeasured', 'merge');
    expect(r.code).toBe(1);
    expect(r.out).toContain('GATE C FAIL dependencyCycles: not measured on source');
    expect(r.out).toContain(
      'GATE B FAIL dependencies.depends_on: not measured on source (no table tasks_task_dependencies)',
    );
  });
});
