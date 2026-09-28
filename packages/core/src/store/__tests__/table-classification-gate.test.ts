/**
 * Gate A — every physical table in the project and global `cleo.db` has a
 * replication class (T12332).
 *
 * The table set comes from `sqlite_master`, never from the Drizzle schema:
 * the runtime writes some bare legacy twins, creates other tables in runtime
 * DDL, and SQLite creates FTS5/vec shadow tables on its own. None of those
 * are visible to a schema walk.
 *
 * Two shapes are checked:
 *
 * 1. FRESH stores, built through the same path the runtime takes: the
 *    dual-scope chokepoint plus every domain binder that runs its own lineage
 *    on the shared handle (tasks, brain, nexus, conduit for the project;
 *    agent registry and skills for the global store). A table introduced by a
 *    new migration shows up here.
 * 2. The LIVE project-store shape, from a committed `sqlite_master` name dump
 *    of the cleocode project store (`fixtures/cleocode-project-sqlite-master-
 *    2026-09-27.tsv`: names and types only, no rows). It carries what a fresh
 *    store never has: the frozen bare twins' live data layout and the brain
 *    FTS tables that `brain-search` creates lazily. A user's database is never
 *    opened.
 *
 * Tables awaiting an owner ruling sit on the registry's `pending` list: they
 * carry no class, are printed on every run, and never count as portable.
 *
 * @task T12332
 * @epic T12322
 */

import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { TableClassification, TableScope } from '@cleocode/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureGlobalAgentRegistryDb } from '../agent-registry-store.js';
import { bindConduitDomain } from '../conduit-sqlite.js';
import { _resetDualScopeDbCache, openDualScopeDb } from '../dual-scope-db.js';
import { getBrainDb } from '../memory-sqlite.js';
import { getNexusDb } from '../nexus-sqlite.js';
import { openSkillsDb } from '../skills-db.js';
import { getDb } from '../sqlite.js';
import {
  classifyTable,
  getTableRegistry,
  isPortableTableClass,
  TABLE_CLASSES,
} from '../table-classification.js';

const LIVE_PROJECT_DUMP = join(
  import.meta.dirname,
  'fixtures',
  'cleocode-project-sqlite-master-2026-09-27.tsv',
);

let testRoot: string;
const fresh: Record<TableScope, Set<string>> = { project: new Set(), global: new Set() };
const columns: Record<TableScope, Map<string, Set<string>>> = {
  project: new Map(),
  global: new Map(),
};
let liveProject: Set<string>;

function tablesOf(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function columnsOf(db: DatabaseSync, tables: Set<string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const t of tables) {
    const cols = db.prepare(`PRAGMA table_info("${t}")`).all() as Array<{ name: string }>;
    out.set(t, new Set(cols.map((c) => c.name)));
  }
  return out;
}

/** Table names from a `type<TAB>name<TAB>tbl_name` dump. */
function readDump(path: string): Set<string> {
  return new Set(
    readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.split('\t'))
      .filter(([type]) => type === 'table')
      .map(([, name]) => name),
  );
}

/** Classify a table set; return the unclassified and pending names. */
function audit(scope: TableScope, tables: Set<string>) {
  const results: TableClassification[] = [...tables].sort().map((t) => classifyTable(scope, t));
  return {
    results,
    unclassified: results.filter((r) => r.kind === 'unclassified').map((r) => r.table),
    pending: results.filter((r) => r.kind === 'pending').map((r) => r.table),
  };
}

/** Print the per-class counts and the pending list, so every run shows them. */
function report(label: string, scope: TableScope, tables: Set<string>): void {
  const { results, pending } = audit(scope, tables);
  const counts = Object.fromEntries(TABLE_CLASSES.map((c) => [c, 0]));
  for (const r of results) if (r.kind === 'entry' || r.kind === 'pattern') counts[r.class] += 1;
  const byClass = TABLE_CLASSES.map((c) => `${c} ${counts[c]}`).join(', ');
  console.log(`[gate-a] ${label}: ${tables.size} tables; ${byClass}; pending ${pending.length}`);
  for (const name of pending) {
    const r = classifyTable(scope, name);
    if (r.kind === 'pending') {
      console.warn(`[gate-a] PENDING OWNER RULING ${scope}.${name}: ${r.pending.question}`);
    }
  }
}

function unclassifiedMessage(label: string, names: string[]): string {
  return (
    `${label}: ${names.length} table(s) have no replication class: ${names.join(', ')}.\n` +
    'Add each to packages/core/src/store/table-classification.ts (an explicit entry, ' +
    'or the pending list with the question for the owner). An unclassified table ' +
    'would silently never reach, or silently leak to, another device.'
  );
}

beforeAll(async () => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  testRoot = join(tmpdir(), `gate-a-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const projectDir = join(testRoot, 'project');
  mkdirSync(join(projectDir, '.cleo'), { recursive: true });
  const globalDir = join(testRoot, 'cleo');
  mkdirSync(globalDir, { recursive: true });
  vi.stubEnv('CLEO_HOME', globalDir);

  // Project: the chokepoint, then every domain that runs its own lineage on
  // the shared handle (legacy bare twins, conduit FTS, nexus meta, vec0).
  const project = await openDualScopeDb('project', projectDir);
  await getDb(projectDir);
  await getBrainDb(projectDir);
  await getNexusDb(projectDir);
  await bindConduitDomain(projectDir);
  fresh.project = tablesOf(project.db.$client);
  columns.project = columnsOf(project.db.$client, fresh.project);

  // Global: the chokepoint plus the domains with their own meta tables.
  const global = await openDualScopeDb('global');
  await ensureGlobalAgentRegistryDb();
  await openSkillsDb();
  fresh.global = tablesOf(global.db.$client);
  columns.global = columnsOf(global.db.$client, fresh.global);

  liveProject = readDump(LIVE_PROJECT_DUMP);

  report('fresh project', 'project', fresh.project);
  report('fresh global', 'global', fresh.global);
  report('live project shape', 'project', liveProject);
}, 300_000);

afterAll(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(testRoot, { recursive: true, force: true });
});

describe('Gate A: every table has a class', () => {
  it('builds non-trivial fresh stores (guards against a vacuous pass)', () => {
    expect(fresh.project.size).toBeGreaterThan(150);
    expect(fresh.global.size).toBeGreaterThan(60);
    expect(liveProject.size).toBeGreaterThan(150);
  });

  it('fresh project cleo.db: no unclassified table', () => {
    const { unclassified } = audit('project', fresh.project);
    expect(unclassified, unclassifiedMessage('fresh project', unclassified)).toEqual([]);
  });

  it('fresh global cleo.db: no unclassified table', () => {
    const { unclassified } = audit('global', fresh.global);
    expect(unclassified, unclassifiedMessage('fresh global', unclassified)).toEqual([]);
  });

  it('live project shape (frozen bare twins, lazy FTS): no unclassified table', () => {
    const { unclassified } = audit('project', liveProject);
    expect(unclassified, unclassifiedMessage('live project', unclassified)).toEqual([]);
  });
});

describe('Gate A: the registry describes real tables', () => {
  it.each(['project', 'global'] as const)('%s: no stale entry', (scope) => {
    const known = scope === 'project' ? new Set([...fresh.project, ...liveProject]) : fresh.global;
    const stale = Object.entries(getTableRegistry(scope).tables)
      .filter(([t, e]) => !known.has(t) && e.status !== 'optional-transient')
      .map(([t]) => t);
    expect(
      stale,
      `${scope}: registry entries exist in neither the fresh store nor the known live shape. ` +
        'Remove them, or mark a runtime-only table optional-transient.',
    ).toEqual([]);
  });

  it.each([
    'project',
    'global',
  ] as const)('%s: every pending table exists and has no class', (scope) => {
    const registry = getTableRegistry(scope);
    const known = scope === 'project' ? new Set([...fresh.project, ...liveProject]) : fresh.global;
    for (const p of registry.pending) {
      expect(known.has(p.table), `pending ${scope}.${p.table} no longer exists`).toBe(true);
      expect(
        Object.hasOwn(registry.tables, p.table),
        `${scope}.${p.table} is both pending and classified`,
      ).toBe(false);
    }
  });

  it.each([
    'project',
    'global',
  ] as const)('%s: column overrides and row routers name real columns', (scope) => {
    const missing: string[] = [];
    for (const [table, entry] of Object.entries(getTableRegistry(scope).tables)) {
      const cols = columns[scope].get(table);
      if (!cols) continue; // present only in the live shape; the dump carries no columns
      for (const o of entry.columns ?? []) {
        if (!cols.has(o.column)) missing.push(`${table}.${o.column}`);
      }
      if (entry.rowRouting && !cols.has(entry.rowRouting.column)) {
        missing.push(`${table}.${entry.rowRouting.column} (row router)`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('frozen legacy twins point at a classified live twin', () => {
    const registry = getTableRegistry('project');
    for (const [table, entry] of Object.entries(registry.tables)) {
      if (entry.status !== 'frozen-legacy') continue;
      expect(entry.class, table).toBe('local-only');
      expect(entry.dropTask, table).toBeTruthy();
      const twin = entry.liveTwin ?? '';
      expect(Object.hasOwn(registry.tables, twin), `${table} → ${twin}`).toBe(true);
    }
  });
});

describe('classifyTable', () => {
  it('resolves entries, patterns, pending and unknown names', () => {
    expect(classifyTable('project', 'tasks_tasks')).toMatchObject({
      kind: 'entry',
      class: 'portable-project',
    });
    expect(classifyTable('project', 'brain_observations_fts_idx')).toMatchObject({
      kind: 'pattern',
      class: 'derived',
    });
    expect(classifyTable('project', 'brain_embeddings_vector_chunks00')).toMatchObject({
      kind: 'pattern',
      class: 'derived',
    });
    expect(classifyTable('project', '_exodus_recovery_tasks')).toMatchObject({
      kind: 'pattern',
      class: 'local-only',
    });
    expect(classifyTable('global', 'service_connections')).toMatchObject({
      kind: 'entry',
      class: 'portable-secret',
    });
    expect(classifyTable('project', 'no_such_table').kind).toBe('unclassified');
    // Scope matters: the exodus scratch pattern is project-only.
    expect(classifyTable('global', '_exodus_recovery_tasks').kind).toBe('unclassified');
  });

  it('does not treat inherited object keys as entries', () => {
    expect(classifyTable('project', 'constructor').kind).toBe('unclassified');
    expect(classifyTable('project', '__proto__').kind).toBe('unclassified');
  });

  it('only portable classes travel', () => {
    expect(TABLE_CLASSES.filter(isPortableTableClass)).toEqual([
      'portable-project',
      'portable-personal',
      'portable-secret',
    ]);
  });
});
