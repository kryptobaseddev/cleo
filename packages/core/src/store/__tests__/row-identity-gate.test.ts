/**
 * Row-identity gate (T12341): every syncing table either carries a declared
 * uid or is counted as pending, and the pending count only shrinks.
 *
 * The table set comes from `sqlite_master` of fresh stores built through the
 * runtime path, like Gate A (`table-classification-gate.test.ts`). A table is
 * SYNCING when its Gate A class is portable and it is not a frozen legacy
 * twin. Every syncing table must be either:
 *
 * - declared in `ROW_IDENTITY` (`store/row-identity.ts`), with its uid column,
 *   its uid index (or uid primary key) and every column the declaration names
 *   physically present; or
 * - PENDING: not declared yet. The pending count per scope is pinned in
 *   {@link PENDING_PINNED}. A new syncing table raises it and fails: declare
 *   the table instead. Declaring one lowers it and fails too, until the pin is
 *   lowered in the same change, so the allowance cannot be spent again.
 *
 * @task T12341
 * @epic T12323
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { TableScope } from '@cleocode/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureGlobalAgentRegistryDb } from '../agent-registry-store.js';
import { bindConduitDomain } from '../conduit-sqlite.js';
import { _resetDualScopeDbCache, openDualScopeDb } from '../dual-scope-db.js';
import { getBrainDb } from '../memory-sqlite.js';
import { getNexusDb } from '../nexus-sqlite.js';
import { ROW_IDENTITY, rowIdentityColumns, UID_COLUMN } from '../row-identity.js';
import { openSkillsDb } from '../skills-db.js';
import { getDb } from '../sqlite.js';
import { classifyTable, isPortableTableClass } from '../table-classification.js';

/**
 * Syncing tables without a declared uid, per scope. Only ever lowered: each
 * follow-up that declares tables lowers it in the same change (spec
 * t12341-uid-scheme §15).
 */
const PENDING_PINNED: Readonly<Record<TableScope, number>> = { project: 96, global: 43 };

let testRoot: string;
const stores: Partial<Record<TableScope, DatabaseSync>> = {};

function tablesOf(db: DatabaseSync): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
}

/** Portable, non-frozen tables of a store. */
function syncingTables(scope: TableScope, db: DatabaseSync): string[] {
  return tablesOf(db).filter((table) => {
    const c = classifyTable(scope, table);
    if (c.kind === 'entry')
      return isPortableTableClass(c.class) && c.entry.status !== 'frozen-legacy';
    if (c.kind === 'pattern') return isPortableTableClass(c.class);
    return false;
  });
}

function store(scope: TableScope): DatabaseSync {
  const db = stores[scope];
  if (!db) throw new Error(`no ${scope} store`);
  return db;
}

beforeAll(async () => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  testRoot = join(
    tmpdir(),
    `row-identity-gate-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe.each(['project', 'global'] as const)('row identity: %s store', (scope) => {
  it('declares only syncing tables that exist', () => {
    const syncing = new Set(syncingTables(scope, store(scope)));
    for (const spec of ROW_IDENTITY[scope]) {
      expect(syncing.has(spec.table), `${spec.table} is not a syncing table of this store`).toBe(
        true,
      );
    }
  });

  it('every declared table has its uid, its uid index and every declared column', () => {
    const db = store(scope);
    for (const spec of ROW_IDENTITY[scope]) {
      const cols = db.prepare('SELECT name, pk FROM pragma_table_info(?)').all(spec.table) as {
        name: string;
        pk: number;
      }[];
      const names = new Set(cols.map((c) => c.name));
      const named = [
        ...rowIdentityColumns(scope, spec.table),
        ...spec.key,
        ...(spec.birth ? [spec.birth] : []),
        ...(spec.content ?? []),
        ...[...(spec.owners ?? []), ...(spec.keyRefs ?? []), ...(spec.refs ?? [])].map(
          (r) => r.column,
        ),
        ...(spec.jsonArrayRefs ?? []).map((r) => r.column),
        ...(spec.storedRefUids ?? []).map((r) => r.from),
      ];
      for (const column of named) expect(names, `${spec.table}.${column}`).toContain(column);
      const uidIsPk = cols.some((c) => c.name === UID_COLUMN && c.pk > 0);
      const uniqueOnUid = (
        db.prepare('SELECT name, "unique" AS u FROM pragma_index_list(?)').all(spec.table) as {
          name: string;
          u: number;
        }[]
      ).some(
        (ix) =>
          ix.u === 1 &&
          (db.prepare('SELECT name FROM pragma_index_info(?)').all(ix.name) as { name: string }[])
            .map((c) => c.name)
            .join(',') === UID_COLUMN,
      );
      expect(uidIsPk || uniqueOnUid, `${spec.table}: uid must be unique`).toBe(true);
    }
  });

  it('the pending count is pinned and only shrinks', () => {
    const declared = new Set(ROW_IDENTITY[scope].map((s) => s.table));
    const pending = syncingTables(scope, store(scope)).filter((t) => !declared.has(t));
    console.log(`[row-identity] ${scope}: ${declared.size} declared, ${pending.length} pending`);
    expect(
      pending.length,
      pending.length > PENDING_PINNED[scope]
        ? `a syncing table has no declared uid; declare it in store/row-identity.ts (pending: ${pending.join(', ')})`
        : `tables were declared; lower PENDING_PINNED.${scope} to ${pending.length}`,
    ).toBe(PENDING_PINNED[scope]);
  });
});
