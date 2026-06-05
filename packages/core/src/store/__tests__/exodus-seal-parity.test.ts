/**
 * Unit tests for the fleet-flow count-parity gate + seal refusal (T11837).
 *
 * `computeCountParity` is the memory-safe deficit gate (COUNT(*) only, never the
 * heavy digest) that `cleo exodus seal` and `cleo doctor exodus-health` rely on.
 * These tests assert it catches a row deficit, tolerates a surplus (the live
 * consolidated DB moved ahead of the frozen legacy snapshot), and that
 * `sealExodus` REFUSES (archives nothing) on a deficit — the safety invariant
 * that prevents sealing an incompletely-migrated install.
 *
 * @task T11837 (EP-EXODUS-FLEET-HARDENING)
 * @saga T11242
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeCountParity } from '../exodus/count-parity.js';
import { sealExodus } from '../exodus/seal.js';
import type { ExodusPlan, LegacyDbDescriptor } from '../exodus/types.js';

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => DatabaseSyncType;
};

vi.mock('../../logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe('computeCountParity + sealExodus refusal (T11837)', () => {
  let tmpDir: string;
  let sourcePath: string;
  let projectPath: string;
  let globalPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cleo-seal-parity-'));
    sourcePath = join(tmpDir, 'tasks.db');
    projectPath = join(tmpDir, 'cleo-project.db');
    globalPath = join(tmpDir, 'cleo-global.db');

    // Source: legacy 'tasks' (50 rows) → consolidated 'tasks_tasks'.
    const src = new DatabaseSync(sourcePath);
    try {
      src.exec(`CREATE TABLE "tasks" (id INTEGER PRIMARY KEY, val TEXT)`);
      for (let i = 1; i <= 50; i++) src.exec(`INSERT INTO "tasks" VALUES (${i}, 'v-${i}')`);
    } finally {
      src.close();
    }
    new DatabaseSync(globalPath).close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function sources(): LegacyDbDescriptor[] {
    return [{ name: 'tasks', path: sourcePath, targetScope: 'project' }];
  }

  function makePlan(): ExodusPlan {
    return {
      sources: sources(),
      totalSourceBytes: 0,
      availableBytes: 100_000_000,
      diskPreflight: true,
      stagingDir: join(tmpDir, 'staging'),
      resumeFromStaging: false,
      projectDbPath: projectPath,
      globalDbPath: globalPath,
    };
  }

  function seedTarget(count: number): void {
    const tgt = new DatabaseSync(projectPath);
    try {
      tgt.exec(`CREATE TABLE "tasks_tasks" (id INTEGER PRIMARY KEY, val TEXT)`);
      for (let i = 1; i <= count; i++)
        tgt.exec(`INSERT INTO "tasks_tasks" VALUES (${i}, 'v-${i}')`);
    } finally {
      tgt.close();
    }
  }

  it('parity: full copy has ok:true, zero deficit', () => {
    seedTarget(50);
    const r = computeCountParity(sources(), projectPath, globalPath);
    expect(r.ok).toBe(true);
    expect(r.deficits).toHaveLength(0);
    const entry = r.entries.find((e) => e.targetTable === 'tasks_tasks');
    expect(entry?.sourceCount).toBe(50);
    expect(entry?.targetCount).toBe(50);
    expect(entry?.deficit).toBe(0);
  });

  it('surplus: target ahead of source (live DB moved on) is tolerated — ok:true', () => {
    seedTarget(53); // 3 more than source
    const r = computeCountParity(sources(), projectPath, globalPath);
    expect(r.ok).toBe(true);
    const entry = r.entries.find((e) => e.targetTable === 'tasks_tasks');
    expect(entry?.targetCount).toBe(53);
    expect(entry?.deficit).toBe(0);
  });

  it('deficit: target missing rows → ok:false with the table named', () => {
    seedTarget(40); // 10 missing
    const r = computeCountParity(sources(), projectPath, globalPath);
    expect(r.ok).toBe(false);
    const d = r.deficits.find((e) => e.targetTable === 'tasks_tasks');
    expect(d?.deficit).toBe(10);
  });

  it('seal REFUSES on a deficit and does NOT archive the legacy source', () => {
    seedTarget(40); // deficit
    expect(existsSync(sourcePath)).toBe(true);

    const result = sealExodus(makePlan(), 'project', tmpDir);

    expect(result.ok).toBe(false);
    expect(result.refusedReason).toContain('tasks_tasks');
    expect(result.scopes).toHaveLength(0);
    // Safety invariant: a refused seal must leave the legacy source UNTOUCHED.
    expect(existsSync(sourcePath), 'refused seal must not archive the source').toBe(true);
  });
});
