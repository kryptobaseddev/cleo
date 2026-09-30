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
 * T12613 hardening, each also paired with a red mutation:
 *
 *   - a `.rows` sidecar is bound to its JSON (file sha256, per-table line
 *     counts and recomputed digests), so a sidecar swapped in from another
 *     store FAILS;
 *   - `--allow-deleted` is validated: rows not in the source, more lines than
 *     `--max-deleted`, or the whole source row set FAIL, and excused rows are
 *     reported per table;
 *   - the WAL snapshot is gone before the store is hashed, is created 0700,
 *     does not survive a crash, and a SIGTERM during the copy removes it;
 *   - row hashes are HMACs under a per-comparison key; fingerprints made with
 *     different keys FAIL, and `.rows` and `.key` are written 0600.
 *
 * T12636, each also paired with a red mutation:
 *
 *   - a per-table tombstone cap, and an explicit `--allow-table-wipe` for a
 *     table that would lose every row (the 404-row scenario: 4 tombstones
 *     erased two whole tables under the global cap);
 *   - every fingerprint JSON carries a MAC under the comparison key, and an
 *     edited field or a missing `--key-file` FAILS;
 *   - a new key is written only with `--key-out`, never into the directory
 *     of `--out`/`--rows`, and never over an existing file.
 *
 * T12641, each also paired with a red mutation:
 *
 *   - `--key-out` is refused anywhere in the directory TREE of `--out` or
 *     `--rows`, by realpath, so a subdirectory or a symlink does not get
 *     around it;
 *   - each fingerprint carries a store identity (project id + per-run nonce,
 *     under the MAC): the source fingerprint copied in as the replica FAILS,
 *     a replica of another project FAILS, and a replica of the same project
 *     compares normally.
 *
 * The scripts run as real child processes, exactly as an operator runs them.
 * All fingerprints of one comparison share the key in `keyFile`. New keys go
 * to `keyRoot`, a sibling of `testRoot`, because a key inside the tree of the
 * fingerprints is refused.
 *
 * T12341 (row uids):
 *
 *   - a store before the uid migration replays its migrated copy only with
 *     `--omit-row-identity` (no other replicated value changed); without the
 *     flag the column sets differ and it FAILS;
 *   - two independent migrations of one store fingerprint identically WITH
 *     the uids hashed (the backfill is deterministic), and equal to the rows
 *     the per-connection trigger filled on insert.
 *
 * @task T12332
 * @task T12613
 * @task T12636
 * @task T12341
 * @task T12641
 * @task T12675
 * @epic T12322
 */

// Row uids are opt-in (T12341); these tests exercise them.
process.env.CLEO_ROW_UID_FILL = '1';

import { execFileSync, spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isInsideDirectoryTree } from '../../../../../scripts/lib/path-containment.mjs';
import { bindConduitDomain } from '../conduit-sqlite.js';
import { _resetDualScopeDbCache, openDualScopeDb } from '../dual-scope-db.js';
import { getBrainDb } from '../memory-sqlite.js';
import { getNexusDb } from '../nexus-sqlite.js';
import {
  prepareRowIdentity,
  preReleaseBirthFp,
  ROW_IDENTITY,
  rowIdentityColumns,
} from '../row-identity.js';
import { ROW_IDENTITY_TABLES } from '../row-identity-registry.js';
import { getDb } from '../sqlite.js';
import { classifyTable, isPortableTableClass } from '../table-classification.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const FINGERPRINT = join(REPO_ROOT, 'scripts', 'fingerprint-store.mjs');
const COMPARE = join(REPO_ROOT, 'scripts', 'compare-fingerprints.mjs');
const UID_MIGRATION = join(
  REPO_ROOT,
  'packages/core/migrations/drizzle-cleo-project/20260928120000_t12341-row-uids/migration.sql',
);

/** One targeted change per copy of the source store. */
const MUTATIONS = {
  copy: '',
  lostRow: "DELETE FROM tasks_task_dependencies WHERE task_id = 'T3'",
  // The T12886 guard trigger refuses this edge, so the replica is one a
  // pre-guard build wrote: drop the trigger first. Gate C must still catch it.
  cycle: `DROP TRIGGER IF EXISTS tasks_task_dependencies_cycle_guard_insert;
    INSERT INTO tasks_task_dependencies (task_id, depends_on) VALUES ('T2', 'T3')`,
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

const TEST_PROJECT_ID = 'c0ffee000001';
let testRoot: string;
let keyRoot: string;
let keyFile: string;
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
  mac?: string;
  identity?: { projectId: string | null; nonce: string };
  store: string;
  vecLoaded: boolean;
  keyId: string;
  rowsFile: string | null;
  rowsSha256: string | null;
  tables: Record<string, TableFp>;
  relationships: Record<string, { dangling?: number; informational?: boolean }>;
  invariants: Record<string, number>;
}

type Role = 'source' | 'replica';

/** Fingerprint one store file with the shared key (or other key args) in a role; returns the JSON, its path, and the sidecar. */
function fingerprintFile(
  dbFile: string,
  label: string,
  key = ['--key-file', keyFile],
  role: Role = 'replica',
) {
  const file = join(testRoot, `${label}.fp.json`);
  execFileSync(
    'node',
    [FINGERPRINT, '--db', dbFile, '--label', label, '--out', file, '--role', role, ...key],
    { encoding: 'utf8' },
  );
  const raw = readFileSync(file, 'utf8');
  return {
    fp: JSON.parse(raw) as Fingerprint,
    file,
    raw,
    rows: readFileSync(`${file}.rows`, 'utf8'),
  };
}
/** The source store fingerprints as `source`, every other store as `replica`, unless a role is given. */
function fingerprint(name: StoreName, role: Role = name === 'source' ? 'source' : 'replica') {
  const usual = name === 'source' ? 'source' : 'replica';
  return fingerprintFile(db[name], role === usual ? name : `${name}-as-${role}`, undefined, role);
}

/** Run the comparator; returns its exit code and stdout. */
function compare(source: string, replica: string, mode: 'replay' | 'merge', extra: string[] = []) {
  try {
    const out = execFileSync(
      'node',
      [
        COMPARE,
        '--source',
        source,
        '--replica',
        replica,
        '--mode',
        mode,
        '--key-file',
        keyFile,
        ...extra,
      ],
      { encoding: 'utf8' },
    );
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { code: err.status, out: err.stdout };
  }
}
const cmp = (source: StoreName, replica: StoreName, mode: 'replay' | 'merge') =>
  compare(fingerprint(source, 'source').file, fingerprint(replica, 'replica').file, mode);

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
  keyRoot = `${testRoot}-keys`;
  mkdirSync(keyRoot, { recursive: true });
  keyFile = join(testRoot, 'comparison.key');
  writeFileSync(keyFile, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
  // Every compared store sits beside a project-id file: the comparator fails closed without one.
  writeFileSync(join(projectDir, '.cleo', 'project-id'), `${TEST_PROJECT_ID}\n`);
  writeFileSync(join(testRoot, 'project-id'), `${TEST_PROJECT_ID}\n`);

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
  rmSync(keyRoot, { recursive: true, force: true });
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
        [
          FINGERPRINT,
          '--db',
          db.copy,
          '--label',
          dirname(db.copy),
          '--role',
          'replica',
          '--out',
          out,
          '--key-file',
          keyFile,
        ],
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

/** Canonical JSON (keys sorted at every level), written independently of scripts/lib as an oracle. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}
/** Re-sign an edited fingerprint with the comparison key, as someone holding the key could. */
function signed(fp: Fingerprint): string {
  const { mac: _mac, ...body } = fp;
  const key = readFileSync(keyFile, 'utf8').trim();
  return JSON.stringify({
    ...body,
    mac: createHmac('sha256', key).update(canonical(body)).digest('hex'),
  });
}

/** Copy a fingerprint (JSON + sidecar) under a new label, re-signed, so a test can tamper with the copy. */
function cloneFingerprint(name: StoreName, label: string) {
  const { file } = fingerprint(name);
  const clone = join(testRoot, `${label}.fp.json`);
  const fp = JSON.parse(readFileSync(file, 'utf8')) as Fingerprint;
  fp.rowsFile = `${label}.fp.json.rows`;
  writeFileSync(clone, signed(fp));
  copyFileSync(`${file}.rows`, `${clone}.rows`);
  return { file: clone, fp };
}
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe('T12613: the .rows sidecar is bound to its fingerprint', () => {
  it("the source's sidecar copied over a wiped replica's FAILS merge", () => {
    const src = fingerprint('source');
    const wiped = cloneFingerprint('emptied', 'wipedSwapped');
    copyFileSync(`${src.file}.rows`, `${wiped.file}.rows`);
    const r = compare(src.file, wiped.file, 'merge');
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      'GATE B FAIL *: replica .rows does not match its fingerprint: file sha256 differs from rowsSha256',
    );
  });

  it('a swapped sidecar with a patched rowsSha256 still FAILS on line counts', () => {
    const src = fingerprint('source');
    const wiped = cloneFingerprint('emptied', 'wipedPatched');
    copyFileSync(`${src.file}.rows`, `${wiped.file}.rows`);
    writeFileSync(wiped.file, signed({ ...wiped.fp, rowsSha256: sha256(src.rows) }));
    const r = compare(src.file, wiped.file, 'merge');
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      'GATE B FAIL tasks_tasks: replica .rows does not match its fingerprint: 3 line(s) for 0 row(s)',
    );
    expect(r.out).not.toContain('file sha256 differs');
  });

  it('a swapped sidecar with equal counts and a patched rowsSha256 FAILS on the recomputed digest', () => {
    const src = fingerprint('source');
    const changed = cloneFingerprint('changedRow', 'changedPatched');
    copyFileSync(`${src.file}.rows`, `${changed.file}.rows`);
    writeFileSync(changed.file, signed({ ...changed.fp, rowsSha256: sha256(src.rows) }));
    const r = compare(src.file, changed.file, 'merge');
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      'GATE B FAIL tasks_tasks: replica .rows does not match its fingerprint: digest recomputed from the lines differs',
    );
  });

  it('a sidecar whose bytes changed but whose digests still match FAILS on the file hash', () => {
    const src = fingerprint('source');
    const copy = cloneFingerprint('copy', 'copyReordered');
    const lines = readFileSync(`${copy.file}.rows`, 'utf8').trimEnd().split('\n');
    writeFileSync(`${copy.file}.rows`, `${lines.reverse().join('\n')}\n`);
    const r = compare(src.file, copy.file, 'merge');
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      'GATE B FAIL *: replica .rows does not match its fingerprint: file sha256 differs from rowsSha256',
    );
    expect(r.out).not.toContain('digest recomputed');
  });
});

describe('T12613: --allow-deleted is validated', () => {
  const tombstones = (name: string, lines: string[]) => {
    const file = join(testRoot, `${name}.tombstones`);
    writeFileSync(file, `${lines.join('\n')}\n`);
    return file;
  };
  const observationLines = () =>
    fingerprint('source')
      .rows.split('\n')
      .filter((l) => l.startsWith('brain_observations\t'));

  it('a tombstone for a row the source never had FAILS', () => {
    const allow = tombstones('foreign', [`tasks_tasks\t${'0'.repeat(64)}`]);
    const r = compare(fingerprint('source').file, fingerprint('copy').file, 'merge', [
      '--allow-deleted',
      allow,
    ]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      'GATE B FAIL *: --allow-deleted names 1 row(s) that are not in the source',
    );
  });

  it('more tombstones than --max-deleted (default 1%) FAIL; an explicit cap passes, loudly', () => {
    const allow = tombstones('observations', observationLines());
    const src = fingerprint('source').file;
    const rep = fingerprint('lostObservations').file;
    const capped = compare(src, rep, 'merge', ['--allow-deleted', allow]);
    expect(capped.code).toBe(1);
    expect(capped.out).toMatch(
      /GATE B FAIL \*: --allow-deleted holds 3 row\(s\), over the --max-deleted cap of \d+/,
    );

    // The whole table goes, so the per-table cap and the wipe need their own consent here.
    const wipe = ['--max-deleted-per-table', '100%', '--allow-table-wipe', 'brain_observations'];
    const r = compare(src, rep, 'merge', ['--allow-deleted', allow, '--max-deleted', '3', ...wipe]);
    expect(r.out).toContain('PASS (merge)');
    expect(r.out).toContain(
      'WARNING: --allow-deleted EXCUSED 3 missing row(s) in brain_observations (3 tombstone(s), cap 3)',
    );
    const json = compare(src, rep, 'merge', [
      '--allow-deleted',
      allow,
      '--max-deleted',
      '3',
      ...wipe,
      '--json',
    ]);
    expect(JSON.parse(json.out)).toMatchObject({
      ok: true,
      excused: { brain_observations: 3 },
      allowance: { lines: 3, cap: 3 },
    });
  });

  it("the source's own row set as the tombstone file FAILS, even with the cap lifted", () => {
    const src = fingerprint('source');
    const r = compare(src.file, fingerprint('emptied').file, 'merge', [
      '--allow-deleted',
      `${src.file}.rows`,
      '--max-deleted',
      '100%',
    ]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      'GATE B FAIL *: --allow-deleted equals the source row set (it would excuse deleting everything)',
    );
  });
});

describe('T12613: row hashes are keyed per comparison', () => {
  it('a dependency row hash is an HMAC under the comparison key, not a guessable sha256', () => {
    const { fp, rows } = fingerprint('source');
    const cols = fp.tables.tasks_task_dependencies.columns ?? [];
    const conn = new DatabaseSync(db.source, { readOnly: true });
    const stmt = conn.prepare(
      `SELECT ${cols.map((c) => `"${c}"`).join(',')} FROM tasks_task_dependencies`,
    );
    stmt.setReadBigInts(true);
    const row = stmt.get() as Record<string, unknown>;
    conn.close();
    const canon = (v: unknown) =>
      v === null
        ? 'N'
        : typeof v === 'bigint'
          ? `I${v}`
          : typeof v === 'number'
            ? `R${v}`
            : `S${String(v).length}:${String(v)}`;
    const text = cols.map((c) => canon(row[c])).join('\u0001');
    const key = readFileSync(keyFile, 'utf8').trim();
    const lines = rows.split('\n');
    expect(lines).toContain(
      `tasks_task_dependencies\t${createHmac('sha256', key).update(text).digest('hex')}`,
    );
    expect(lines).not.toContain(`tasks_task_dependencies\t${sha256(text)}`);
  });

  it('a fresh --key-out key is written 0600; fingerprints under different keys FAIL', () => {
    const ownKey = join(keyRoot, 'own.key');
    const own = fingerprintFile(db.copy, 'ownKey', ['--key-out', ownKey]);
    expect(statSync(ownKey).mode & 0o777).toBe(0o600);
    expect(statSync(`${own.file}.rows`).mode & 0o777).toBe(0o600);
    expect(own.fp.keyId).not.toBe(fingerprint('source').fp.keyId);
    const r = compare(fingerprint('source').file, own.file, 'replay');
    expect(r.code).toBe(1);
    expect(r.out).toContain('fingerprints were made with different HMAC keys');
    // The same store under the shared key reproduces the source.
    expect(compare(fingerprint('source').file, fingerprint('copy').file, 'replay').code).toBe(0);
  });

  it('the .rows sidecar is written 0600 even when a wider file already exists', () => {
    const rowsFile = join(testRoot, 'wide.fp.json.rows');
    writeFileSync(rowsFile, '', { mode: 0o644 });
    chmodSync(rowsFile, 0o644);
    fingerprintFile(db.copy, 'wide');
    expect(statSync(rowsFile).mode & 0o777).toBe(0o600);
  });
});

describe('T12613: the WAL snapshot never outlives its use', () => {
  /** A copy of the source held live by a writer with autocheckpoint off, so its WAL stays non-empty. */
  function liveStore(name: string, walSql: string) {
    const dir = join(testRoot, name);
    const tmp = join(testRoot, `${name}-tmp`);
    mkdirSync(dir);
    mkdirSync(tmp);
    const file = join(dir, 'cleo.db');
    copyFileSync(db.source, file);
    const writer = openRaw(file);
    writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
    writer.exec(walSql);
    return { file, tmp, writer };
  }
  const run = (args: string[], tmp: string) =>
    spawn('node', [FINGERPRINT, '--role', 'replica', '--key-file', keyFile, ...args], {
      env: { ...process.env, TMPDIR: tmp },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const exited = (child: ReturnType<typeof spawn>) =>
    new Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }>((done) => {
      let out = '';
      child.stdout?.on('data', (d) => {
        out += String(d);
      });
      child.on('exit', (code, signal) => done({ code, signal, out }));
    });

  it('the snapshot is removed before the store is hashed', async () => {
    const live = liveStore(
      'live-fifo',
      "INSERT INTO brain_observations (id, type, title) VALUES ('O4', 'change', 'four')",
    );
    try {
      const fifo = join(testRoot, 'live-fifo.rows');
      execFileSync('mkfifo', [fifo]);
      const child = run(
        [
          '--db',
          live.file,
          '--label',
          'fifo',
          '--out',
          join(testRoot, 'fifo.json'),
          '--rows',
          fifo,
        ],
        live.tmp,
      );
      const done = exited(child);
      // Resolves when the child opens the sidecar, i.e. before it hashes any table.
      const reader = await open(fifo, 'r');
      expect(readdirSync(live.tmp)).toEqual([]);
      await reader.readFile();
      await reader.close();
      const r = await done;
      expect(r.code).toBe(0);
      expect(r.out).toContain('read from a VACUUM INTO snapshot');
    } finally {
      live.writer.close();
    }
  });

  it('a crash after the snapshot leaves no copy behind', async () => {
    const live = liveStore(
      'live-crash',
      "INSERT INTO brain_observations (id, type, title) VALUES ('O4', 'change', 'four')",
    );
    try {
      const out = join(testRoot, 'no-such-dir', 'crash.json');
      const r = await exited(run(['--db', live.file, '--label', 'crash', '--out', out], live.tmp));
      expect(r.code).not.toBe(0);
      expect(readdirSync(live.tmp)).toEqual([]);
    } finally {
      live.writer.close();
    }
  });

  it('SIGTERM during the copy removes the 0700 snapshot directory and exits 143', async () => {
    // 128 MiB in the WAL makes the VACUUM INTO copy long enough to signal it.
    const live = liveStore(
      'live-signal',
      `CREATE TABLE zz_bulk (b BLOB);
       WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 128)
       INSERT INTO zz_bulk SELECT randomblob(1048576) FROM n;`,
    );
    try {
      const child = run(
        ['--db', live.file, '--label', 'signal', '--out', join(testRoot, 'signal.json')],
        live.tmp,
      );
      const done = exited(child);
      let snapshotDir: string | undefined;
      const deadline = Date.now() + 30_000;
      while (!snapshotDir && Date.now() < deadline) {
        for (const d of readdirSync(live.tmp)) {
          if (existsSync(join(live.tmp, d, 'snapshot.db'))) snapshotDir = join(live.tmp, d);
        }
      }
      expect(snapshotDir).toBeDefined();
      expect(statSync(snapshotDir as string).mode & 0o777).toBe(0o700);
      child.kill('SIGTERM');
      const r = await done;
      expect(r.code).toBe(143);
      expect(readdirSync(live.tmp)).toEqual([]);
    } finally {
      live.writer.close();
    }
  }, 120_000);
});

/** Run the fingerprint script expecting a refusal; returns its stderr. */
function refusedFingerprint(args: string[]): string {
  try {
    execFileSync('node', [FINGERPRINT, '--db', db.copy, '--role', 'replica', ...args], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (e) {
    return (e as { stderr: string }).stderr;
  }
  throw new Error('fingerprint-store did not refuse');
}

describe('T12636: a per-table cap, and an explicit flag to wipe a table', () => {
  /** The 404-row fixture: the source plus observations up to 404 syncing rows, and a replica missing two whole tables. */
  function fixture404() {
    const base = fingerprint('source');
    const synced = Object.values(base.fp.tables)
      .filter((t) => t.shareable)
      .reduce((n, t) => n + (t.rows ?? 0), 0);
    const src = join(testRoot, 'src404.db');
    const rep = join(testRoot, 'rep404.db');
    if (!existsSync(src)) {
      copyFileSync(db.source, src);
      const conn = openRaw(src);
      const add = conn.prepare(
        "INSERT INTO brain_observations (id, type, title) VALUES (?, 'change', ?)",
      );
      for (let i = 0; i < 404 - synced; i++) add.run(`P${i}`, `padding ${i}`);
      conn.close();
      copyFileSync(src, rep);
      const wipe = openRaw(rep);
      wipe.exec('DELETE FROM tasks_task_dependencies; DELETE FROM tasks_tasks;');
      wipe.close();
    }
    const s = fingerprintFile(src, 'src404', undefined, 'source');
    const r = fingerprintFile(rep, 'rep404');
    const total = Object.values(s.fp.tables)
      .filter((t) => t.shareable)
      .reduce((n, t) => n + (t.rows ?? 0), 0);
    const lines = s.rows
      .split('\n')
      .filter((l) => l.startsWith('tasks_tasks\t') || l.startsWith('tasks_task_dependencies\t'));
    const allow = join(testRoot, 'tombstones404');
    writeFileSync(allow, `${lines.join('\n')}\n`);
    return { src: s.file, rep: r.file, total, tombstones: lines.length, allow };
  }

  it('4 tombstones under the global 1% cap cannot erase two whole tables of a 404-row store', () => {
    const f = fixture404();
    expect(f.total).toBe(404);
    expect(f.tombstones).toBe(4);
    const r = compare(f.src, f.rep, 'merge', ['--allow-deleted', f.allow]);
    expect(r.code).toBe(1);
    expect(r.out).not.toContain('over the --max-deleted cap'); // 4 ≤ ceil(1% of 404) = 5
    expect(r.out).toContain(
      "GATE B FAIL tasks_tasks: --allow-deleted holds 3 row(s) of this table's 3, over the --max-deleted-per-table cap of 1",
    );
    expect(r.out).toContain(
      'GATE B FAIL tasks_task_dependencies: --allow-deleted would delete all 1 source row(s); pass --allow-table-wipe tasks_task_dependencies if that is intended',
    );
  });

  it('with the per-table cap lifted a whole-table wipe still needs --allow-table-wipe, and is reported', () => {
    const f = fixture404();
    const lifted = ['--allow-deleted', f.allow, '--max-deleted-per-table', '3'];
    const r = compare(f.src, f.rep, 'merge', lifted);
    expect(r.code).toBe(1);
    expect(r.out).not.toContain('over the --max-deleted-per-table cap');
    expect(r.out).toContain(
      'GATE B FAIL tasks_tasks: --allow-deleted would delete all 3 source row(s); pass --allow-table-wipe tasks_tasks if that is intended',
    );

    const wipes = [
      '--allow-table-wipe',
      'tasks_tasks',
      '--allow-table-wipe',
      'tasks_task_dependencies',
    ];
    const ok = compare(f.src, f.rep, 'merge', [...lifted, ...wipes]);
    expect(ok.out).toContain('PASS (merge)');
    expect(ok.out).toContain(
      'WARNING: --allow-table-wipe: EVERY source row of tasks_tasks was deleted',
    );
    expect(ok.out).toContain(
      'WARNING: --allow-table-wipe: EVERY source row of tasks_task_dependencies was deleted',
    );
  });
});

describe('T12636: every fingerprint JSON is signed with the comparison key', () => {
  it('an edited rowsFile or count FAILS the MAC', () => {
    const src = fingerprint('source');
    const copy = fingerprint('copy');
    const fp = JSON.parse(copy.raw) as Fingerprint;
    const editedRows = join(testRoot, 'edited-rows.fp.json');
    writeFileSync(editedRows, JSON.stringify({ ...fp, rowsFile: 'source.fp.json.rows' }));
    const r1 = compare(src.file, editedRows, 'merge');
    expect(r1.code).toBe(1);
    expect(r1.out).toContain(
      'GATE B FAIL *: replica fingerprint MAC does not verify under --key-file (edited, or made with another key)',
    );

    const editedCount = join(testRoot, 'edited-count.fp.json');
    fp.tables.tasks_tasks.rows = 4;
    writeFileSync(editedCount, JSON.stringify(fp));
    const r2 = compare(editedCount, src.file, 'replay');
    expect(r2.code).toBe(1);
    expect(r2.out).toContain('GATE B FAIL *: source fingerprint MAC does not verify');
  });

  it('an untouched fingerprint verifies, and without --key-file nothing is trusted', () => {
    const src = fingerprint('source');
    expect(src.fp.mac).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(signed(src.fp)).mac).toBe(src.fp.mac);
    let out = '';
    try {
      execFileSync('node', [COMPARE, '--source', src.file, '--replica', fingerprint('copy').file], {
        encoding: 'utf8',
      });
    } catch (e) {
      out = (e as { stdout: string }).stdout;
    }
    expect(out).toContain('GATE B FAIL *: no --key-file: the fingerprint MACs cannot be verified');
  });
});

describe('T12636: a new key never lands beside the fingerprints', () => {
  it('requires exactly one of --key-file or --key-out', () => {
    const out = join(testRoot, 'nokey.fp.json');
    expect(refusedFingerprint(['--out', out])).toContain(
      'pass exactly one of --key-file <existing> or --key-out <new>',
    );
    expect(existsSync(out)).toBe(false);
  });

  it('refuses --key-out in the directory of --out or --rows', () => {
    const out = join(testRoot, 'beside.fp.json');
    expect(refusedFingerprint(['--out', out, '--key-out', join(testRoot, 'beside.key')])).toContain(
      'refusing --key-out inside the directory tree of --out or --rows',
    );
    const rowsDir = join(testRoot, 'rowsdir');
    mkdirSync(rowsDir, { recursive: true });
    // --out lives outside testRoot here, so only the --rows tree can refuse.
    mkdirSync(join(keyRoot, 'outs'), { recursive: true });
    expect(
      refusedFingerprint([
        '--out',
        join(keyRoot, 'outs', 'keys-elsewhere.fp.json'),
        '--rows',
        join(rowsDir, 'x.rows'),
        '--key-out',
        join(rowsDir, 'x.key'),
      ]),
    ).toContain('refusing --key-out inside the directory tree of --out or --rows');
    expect(existsSync(join(testRoot, 'beside.key'))).toBe(false);
    expect(existsSync(join(rowsDir, 'x.key'))).toBe(false);
  });

  it('never overwrites an existing key', () => {
    const existing = join(keyRoot, 'existing.key');
    writeFileSync(existing, 'k'.repeat(64));
    const stderr = refusedFingerprint([
      '--out',
      join(testRoot, 'overwrite.fp.json'),
      '--key-out',
      existing,
    ]);
    expect(stderr).toContain('EEXIST');
    expect(readFileSync(existing, 'utf8')).toBe('k'.repeat(64));
  });
});

describe('T12341: row uids', () => {
  /** A copy of the source as it was before the uid migration: no identity columns, tables or trigger. */
  function preMigrationCopy(label: string): string {
    const file = join(testRoot, `${label}.db`);
    copyFileSync(db.source, file);
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

  it('the migration changes no replicated value: pre replays post with --omit-row-identity', () => {
    const pre = fingerprintFile(preMigrationCopy('preUid'), 'preUid', undefined, 'source');
    const post = fingerprintFile(db.source, 'postUidOmitted', [
      '--key-file',
      keyFile,
      '--omit-row-identity',
    ]);
    expect(post.fp.tables.tasks_tasks?.columns).not.toContain('uid');
    const ok = compare(pre.file, post.file, 'replay');
    expect(ok.out).toContain('PASS (replay)');
    expect(ok.code).toBe(0);
    const withUids = compare(pre.file, fingerprint('source').file, 'replay');
    expect(withUids.code).toBe(1);
  });

  it('the backfill is deterministic: two independent migrations fingerprint identically', () => {
    const one = preMigrationCopy('migratedOne');
    const two = preMigrationCopy('migratedTwo');
    migrate(one);
    migrate(two);
    const a = fingerprintFile(one, 'migratedOne', undefined, 'source');
    const b = fingerprintFile(two, 'migratedTwo');
    expect(a.fp.tables.tasks_tasks?.columns).toContain('uid');
    const r = compare(a.file, b.file, 'replay');
    expect(r.out).toContain('PASS (replay)');
    expect(r.code).toBe(0);
    // The source's rows were inserted without a uid on a connection with the
    // per-connection trigger: they got the same uids the backfill derives.
    const same = compare(
      fingerprint('source').file,
      fingerprintFile(one, 'migratedOneAsReplica').file,
      'replay',
    );
    expect(same.out).toContain('PASS (replay)');
    expect(same.code).toBe(0);
  });
});

describe('T12341: pre-release identity values are cleared and re-derived', () => {
  it('a store filled by a pre-release build (no recipe marker) refills deterministically, changing nothing else', () => {
    // A copy of the source as a pre-release build left it: other uid and
    // fingerprint values, no recipe marker.
    const stale = (label: string) => {
      const file = join(testRoot, `${label}.db`);
      copyFileSync(db.source, file);
      const conn = openRaw(file);
      // The pre-release (v4/v5) recipe's fingerprints, as live cleocode got them.
      const set = conn.prepare('UPDATE tasks_tasks SET birth_fp = ? WHERE rowid = ?');
      for (const row of conn.prepare('SELECT rowid AS r, * FROM tasks_tasks').all() as Array<
        Record<string, string | null> & { r: number }
      >) {
        set.run(preReleaseBirthFp(conn, 'tasks_tasks', row), row.r);
      }
      conn.exec('DELETE FROM tasks_row_identity_meta');
      conn.close();
      return file;
    };
    const refill = (file: string) => {
      const conn = openRaw(file);
      try {
        expect(prepareRowIdentity(conn, 'project')?.refill).toBe('cleared');
      } finally {
        conn.close();
      }
    };
    const one = stale('staleOne');
    const two = stale('staleTwo');
    const pre = fingerprintFile(
      one,
      'staleOnePre',
      ['--key-file', keyFile, '--omit-row-identity'],
      'source',
    );
    refill(one);
    refill(two);
    // Nothing but identity changed.
    const post = fingerprintFile(one, 'staleOnePost', [
      '--key-file',
      keyFile,
      '--omit-row-identity',
    ]);
    const same = compare(pre.file, post.file, 'replay');
    expect(same.out).toContain('PASS (replay)');
    expect(same.code).toBe(0);
    // Two independent refills agree, and match a store that never had stale values.
    const a = fingerprintFile(one, 'refilledOne', undefined, 'source');
    const b = fingerprintFile(two, 'refilledTwo');
    const det = compare(a.file, b.file, 'replay');
    expect(det.out).toContain('PASS (replay)');
    expect(det.code).toBe(0);
    const fresh = compare(a.file, fingerprint('copy').file, 'replay');
    expect(fresh.out).toContain('PASS (replay)');
    expect(fresh.code).toBe(0);
  });
});

describe('T12641: --key-out is refused anywhere inside the --out/--rows tree', () => {
  it('refuses a key in a subdirectory of the --out directory', () => {
    const sub = join(testRoot, 'sub', 'deeper');
    mkdirSync(sub, { recursive: true });
    const stderr = refusedFingerprint([
      '--out',
      join(testRoot, 'subcase.fp.json'),
      '--key-out',
      join(sub, 'y.key'),
    ]);
    expect(stderr).toContain('refusing --key-out inside the directory tree of --out or --rows');
    expect(existsSync(join(sub, 'y.key'))).toBe(false);
  });

  it('refuses a key that reaches the tree through a symlink, either way round', () => {
    // The key path goes through a link that points into the --out directory.
    const intoOut = join(keyRoot, 'link-into-out');
    symlinkSync(testRoot, intoOut);
    expect(
      refusedFingerprint([
        '--out',
        join(testRoot, 'linkcase.fp.json'),
        '--key-out',
        join(intoOut, 'z.key'),
      ]),
    ).toContain('refusing --key-out inside the directory tree of --out or --rows');
    expect(existsSync(join(testRoot, 'z.key'))).toBe(false);

    // The --out path goes through a link whose target contains the key directory.
    const outsReal = join(testRoot, 'outs-real');
    mkdirSync(join(outsReal, 'keys'), { recursive: true });
    const outLink = join(keyRoot, 'outs-link');
    symlinkSync(outsReal, outLink);
    expect(
      refusedFingerprint([
        '--out',
        join(outLink, 'o.fp.json'),
        '--key-out',
        join(outsReal, 'keys', 'k.key'),
      ]),
    ).toContain('refusing --key-out inside the directory tree of --out or --rows');
    expect(existsSync(join(outsReal, 'keys', 'k.key'))).toBe(false);
  });
});

describe('T12641: each fingerprint is bound to a run identity', () => {
  /** A copy of the source at `<name>/.cleo/cleo.db`, with `.cleo/project-id` when an id is given. */
  function projectStore(name: string, projectId?: string) {
    const cleoDir = join(testRoot, name, '.cleo');
    mkdirSync(cleoDir, { recursive: true });
    const file = join(cleoDir, 'cleo.db');
    if (!existsSync(file)) copyFileSync(db.source, file);
    if (projectId) writeFileSync(join(cleoDir, 'project-id'), `# test identity\n${projectId}\n`);
    return file;
  }

  it('the genuine, signed source fingerprint copied in as the replica FAILS', () => {
    const src = fingerprint('source');
    expect(src.fp.identity?.nonce).toMatch(/^[0-9a-f]{32}$/);
    const dup = join(testRoot, 'source-dup.fp.json');
    copyFileSync(src.file, dup); // its rowsFile still names the source sidecar beside it
    for (const mode of ['replay', 'merge'] as const) {
      const r = compare(src.file, dup, mode);
      expect(r.code).toBe(1);
      expect(r.out).toContain(
        "GATE B FAIL *: the replica carries the source's nonce: it is the source fingerprint, or a copy of it",
      );
      expect(r.out).not.toContain('MAC does not verify');
    }
  });

  it('a replica of the same project compares normally; another project FAILS', () => {
    const a = fingerprintFile(projectStore('projA', 'a1b2c3d4e5f6'), 'projA', undefined, 'source');
    const a2 = fingerprintFile(projectStore('projA2', 'a1b2c3d4e5f6'), 'projA2');
    expect(a.fp.identity?.projectId).toBe('a1b2c3d4e5f6');
    expect(a2.fp.identity?.nonce).not.toBe(a.fp.identity?.nonce);
    const same = compare(a.file, a2.file, 'replay');
    expect(same.out).toContain('PASS (replay)');
    expect(same.code).toBe(0);

    const b = fingerprintFile(projectStore('projB', 'f6e5d4c3b2a1'), 'projB');
    const other = compare(a.file, b.file, 'replay');
    expect(other.code).toBe(1);
    expect(other.out).toContain(
      'GATE B FAIL *: the replica belongs to another project (a1b2c3d4e5f6 vs f6e5d4c3b2a1)',
    );
  });

  it('an operator-supplied nonce reused for the replica FAILS, and a bad project-id is refused', () => {
    const nonce = ['--nonce', 'operator-run-0001'];
    const a = fingerprintFile(db.source, 'nonceA', ['--key-file', keyFile, ...nonce], 'source');
    const b = fingerprintFile(db.copy, 'nonceB', ['--key-file', keyFile, ...nonce]);
    const r = compare(a.file, b.file, 'replay');
    expect(r.code).toBe(1);
    expect(r.out).toContain("the replica carries the source's nonce");

    const badDir = join(testRoot, 'badid');
    mkdirSync(badDir, { recursive: true });
    copyFileSync(db.source, join(badDir, 'cleo.db'));
    writeFileSync(join(badDir, 'project-id'), '../etc\n');
    let stderr = '';
    try {
      execFileSync(
        'node',
        [
          FINGERPRINT,
          '--db',
          join(badDir, 'cleo.db'),
          '--role',
          'replica',
          '--out',
          join(testRoot, 'badid.fp.json'),
          '--key-file',
          keyFile,
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      );
    } catch (e) {
      stderr = (e as { stderr: string }).stderr;
    }
    expect(stderr).toContain('unusable project-id file');
  });
});

describe('T12641 round 2: roles, fail-closed project id, missing nonce', () => {
  it('swapped --source and --replica FAIL on the recorded roles', () => {
    const r = compare(fingerprint('copy').file, fingerprint('source').file, 'replay');
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      'GATE B FAIL *: wrong fingerprint roles: --source is replica, --replica is source (expected source, replica)',
    );
  });

  it('a replica fingerprint with no nonce FAILS, even when correctly signed', () => {
    const src = fingerprint('source');
    const copy = fingerprint('copy');
    const { nonce: _nonce, ...identity } = copy.fp.identity ?? { nonce: '' };
    const noNonce = join(testRoot, 'no-nonce.fp.json');
    writeFileSync(noNonce, signed({ ...copy.fp, identity: identity as Fingerprint['identity'] }));
    const r = compare(src.file, noNonce, 'replay');
    expect(r.code).toBe(1);
    expect(r.out).toContain('GATE B FAIL *: a fingerprint has no store identity nonce');
    expect(r.out).not.toContain('MAC does not verify');
  });

  it('a project id on one side only FAILS (fail closed), and so do two missing ids', () => {
    const noIdDir = join(testRoot, 'noid');
    mkdirSync(noIdDir, { recursive: true });
    const noIdDb = join(noIdDir, 'cleo.db');
    if (!existsSync(noIdDb)) copyFileSync(db.copy, noIdDb);
    const noId = fingerprintFile(noIdDb, 'noid');
    expect(noId.fp.identity?.projectId).toBeNull();

    const oneSided = compare(fingerprint('source').file, noId.file, 'replay');
    expect(oneSided.code).toBe(1);
    expect(oneSided.out).toContain(
      `GATE B FAIL *: project id missing (source ${TEST_PROJECT_ID}, replica none)`,
    );

    const noIdSource = fingerprintFile(noIdDb, 'noid-source', undefined, 'source');
    const noIdReplica = fingerprintFile(noIdDb, 'noid-replica');
    const neither = compare(noIdSource.file, noIdReplica.file, 'replay');
    expect(neither.code).toBe(1);
    expect(neither.out).toContain('GATE B FAIL *: project id missing (source none, replica none)');
  });
});

describe('T12641 round 2: containment compares file identity, not spelling', () => {
  // A simulated case-insensitive filesystem: names fold to lower case for identity.
  const folding = {
    realpath: (p: string) => p,
    stat: (p: string) => ({ dev: 1, ino: p.toLowerCase() as unknown as number }),
  };
  // A simulated case-sensitive filesystem: every spelling is its own directory.
  const sensitive = {
    realpath: (p: string) => p,
    stat: (p: string) => ({ dev: 1, ino: p as unknown as number }),
  };

  it('a differently cased path to the --out directory is inside it (simulated, host-independent)', () => {
    expect(isInsideDirectoryTree('/d/out/k1', '/d/Out', folding)).toBe(true);
    expect(isInsideDirectoryTree('/d/OUT/sub/k1', '/d/Out', folding)).toBe(true);
    expect(isInsideDirectoryTree('/d/out/k1', '/d/Out', sensitive)).toBe(false);
    expect(isInsideDirectoryTree('/d/keys/k1', '/d/Out', folding)).toBe(false);
  });

  it.skipIf(
    // Real filesystem check: only meaningful where the host folds case (macOS/Windows default).
    (() => {
      const probe = join(tmpdir(), `case-probe-${process.pid}-A`);
      mkdirSync(probe, { recursive: true });
      const folds = existsSync(probe.replace(/-A$/, '-a'));
      rmSync(probe, { recursive: true, force: true });
      return !folds;
    })(),
  )(
    'refuses --key-out <d>/out/k1 when --out is <d>/Out/fp.json on a case-folding filesystem',
    () => {
      const d = join(keyRoot, 'casefold');
      mkdirSync(join(d, 'Out'), { recursive: true });
      const stderr = refusedFingerprint([
        '--out',
        join(d, 'Out', 'fp.json'),
        '--key-out',
        join(d, 'out', 'k1'),
      ]);
      expect(stderr).toContain('refusing --key-out inside the directory tree of --out or --rows');
      expect(readdirSync(join(d, 'Out'))).toEqual([]);
    },
  );
});

describe('T12641 round 3: scope is part of the identity', () => {
  /** Fingerprint a store in an explicit scope and role. */
  function scoped(dbFile: string, label: string, scope: 'project' | 'global', role: Role) {
    const file = join(testRoot, `${label}.fp.json`);
    execFileSync(
      'node',
      [
        FINGERPRINT,
        '--db',
        dbFile,
        '--label',
        label,
        '--out',
        file,
        '--role',
        role,
        '--scope',
        scope,
        '--key-file',
        keyFile,
      ],
      { encoding: 'utf8' },
    );
    return { file, fp: JSON.parse(readFileSync(file, 'utf8')) as Fingerprint & { scope: string } };
  }
  /** The global cleo.db the runtime built under CLEO_HOME, and a copy of it in its own directory. */
  function globalStores() {
    const globalDb = join(testRoot, 'cleo', 'cleo.db');
    const copyDir = join(testRoot, 'global-replica');
    const copy = join(copyDir, 'cleo.db');
    if (!existsSync(copy)) {
      mkdirSync(copyDir, { recursive: true });
      const conn = new DatabaseSync(globalDb, { readOnly: true });
      conn.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
      conn.close();
    }
    expect(existsSync(join(testRoot, 'cleo', 'project-id'))).toBe(false);
    return { globalDb, copy };
  }

  it('a global store against its replica PASSES without a project id', () => {
    const { globalDb, copy } = globalStores();
    const src = scoped(globalDb, 'global-src', 'global', 'source');
    const rep = scoped(copy, 'global-rep', 'global', 'replica');
    expect(src.fp.scope).toBe('global');
    expect(src.fp.identity?.projectId).toBeNull();
    const r = compare(src.file, rep.file, 'replay');
    expect(r.out).toContain('PASS (replay)');
    expect(r.code).toBe(0);
  });

  it('a global fingerprint never compares against a project one, either way round', () => {
    const { globalDb } = globalStores();
    const g = scoped(globalDb, 'global-src2', 'global', 'source');
    const gRep = scoped(globalDb, 'global-rep2', 'global', 'replica');
    const p = fingerprint('source');
    const pRep = fingerprint('copy');
    for (const [source, replica, s, r] of [
      [g.file, pRep.file, 'global', 'project'],
      [p.file, gRep.file, 'project', 'global'],
    ]) {
      const out = compare(source, replica, 'replay');
      expect(out.code).toBe(1);
      expect(out.out).toContain(
        `GATE B FAIL *: scopes differ or are unknown (source ${s}, replica ${r}): a project store never compares against the global store`,
      );
    }
  });

  it('the scope is under the MAC: flipping it FAILS', () => {
    const p = fingerprint('copy');
    const flipped = join(testRoot, 'scope-flipped.fp.json');
    writeFileSync(flipped, JSON.stringify({ ...JSON.parse(p.raw), scope: 'global' }));
    const r = compare(fingerprint('source').file, flipped, 'replay');
    expect(r.code).toBe(1);
    expect(r.out).toContain('GATE B FAIL *: replica fingerprint MAC does not verify');
  });
});
