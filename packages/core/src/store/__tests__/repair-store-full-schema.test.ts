/** Repair against the complete runtime schema, including every domain's FTS and vec tables. */
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { syncDocsFts } from '../../docs/docs-fts.js';
import { ensureFts5Tables } from '../../memory/brain-search.js';
import { storeDecision } from '../../memory/decisions.js';
import { createAttachmentStore } from '../attachment-store.js';
import { bindConduitDomain } from '../conduit-sqlite.js';
import { bindBrainDomain } from '../memory-sqlite.js';
import { bindNexusDomain } from '../nexus-sqlite.js';
import { openCleoDbSnapshot } from '../open-cleo-db.js';
import { repairStore } from '../repair-store.js';
import { assertRepairQuiescent, repairFileHash } from '../repair-store-files.js';
import { repairTableCounts } from '../repair-store-salvage.js';
import { getNativeTasksDb, resetDbState } from '../sqlite.js';
import { createTestDb, makeTasks, type TestDbEnv } from './test-db-helper.js';

let env: TestDbEnv;
let live: string;
let child: ChildProcess | undefined;
beforeEach(async () => {
  env = await createTestDb();
  live = join(env.cleoDir, 'cleo.db');
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
  child = undefined;
  resetDbState();
  await env.cleanup();
});

/** The real domain openers supply runtime-only tables and triggers as well as all migrations. */
async function fullSchema(): Promise<DatabaseSync> {
  await bindBrainDomain(env.tempDir);
  await bindConduitDomain(env.tempDir);
  await bindNexusDomain(env.tempDir);
  await syncDocsFts(env.tempDir);
  const db = getNativeTasksDb(env.tempDir);
  if (!db) throw new Error('full runtime schema not open');
  expect(ensureFts5Tables(db)).toBe(true);
  return db;
}

it('repairs the complete current schema with contentless/external FTS and vectors, without losing source rows', async () => {
  const db = await fullSchema();
  const schema = () =>
    db
      .prepare(
        "SELECT type,name,sql FROM main.sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
      )
      .all();
  const expectedSchema = schema();
  const virtual = db
    .prepare("SELECT name,sql FROM main.sqlite_schema WHERE sql LIKE '%VIRTUAL TABLE%'")
    .all();
  expect(virtual).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'docs_fts', sql: expect.stringContaining("content=''") }),
      expect.objectContaining({
        name: 'brain_decisions_fts',
        sql: expect.stringContaining('content=brain_decisions'),
      }),
      expect.objectContaining({ name: 'conduit_messages_fts' }),
      expect.objectContaining({ name: 'nexus_symbols_fts' }),
      expect.objectContaining({ name: 'brain_embeddings', sql: expect.stringContaining('vec0') }),
    ]),
  );
  await env.accessor.upsertSingleTask(
    makeTasks([{ id: 'T100', title: 'before snapshot', status: 'pending' }])[0]!,
  );
  const backups = join(env.cleoDir, 'backups', 'sqlite');
  mkdirSync(backups, { recursive: true });
  const snapshot = join(backups, 'tasks-20261113-120000.db');
  db.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);

  await env.accessor.upsertSingleTask(
    makeTasks([{ id: 'T101', title: 'after snapshot', status: 'pending' }])[0]!,
  );
  await storeDecision(env.tempDir, {
    type: 'technical',
    decision: 'survivingdecision',
    rationale: 'Readable after snapshot',
    confidence: 'high',
    confirmationState: 'accepted',
  });
  const document = Buffer.from('# Surviving document\n\nsalvagedcontentlessindex\n');
  await createAttachmentStore().put(
    document,
    {
      kind: 'blob',
      storageKey: '',
      mime: 'text/markdown',
      size: document.byteLength,
    },
    'task',
    'T101',
    'repair-test',
    env.tempDir,
    { slug: 'surviving-document', type: 'note' },
  );
  await syncDocsFts(env.tempDir);
  db.exec(
    "INSERT INTO nexus_nodes(id,kind,label,file_path,indexed_at) VALUES ('repair-node','function','survivingnexus','src/repaired.ts','2026-11-14T00:00:00Z')",
  );
  db.exec(`INSERT INTO conduit_conversations(id,participants,created_at,updated_at)
    VALUES ('repair-conversation','["a","b"]','2026-11-14T00:00:00Z','2026-11-14T00:00:00Z');
    INSERT INTO conduit_messages(id,conversation_id,from_agent_id,to_agent_id,content,created_at)
    VALUES ('repair-message','repair-conversation','a','b','survivingconduit','2026-11-14T00:00:00Z')`);
  const vector = Buffer.from(new Float32Array(384).fill(0.125).buffer);
  db.prepare('INSERT INTO brain_embeddings(id,embedding,model) VALUES(?,?,?)').run(
    'repair-vector',
    vector,
    'fixture',
  );
  const before = repairTableCounts(db);
  const page = Number(
    db.prepare("SELECT rootpage FROM sqlite_schema WHERE name='tasks_tasks_title_idx'").get()
      ?.rootpage ??
      db
        .prepare(
          "SELECT rootpage FROM sqlite_schema WHERE type='index' AND tbl_name='tasks_tasks' AND rootpage > 0 LIMIT 1",
        )
        .get()?.rootpage,
  );
  const pageSize = Number(db.prepare('PRAGMA page_size').get()?.page_size);
  expect(page).toBeGreaterThan(1);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  resetDbState();
  const damaged = readFileSync(live);
  damaged.fill(0, (page - 1) * pageSize, page * pageSize);
  Buffer.from('GARBAGE-NOT-SQLITE').copy(damaged);
  writeFileSync(live, damaged);

  const receipt = await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir });
  expect(receipt).toMatchObject({ status: 'repaired', integrityOK: true, snapshot });
  const repaired = openCleoDbSnapshot(live, { loadSqliteVec: true });
  try {
    expect(
      repaired.db
        .prepare(
          "SELECT type,name,sql FROM main.sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
        )
        .all(),
    ).toEqual(expectedSchema);
    const counts = repairTableCounts(repaired.db);
    for (const [table, count] of Object.entries(before)) {
      if (!receipt.tables[table]?.rebuilt)
        expect(counts[table], table).toBeGreaterThanOrEqual(count);
    }
    expect(repaired.db.prepare('SELECT id FROM main.tasks_tasks ORDER BY id').all()).toEqual([
      { id: 'T100' },
      { id: 'T101' },
    ]);
    expect(
      repaired.db
        .prepare("SELECT rowid FROM main.docs_fts WHERE docs_fts MATCH 'salvagedcontentlessindex'")
        .all(),
    ).toHaveLength(1);
    expect(
      repaired.db
        .prepare(
          "SELECT id FROM main.brain_decisions_fts WHERE brain_decisions_fts MATCH 'survivingdecision'",
        )
        .all(),
    ).toHaveLength(1);
    expect(
      repaired.db
        .prepare(
          "SELECT node_id FROM main.nexus_symbols_fts WHERE nexus_symbols_fts MATCH 'survivingnexus'",
        )
        .all(),
    ).toEqual([{ node_id: 'repair-node' }]);
    expect(
      repaired.db
        .prepare(
          "SELECT rowid FROM main.conduit_messages_fts WHERE conduit_messages_fts MATCH 'survivingconduit'",
        )
        .all(),
    ).toHaveLength(1);
    expect(
      repaired.db.prepare('SELECT id,embedding FROM main.brain_embeddings').get(),
    ).toMatchObject({ id: 'repair-vector', embedding: new Uint8Array(vector) });
    expect(repaired.db.prepare('PRAGMA integrity_check').all()).toEqual([
      { integrity_check: 'ok' },
    ]);
    expect(repaired.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    repaired.close();
  }
  const beforeRerun = repairFileHash(live);
  expect(await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir })).toMatchObject({
    status: 'healthy',
    quarantineDir: null,
  });
  expect(repairFileHash(live)).toBe(beforeRerun);
}, 120_000);

/** A real descriptor holder, with a CLEO title as a preceding command has during teardown. */
async function holder(title: string, lifetime: number): Promise<ChildProcess> {
  resetDbState();
  const processHandle = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { openSync, closeSync } from 'node:fs';
    process.title = ${JSON.stringify(title)};
    const fd = openSync(process.argv[1], 'r');
    process.stdout.write('ready\\n');
    setTimeout(() => { closeSync(fd); process.exit(0); }, ${lifetime});
  `,
      live,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child = processHandle;
  if (!processHandle.stdout) throw new Error('holder stdout missing');
  await once(processHandle.stdout, 'data');
  return processHandle;
}

it('waits for a preceding CLEO command to finish teardown without changing original bytes', async () => {
  await holder('cleo list teardown', 700);
  const before = repairFileHash(live);
  const diagnostics: string[] = [];
  await assertRepairQuiescent(live, diagnostics);
  expect(diagnostics).toContain('CLEO store holders exited during the bounded teardown wait');
  expect(repairFileHash(live)).toBe(before);
});

it('refuses a persistent CLEO holder at the deadline with its pid, command and shutdown fix', async () => {
  const held = await holder('cleo list persistent', 60_000);
  const before = repairFileHash(live);
  let clock = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => (clock += 20_000));
  await expect(assertRepairQuiescent(live, [])).rejects.toMatchObject({
    codeName: 'E_STORE_IN_USE',
    message: expect.stringContaining(`pid ${held.pid} (cleo list persistent)`),
    fix: expect.stringContaining('normal shutdown'),
  });
  expect(repairFileHash(live)).toBe(before);
  expect(existsSync(join(env.cleoDir, 'quarantine'))).toBe(false);
});

it('names a non-CLEO holder immediately instead of retrying the repair command', async () => {
  const held = await holder('sqlite-holder fixture', 60_000);
  await expect(assertRepairQuiescent(live, [])).rejects.toMatchObject({
    codeName: 'E_STORE_IN_USE',
    message: expect.stringContaining(`pid ${held.pid} (sqlite-holder fixture)`),
    fix: expect.not.stringContaining('cleo doctor repair-store'),
  });
});
