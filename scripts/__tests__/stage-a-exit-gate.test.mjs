/**
 * Tests for scripts/stage-a-exit-gate.mjs (T12328).
 *
 * Two layers:
 *   - the gate's decisions (`evaluateStore`, `parseArgs`) as pure functions;
 *   - one end-to-end run of the REAL gate, driven through the built CLI,
 *     against a fixture whose data sits only in legacy stores — the shape that
 *     stranded ~21 real projects (T12319) and that the gate exists to catch.
 *
 * The fixture's empty-shell `cleo.db` is created by the CLI itself (a read
 * with the on-open migration switched off), not hand-built, so it carries the
 * real migrations.
 *
 * @task T12328
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluateStore, main, parseArgs } from '../stage-a-exit-gate.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(REPO_ROOT, 'packages', 'cleo', 'bin', 'cleo.js');

/** A passing per-store result; each test breaks one thing. */
function passing() {
  return {
    export: { rc: 0 },
    import: { rc: 0, lossless: true },
    projectId: { source: 'p1', restored: 'p1' },
    reconcile: {
      rc: 0,
      tasks: { expected: 2, actual: 2 },
      observations: { expected: 3, actual: 3 },
    },
  };
}

describe('evaluateStore', () => {
  it('passes a clean round trip', () => {
    expect(evaluateStore(passing())).toEqual([]);
  });

  it('fails when import is not lossless even with rc 0', () => {
    const r = passing();
    r.import.lossless = false;
    expect(evaluateStore(r)).toEqual(['import did not report lossless:true']);
  });

  it('fails when lossless is missing — absence is not a pass', () => {
    const r = passing();
    r.import.lossless = null;
    expect(evaluateStore(r)).toHaveLength(1);
  });

  it('fails when projectId changes', () => {
    const r = passing();
    r.projectId.restored = 'p2';
    expect(evaluateStore(r)[0]).toContain('projectId changed');
  });

  it('fails when reconcile leaves counts short, or the expectation is unknowable', () => {
    const r = passing();
    r.reconcile.tasks.actual = 0;
    r.reconcile.observations.expected = null;
    expect(evaluateStore(r)).toEqual([
      'tasks after reconcile: expected 2, got 0',
      'observations after reconcile: expected null, got 3',
    ]);
  });
});

describe('parseArgs', () => {
  it('defaults to the four Stage A stores, reconciling llmtxt and claude-todo', () => {
    const o = parseArgs([]);
    expect(o.stores.map((s) => `${s.name}:${s.reconcile}`)).toEqual([
      'axiom-analytics:false',
      'cleocode:false',
      'llmtxt:true',
      'claude-todo:true',
    ]);
  });

  it('takes explicit stores and reconcile names', () => {
    const o = parseArgs(['--store', 'a=/x/a', '--store', 'b=/x/b', '--reconcile', 'b']);
    expect(o.stores).toEqual([
      { name: 'a', root: '/x/a', reconcile: false },
      { name: 'b', root: '/x/b', reconcile: true },
    ]);
  });

  it('rejects malformed input', () => {
    expect(() => parseArgs(['--store', 'nameonly'])).toThrow();
    expect(() => parseArgs(['--bogus'])).toThrow();
  });
});

describe('end-to-end against a stranded-legacy fixture', () => {
  let root;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'cleo-t12328-'));
    const proj = path.join(root, 'fixture');
    const cleo = path.join(proj, '.cleo');
    mkdirSync(cleo, { recursive: true });
    mkdirSync(path.join(proj, '.git'));
    writeFileSync(
      path.join(cleo, 'project-info.json'),
      JSON.stringify({ projectId: 'fixture-proj-1', name: 'fixture' }),
    );
    const tasks = new DatabaseSync(path.join(cleo, 'tasks.db'));
    tasks.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', priority TEXT NOT NULL DEFAULT 'medium',
      type TEXT, parent_id TEXT, pipeline_stage TEXT, archive_reason TEXT, created_at TEXT NOT NULL);
      INSERT INTO tasks VALUES
        ('T1','epic','active','high','epic',NULL,NULL,NULL,'2026-01-01T00:00:00Z'),
        ('T2','task','pending','medium','task','T1',NULL,NULL,'2026-01-02T00:00:00Z');`);
    tasks.close();
    const brain = new DatabaseSync(path.join(cleo, 'brain.db'));
    brain.exec(`CREATE TABLE brain_observations (id TEXT PRIMARY KEY, type TEXT NOT NULL,
      title TEXT NOT NULL, created_at TEXT NOT NULL, valid_at TEXT);
      INSERT INTO brain_observations VALUES
        ('O1','discovery','a','2026-02-01 10:00:00',NULL),
        ('O2','discovery','b','2026-02-02 10:00:00','2026-02-02 10:00:00'),
        ('O3','discovery','c','2026-02-03 10:00:00',NULL);`);
    brain.close();
    // Let the CLI create the empty-shell cleo.db with real migrations, the
    // on-open migration switched off: the measured stranded state.
    const env = {
      ...process.env,
      HOME: root,
      CLEO_HOME: path.join(root, 'h'),
      CLEO_CONFIG_HOME: path.join(root, 'c'),
      CLEO_DISABLE_EXODUS_ON_OPEN: '1',
    };
    delete env.CLEO_DIR;
    delete env.CLEO_ROOT;
    spawnSync(process.execPath, [CLI, 'list', '--output', 'count'], { cwd: proj, env });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.skipIf(!existsSync(CLI))(
    'exports, restores at a new path, reconciles and passes',
    () => {
      expect(existsSync(path.join(root, 'fixture', '.cleo', 'cleo.db'))).toBe(true);
      const chunks = [];
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = (c) => {
        chunks.push(String(c));
        return true;
      };
      let rc;
      try {
        rc = main([
          '--store',
          `fixture=${path.join(root, 'fixture')}`,
          '--reconcile',
          'fixture',
          '--work',
          path.join(root, 'work'),
        ]);
      } finally {
        process.stdout.write = write;
      }
      const summary = JSON.parse(chunks.join(''));
      const store = summary.stores[0];
      expect(store.failures).toEqual([]);
      expect(rc).toBe(0);
      expect(store.export.unmigratedLegacyData).toBe(true);
      expect(store.import.lossless).toBe(true);
      expect(store.relocatedTo).not.toBe(store.source);
      expect(store.projectId).toEqual({ source: 'fixture-proj-1', restored: 'fixture-proj-1' });
      expect(store.reconcile.before).toEqual({ tasks: 0, observations: 0 });
      expect(store.reconcile.tasks).toEqual({ expected: 2, actual: 2 });
      expect(store.reconcile.observations).toEqual({ expected: 3, actual: 3 });
      // The fixture source is never written by the gate: no reconciled rows there.
      const src = new DatabaseSync(path.join(root, 'fixture', '.cleo', 'cleo.db'), {
        readOnly: true,
      });
      const n = src.prepare('SELECT COUNT(*) AS n FROM tasks_tasks').get();
      src.close();
      expect(Number(n.n)).toBe(0);
    },
    180_000,
  );
});
