/**
 * Slice-1 union rule and snapshot pinning (T12535).
 *
 * - The initial `schema_meta` / `sticky_tags` collapse never drops a row only
 *   the twin holds: the bare value wins every key both hold, and twin-only
 *   keys and sticky tags are carried over and listed as `kept` (the sticky
 *   junction then follows each note's `tags_json`).
 * - The snapshot a twin collapse takes is pinned: its sidecar says
 *   `pinned: true`, rotation skips it (it does not count toward the cap),
 *   `cleo backup list` shows it, and a snapshot an earlier build took is
 *   pinned at the next open.
 *
 * @task T12535
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { twinCollapseDoctorCheck } from '../../doctor/twin-collapse.js';
import { addSticky } from '../../sticky/create.js';
import { listSystemBackups } from '../../system/backup.js';
import { rotateBackupDir, writeBackupSidecar } from '../backup-sidecar.js';
import { closeBrainDb, getBrainDb } from '../memory-sqlite.js';
import { getDb, getNativeDb, resetDbState } from '../sqlite.js';
import { createSqliteDataAccessor } from '../sqlite-data-accessor.js';
import {
  collapseTwinTables,
  inspectTwinCollapse,
  TWIN_COLLAPSE_MARKER_PREFIX,
} from '../twin-collapse.js';

let root: string;
let projectDir: string;

const dbPath = (): string => join(projectDir, '.cleo', 'cleo.db');
const backupDir = (): string => join(projectDir, '.cleo', 'backups', 'sqlite');

function db(): DatabaseSync {
  const handle = getNativeDb(projectDir);
  if (!handle) throw new Error('native handle not bound');
  return handle;
}

function setMeta(table: string, key: string, value: string): void {
  db()
    .prepare(
      `INSERT INTO main.${table} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

function meta(table: string, key: string): string | undefined {
  return (
    db().prepare(`SELECT value FROM main.${table} WHERE key = ?`).get(key) as
      | { value: string }
      | undefined
  )?.value;
}

/** The pre-migration shape of `schema_meta`: no marker, a live bare table. */
function preMigrationMeta(): void {
  db()
    .prepare('DELETE FROM main.tasks_schema_meta WHERE key = ?')
    .run(`${TWIN_COLLAPSE_MARKER_PREFIX}schema_meta`);
  setMeta('schema_meta', 'schemaVersion', '"live"');
  setMeta('schema_meta', 'focus_state', '{"currentTask":"T900"}');
  setMeta('tasks_schema_meta', 'focus_state', '{"currentTask":"T100"}');
}

function sidecar(backupId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(backupDir(), `${backupId}.meta.json`), 'utf8'));
}

async function reopen(): Promise<void> {
  resetDbState();
  await getDb(projectDir);
  await getBrainDb(projectDir);
}

beforeEach(async () => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  resetDbState();
  root = join(tmpdir(), `s1-union-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  projectDir = join(root, 'project');
  mkdirSync(join(projectDir, '.cleo'), { recursive: true });
  mkdirSync(join(root, 'cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(root, 'cleo'));
  await getDb(projectDir);
  await getBrainDb(projectDir);
});

afterEach(() => {
  closeBrainDb();
  resetDbState();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('union: the initial collapse never drops a twin-only row', () => {
  it('schema_meta: twin-only keys are carried over and listed; the bare value wins shared keys', async () => {
    preMigrationMeta();
    setMeta('tasks_schema_meta', 'project_meta', '{"name":"only-in-the-twin"}');
    setMeta('tasks_schema_meta', 'release_notes', '{"v":"2026.9.0"}');
    const [receipt] = collapseTwinTables(db(), dbPath());
    expect(receipt).toMatchObject({
      table: 'schema_meta',
      status: 'initial',
      dropped: [],
      kept: ['project_meta', 'release_notes', 'task_id_sequence'],
    });
    const accessor = await createSqliteDataAccessor(projectDir);
    expect(await accessor.getMetaValue('project_meta')).toEqual({ name: 'only-in-the-twin' });
    expect(meta('tasks_schema_meta', 'release_notes')).toBe('{"v":"2026.9.0"}');
    expect(meta('tasks_schema_meta', 'focus_state')).toBe('{"currentTask":"T900"}'); // bare wins
    expect(inspectTwinCollapse(db())[0]).toMatchObject({
      state: 'collapsed',
      kept: ['project_meta', 'release_notes', 'task_id_sequence'],
    });
  });

  it('sticky_tags: a twin-only tag the note names is kept and listed', async () => {
    const note = await addSticky({ content: 'n', tags: [] }, projectDir);
    db()
      .prepare('DELETE FROM main.brain_schema_meta WHERE key = ?')
      .run(`${TWIN_COLLAPSE_MARKER_PREFIX}sticky_tags`);
    db()
      .prepare('UPDATE main.brain_sticky_notes SET tags_json = ? WHERE id = ?')
      .run('["alpha","history"]', note.id);
    db()
      .prepare('INSERT INTO main.sticky_tags (sticky_id, tag) VALUES (?, ?)')
      .run(note.id, 'alpha');
    db()
      .prepare('INSERT INTO main.brain_sticky_tags (sticky_id, tag) VALUES (?, ?)')
      .run(note.id, 'history');
    const receipt = collapseTwinTables(db(), dbPath()).find((r) => r.table === 'sticky_tags');
    expect(receipt).toMatchObject({
      status: 'initial',
      dropped: [],
      kept: [`${note.id}\thistory`],
    });
    expect(
      db()
        .prepare('SELECT tag FROM main.brain_sticky_tags WHERE sticky_id = ? ORDER BY tag')
        .all(note.id),
    ).toEqual([{ tag: 'alpha' }, { tag: 'history' }]);
  });
});

describe('sticky: a twin-only tag the note does not name', () => {
  it('is listed as archived (not kept), leaves the junction, and is recorded under the archive key', async () => {
    const note = await addSticky({ content: 'n', tags: [] }, projectDir);
    db()
      .prepare('DELETE FROM main.brain_schema_meta WHERE key = ?')
      .run(`${TWIN_COLLAPSE_MARKER_PREFIX}sticky_tags`);
    db()
      .prepare('UPDATE main.brain_sticky_notes SET tags_json = ? WHERE id = ?')
      .run('["alpha"]', note.id);
    db()
      .prepare('INSERT INTO main.sticky_tags (sticky_id, tag) VALUES (?, ?)')
      .run(note.id, 'alpha');
    db()
      .prepare('INSERT INTO main.brain_sticky_tags (sticky_id, tag) VALUES (?, ?)')
      .run(note.id, 'stale');
    const receipt = collapseTwinTables(db(), dbPath()).find((r) => r.table === 'sticky_tags');
    expect(receipt).toMatchObject({ kept: [], archived: [`${note.id}\tstale`], dropped: [] });
    expect(
      db().prepare('SELECT tag FROM main.brain_sticky_tags WHERE sticky_id = ?').all(note.id),
    ).toEqual([{ tag: 'alpha' }]);
    const archive = db()
      .prepare('SELECT value FROM main.brain_schema_meta WHERE key = ?')
      .get('twin_collapse_archive:sticky_tags') as { value: string };
    expect(JSON.parse(archive.value)).toEqual([`${note.id}\tstale`]);
  });
});

describe('replaced twin values: focus_state history merged, everything else archived', () => {
  /** A session-note list like the live stores carry. */
  const notes = (from: number, count: number, prefix: string) =>
    Array.from({ length: count }, (_, i) => ({
      note: `${prefix} note ${from + i}: ${'work on the store '.repeat(6)}`,
      timestamp: new Date(Date.UTC(2026, 0, 1) + (from + i) * 3_600_000).toISOString(),
    }));

  it('kodomeet shape: a focus_state only the twin holds is kept whole', () => {
    db()
      .prepare('DELETE FROM main.tasks_schema_meta WHERE key = ?')
      .run(`${TWIN_COLLAPSE_MARKER_PREFIX}schema_meta`);
    setMeta('schema_meta', 'schemaVersion', '"live"');
    const focus = JSON.stringify({
      currentTask: null,
      currentPhase: 'core',
      sessionNotes: notes(0, 20, 'kodo'),
    });
    expect(focus.length).toBeGreaterThan(2_800);
    setMeta('tasks_schema_meta', 'focus_state', focus);
    const [receipt] = collapseTwinTables(db(), dbPath());
    expect(receipt?.kept).toContain('focus_state');
    expect(receipt?.dropped).toEqual([]);
    expect(meta('tasks_schema_meta', 'focus_state')).toBe(focus);
  });

  it('cleocode shape: a 178 KB twin history merges into the live focus_state; the twin value is archived', () => {
    db()
      .prepare('DELETE FROM main.tasks_schema_meta WHERE key = ?')
      .run(`${TWIN_COLLAPSE_MARKER_PREFIX}schema_meta`);
    setMeta('schema_meta', 'schemaVersion', '"live"');
    const history = notes(0, 1100, 'history');
    const twinFocus = JSON.stringify({
      currentTask: null,
      currentPhase: 'core',
      sessionNotes: history,
    });
    expect(twinFocus.length).toBeGreaterThan(170_000);
    // The live bare value: current task, and a few notes, two of them also in the twin.
    const liveNotes = [
      history[1098],
      history[1099],
      ...notes(2000, 3, 'live'),
      // A live note older than most of the twin history: the union must sort it in.
      { note: 'live, written early', timestamp: '2026-01-01T05:30:00.000Z' },
    ];
    const bareFocus = JSON.stringify({
      currentTask: 'T12100',
      currentPhase: null,
      sessionNotes: liveNotes,
    });
    setMeta('tasks_schema_meta', 'focus_state', twinFocus);
    setMeta('schema_meta', 'focus_state', bareFocus);
    // Another key both hold with different values, and no merge rule.
    setMeta('tasks_schema_meta', 'project_meta', '{"name":"twin copy"}');
    setMeta('schema_meta', 'project_meta', '{"name":"live"}');
    const [receipt] = collapseTwinTables(db(), dbPath());
    expect(receipt?.archived).toEqual(expect.arrayContaining(['focus_state', 'project_meta']));
    const merged = JSON.parse(meta('tasks_schema_meta', 'focus_state') ?? '{}');
    expect(merged.currentTask).toBe('T12100'); // bare's current fields win
    expect(merged.currentPhase).toBeNull();
    expect(merged.sessionNotes).toHaveLength(1100 + 4); // union, the 2 shared notes once
    const stamps = merged.sessionNotes.map((n: { timestamp: string }) => n.timestamp);
    expect([...stamps].sort()).toEqual(stamps);
    // Every replaced twin value is kept verbatim under its archive key.
    expect(meta('tasks_schema_meta', 'twin_collapse_archive:focus_state')).toBe(twinFocus);
    expect(meta('tasks_schema_meta', 'twin_collapse_archive:project_meta')).toBe(
      '{"name":"twin copy"}',
    );
    expect(meta('tasks_schema_meta', 'project_meta')).toBe('{"name":"live"}');
    expect(inspectTwinCollapse(db())[0]).toMatchObject({
      archived: expect.arrayContaining(['focus_state', 'project_meta']),
    });
    // Informational, not a warning: nothing was lost.
    expect(twinCollapseDoctorCheck(projectDir)).toMatchObject({
      status: 'ok',
      message: expect.stringMatching(
        /archived the twin's own values of schema_meta: .*focus_state/,
      ),
    });
  });

  it('a second open changes nothing: no re-merge, no duplicate notes, the archive untouched', async () => {
    preMigrationMeta();
    setMeta(
      'tasks_schema_meta',
      'focus_state',
      JSON.stringify({ currentTask: null, sessionNotes: notes(0, 50, 'history') }),
    );
    setMeta(
      'schema_meta',
      'focus_state',
      JSON.stringify({ currentTask: 'T1', sessionNotes: notes(49, 3, 'history') }),
    );
    collapseTwinTables(db(), dbPath());
    const all = () =>
      JSON.stringify(
        db().prepare('SELECT key, value FROM main.tasks_schema_meta ORDER BY key').all(),
      );
    const first = all();
    const noteCount = () =>
      JSON.parse(meta('tasks_schema_meta', 'focus_state') ?? '{}').sessionNotes.length;
    expect(noteCount()).toBe(52);
    for (let i = 0; i < 2; i++) {
      await reopen();
      expect(collapseTwinTables(db(), dbPath())[0]?.status).toBe('unchanged');
      expect(noteCount()).toBe(52);
    }
    expect(all()).toBe(first);
  });

  it('malformed focus_state or a non-array sessionNotes: the bare value wins and the twin value is archived', () => {
    const cases: Array<[string, string]> = [
      ['{not json', JSON.stringify({ sessionNotes: notes(0, 2, 'x') })],
      [JSON.stringify({ currentTask: 'T2', sessionNotes: [] }), '{"sessionNotes": "not an array"}'],
      [JSON.stringify({ currentTask: 'T3' }), 'also not json'],
    ];
    for (const [bare, twin] of cases) {
      db().prepare("DELETE FROM main.tasks_schema_meta WHERE key LIKE 'twin_collapse%'").run();
      setMeta('schema_meta', 'schemaVersion', '"live"');
      setMeta('schema_meta', 'focus_state', bare);
      setMeta('tasks_schema_meta', 'focus_state', twin);
      const [receipt] = collapseTwinTables(db(), dbPath());
      expect(meta('tasks_schema_meta', 'focus_state'), bare).toBe(bare);
      expect(meta('tasks_schema_meta', 'twin_collapse_archive:focus_state')).toBe(twin);
      expect(receipt?.archived).toContain('focus_state');
    }
  });

  it('notes with the same timestamp and different text are both kept', () => {
    preMigrationMeta();
    const at = '2026-01-01T10:00:00.000Z';
    setMeta(
      'tasks_schema_meta',
      'focus_state',
      JSON.stringify({ sessionNotes: [{ note: 'twin', timestamp: at }] }),
    );
    setMeta(
      'schema_meta',
      'focus_state',
      JSON.stringify({ currentTask: 'T4', sessionNotes: [{ note: 'bare', timestamp: at }] }),
    );
    collapseTwinTables(db(), dbPath());
    const merged = JSON.parse(meta('tasks_schema_meta', 'focus_state') ?? '{}');
    expect(merged.sessionNotes.map((n: { note: string }) => n.note).sort()).toEqual([
      'bare',
      'twin',
    ]);
  });

  it('an unchanged twin value (the same as the result) is not archived', () => {
    preMigrationMeta();
    setMeta('schema_meta', 'project_meta', '{"name":"same"}');
    setMeta('tasks_schema_meta', 'project_meta', '{"name":"same"}');
    const [receipt] = collapseTwinTables(db(), dbPath());
    expect(receipt?.archived).not.toContain('project_meta');
    expect(meta('tasks_schema_meta', 'twin_collapse_archive:project_meta')).toBeUndefined();
  });
});

describe('pinning: the pre-collapse snapshot is never rotated', () => {
  it('the collapse snapshot is written pinned and cleo backup list shows it', () => {
    preMigrationMeta();
    setMeta('tasks_schema_meta', 'project_meta', '{"name":"x"}');
    const [receipt] = collapseTwinTables(db(), dbPath());
    const snapshot = receipt?.snapshotPath as string;
    expect(existsSync(snapshot)).toBe(true);
    const backupId = snapshot.slice(snapshot.indexOf('.migration-') + 1);
    expect(sidecar(backupId)).toMatchObject({ pinned: true, type: 'migration' });
    expect(listSystemBackups(projectDir).find((b) => b.backupId === backupId)).toMatchObject({
      pinned: true,
      pinnedReason: expect.stringContaining('T12535'),
    });
    expect(inspectTwinCollapse(db())[0]).toMatchObject({ snapshotPinned: true });
  });

  it('a marker whose snapshot is gone is reported by doctor', () => {
    preMigrationMeta();
    setMeta('tasks_schema_meta', 'project_meta', '{"name":"x"}');
    const [receipt] = collapseTwinTables(db(), dbPath());
    rmSync(receipt?.snapshotPath as string);
    expect(inspectTwinCollapse(db())[0]).toMatchObject({
      snapshotMissing: true,
      snapshotPinned: null,
    });
    expect(twinCollapseDoctorCheck(projectDir)).toMatchObject({
      status: 'warning',
      message: expect.stringMatching(/pre-collapse snapshot of schema_meta .* is missing/),
    });
  });

  it('a malformed sidecar never pins a backup, even if it says pinned: true', () => {
    mkdirSync(backupDir(), { recursive: true });
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) {
      const id = `migration-20260102-0000${String(i).padStart(2, '0')}`;
      const file = join(backupDir(), `cleo.db.${id}`);
      writeFileSync(file, `snapshot ${i}`);
      const at = new Date(Date.UTC(2026, 0, 2, 0, 0, i));
      utimesSync(file, at, at);
      writeFileSync(
        join(backupDir(), `${id}.meta.json`),
        JSON.stringify({
          backupId: id,
          type: 'migration',
          timestamp: at.toISOString(),
          ...(i === 0 ? { pinned: true, files: 'cleo.db' } : { files: ['cleo.db'] }),
        }),
      );
      ids.push(id);
    }
    rotateBackupDir(backupDir(), 10, 'migration');
    expect(existsSync(join(backupDir(), `cleo.db.${ids[0]}`))).toBe(false);
  });

  it('rotation skips a pinned backup, and it does not count toward the cap', () => {
    mkdirSync(backupDir(), { recursive: true });
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const id = `migration-20260101-0000${String(i).padStart(2, '0')}`;
      const file = join(backupDir(), `cleo.db.${id}`);
      writeFileSync(file, `snapshot ${i}`);
      const at = new Date(Date.UTC(2026, 0, 1, 0, 0, i));
      utimesSync(file, at, at);
      writeBackupSidecar(backupDir(), {
        backupId: id,
        type: 'migration',
        timestamp: at.toISOString(),
        files: ['cleo.db'],
        ...(i === 0 ? { pinned: true, pinnedReason: 'test' } : {}),
      });
      ids.push(id);
    }
    rotateBackupDir(backupDir(), 10, 'migration');
    const kept = ids.filter((id) => existsSync(join(backupDir(), `cleo.db.${id}`)));
    // The pinned oldest survives; of the other 11, the 10 newest are kept.
    expect(kept).toEqual([ids[0], ...ids.slice(2)]);
  });

  it('rotation never deletes an unpinned snapshot a marker references, and it does not count toward the cap (T12727)', () => {
    mkdirSync(backupDir(), { recursive: true });
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const id = `migration-20260103-0000${String(i).padStart(2, '0')}`;
      const file = join(backupDir(), `cleo.db.${id}`);
      writeFileSync(file, `snapshot ${i}`); // no sidecar at all, as 2026.9.21 left some
      const at = new Date(Date.UTC(2026, 0, 3, 0, 0, i));
      utimesSync(file, at, at);
      ids.push(id);
    }
    setMeta(
      'brain_schema_meta',
      `${TWIN_COLLAPSE_MARKER_PREFIX}sticky_tags`,
      JSON.stringify({ version: 3, snapshot: join(backupDir(), `cleo.db.${ids[0]}`) }),
    );
    rotateBackupDir(backupDir(), 10, 'migration');
    const kept = ids.filter((id) => existsSync(join(backupDir(), `cleo.db.${id}`)));
    expect(kept).toEqual([ids[0], ...ids.slice(2)]);
  });

  it('an unreadable marker keeps every migration backup, says so, and other types still rotate (T12770)', () => {
    mkdirSync(backupDir(), { recursive: true });
    for (let i = 0; i < 12; i++) {
      const n = String(i).padStart(2, '0');
      writeFileSync(join(backupDir(), `cleo.db.migration-20260104-0000${n}`), 'x');
      writeFileSync(join(backupDir(), `cleo.db.snapshot-20260104-0000${n}`), 'x');
    }
    const key = `brain_schema_meta:${TWIN_COLLAPSE_MARKER_PREFIX}sticky_tags`;
    setMeta('brain_schema_meta', `${TWIN_COLLAPSE_MARKER_PREFIX}sticky_tags`, '{not json');
    expect(rotateBackupDir(backupDir(), 10, 'migration')).toMatchObject({
      deleted: [],
      keptAll: 'marker-unreadable',
      unreadable: [key],
    });
    expect(readdirSync(backupDir()).filter((f) => f.includes('.migration-'))).toHaveLength(12);
    const other = rotateBackupDir(backupDir(), 10, 'snapshot');
    expect(other).toMatchObject({ keptAll: null });
    expect(other.deleted).toHaveLength(2);
    expect(readdirSync(backupDir()).filter((f) => f.includes('.snapshot-'))).toHaveLength(10);
    expect(twinCollapseDoctorCheck(projectDir)).toMatchObject({
      status: 'warning',
      message: expect.stringContaining(
        `the twin-collapse marker ${key} cannot be read, so backup rotation keeps every migration backup`,
      ),
    });
  });

  it('cleo doctor names a marker whose snapshot field cannot be read, on an otherwise healthy store (T12770)', () => {
    const key = `${TWIN_COLLAPSE_MARKER_PREFIX}sticky_tags`;
    expect(twinCollapseDoctorCheck(projectDir)).toMatchObject({ status: 'ok' });
    const marker = JSON.parse(meta('brain_schema_meta', key) ?? '{}');
    setMeta('brain_schema_meta', key, JSON.stringify({ ...marker, snapshot: 42 }));
    expect(twinCollapseDoctorCheck(projectDir)).toMatchObject({
      status: 'warning',
      message: `the twin-collapse marker brain_schema_meta:${key} cannot be read, so backup rotation keeps every migration backup in .cleo/backups/sqlite until it is repaired`,
    });
  });

  it('a store that cannot be read (busy, corrupt) keeps migration backups and reports the error (T12770)', () => {
    const other = join(root, 'other', '.cleo');
    const dir = join(other, 'backups', 'sqlite');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(other, 'cleo.db'), 'not a database, as good as locked');
    for (let i = 0; i < 12; i++)
      writeFileSync(join(dir, `cleo.db.migration-20260105-0000${String(i).padStart(2, '0')}`), 'x');
    const kept = rotateBackupDir(dir, 10, 'migration');
    expect(kept).toMatchObject({ deleted: [], keptAll: 'store-unreadable' });
    expect(kept.error).toEqual(expect.any(String));
    expect(readdirSync(dir)).toHaveLength(12);
  });

  it('a pre-collapse snapshot with no sidecar is pinned at the next open, once (T12727)', async () => {
    preMigrationMeta();
    const [receipt] = collapseTwinTables(db(), dbPath());
    const snapshot = receipt?.snapshotPath as string;
    const backupId = snapshot.slice(snapshot.indexOf('.migration-') + 1);
    const path = join(backupDir(), `${backupId}.meta.json`);
    rmSync(path);
    expect(inspectTwinCollapse(db())[0]).toMatchObject({ snapshotPinned: false });
    await reopen();
    expect(sidecar(backupId)).toMatchObject({ backupId, type: 'migration', pinned: true });
    const first = readFileSync(path, 'utf8');
    const firstMtime = statSync(path).mtimeMs;
    await reopen();
    expect(readFileSync(path, 'utf8')).toBe(first);
    expect(statSync(path).mtimeMs).toBe(firstMtime);
    expect(readFileSync(snapshot).length).toBeGreaterThan(0);
  });

  it('a snapshot an earlier build took unpinned is reported, then pinned at the next open', async () => {
    preMigrationMeta();
    setMeta('tasks_schema_meta', 'project_meta', '{"name":"x"}');
    const [receipt] = collapseTwinTables(db(), dbPath());
    const snapshot = receipt?.snapshotPath as string;
    const backupId = snapshot.slice(snapshot.indexOf('.migration-') + 1);
    // As 2026.9.21 wrote it: no pinned flag.
    const {
      pinned: _p,
      pinnedReason: _r,
      ...unpinned
    } = sidecar(backupId) as {
      pinned?: boolean;
      pinnedReason?: string;
    };
    writeFileSync(join(backupDir(), `${backupId}.meta.json`), JSON.stringify(unpinned));
    expect(inspectTwinCollapse(db())[0]).toMatchObject({ snapshotPinned: false });
    expect(twinCollapseDoctorCheck(projectDir)).toMatchObject({
      status: 'warning',
      message: expect.stringMatching(/is not pinned yet/),
    });
    await reopen();
    expect(sidecar(backupId)).toMatchObject({ pinned: true });
    expect(inspectTwinCollapse(db())[0]).toMatchObject({ snapshotPinned: true });
  });
});
