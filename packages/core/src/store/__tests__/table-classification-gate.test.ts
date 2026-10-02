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
 * carry no class and never count as portable. The allowed count is ZERO, so
 * a pending table fails CI until the owner rules on it.
 *
 * Columns are gated too. A committed per-table column snapshot
 * (`fixtures/table-classification-columns.json`, from `PRAGMA table_info` of
 * the fresh stores) fails on any added or removed column until the snapshot
 * acknowledges it, and a credential-shaped column name in a syncing table
 * fails outright unless the registry gives that column its own class.
 * Regenerate the snapshot, after reviewing the diff, with:
 *
 *     CLEO_UPDATE_COLUMN_SNAPSHOT=1 pnpm vitest run \
 *       src/store/__tests__/table-classification-gate.test.ts
 *
 * @task T12332
 * @epic T12322
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { TableClassification, TableScope } from '@cleocode/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureGlobalAgentRegistryDb } from '../agent-registry-store.js';
import { bindConduitDomain } from '../conduit-sqlite.js';
import { _resetDualScopeDbCache, openDualScopeDb } from '../dual-scope-db.js';
import { getBrainDb } from '../memory-sqlite.js';
import { getNexusDb } from '../nexus-sqlite.js';
import { CREDENTIAL_COLUMNS } from '../portable-bundle-scan.js';
import { openSkillsDb } from '../skills-db.js';
import { getDb } from '../sqlite.js';
import {
  classifyTrigger,
  normalizeSql,
  OWNED_TRIGGERS,
  suspendClause,
  type TriggerClass,
  verifyOwnedTriggers,
} from '../sync/trigger-classes.js';
import {
  classifyTable,
  getTableRegistry,
  isPortableTableClass,
  TABLE_CLASS_POLICY,
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
type TriggerRow = { name: string; tbl_name: string; sql: string };
const triggers: Record<TableScope, TriggerRow[]> = { project: [], global: [] };
let liveProjectTriggers: Array<{ name: string; table: string }> = [];
let ownedFindings: ReturnType<typeof verifyOwnedTriggers> = [];

/**
 * The registry's column snapshot: scope → table → sorted column names, taken
 * from `PRAGMA table_info` of the fresh stores.
 */
const COLUMN_SNAPSHOT = join(import.meta.dirname, 'fixtures', 'table-classification-columns.json');
type ColumnSnapshot = Record<TableScope, Record<string, string[]>>;

function snapshotOf(): ColumnSnapshot {
  const out = { project: {}, global: {} } as ColumnSnapshot;
  for (const scope of ['project', 'global'] as const) {
    for (const t of [...columns[scope].keys()].sort()) {
      out[scope][t] = [...(columns[scope].get(t) ?? [])].sort();
    }
  }
  return out;
}

/**
 * A column name that looks like a credential. In a syncing (non-secret) table
 * such a column must carry its own class in the registry: `portable-secret`
 * when it is a credential, `strip` or `local-only` when that is the correct
 * treatment (the override's `reason` says why).
 */
const CREDENTIAL_NAME = /key|token|secret|passw|credential|oauth|_enc$/i;
const SYNC_CLASSES_NEEDING_REVIEW = new Set(['portable-project', 'portable-personal']);

/**
 * Reviewed column names that match {@link CREDENTIAL_NAME} but are not
 * credentials, keyed `table.column` (either scope). Pinned HERE so each new
 * match takes an explicit, reviewed edit to the gate. None of them may take a
 * `strip` or `local-only` class instead: every one must sync for its table to
 * mean anything on another device.
 */
const NOT_A_CREDENTIAL: Readonly<Record<string, string>> = Object.fromEntries(
  (
    [
      [
        'search keywords (free text written by agents)',
        [
          'architecture_decisions.keywords',
          'attachments.keywords',
          'docs_attachments.keywords',
          'tasks_architecture_decisions.keywords',
        ],
      ],
      [
        'caller-chosen idempotency key: a dedup id, not a secret, and it must sync or a retry on another device double-writes',
        [
          'audit_log.idempotency_key',
          'brain_observations.idempotency_key',
          'conduit_messages.idempotency_key',
          'conduit_topic_messages.idempotency_key',
          'tasks_audit_log.idempotency_key',
          'tasks_goal.idempotency_key',
          'tasks_tasks.idempotency_key',
        ],
      ],
      [
        'LLM token COUNTS (integers), not auth tokens',
        [
          'brain_observations.discovery_tokens',
          'brain_retrieval_log.tokens_used',
          'brain_transcript_events.tokens',
          'conduit_attachment_contributors.total_tokens_added',
          'conduit_attachment_contributors.total_tokens_removed',
          'conduit_attachment_versions.tokens',
          'conduit_attachment_versions.tokens_added',
          'conduit_attachment_versions.tokens_removed',
          'conduit_attachments.tokens',
          'tasks_token_usage.input_tokens',
          'tasks_token_usage.output_tokens',
          'tasks_token_usage.total_tokens',
          'token_usage.input_tokens',
          'token_usage.output_tokens',
          'token_usage.total_tokens',
        ],
      ],
      [
        'content-addressed blob key (a hash of the attachment bytes)',
        ['conduit_attachment_versions.storage_key', 'conduit_attachments.storage_key'],
      ],
      [
        'row key naming a projection, criterion source or profile trait',
        [
          'tasks_acceptance_projection_dirty.projection_key',
          'tasks_acceptance_projection_state.projection_key',
          'tasks_task_acceptance_criteria.source_key',
          'nexus_user_profile.trait_key',
        ],
      ],
    ] as const
  ).flatMap(([reason, keys]) => keys.map((k) => [k, reason])),
);

/**
 * The change journal's own tables (T12342): created only when a `sync.*` flag
 * is first enabled, from the sync-journal schema folder, in either store.
 */
const SYNC_JOURNAL_DDL =
  'packages/core/migrations/sync-journal/20260929140000_t12342-sync-clock/migration.sql';
const SYNC_CAPTURE_DDL =
  'packages/core/migrations/sync-journal/20260930120000_t12343-capture/migration.sql';
const SYNC_SEALER_DDL =
  'packages/core/migrations/sync-journal/20261001170000_t12984-sealer/migration.sql';
const SYNC_JOURNAL_TABLES = {
  _sync_capture: { class: 'local-only', ddl: SYNC_CAPTURE_DDL },
  _sync_frame: { class: 'local-only', ddl: SYNC_CAPTURE_DDL },
  _sync_undo: { class: 'local-only', ddl: SYNC_CAPTURE_DDL },
  _sync_txn: { class: 'local-only', ddl: SYNC_SEALER_DDL },
  _sync_op: { class: 'local-only', ddl: SYNC_SEALER_DDL },
  _sync_row_meta: { class: 'local-only', ddl: SYNC_SEALER_DDL },
  _sync_ledger: { class: 'local-only', ddl: SYNC_SEALER_DDL },
  _sync_quarantine: { class: 'local-only', ddl: SYNC_SEALER_DDL },
  _sync_clock: { class: 'local-only', ddl: SYNC_JOURNAL_DDL },
  _sync_meta: { class: 'local-only', ddl: SYNC_JOURNAL_DDL },
  _sync_replica: { class: 'local-only', ddl: SYNC_JOURNAL_DDL },
};

/**
 * `optional-transient` is an escape hatch from the stale-entry check, so like
 * `derived` it is pinned HERE: adding one takes an explicit edit to the gate.
 * Each names its class and the source file whose runtime DDL creates it; the
 * gate checks that DDL still exists, so the exemption cannot outlive its
 * table.
 */
const OPTIONAL_TRANSIENT: Record<TableScope, Record<string, { class: string; ddl: string }>> = {
  project: {
    _exodus_database_identity: {
      class: 'local-only',
      ddl: 'packages/core/src/store/exodus/recovery.ts',
    },
    _fts5_check: { class: 'local-only', ddl: 'packages/core/src/memory/brain-search.ts' },
    ...SYNC_JOURNAL_TABLES,
  },
  global: {
    __catalog_meta: { class: 'local-only', ddl: 'packages/core/src/llm/catalog-seeder.ts' },
    ...SYNC_JOURNAL_TABLES,
    // No global binder creates it yet; pinned so a future one is never derived.
    brain_embeddings: {
      class: 'portable-personal',
      ddl: 'packages/core/src/store/memory-sqlite.ts',
    },
  },
};
const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

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

function triggersOf(db: DatabaseSync): TriggerRow[] {
  return db
    .prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
    .all() as TriggerRow[];
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
  triggers.project = triggersOf(project.db.$client);
  ownedFindings = verifyOwnedTriggers(project.db.$client);

  // Global: the chokepoint plus the domains with their own meta tables.
  const global = await openDualScopeDb('global');
  await ensureGlobalAgentRegistryDb();
  await openSkillsDb();
  fresh.global = tablesOf(global.db.$client);
  columns.global = columnsOf(global.db.$client, fresh.global);
  triggers.global = triggersOf(global.db.$client);

  liveProject = readDump(LIVE_PROJECT_DUMP);
  liveProjectTriggers = readFileSync(LIVE_PROJECT_DUMP, 'utf8')
    .split('\n')
    .map((line) => line.split('\t'))
    .filter(([type]) => type === 'trigger')
    .map(([, name, table]) => ({ name: name as string, table: table as string }));

  if (process.env.CLEO_UPDATE_COLUMN_SNAPSHOT === '1') {
    writeFileSync(COLUMN_SNAPSHOT, `${JSON.stringify(snapshotOf(), null, 2)}\n`);
    console.log(`[gate-a] column snapshot written: ${COLUMN_SNAPSHOT}`);
  }

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
  ] as const)('%s: nothing is pending an owner ruling (allowed count is zero)', (scope) => {
    const pending = getTableRegistry(scope).pending.map((p) => `${p.table}: ${p.question}`);
    expect(
      pending,
      `${scope}: tables on the pending list have no class. Get the ruling and classify them; ` +
        'a pending table must not reach CI.',
    ).toEqual([]);
  });

  it.each([
    'project',
    'global',
  ] as const)('%s: optional-transient is only the pinned runtime-DDL tables', (scope) => {
    const pinned = OPTIONAL_TRANSIENT[scope];
    const used = Object.entries(getTableRegistry(scope).tables)
      .filter(([, e]) => e.status === 'optional-transient')
      .map(([t]) => t)
      .sort();
    expect(used, `${scope}: optional-transient entries outside the pinned set`).toEqual(
      Object.keys(pinned).sort(),
    );
    for (const [table, { class: cls, ddl: file }] of Object.entries(pinned)) {
      expect(classifyTable(scope, table)).toMatchObject({ kind: 'entry', class: cls });
      const src = readFileSync(join(REPO_ROOT, file), 'utf8');
      const ddl = new RegExp(`CREATE (VIRTUAL )?TABLE IF NOT EXISTS (main\\.)?${table}\\b`);
      expect(ddl.test(src), `${scope}.${table}: no runtime DDL left in ${file}`).toBe(true);
    }
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

describe('Gate A: columns', () => {
  it('the committed column snapshot matches the fresh stores', () => {
    const want = JSON.parse(readFileSync(COLUMN_SNAPSHOT, 'utf8')) as ColumnSnapshot;
    const got = snapshotOf();
    const diffs: string[] = [];
    for (const scope of ['project', 'global'] as const) {
      // sqlite-vec is an optional native extension: where it does not load, the
      // vec0 table and its shadows are absent. Their shape is fixed by vec0.
      const vecMissing = !got[scope].brain_embeddings && Boolean(want[scope].brain_embeddings);
      if (vecMissing) console.warn(`[gate-a] ${scope}: sqlite-vec not loaded; vec0 tables skipped`);
      const tables = new Set([...Object.keys(want[scope]), ...Object.keys(got[scope])]);
      for (const t of [...tables].sort()) {
        if (vecMissing && /^brain_embeddings(_|$)/.test(t)) continue;
        const w = new Set(want[scope][t] ?? []);
        const g = new Set(got[scope][t] ?? []);
        if (!want[scope][t]) diffs.push(`${scope}.${t}: new table not in the snapshot`);
        if (!got[scope][t]) diffs.push(`${scope}.${t}: in the snapshot, gone from the store`);
        for (const c of g) if (!w.has(c)) diffs.push(`${scope}.${t}.${c}: new column`);
        for (const c of w) if (!g.has(c)) diffs.push(`${scope}.${t}.${c}: removed column`);
      }
    }
    expect(
      diffs,
      'Columns changed since the registry snapshot. Check each new column against the ' +
        'registry (does it need a column class?), then regenerate the snapshot with ' +
        'CLEO_UPDATE_COLUMN_SNAPSHOT=1 (see the file header).',
    ).toEqual([]);
  });

  it.each([
    'project',
    'global',
  ] as const)('%s: a credential-shaped column in a syncing table has its own class', (scope) => {
    const bad: string[] = [];
    for (const [table, cols] of columns[scope]) {
      const r = classifyTable(scope, table);
      if (r.kind !== 'entry' && r.kind !== 'pattern') continue; // gated above
      if (!SYNC_CLASSES_NEEDING_REVIEW.has(r.class)) continue;
      const overridden = new Set(
        (r.kind === 'entry' ? r.entry.columns : undefined)?.map((o) => o.column),
      );
      for (const c of cols) {
        if (!CREDENTIAL_NAME.test(c) || overridden.has(c)) continue;
        if (Object.hasOwn(NOT_A_CREDENTIAL, `${table}.${c}`)) continue;
        bad.push(`${table}.${c} (${r.class})`);
      }
    }
    expect(
      bad.sort(),
      `${scope}: these columns look like credentials and would sync in the clear. Give each a ` +
        "column override: 'portable-secret' for a credential, or 'strip' / 'local-only' with a " +
        'reason when that is the correct treatment. Only a reviewed non-credential goes on the ' +
        'NOT_A_CREDENTIAL list in this file.',
    ).toEqual([]);
  });

  it('every NOT_A_CREDENTIAL entry names a real column (no stale exemption)', () => {
    const real = new Set<string>();
    for (const scope of ['project', 'global'] as const) {
      for (const [t, cols] of columns[scope]) for (const c of cols) real.add(`${t}.${c}`);
    }
    expect(Object.keys(NOT_A_CREDENTIAL).filter((k) => !real.has(k))).toEqual([]);
  });

  it('portable-secret column overrides agree with CREDENTIAL_COLUMNS', () => {
    const registry = new Set<string>();
    for (const scope of ['project', 'global'] as const) {
      for (const [table, entry] of Object.entries(getTableRegistry(scope).tables)) {
        for (const o of entry.columns ?? []) {
          if (o.class === 'portable-secret') registry.add(`${table}.${o.column}`);
        }
      }
    }
    const bundle = new Set(
      Object.entries(CREDENTIAL_COLUMNS).flatMap(([t, cs]) => cs.map((c) => `${t}.${c}`)),
    );
    expect(
      [...registry].filter((k) => !bundle.has(k)).sort(),
      'missing from CREDENTIAL_COLUMNS',
    ).toEqual([]);
    expect([...bundle].filter((k) => !registry.has(k)).sort(), 'missing from the registry').toEqual(
      [],
    );
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
    // No classification by prefix or suffix alone: an unknown `_fts` table or
    // `brain_embeddings_*` table is unclassified until someone rules on it.
    expect(classifyTable('project', 'foo_fts').kind).toBe('unclassified');
    expect(classifyTable('project', 'foo_fts_data').kind).toBe('unclassified');
    expect(classifyTable('global', 'foo_fts').kind).toBe('unclassified');
    expect(classifyTable('project', 'brain_embeddings_backup').kind).toBe('unclassified');
    expect(classifyTable('global', 'brain_embeddings_v2').kind).toBe('unclassified');
    // Scope matters: the exodus scratch pattern is project-only.
    expect(classifyTable('global', '_exodus_recovery_tasks').kind).toBe('unclassified');
  });

  it('does not treat inherited object keys as entries', () => {
    expect(classifyTable('project', 'constructor').kind).toBe('unclassified');
    expect(classifyTable('project', '__proto__').kind).toBe('unclassified');
  });

  it('only portable classes sync', () => {
    expect(TABLE_CLASSES.filter(isPortableTableClass)).toEqual([
      'portable-project',
      'portable-personal',
      'portable-secret',
    ]);
  });
});

describe('Gate A: two-tier policy', () => {
  it('tier 1: every class is backed up, whatever its sync class', () => {
    expect(Object.keys(TABLE_CLASS_POLICY).sort()).toEqual([...TABLE_CLASSES].sort());
    for (const c of TABLE_CLASSES) expect(TABLE_CLASS_POLICY[c].backup, c).toBe(true);
  });

  /**
   * `derived` is narrow: only what is rebuilt deterministically, cheaply and
   * without an LLM. That is FTS5/sqlite-vec shadow tables and the nexus code
   * graph. The allowlist lives HERE, in the assertion, so widening `derived`
   * takes an explicit edit to the gate.
   */
  const NEXUS_CODE_GRAPH = new Set([
    'nexus_nodes',
    'nexus_relations',
    'nexus_contracts',
    'nexus_code_index',
  ]);
  const FTS_SHADOW = /^[a-z_]+_fts(_(config|data|docsize|idx|content))?$/;
  const VEC_SHADOW = /^brain_embeddings_(chunks|info|rowids|vector_chunks[0-9]{2})$/;
  const derivedAllowed = (t: string) =>
    NEXUS_CODE_GRAPH.has(t) || FTS_SHADOW.test(t) || VEC_SHADOW.test(t);

  it.each([
    'project',
    'global',
  ] as const)('%s: derived is only FTS/vec shadows and the nexus code graph', (scope) => {
    const shapes = scope === 'project' ? [...fresh.project, ...liveProject] : [...fresh.global];
    const names = new Set([...Object.keys(getTableRegistry(scope).tables), ...shapes]);
    const wide = [...names]
      .filter((t) => {
        const r = classifyTable(scope, t);
        return (r.kind === 'entry' || r.kind === 'pattern') && r.class === 'derived';
      })
      .filter((t) => !derivedAllowed(t))
      .sort();
    expect(wide, `${scope}: tables classed derived outside the narrow set`).toEqual([]);
  });

  it.each([
    'project',
    'global',
  ] as const)('%s: embeddings and LLM/sleep output are not derived', (scope) => {
    for (const t of [
      'brain_embeddings',
      'brain_patterns',
      'brain_page_edges',
      'brain_memory_trees',
    ]) {
      const r = classifyTable(scope, t);
      expect(r.kind === 'entry' && r.class !== 'derived', `${scope}.${t}`).toBe(true);
    }
  });

  /**
   * cleo-dev's journal spec review rulings (2026-09-29, Q9 and Q11): STDP
   * event history and token usage are portable-personal, and final. Pinned
   * HERE so reverting either takes an explicit edit to the gate.
   */
  const PERSONAL_BY_RULING: Record<TableScope, readonly string[]> = {
    project: [
      'brain_plasticity_events',
      'brain_weight_history',
      'tasks_token_usage',
      'token_usage',
    ],
    global: ['brain_plasticity_events', 'brain_weight_history'],
  };

  it.each([
    'project',
    'global',
  ] as const)('%s: STDP event history and token usage are portable-personal (ruled)', (scope) => {
    for (const t of PERSONAL_BY_RULING[scope]) {
      expect(classifyTable(scope, t), `${scope}.${t}`).toMatchObject({
        kind: 'entry',
        class: 'portable-personal',
        entry: { status: 'resolved' },
      });
    }
  });
});

/**
 * Every trigger has a class, and a guard or side-effect trigger's LIVE text
 * carries its suspension clause (journal spec §3.5 Rule 4; C2(b), D4,
 * T12819, T12827). A frozen-guard never does.
 */
describe('Gate A: trigger classes', () => {
  it.each([
    'project',
    'global',
  ] as const)('%s: every trigger of the fresh store has a class', (scope) => {
    const unclassified = triggers[scope]
      .filter((t) => classifyTrigger(scope, t.name, t.tbl_name, t.sql) === undefined)
      .map((t) => t.name);
    expect(
      unclassified,
      `${scope}: unclassified triggers. Add each to OWNED_TRIGGERS (guard / side-effect, with the ` +
        'suspension clause in a migration) or make it match a class rule in store/sync/trigger-classes.ts.',
    ).toEqual([]);
  });

  it('project: live text matches its class (clause on guard and side-effect, none on frozen-guard)', () => {
    const bad: string[] = [];
    for (const t of triggers.project) {
      const c = classifyTrigger('project', t.name, t.tbl_name, t.sql);
      if (!c) continue;
      const text = normalizeSql(t.sql);
      const hasClause = text.includes('cleo_trigger_suspend');
      const want: Partial<Record<TriggerClass, boolean>> = {
        guard: true,
        'side-effect': true,
        'frozen-guard': false,
        'derived-maintenance': false,
      };
      if (want[c.class] === undefined) continue;
      if (want[c.class] !== hasClause) bad.push(`${t.name} (${c.class})`);
      if (c.class === 'guard' || c.class === 'side-effect') {
        if (!text.includes(normalizeSql(suspendClause(c.class))))
          bad.push(`${t.name}: wrong scope`);
      }
    }
    expect(bad).toEqual([]);
    expect(ownedFindings).toEqual([]);
    const owned = triggers.project.filter((t) => Object.hasOwn(OWNED_TRIGGERS, t.name));
    expect(owned).toHaveLength(Object.keys(OWNED_TRIGGERS).length);
  });

  it('live cleocode shape: every trigger has a class', () => {
    const freshNames = new Set(triggers.project.map((t) => t.name));
    const unclassified = liveProjectTriggers
      .filter((t) => !freshNames.has(t.name))
      .filter((t) => {
        if (classifyTrigger('project', t.name, t.table, '')) return false;
        // Lazily created FTS maintenance (brain-search.ts): `<table>_ai|ad|au`
        // on a table whose `<table>_fts` index is derived.
        const m = /^(\w+)_a[idu]$/.exec(t.name);
        const fts = m ? classifyTable('project', `${m[1]}_fts`) : undefined;
        return !(
          fts &&
          (fts.kind === 'entry' || fts.kind === 'pattern') &&
          fts.class === 'derived'
        );
      })
      .map((t) => t.name);
    expect(unclassified).toEqual([]);
  });
});
