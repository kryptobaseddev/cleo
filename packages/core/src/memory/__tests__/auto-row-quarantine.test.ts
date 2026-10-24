/**
 * Reversible auto-row quarantine (T13951, owner decision D11179): dry-run
 * counts, the approved-count guard, a crash mid-apply that restore can undo,
 * restore idempotency, and a human "Doc attached" note that is never touched.
 *
 * @task T13951
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDualScopeDbCache } from '../../store/dual-scope-db.js';
import { closeBrainDb } from '../../store/memory-sqlite.js';
import {
  AutoRowQuarantineError,
  applyAutoRowQuarantine,
  openQuarantineStores,
  planAutoRowQuarantine,
  type QuarantineScope,
  type QuarantineStore,
  restoreAutoRowQuarantine,
} from '../auto-row-quarantine.js';
import { buildTraceText } from '../dispatch-trace-format.js';

let dir: string;
let project: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-auto-row-quarantine-'));
  project = join(dir, 'project');
  mkdirSync(join(project, '.cleo'), { recursive: true });
  mkdirSync(join(dir, 'home'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(dir, 'home'));
  vi.stubEnv('CLEO_DIR', join(project, '.cleo'));
  vi.stubEnv('CLEO_ROOT', project);
});

afterEach(() => {
  closeBrainDb();
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const trace = buildTraceText({
  taskId: '',
  predictedAgentId: 'cleo-subagent',
  confidence: 0,
  reason: 'universal-base fallback',
  registryHit: false,
  fallbackUsed: true,
  resolvedAt: '2026-10-01T00:00:00.000Z',
});
const docPayload = JSON.stringify({ kind: 'doc-attachment', attachmentId: 'A1', ownerId: 'T1' });

/** Seed auto rows and real rows into one store; ids are prefixed per store. */
function seed(db: DatabaseSync, p: string): void {
  const pattern = db.prepare(
    "INSERT INTO main.brain_patterns (id, type, pattern, context, verified) VALUES (?, 'workflow', ?, 'ctx', ?)",
  );
  pattern.run(`${p}P-trace-1`, trace, 0);
  pattern.run(`${p}P-trace-2`, `${trace} `, 0);
  pattern.run(`${p}P-trace-verified`, `${trace}  `, 1);
  pattern.run(`${p}P-real`, 'Run biome on the exact changed files before push', 0);
  const observation = db.prepare(
    "INSERT INTO main.brain_observations (id, type, title, narrative) VALUES (?, 'feature', ?, ?)",
  );
  observation.run(`${p}O-doc`, 'Doc attached: spec', docPayload);
  observation.run(`${p}O-human`, 'Doc attached: why we dropped X', 'We dropped X because Y');
  observation.run(`${p}O-stub`, 'Task complete: T1', 'Task T1 completed with status: done');
  observation.run(`${p}O-real`, 'Worktree incident', 'cancel destroys the named worktree');
}

/** `invalid_at` of every row in one store, keyed by id. */
function invalidAt(db: DatabaseSync): Record<string, string | null> {
  const rows = [
    ...db.prepare('SELECT id, invalid_at FROM main.brain_patterns').all(),
    ...db.prepare('SELECT id, invalid_at FROM main.brain_observations').all(),
  ];
  return Object.fromEntries(
    rows.map((row) => [String(row.id), row.invalid_at === null ? null : String(row.invalid_at)]),
  );
}

/** Open both stores and seed them. */
async function seededStores(): Promise<Record<QuarantineScope, QuarantineStore>> {
  const stores = await openQuarantineStores(project);
  seed(stores.project.db, '');
  seed(stores.global.db, 'G-');
  return stores;
}

const approved = {
  project: { patterns: 2, observations: 2 },
  global: { patterns: 2, observations: 2 },
};

describe('auto-row quarantine (T13951)', () => {
  it('dry run counts each store separately and names the predicates', async () => {
    const stores = await seededStores();
    const plan = planAutoRowQuarantine(stores);
    for (const scope of ['project', 'global'] as const) {
      expect(plan.counts[scope].patterns).toEqual({ count: 2, byRule: { 'dispatch-trace': 2 } });
      expect(plan.counts[scope].observations).toEqual({
        count: 2,
        byRule: { 'doc-attachment': 1, 'task-stub': 1 },
      });
    }
    expect(plan.ids.global.observations).toEqual(['G-O-doc', 'G-O-stub']);
    expect(plan.predicates['doc-attachment']).toContain('"kind":"doc-attachment"');
  });

  it('refuses an apply whose approved counts no longer match, writing nothing', async () => {
    const stores = await seededStores();
    const receipt = join(dir, 'receipt.json');
    const stale = { ...approved, project: { patterns: 1, observations: 2 } };
    await expect(applyAutoRowQuarantine(stores, stale, receipt)).rejects.toMatchObject({
      code: 'E_QUARANTINE_EXPECT_MISMATCH',
    });
    expect(existsSync(receipt)).toBe(false);
    expect(Object.values(invalidAt(stores.project.db)).every((v) => v === null)).toBe(true);
  });

  it('quarantines exactly the planned rows, and restore is idempotent', async () => {
    const stores = await seededStores();
    const receiptPath = join(dir, 'receipt.json');
    const receipt = await applyAutoRowQuarantine(stores, approved, receiptPath, { batchSize: 1 });
    expect(receipt.status).toBe('complete');
    expect(receipt.quarantined).toEqual(approved);
    const after = invalidAt(stores.project.db);
    expect(after['P-trace-1']).toBe(receipt.quarantinedAt);
    expect(after['O-doc']).toBe(receipt.quarantinedAt);
    // Never touched: real rows, a verified trace, a human "Doc attached" note.
    for (const id of ['P-real', 'P-trace-verified', 'O-human', 'O-real']) {
      expect(after[id]).toBeNull();
    }

    expect(await restoreAutoRowQuarantine(stores, receiptPath)).toEqual(approved);
    expect(Object.values(invalidAt(stores.global.db)).every((v) => v === null)).toBe(true);
    const zero = { patterns: 0, observations: 0 };
    expect(await restoreAutoRowQuarantine(stores, receiptPath)).toEqual({
      project: zero,
      global: zero,
    });
  });

  it('leaves a usable receipt when the apply crashes mid-way', async () => {
    const stores = await seededStores();
    let calls = 0;
    const crashing = {
      ...stores,
      project: {
        ...stores.project,
        write: (...args: Parameters<QuarantineStore['write']>) => {
          calls++;
          if (calls === 2) throw new Error('simulated crash');
          return stores.project.write(...args);
        },
      },
    };
    const receiptPath = join(dir, 'receipt.json');
    await expect(
      applyAutoRowQuarantine(crashing, approved, receiptPath, { batchSize: 1 }),
    ).rejects.toThrow('simulated crash');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as { status: string };
    expect(receipt.status).toBe('started');
    expect(Object.values(invalidAt(stores.project.db)).filter((v) => v !== null)).toHaveLength(1);

    const restored = await restoreAutoRowQuarantine(stores, receiptPath);
    expect(restored.project.patterns).toBe(1);
    expect(Object.values(invalidAt(stores.project.db)).every((v) => v === null)).toBe(true);
  });

  it('rejects a file that is not a quarantine receipt', async () => {
    const stores = await seededStores();
    const missing = join(dir, 'missing.json');
    await expect(restoreAutoRowQuarantine(stores, missing)).rejects.toBeInstanceOf(
      AutoRowQuarantineError,
    );
  });
});
