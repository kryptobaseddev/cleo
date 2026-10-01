/**
 * Sync write-invariant registry against fresh stores (T12881, §3.6.7 rule 5).
 *
 * Gate 38 (`scripts/lint-sync-write-invariants.mjs`) checks the registry from
 * source: every trigger-covered name is created by a migration SQL file. This
 * test checks the same entries physically, on project and global stores
 * built through the runtime path like Gate A: every trigger or index a
 * `trigger-covered` entry names is in `sqlite_master`, every table an entry
 * names exists in some store, and every `monotonic-merge-rule` column exists
 * on its table.
 *
 * @task T12881
 * @epic T12323
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { SYNC_WRITE_INVARIANTS, type TableScope } from '@cleocode/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureGlobalAgentRegistryDb } from '../agent-registry-store.js';
import { bindConduitDomain } from '../conduit-sqlite.js';
import { _resetDualScopeDbCache, openDualScopeDb } from '../dual-scope-db.js';
import { getBrainDb } from '../memory-sqlite.js';
import { getNexusDb } from '../nexus-sqlite.js';
import { openSkillsDb } from '../skills-db.js';
import { getDb } from '../sqlite.js';

let testRoot: string;
const stores: Partial<Record<TableScope, DatabaseSync>> = {};

function names(type: 'table' | 'trigger' | 'index'): Set<string> {
  const out = new Set<string>();
  for (const db of Object.values(stores)) {
    for (const r of db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all(type) as {
      name: string;
    }[])
      out.add(r.name);
  }
  return out;
}

beforeAll(async () => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  testRoot = join(
    tmpdir(),
    `sync-write-invariants-gate-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const projectDir = join(testRoot, 'project');
  mkdirSync(join(projectDir, '.cleo'), { recursive: true });
  const globalDir = join(testRoot, 'cleo');
  mkdirSync(globalDir, { recursive: true });
  vi.stubEnv('CLEO_HOME', globalDir);

  const project = await openDualScopeDb('project', projectDir);
  await getDb(projectDir);
  await getBrainDb(projectDir);
  await getNexusDb(projectDir);
  await bindConduitDomain(projectDir);
  stores.project = project.db.$client;

  const global = await openDualScopeDb('global');
  await ensureGlobalAgentRegistryDb();
  await openSkillsDb();
  stores.global = global.db.$client;
}, 300_000);

afterAll(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(testRoot, { recursive: true, force: true });
});

describe('sync write-invariant registry on fresh stores', () => {
  it('every trigger-covered trigger or index exists in sqlite_master', () => {
    const present = new Set([...names('trigger'), ...names('index')]);
    const missing = SYNC_WRITE_INVARIANTS.filter((e) => e.class === 'trigger-covered').flatMap(
      (e) => (e.triggers ?? []).filter((t) => !present.has(t)).map((t) => `${e.id}: ${t}`),
    );
    expect(missing).toEqual([]);
  });

  it('every named table exists in a fresh store', () => {
    const tables = names('table');
    const missing = SYNC_WRITE_INVARIANTS.flatMap((e) =>
      e.tables.filter((t) => !tables.has(t)).map((t) => `${e.id}: ${t}`),
    );
    expect(missing).toEqual([]);
  });

  it('every merge-rule column exists on its table', () => {
    const missing: string[] = [];
    for (const e of SYNC_WRITE_INVARIANTS) {
      if (!e.mergeRule) continue;
      const cols = new Set<string>();
      for (const db of Object.values(stores)) {
        for (const r of db
          .prepare('SELECT name FROM pragma_table_info(?)')
          .all(e.mergeRule.table) as { name: string }[])
          cols.add(r.name);
      }
      for (const c of e.mergeRule.columns) {
        if (c !== '*' && !cols.has(c)) missing.push(`${e.id}: ${e.mergeRule.table}.${c}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
