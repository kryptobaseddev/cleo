/**
 * Twin collapses (T12535, PR 2): `attachments` → `docs_attachments` and
 * `attachment_refs` → `docs_attachment_refs`, bare-authoritative, initial
 * collapse plus incremental re-merge on every open.
 *
 * Every case starts from a fresh migrated store put back into the
 * PRE-MIGRATION shape: the markers removed, the twin without the UNIQUE
 * indexes this build adds, the bare tables holding a realistic docs set the
 * way the 2026.9.20 build writes it (ADRs in a supersedes chain with display
 * aliases, a spec, plain task attachments without a slug, refs from tasks,
 * sessions and observations), and the twin holding a frozen exodus copy. "Old
 * build" below means raw writes to the bare tables; "re-open" drops the
 * bindings so the next `getDb` runs the collapse inside the bind, as a new CLI
 * process does.
 *
 * @task T12535
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Attachment } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findHighestAdrNumber } from '../../docs/adr-allocator.js';
import { setDisplayAlias } from '../../docs/display-alias.js';
import { updateDocBySlug } from '../../docs/docs-update.js';
import { supersedeDoc } from '../../docs/supersede.js';
import { retryTwinCollapse, twinCollapseDoctorCheck } from '../../doctor/twin-collapse.js';
import { createAttachmentStore } from '../attachment-store.js';
import { getDb, getNativeDb, resetDbState } from '../sqlite.js';
import { storeWriteBlock } from '../store-write-guard.js';
import {
  collapseTwinTables,
  inspectTwinCollapse,
  TWIN_COLLAPSE_MARKER_PREFIX,
} from '../twin-collapse.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const MARKERS = ['attachments', 'attachment_refs'].map((t) => `${TWIN_COLLAPSE_MARKER_PREFIX}${t}`);
const UNIQUE_INDEXES = ['uniq_docs_attachments_sha256', 'uniq_docs_attachments_slug'];
/** Index of each pair in the collapse receipts and inspect output. */
const DOCS = 2;
const REFS = 3;

/** The columns both tables share (the bare table's, in its order). */
const COLUMNS = [
  'id',
  'sha256',
  'attachment_json',
  'created_at',
  'ref_count',
  'slug',
  'type',
  'lifecycle_status',
  'supersedes',
  'superseded_by',
  'summary',
  'keywords',
  'topics',
  'related_tasks',
  'display_alias',
  'owner_version',
  'doc_version',
] as const;
const REF_COLUMNS = ['attachment_id', 'owner_type', 'owner_id', 'attached_at', 'attached_by'];

/** A markdown blob attachment as `put` takes it (sha256 and storage key are filled in). */
const blob = (size: number): Omit<Attachment, 'sha256'> =>
  ({ kind: 'blob', storageKey: '', mime: 'text/markdown', size }) as Omit<Attachment, 'sha256'>;

let root: string;
let projectDir: string;

const dbPath = (): string => join(projectDir, '.cleo', 'cleo.db');
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');

function tasksNative(): DatabaseSync {
  const db = getNativeDb(projectDir);
  if (!db) throw new Error('tasks native handle not bound');
  return db;
}

/** A new CLI process: drop every binding, bind again (the collapse runs in the bind). */
async function reopen(): Promise<void> {
  resetDbState();
  await getDb(projectDir);
}

/** sha256 over a table's rows in a stable order: the byte-level fingerprint. */
function digest(db: DatabaseSync, table: string, schema = 'main'): string {
  const order = table.includes('refs') ? 'attachment_id, owner_type, owner_id' : 'id';
  return sha(
    JSON.stringify(db.prepare(`SELECT * FROM ${schema}.${table} ORDER BY ${order}`).all()),
  );
}

/** Shared-column rows of a table, keyed like the collapse keys them. */
function rows(db: DatabaseSync, table: string, schema = 'main'): string[] {
  const cols = table.includes('refs') ? REF_COLUMNS : COLUMNS;
  const order = table.includes('refs') ? 'attachment_id, owner_type, owner_id' : 'id';
  return (
    db
      .prepare(`SELECT ${cols.join(', ')} FROM ${schema}.${table} ORDER BY ${order}`)
      .all() as Array<Record<string, unknown>>
  ).map((r) => JSON.stringify(cols.map((c) => r[c] ?? null)));
}

function uniqueIndexes(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM main.sqlite_master WHERE type = 'index' AND tbl_name = 'docs_attachments' AND name LIKE 'uniq_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

interface Doc {
  readonly id: string;
  readonly slug?: string | null;
  readonly type?: string | null;
  readonly status?: string;
  readonly supersedes?: string | null;
  readonly supersededBy?: string | null;
  readonly alias?: number | null;
  readonly summary?: string | null;
  readonly createdAt?: string;
  readonly refs?: ReadonlyArray<readonly [string, string]>;
}

/** A doc row (and its refs) written the way the 2026.9.20 build writes it, into `table`. */
function writeDoc(db: DatabaseSync, table: 'attachments' | 'docs_attachments', doc: Doc): void {
  const refsTable = table === 'attachments' ? 'attachment_refs' : 'docs_attachment_refs';
  const hash = sha(`content of ${doc.id}`);
  db.prepare(
    `INSERT INTO main.${table} (id, sha256, attachment_json, created_at, ref_count, slug, type, lifecycle_status, supersedes, superseded_by, summary, keywords, topics, related_tasks, display_alias, owner_version, doc_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    doc.id,
    hash,
    JSON.stringify({ kind: 'blob', storageKey: hash, mime: 'text/markdown', size: 42 }),
    doc.createdAt ?? '2026-09-20T10:00:00.000Z',
    doc.refs?.length ?? 0,
    doc.slug ?? null,
    doc.type ?? null,
    doc.status ?? 'draft',
    doc.supersedes ?? null,
    doc.supersededBy ?? null,
    doc.summary ?? null,
    doc.type === 'adr' ? '["storage"]' : null,
    null,
    doc.type === 'adr' ? '["T100"]' : null,
    doc.alias ?? null,
    null,
    1,
  );
  for (const [ownerType, ownerId] of doc.refs ?? []) {
    db.prepare(
      `INSERT INTO main.${refsTable} (attachment_id, owner_type, owner_id, attached_at, attached_by) VALUES (?, ?, ?, ?, ?)`,
    ).run(doc.id, ownerType, ownerId, '2026-09-20T10:00:00.000Z', 'agent');
  }
}

/** The live docs set, in bare `attachments` (the 2026.9.20 build's tables). */
const LIVE_DOCS: readonly Doc[] = [
  // `a…` sorts before `b…`: the chain's forward reference needs deferred FKs.
  {
    id: 'att-adr-001',
    slug: 'adr-001',
    type: 'adr',
    status: 'superseded',
    supersededBy: 'att-adr-002',
    alias: 1,
    summary: 'Use SQLite',
    refs: [['task', 'T100']],
  },
  {
    id: 'att-adr-002',
    slug: 'adr-002',
    type: 'adr',
    status: 'accepted',
    supersedes: 'att-adr-001',
    alias: 2,
    summary: 'Use one cleo.db',
    refs: [
      ['task', 'T100'],
      ['session', 'ses_1'],
    ],
  },
  { id: 'att-spec-a', slug: 'spec-a', type: 'spec', summary: 'Spec A', refs: [['task', 'T101']] },
  {
    id: 'att-note-1',
    refs: [
      ['task', 'T102'],
      ['observation', 'O-1'],
    ],
  },
  { id: 'att-note-2', refs: [['task', 'T103']] },
];

/**
 * Put the store back in the pre-migration shape: no markers, no UNIQUE
 * indexes on the twin, the live docs in the bare tables, a frozen exodus copy
 * in the twin (one stale row, one twin-only row whose slug duplicates a live
 * one, and a twin-only ref).
 */
function preMigration(): DatabaseSync {
  const db = tasksNative();
  for (const marker of MARKERS)
    db.prepare('DELETE FROM main.tasks_schema_meta WHERE key = ?').run(marker);
  for (const index of UNIQUE_INDEXES) db.exec(`DROP INDEX IF EXISTS main.${index}`);
  for (const doc of LIVE_DOCS) writeDoc(db, 'attachments', doc);
  writeDoc(db, 'docs_attachments', {
    id: 'att-adr-001',
    slug: 'adr-001',
    type: 'adr',
    status: 'accepted', // stale: superseded since
    summary: 'Use SQLite',
    refs: [['task', 'T100']],
  });
  writeDoc(db, 'docs_attachments', {
    id: 'att-frozen',
    slug: 'spec-a', // a frozen duplicate of a live slug
    type: 'spec',
    refs: [['task', 'T101']],
  });
  return db;
}

function migrationSnapshots(): string[] {
  const dir = join(projectDir, '.cleo', 'backups', 'sqlite');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith('cleo.db.migration-')) : [];
}

function readRows(file: string): string[] {
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.length > 0)
    : [];
}

/** The messages along a rejected write's error chain, or `''` when it succeeded. */
async function refusal(write: () => unknown): Promise<string> {
  try {
    await write();
    return '';
  } catch (error) {
    const messages: string[] = [];
    for (let e: unknown = error; e instanceof Error; e = e.cause) messages.push(e.message);
    return messages.join(' <- ');
  }
}

beforeEach(async () => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  resetDbState();
  root = join(tmpdir(), `twin-collapse-docs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  projectDir = join(root, 'project');
  mkdirSync(join(projectDir, '.cleo'), { recursive: true });
  mkdirSync(join(root, 'cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(root, 'cleo'));
  await getDb(projectDir);
});

afterEach(() => {
  resetDbState();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('fresh store', () => {
  it('collapses both docs pairs on first bind (nothing to carry) and creates the UNIQUE indexes', () => {
    const db = tasksNative();
    for (const marker of MARKERS)
      expect(
        db.prepare('SELECT 1 FROM main.tasks_schema_meta WHERE key = ?').get(marker),
      ).toBeDefined();
    expect(uniqueIndexes(db)).toEqual(UNIQUE_INDEXES);
    expect(migrationSnapshots()).toEqual([]);
  });
});

describe('union-shape migration (T12541: a migration must really run)', () => {
  const MIGRATION = '20260929000000_t12535-docs-attachments-union-shape';
  const shape = (db: DatabaseSync) => ({
    column: (
      db.prepare("SELECT name FROM pragma_table_info('docs_attachments', 'main')").all() as Array<{
        name: string;
      }>
    ).some((c) => c.name === 'display_alias'),
    indexes: (
      db
        .prepare(
          "SELECT name FROM main.sqlite_master WHERE type = 'index' AND name IN ('idx_docs_attachments_display_alias', 'idx_docs_attachments_type') ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name),
    journaled:
      db.prepare('SELECT 1 FROM main.__drizzle_migrations WHERE name = ?').get(MIGRATION) !==
      undefined,
  });
  const APPLIED = {
    column: true,
    indexes: ['idx_docs_attachments_display_alias', 'idx_docs_attachments_type'],
    journaled: true,
  };

  it('a fresh store runs it', () => {
    expect(shape(tasksNative())).toEqual(APPLIED);
  });

  it('an upgraded store (the shape before this build) runs it on the next open', async () => {
    const db = tasksNative();
    db.exec('DROP INDEX main.idx_docs_attachments_display_alias');
    db.exec('DROP INDEX main.idx_docs_attachments_type');
    db.exec('ALTER TABLE main.docs_attachments DROP COLUMN display_alias');
    db.prepare('DELETE FROM main.__drizzle_migrations WHERE name = ?').run(MIGRATION);
    expect(shape(db)).toEqual({ column: false, indexes: [], journaled: false });
    await reopen();
    expect(shape(tasksNative())).toEqual(APPLIED);
  });
});

describe('initial collapse: the bare tables are authoritative', () => {
  it('carries every live row and ref, drops the frozen twin-only ones, snapshots first', async () => {
    const db = preMigration();
    const bareDocs = rows(db, 'attachments');
    const bareRefs = rows(db, 'attachment_refs');
    const receipts = collapseTwinTables(db, dbPath());
    expect(receipts[DOCS]).toMatchObject({
      table: 'attachments',
      status: 'initial',
      inserted: 4, // att-adr-001 existed (stale) and is replaced
      replaced: 1,
      deleted: 1,
      dropped: ['["att-frozen"]'],
      snapshotPath: expect.stringContaining('cleo.db.migration-'),
    });
    expect(receipts[REFS]).toMatchObject({
      status: 'initial',
      dropped: ['["att-frozen","task","T101"]'],
    });
    expect(rows(db, 'docs_attachments')).toEqual(bareDocs);
    expect(rows(db, 'docs_attachment_refs')).toEqual(bareRefs);
    expect(migrationSnapshots()).toHaveLength(1); // one snapshot for every pair

    // The docs read APIs (on the redirected barrel) serve the live set.
    const store = createAttachmentStore();
    expect(await store.findBySlug('adr-002', projectDir)).toMatchObject({
      lifecycleStatus: 'accepted',
      displayAlias: 2,
      metadata: { id: 'att-adr-002' },
    });
    expect(await store.findBySlug('adr-001', projectDir)).toMatchObject({
      lifecycleStatus: 'superseded',
    });
    expect((await store.findBySlug('spec-a', projectDir))?.metadata.id).toBe('att-spec-a');
    expect((await store.listByOwner('task', 'T100', projectDir)).map((m) => m.id).sort()).toEqual([
      'att-adr-001',
      'att-adr-002',
    ]);
    expect((await store.listRefs('att-note-1', projectDir)).length).toBe(2);
  });

  it('keeps the self-FK chain valid with foreign keys ON (checked at commit)', () => {
    const db = preMigration();
    db.exec('PRAGMA foreign_keys = ON');
    try {
      expect(collapseTwinTables(db, dbPath())[DOCS]?.status).toBe('initial');
      expect(db.prepare('PRAGMA main.foreign_key_check(docs_attachments)').all()).toEqual([]);
      expect(
        db
          .prepare("SELECT superseded_by FROM main.docs_attachments WHERE id = 'att-adr-001'")
          .get(),
      ).toEqual({ superseded_by: 'att-adr-002' });
    } finally {
      db.exec('PRAGMA foreign_keys = OFF');
    }
  });
});

describe('uniqueness and collisions', () => {
  it('slug and sha256 are UNIQUE on the twin after the merge (several NULL slugs allowed)', async () => {
    const db = preMigration();
    collapseTwinTables(db, dbPath());
    expect(uniqueIndexes(db)).toEqual(UNIQUE_INDEXES);
    expect(
      await refusal(() => writeDoc(db, 'docs_attachments', { id: 'att-dup-slug', slug: 'spec-a' })),
    ).toMatch(/UNIQUE constraint failed: docs_attachments\.slug/);
    expect(
      await refusal(() =>
        db
          .prepare(
            "INSERT INTO main.docs_attachments (id, sha256, attachment_json, created_at) SELECT 'att-dup-sha', sha256, attachment_json, created_at FROM main.docs_attachments WHERE id = 'att-spec-a'",
          )
          .run(),
      ),
    ).toMatch(/UNIQUE constraint failed: docs_attachments\.sha256/);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM main.docs_attachments WHERE slug IS NULL').get(),
    ).toEqual({ n: 2 });
    // The put pre-check reports the collision on the twin.
    await expect(
      createAttachmentStore().put(
        Buffer.from('other bytes'),
        blob(11),
        'task',
        'T104',
        'agent',
        projectDir,
        { slug: 'adr-002', type: 'adr' },
      ),
    ).rejects.toMatchObject({ name: 'SlugCollisionError' });
  });

  it('two rows the old build swapped slugs on re-merge without tripping the UNIQUE index', async () => {
    const db = preMigration();
    collapseTwinTables(db, dbPath());
    db.exec('BEGIN');
    db.exec("UPDATE main.attachments SET slug = 'swap-tmp' WHERE id = 'att-adr-001'");
    db.exec("UPDATE main.attachments SET slug = 'adr-001' WHERE id = 'att-adr-002'");
    db.exec("UPDATE main.attachments SET slug = 'adr-002' WHERE id = 'att-adr-001'");
    db.exec('COMMIT');
    expect(collapseTwinTables(db, dbPath())[DOCS]).toMatchObject({
      status: 'incremental',
      replaced: 2,
    });
    expect(
      db
        .prepare('SELECT id, slug FROM main.docs_attachments WHERE type = ? ORDER BY id')
        .all('adr'),
    ).toEqual([
      { id: 'att-adr-001', slug: 'adr-002' },
      { id: 'att-adr-002', slug: 'adr-001' },
    ]);
    expect(uniqueIndexes(db)).toEqual(UNIQUE_INDEXES);
  });
});

describe('incremental re-merge: the old build keeps writing the bare tables', () => {
  it('old-build inserts, updates and deletes appear in the new build reads', async () => {
    preMigration();
    await reopen();
    const store = createAttachmentStore();
    // This build adds a doc of its own (twin only): the re-merge keeps it.
    const mine = await store.put(
      Buffer.from('# new build doc'),
      blob(15),
      'task',
      'T200',
      'agent',
      projectDir,
      { slug: 'new-build-doc', type: 'note' },
    );
    const db = tasksNative();
    writeDoc(db, 'attachments', {
      id: 'att-spec-b',
      slug: 'spec-b',
      type: 'spec',
      refs: [['task', 'T105']],
    });
    db.exec("UPDATE main.attachments SET summary = 'Spec A, revised' WHERE id = 'att-spec-a'");
    db.exec("DELETE FROM main.attachment_refs WHERE attachment_id = 'att-note-2'");
    db.exec("DELETE FROM main.attachments WHERE id = 'att-note-2'");

    await reopen();
    expect(inspectTwinCollapse(tasksNative())[DOCS]).toMatchObject({
      state: 'collapsed',
      conflicts: [],
    });
    expect((await store.findBySlug('spec-b', projectDir))?.metadata.id).toBe('att-spec-b');
    expect((await store.findBySlug('spec-a', projectDir))?.summary).toBe('Spec A, revised');
    expect(await store.getMetadata('att-note-2', projectDir)).toBeNull();
    expect(await store.listByOwner('task', 'T103', projectDir)).toEqual([]);
    expect((await store.listByOwner('task', 'T105', projectDir)).map((m) => m.id)).toEqual([
      'att-spec-b',
    ]);
    expect((await store.findBySlug('new-build-doc', projectDir))?.metadata.id).toBe(mine.id);
  });

  it('a row both builds changed since the last merge keeps the twin value, and doctor reports it', async () => {
    preMigration();
    await reopen();
    await setDisplayAlias(projectDir, { slug: 'spec-a', displayAlias: 7 }); // this build
    tasksNative().exec(
      "UPDATE main.attachments SET summary = 'old build edit' WHERE id = 'att-spec-a'",
    ); // the old build, same row
    tasksNative().exec(
      "UPDATE main.attachments SET summary = 'old build only' WHERE id = 'att-note-1'",
    ); // the old build alone: no conflict

    await reopen();
    const store = createAttachmentStore();
    expect(await store.findBySlug('spec-a', projectDir)).toMatchObject({
      displayAlias: 7, // twin wins
      summary: 'Spec A',
    });
    expect(
      tasksNative()
        .prepare("SELECT summary FROM main.docs_attachments WHERE id = 'att-note-1'")
        .get(),
    ).toEqual({ summary: 'old build only' });
    expect(inspectTwinCollapse(tasksNative())[DOCS]).toMatchObject({
      state: 'collapsed',
      conflicts: ['["att-spec-a"]'],
    });
    expect(twinCollapseDoctorCheck(projectDir)).toMatchObject({ status: 'warning' });
  });
});

describe('idempotency', () => {
  it('a second run is a no-op for both docs pairs', () => {
    const db = preMigration();
    collapseTwinTables(db, dbPath());
    const docs = digest(db, 'docs_attachments');
    const refs = digest(db, 'docs_attachment_refs');
    const kv = () =>
      sha(JSON.stringify(db.prepare('SELECT * FROM main.tasks_schema_meta ORDER BY key').all()));
    const kvBefore = kv();
    const again = collapseTwinTables(db, dbPath());
    expect([again[DOCS]?.status, again[REFS]?.status]).toEqual(['unchanged', 'unchanged']);
    expect(digest(db, 'docs_attachments')).toBe(docs);
    expect(digest(db, 'docs_attachment_refs')).toBe(refs);
    expect(kv()).toBe(kvBefore); // the markers were not rewritten
    expect(migrationSnapshots()).toHaveLength(1);
  });
});

describe('failure injection mid-merge', () => {
  it('both tables stay byte-identical, the error is E_TWIN_COLLAPSE_FAILED, retry completes', () => {
    const db = preMigration();
    const before = ['attachments', 'docs_attachments', 'attachment_refs'].map((t) => digest(db, t));
    db.exec(
      "CREATE TEMP TRIGGER inject_fail BEFORE INSERT ON main.docs_attachments WHEN NEW.id = 'att-spec-a' BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    );
    let caught: unknown;
    try {
      collapseTwinTables(db, dbPath());
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 55,
      message: expect.stringMatching(/injected failure/),
      details: { snapshotWritten: true },
    });
    expect(db.isTransaction).toBe(false);
    expect(
      ['attachments', 'docs_attachments', 'attachment_refs'].map((t) => digest(db, t)),
    ).toEqual(before);
    // Each pair is its own transaction: the refs pair merged on its own.
    expect(rows(db, 'docs_attachment_refs')).toEqual(rows(db, 'attachment_refs'));
    expect(inspectTwinCollapse(db)[REFS]?.state).toBe('collapsed');
    expect(uniqueIndexes(db)).toEqual([]); // the index drop rolled back with the rest
    expect(inspectTwinCollapse(db)[DOCS]).toMatchObject({ state: 'failed' });

    db.exec('DROP TRIGGER temp.inject_fail');
    expect(collapseTwinTables(db, dbPath())[DOCS]?.status).toBe('initial');
    expect(inspectTwinCollapse(db)[DOCS]?.state).toBe('collapsed');
    expect(uniqueIndexes(db)).toEqual(UNIQUE_INDEXES);
  });

  it('a bare row that violates a twin CHECK degrades the store and doctor names the cause', async () => {
    const db = preMigration();
    writeDoc(db, 'attachments', { id: 'att-bad-date', createdAt: 'yesterday' });
    expect(await refusal(() => reopen())).toBe(''); // never locked out
    const blocked = await storeWriteBlock(projectDir);
    expect(blocked).toMatchObject({
      code: 55,
      details: { tables: ['attachments'] },
    });
    expect(String(blocked?.message)).toMatch(/CHECK constraint failed/);
    expect(inspectTwinCollapse(tasksNative())[DOCS]).toMatchObject({
      state: 'failed',
      failure: { cause: expect.stringMatching(/CHECK constraint failed/) },
    });
    expect(twinCollapseDoctorCheck(projectDir)).toMatchObject({ status: 'error' });
    // Reads still serve the bare-authoritative view, the bad row included.
    const store = createAttachmentStore();
    expect((await store.getMetadata('att-bad-date', projectDir))?.createdAt).toBe('yesterday');
    expect((await store.findBySlug('spec-a', projectDir))?.metadata.id).toBe('att-spec-a');
  });
});

describe('degraded mode: reads served, every docs write refused, retry restores writes', () => {
  it('blocked backups directory', async () => {
    preMigration();
    const backups = join(projectDir, '.cleo', 'backups');
    writeFileSync(backups, 'not a directory');
    expect(await refusal(() => reopen())).toBe('');
    const db = tasksNative();
    const store = createAttachmentStore();

    // Reads see the bare-authoritative merge from the TEMP shadows …
    expect(await store.findBySlug('adr-002', projectDir)).toMatchObject({ displayAlias: 2 });
    expect((await store.findBySlug('spec-a', projectDir))?.metadata.id).toBe('att-spec-a');
    expect((await store.listByOwner('session', 'ses_1', projectDir)).map((m) => m.id)).toEqual([
      'att-adr-002',
    ]);
    // … and a dry run (a read) is served too.
    expect(
      await updateDocBySlug(projectDir, { slug: 'spec-a', content: '# A2', dryRun: true }),
    ).toMatchObject({ ok: true });
    // … while main is untouched.
    expect(
      db.prepare("SELECT 1 FROM main.docs_attachments WHERE id = 'att-adr-002'").get(),
    ).toBeUndefined();

    const state = () =>
      ['docs_attachments', 'docs_attachment_refs']
        .flatMap((t) => [digest(db, t), digest(db, t, 'temp')])
        .join();
    const before = state();
    const writes: Array<[string, () => Promise<unknown>]> = [
      [
        'put',
        () =>
          store.put(Buffer.from('# degraded'), blob(10), 'task', 'T300', 'agent', projectDir, {
            slug: 'degraded-doc',
            type: 'note',
          }),
      ],
      ['ref', () => store.ref('att-spec-a', 'task', 'T301', 'agent', projectDir)],
      ['deref', () => store.deref('att-note-2', 'task', 'T103', projectDir)],
      ['supersede', () => supersedeDoc(projectDir, { oldSlug: 'spec-a', newSlug: 'adr-002' })],
      ['set-alias', () => setDisplayAlias(projectDir, { slug: 'spec-a', displayAlias: 9 })],
      ['update', () => updateDocBySlug(projectDir, { slug: 'spec-a', content: '# A2' })],
    ];
    for (const [name, write] of writes) {
      const message = await refusal(write);
      expect(message, name).toMatch(/Twin collapse of attachments, attachment_refs failed/);
    }
    for (const [, write] of writes) await expect(write()).rejects.toMatchObject({ code: 55 });
    expect(state()).toBe(before); // nothing landed anywhere
    // Backstop: a raw write that skips the accessors hits the shadow's trigger.
    expect(
      await refusal(() =>
        db.prepare("UPDATE docs_attachments SET summary = 'raw' WHERE id = 'att-spec-a'").run(),
      ),
    ).toMatch(/E_TWIN_COLLAPSE_FAILED: store is read-only/);

    rmSync(backups);
    const receipts = await retryTwinCollapse(projectDir);
    expect(receipts[DOCS]).toMatchObject({ table: 'attachments', status: 'initial' });
    expect(await storeWriteBlock(projectDir)).toBeNull();
    await setDisplayAlias(projectDir, { slug: 'spec-a', displayAlias: 9 });
    expect(
      db.prepare("SELECT display_alias FROM main.docs_attachments WHERE id = 'att-spec-a'").get(),
    ).toEqual({ display_alias: 9 });
  });
});

describe('redirect: every docs writer lands in the prefixed twins only', () => {
  it('put, ref, deref, supersede, set-alias and update never touch the bare tables', async () => {
    const db = preMigration();
    collapseTwinTables(db, dbPath());
    // Re-resolved per read: a docs writer may re-bind the store connection.
    const bare = () =>
      [digest(tasksNative(), 'attachments'), digest(tasksNative(), 'attachment_refs')].join();
    const bareBefore = bare();
    const store = createAttachmentStore();
    const put = await store.put(
      Buffer.from('# redirect'),
      blob(10),
      'task',
      'T400',
      'agent',
      projectDir,
      { slug: 'adr-003', type: 'adr' },
    );
    await store.ref(put.id, 'session', 'ses_2', 'agent', projectDir);
    await store.deref(put.id, 'session', 'ses_2', projectDir);
    await supersedeDoc(projectDir, { oldSlug: 'adr-002', newSlug: 'adr-003' });
    await setDisplayAlias(projectDir, { slug: 'adr-003', displayAlias: 3 });
    const updated = await updateDocBySlug(projectDir, { slug: 'spec-a', content: '# Spec A v2' });
    expect(updated).toMatchObject({ ok: true });

    expect(bare()).toBe(bareBefore);
    expect(
      db
        .prepare(
          "SELECT slug, lifecycle_status, superseded_by, display_alias FROM main.docs_attachments WHERE slug IN ('adr-002', 'adr-003') ORDER BY slug",
        )
        .all(),
    ).toEqual([
      { slug: 'adr-002', lifecycle_status: 'superseded', superseded_by: put.id, display_alias: 2 },
      {
        slug: 'adr-003',
        lifecycle_status: expect.any(String),
        superseded_by: null,
        display_alias: 3,
      },
    ]);
    expect(
      db
        .prepare(
          'SELECT owner_type, owner_id FROM main.docs_attachment_refs WHERE attachment_id = ?',
        )
        .all(put.id),
    ).toEqual([{ owner_type: 'task', owner_id: 'T400' }]);
    // The re-open after these writes is a no-op: the bare side did not move.
    await reopen();
    expect(inspectTwinCollapse(tasksNative())[DOCS]).toMatchObject({ state: 'collapsed' });
    expect(bare()).toBe(bareBefore);
  });
});

describe('redirect: docs readers read the prefixed twins', () => {
  it('the ADR number allocator sees an ADR only the twin holds', async () => {
    const db = preMigration();
    collapseTwinTables(db, dbPath());
    // An ADR only the bare table holds (not merged yet) is not the allocator's …
    writeDoc(db, 'attachments', { id: 'att-adr-050', slug: 'adr-050-bare-only', type: 'adr' });
    expect(await findHighestAdrNumber(projectDir)).toBe(0);
    // … an ADR in the twin is.
    writeDoc(db, 'docs_attachments', { id: 'att-adr-044', slug: 'adr-044-new', type: 'adr' });
    expect(await findHighestAdrNumber(projectDir)).toBe(44);
  });
});

describe('Gate B: bare rows are a subset of the post-merge twin', () => {
  it('fingerprint-store + compare-fingerprints (merge mode) pass', async () => {
    const db = preMigration();
    const work = join(root, 'gate-b');
    mkdirSync(work, { recursive: true });
    const pre = join(work, 'pre.db');
    const projection = join(work, 'bare-as-twin.db');
    const post = join(work, 'post.db');
    db.exec(`VACUUM INTO '${pre}'`);
    // The bare rows under the twins' names, in an otherwise identical store:
    // the SOURCE side of the subset check.
    db.exec(`VACUUM INTO '${projection}'`);
    const { DatabaseSync: Sqlite } = await import('node:sqlite');
    const proj = new Sqlite(projection);
    proj.exec('DELETE FROM docs_attachments');
    proj.exec('DELETE FROM docs_attachment_refs');
    proj.exec(
      `INSERT INTO docs_attachments (${COLUMNS.join(', ')}) SELECT ${COLUMNS.join(', ')} FROM attachments`,
    );
    proj.exec(
      `INSERT INTO docs_attachment_refs (${REF_COLUMNS.join(', ')}) SELECT ${REF_COLUMNS.join(', ')} FROM attachment_refs`,
    );
    proj.close();

    collapseTwinTables(db, dbPath());
    db.exec(`VACUUM INTO '${post}'`);

    const keyDir = join(root, 'gate-b-key');
    mkdirSync(keyDir, { recursive: true });
    const key = join(keyDir, 'compare.key');
    const fingerprint = (file: string, label: string): string => {
      const out = join(work, `${label}.json`);
      execFileSync(
        process.execPath,
        [
          join(REPO_ROOT, 'scripts/fingerprint-store.mjs'),
          '--db',
          file,
          ...(existsSync(key) ? ['--key-file', key] : ['--key-out', key]),
          '--label',
          label,
          '--out',
          out,
        ],
        { cwd: REPO_ROOT, stdio: 'pipe' },
      );
      return out;
    };
    // The whole frozen twin is replaced here (a small fixture), so the
    // deletion caps and the table-wipe guard are raised explicitly.
    const compare = (source: string, replica: string, allowDeleted?: string): string =>
      execFileSync(
        process.execPath,
        [
          join(REPO_ROOT, 'scripts/compare-fingerprints.mjs'),
          '--source',
          source,
          '--replica',
          replica,
          '--key-file',
          key,
          '--mode',
          'merge',
          ...(allowDeleted
            ? [
                '--allow-deleted',
                allowDeleted,
                '--max-deleted',
                '3',
                '--max-deleted-per-table',
                '2',
                '--allow-table-wipe',
                'docs_attachments',
              ]
            : []),
        ],
        { cwd: REPO_ROOT, stdio: 'pipe', encoding: 'utf8' },
      );
    const fpPre = fingerprint(pre, 'pre');
    const fpProjection = fingerprint(projection, 'bare-as-twin');
    const fpPost = fingerprint(post, 'post');
    // Control: the same check against the PRE-migration twin fails.
    expect(() => compare(fpProjection, fpPre)).toThrow();
    // Every bare row is in the post-merge twin …
    const subset = compare(fpProjection, fpPost);
    // … and the pre-migration store lost exactly the frozen twin rows the
    // bare-authoritative rule replaces or drops, passed as allowed deletions.
    const postRows = new Set(readRows(`${fpPost}.rows`));
    const dropped = readRows(`${fpPre}.rows`).filter((r) => !postRows.has(r));
    expect(dropped.map((r) => r.split('\t')[0]).sort()).toEqual([
      'docs_attachment_refs', // (att-frozen, task, T101)
      'docs_attachments', // att-adr-001, stale version
      'docs_attachments', // att-frozen
    ]);
    const allowed = join(work, 'allowed-deleted.rows');
    writeFileSync(allowed, `${dropped.join('\n')}\n`);
    const lossless = compare(fpPre, fpPost, allowed);
    if (process.env.T12535_GATE_B_OUT)
      writeFileSync(process.env.T12535_GATE_B_OUT, [subset, lossless].join('\n---\n'));
    expect(subset).toMatch(/PASS/);
    expect(lossless).toMatch(/PASS/);
  }, 120_000);
});
