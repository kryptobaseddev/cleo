/**
 * Gate (R7-6, T13193 R-4a): every guard trigger and post-apply check declares
 * the rows it reads, so a scoped rebase can widen its footprint by them.
 *
 * @task T13193
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { LedgerOp } from '@cleocode/contracts/ledger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
} from '../../../dual-scope-db.js';
import { captureTableDef, setCaptureEnabled } from '../../capture.js';
import { classifyStoreTriggers, OWNED_TRIGGERS } from '../../trigger-classes.js';
import { GUARD_FOOTPRINTS, POST_APPLY_FOOTPRINTS, widenFootprint } from '../footprints.js';
import { checkTaskTreeShape } from '../post-apply.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../../migrations/sync-journal');
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-footprints-'));
  mkdirSync(join(dir, 'cleo'), { recursive: true });
  mkdirSync(join(dir, 'p', '.cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(dir, 'cleo'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
});

afterEach(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function store(): Promise<DatabaseSync> {
  const db = getDualScopeNativeDb(
    await openDualScopeDbAtPath('project', join(dir, 'p', '.cleo', 'cleo.db')),
  );
  setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
  return db;
}

describe('declared footprints (R7-6)', () => {
  it('every guard trigger of a fresh store declares its footprint, on its own table', async () => {
    const db = await store();
    const guards = classifyStoreTriggers(db, 'project').classified.filter(
      (t) => t.class === 'guard',
    );
    expect(guards.length).toBeGreaterThan(0);
    const missing = guards.filter((g) => GUARD_FOOTPRINTS[g.name] === undefined).map((g) => g.name);
    expect(missing, 'guard triggers without a declared footprint').toEqual([]);
    for (const g of guards) {
      expect(GUARD_FOOTPRINTS[g.name]?.table, g.name).toBe(g.table);
    }
  });

  it('declares no footprint for a guard that no longer exists', () => {
    const owned = Object.entries(OWNED_TRIGGERS)
      .filter(([, cls]) => cls === 'guard')
      .map(([name]) => name);
    const stale = Object.keys(GUARD_FOOTPRINTS).filter((name) => !owned.includes(name));
    expect(stale, 'footprints declared for unknown guards').toEqual([]);
  });

  it('every post-apply check the apply runs declares its footprint', async () => {
    const db = await store();
    // The INSERT cycle guard misses a self-parent (§3.6.3 item 2); PAC-01 catches it.
    db.exec(
      "INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp, parent_id) VALUES ('T1', 'self', NULL, 'pending', 'medium', 'u1', 'fp-u1', 'T1')",
    );
    const checks = checkTaskTreeShape(db, [
      { table: 'tasks_tasks', uid: 'u1', typeChanged: false },
    ]);
    expect(checks.length).toBeGreaterThan(0);
    for (const v of checks) expect(Object.keys(POST_APPLY_FOOTPRINTS)).toContain(v.check);
  });

  it('widens a footprint by the parent chain, the children and the dependency closure', async () => {
    const db = await store();
    const task = (id: string, parent: string | null) =>
      db.exec(
        `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp, parent_id) VALUES ('${id}', '${id}', NULL, 'pending', 'medium', '${id.toLowerCase()}', 'fp-${id}', ${parent ? `'${parent}'` : 'NULL'})`,
      );
    task('TR', null);
    task('TP', 'TR');
    task('TK', 'TP');
    task('TQ', null);
    db.exec(
      "INSERT INTO tasks_task_dependencies (task_id, depends_on) VALUES ('TP', 'TR'), ('TR', 'TQ')",
    );
    const defs = (t: string) => captureTableDef(db, 'project', t) ?? null;
    const widened = (op: LedgerOp) => {
      const out = new Set<string>();
      widenFootprint(db, [op], defs, (t, u) => out.add(`${t}:${u}`));
      return [...out].sort();
    };
    const h = '1791000000000-000000-0192aaaa-7f00-7000-8000-00000000000a';
    // Re-parenting TQ under TP reads TP's whole chain (the cycle guard).
    expect(widened({ t: 'tasks_tasks', u: 'tq', o: 'U', h, a: { parent_id: 'tp' } })).toEqual(
      expect.arrayContaining(['tasks_tasks:tp', 'tasks_tasks:tr']),
    );
    // Retyping TP reads its children (PAC-01).
    expect(widened({ t: 'tasks_tasks', u: 'tp', o: 'U', h, a: { type: 'epic' } })).toContain(
      'tasks_tasks:tk',
    );
    // A status edit reads nothing beyond its row.
    expect(widened({ t: 'tasks_tasks', u: 'tp', o: 'U', h, a: { status: 'active' } })).toEqual([]);
    // A new edge onto TP reads everything TP reaches (the dependency cycle guard).
    expect(
      widened({
        t: 'tasks_task_dependencies',
        u: 'edge',
        o: 'I',
        h,
        a: { task_id: 'tk', depends_on: 'tp' },
      }),
    ).toEqual(expect.arrayContaining(['tasks_tasks:tp', 'tasks_tasks:tr', 'tasks_tasks:tq']));
  });

  it('widens a footprint by a UNIQUE key written in full, as a pseudo-row', async () => {
    const db = await store();
    const defs = (t: string) => captureTableDef(db, 'project', t) ?? null;
    const h = '1791000000000-000000-0192aaaa-7f00-7000-8000-00000000000a';
    const keys = (op: LedgerOp) => {
      const out: string[] = [];
      widenFootprint(db, [op], defs, (t, u) => {
        if (u.startsWith('#')) out.push(`${t}:${u}`);
      });
      return out;
    };
    expect(
      keys({ t: 'tasks_tasks', u: 'a', o: 'I', h, a: { id: 'T1', idempotency_key: 'k1' } }),
    ).toEqual(['tasks_tasks:#idempotency_key=["k1"]']);
    expect(
      keys({ t: 'tasks_tasks', u: 'a', o: 'I', h, a: { id: 'T1', idempotency_key: null } }),
    ).toEqual([]);
  });
});
