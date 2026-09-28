/**
 * Gates B and C tooling — `scripts/fingerprint-store.mjs` and
 * `scripts/compare-fingerprints.mjs` against a real migrated store (T12332).
 *
 * A fresh project `cleo.db` is built through the runtime path (the dual-scope
 * chokepoint plus every lineage-running domain binder) and seeded with a small
 * task graph. It is copied with `VACUUM INTO`, then:
 *
 *   - an untouched copy must PASS `--mode replay` (the fingerprint is
 *     deterministic, and a faithful copy reproduces it);
 *   - a copy missing one row of a portable table must FAIL `--mode replay`
 *     (Gate B);
 *   - a copy with a new dependency cycle must FAIL `--mode merge` (Gate C,
 *     "no increase" over the source's rule-violation counts).
 *
 * The scripts run as real child processes, exactly as an operator runs them.
 * Every fingerprint is checked for the store's path: they must never record one.
 *
 * @task T12332
 * @epic T12322
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bindConduitDomain } from '../conduit-sqlite.js';
import { _resetDualScopeDbCache, openDualScopeDb } from '../dual-scope-db.js';
import { getBrainDb } from '../memory-sqlite.js';
import { getNexusDb } from '../nexus-sqlite.js';
import { getDb } from '../sqlite.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const FINGERPRINT = join(REPO_ROOT, 'scripts', 'fingerprint-store.mjs');
const COMPARE = join(REPO_ROOT, 'scripts', 'compare-fingerprints.mjs');

let testRoot: string;
const db: Record<'source' | 'copy' | 'lostRow' | 'cycle', string> = {
  source: '',
  copy: '',
  lostRow: '',
  cycle: '',
};

interface Fingerprint {
  store: string;
  vecLoaded: boolean;
  tables: Record<string, { class: string; shareable: boolean; rows?: number; sha256?: string }>;
  invariants: Record<string, number>;
}

/** Fingerprint one store; returns the parsed JSON and its path. */
function fingerprint(name: keyof typeof db): { fp: Fingerprint; file: string; raw: string } {
  const file = join(testRoot, `${name}.fp.json`);
  execFileSync('node', [FINGERPRINT, '--db', db[name], '--label', name, '--out', file], {
    encoding: 'utf8',
  });
  const raw = readFileSync(file, 'utf8');
  return { fp: JSON.parse(raw) as Fingerprint, file, raw };
}

/** Run the comparator; returns its exit code and stdout. */
function compare(source: string, replica: string, mode: 'replay' | 'merge') {
  try {
    const out = execFileSync(
      'node',
      [COMPARE, '--source', source, '--replica', replica, '--mode', mode],
      { encoding: 'utf8' },
    );
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { code: err.status, out: err.stdout };
  }
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
    INSERT INTO tasks_tasks (id, title, type, status, parent_id) VALUES ('T2', 'First', 'task', 'pending', 'T1');
    INSERT INTO tasks_tasks (id, title, type, status, parent_id) VALUES ('T3', 'Second', 'task', 'pending', 'T1');
    INSERT INTO tasks_task_dependencies (task_id, depends_on) VALUES ('T3', 'T2');
  `);

  db.source = handle.dbPath;
  for (const name of ['copy', 'lostRow', 'cycle'] as const) {
    db[name] = join(testRoot, `${name}.db`);
    native.exec(`VACUUM INTO '${db[name].replaceAll("'", "''")}'`);
  }
  // Close every handle so the source file is checkpointed before it is read.
  _resetDualScopeDbCache();

  const lost = new DatabaseSync(db.lostRow);
  lost.exec("DELETE FROM tasks_task_dependencies WHERE task_id = 'T3'");
  lost.close();

  const cycle = new DatabaseSync(db.cycle);
  cycle.exec("INSERT INTO tasks_task_dependencies (task_id, depends_on) VALUES ('T2', 'T3')");
  cycle.close();
}, 300_000);

afterAll(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(testRoot, { recursive: true, force: true });
});

describe('fingerprint-store', () => {
  it('classifies from the Gate A registry and hashes every syncing table', () => {
    const { fp } = fingerprint('source');
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
  });

  it('never records a path', () => {
    for (const name of ['source', 'copy'] as const) {
      const { raw, fp } = fingerprint(name);
      expect(fp.store).toBe(name);
      expect(raw).not.toContain(testRoot);
      expect(raw).not.toContain(tmpdir());
    }
  });
});

describe('compare-fingerprints', () => {
  it('replay: a VACUUM INTO copy reproduces the source (PASS)', () => {
    const r = compare(fingerprint('source').file, fingerprint('copy').file, 'replay');
    expect(r.out).toContain('PASS (replay)');
    expect(r.code).toBe(0);
  });

  it('replay: a lost row in a portable table FAILS Gate B', () => {
    const r = compare(fingerprint('source').file, fingerprint('lostRow').file, 'replay');
    expect(r.code).toBe(1);
    expect(r.out).toContain('GATE B FAIL tasks_task_dependencies: rows 1 → 0');
  });

  it('merge: a new dependency cycle FAILS Gate C', () => {
    const { fp } = fingerprint('cycle');
    expect(fp.invariants.dependencyCycles).toBeGreaterThan(0);
    const r = compare(fingerprint('source').file, fingerprint('cycle').file, 'merge');
    expect(r.code).toBe(1);
    expect(r.out).toContain('GATE C FAIL dependencyCycles: 0 →');
  });

  it('merge: changed content alone does not fail (only Gate C and dangling refs are held)', () => {
    const r = compare(fingerprint('source').file, fingerprint('lostRow').file, 'merge');
    expect(r.out).toContain('PASS (merge)');
    expect(r.code).toBe(0);
  });
});
