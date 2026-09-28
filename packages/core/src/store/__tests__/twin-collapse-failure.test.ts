/**
 * A failed twin collapse must never lock the user out (T12535, Blocker B and
 * the fail-mode amendment).
 *
 * With `.cleo/backups` blocked, or not enough free space for the snapshot,
 * the bind still succeeds: reads are served from the merged TEMP shadows,
 * `main` stays untouched, and the write guard refuses writes with
 * `E_TWIN_COLLAPSE_FAILED` naming the cause, the snapshot path and the space
 * needed. The doctor check and `cleo doctor twin-collapse` report it, and the
 * retry succeeds once the cause is cleared. The space check runs before the
 * snapshot.
 *
 * @task T12535
 */

import * as fs from 'node:fs';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  inspectProjectTwinCollapse,
  retryTwinCollapse,
  twinCollapseDoctorCheck,
} from '../../doctor/twin-collapse.js';
import { sessionStatus } from '../../session/engine-ops.js';
import { addSticky } from '../../sticky/create.js';
import { listStickies } from '../../sticky/list.js';
import { getBrainAccessor } from '../memory-accessor.js';
import { getBrainDb } from '../memory-sqlite.js';
import { getDb, getNativeDb, resetDbState } from '../sqlite.js';
import { createSqliteDataAccessor } from '../sqlite-data-accessor.js';
import { storeWriteBlock } from '../store-write-guard.js';
import { TWIN_COLLAPSE_MARKER_PREFIX } from '../twin-collapse.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, statfsSync: vi.fn(actual.statfsSync) };
});

let root: string;
let projectDir: string;

/** Put the store in the pre-migration shape with live bare rows to carry. */
function preMigration(): void {
  const db = getNativeDb(projectDir) as DatabaseSync;
  db.prepare('DELETE FROM main.tasks_schema_meta WHERE key = ?').run(
    `${TWIN_COLLAPSE_MARKER_PREFIX}schema_meta`,
  );
  db.prepare(
    'INSERT INTO main.schema_meta (key, value) VALUES (\'project_meta\', \'{"name":"live"}\')',
  ).run();
}

/**
 * The messages along a rejected write's error chain (drizzle wraps the SQLite
 * error as `cause`), or `''` when the write succeeded.
 */
async function refusal(write: Promise<unknown>): Promise<string> {
  try {
    await write;
    return '';
  } catch (error) {
    const messages: string[] = [];
    for (let e: unknown = error; e instanceof Error; e = e.cause) messages.push(e.message);
    return messages.join(' <- ');
  }
}

/** The next open (a new process) and the error it raises, if any. */
async function reopen(): Promise<unknown> {
  resetDbState();
  try {
    await getDb(projectDir);
    return undefined;
  } catch (error) {
    return error;
  }
}

beforeEach(async () => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  resetDbState();
  root = join(tmpdir(), `twin-collapse-fail-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  projectDir = join(root, 'project');
  mkdirSync(join(projectDir, '.cleo'), { recursive: true });
  mkdirSync(join(root, 'cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(root, 'cleo'));
  await getDb(projectDir);
  await getBrainDb(projectDir);
  preMigration();
});

afterEach(() => {
  vi.mocked(fs.statfsSync).mockRestore?.();
  resetDbState();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('a blocked backups directory', () => {
  it('keeps reads available (merged view), refuses writes with E_TWIN_COLLAPSE_FAILED, doctor reports it, retry succeeds', async () => {
    // The sticky pair is pending too: a tag only the bare junction holds.
    const note = await addSticky({ content: 'n', tags: [] }, projectDir);
    const brain = getNativeDb(projectDir) as DatabaseSync;
    brain
      .prepare('DELETE FROM main.brain_schema_meta WHERE key = ?')
      .run(`${TWIN_COLLAPSE_MARKER_PREFIX}sticky_tags`);
    brain
      .prepare('INSERT INTO main.sticky_tags (sticky_id, tag) VALUES (?, ?)')
      .run(note.id, 'bare-only');
    const backups = join(projectDir, '.cleo', 'backups');
    writeFileSync(backups, 'not a directory');

    expect(await reopen()).toBeUndefined(); // the open succeeds: never locked out
    await getBrainDb(projectDir);
    expect((await listStickies({ tags: ['bare-only'] }, projectDir)).map((n) => n.id)).toEqual([
      note.id,
    ]);
    const db = getNativeDb(projectDir) as DatabaseSync;
    // Reads see the bare-authoritative merge, served from the TEMP shadow …
    const accessor = await createSqliteDataAccessor(projectDir);
    expect(await accessor.getMetaValue('project_meta')).toEqual({ name: 'live' });
    expect((await sessionStatus(projectDir)).success).toBe(true);
    // … while main is untouched.
    expect(
      db.prepare("SELECT value FROM main.tasks_schema_meta WHERE key = 'project_meta'").get(),
    ).toBeUndefined();

    // A direct SDK write (store accessors, bypassing the dispatch guard) fails
    // fast with E_TWIN_COLLAPSE_FAILED before its first statement: nothing
    // lands anywhere, and a sticky's tags_json cannot drift from its tags.
    const focusRows = () =>
      JSON.stringify([
        db.prepare("SELECT value FROM main.tasks_schema_meta WHERE key = 'focus_state'").get(),
        db.prepare("SELECT value FROM temp.tasks_schema_meta WHERE key = 'focus_state'").get(),
      ]);
    const focusBefore = focusRows();
    await expect(accessor.setMetaValue('focus_state', { currentTask: 'T9' })).rejects.toMatchObject(
      {
        code: 55,
      },
    );
    expect(focusRows()).toBe(focusBefore);
    const brainAccessor = await getBrainAccessor(projectDir);
    const stickyRows = () =>
      JSON.stringify([
        db.prepare('SELECT tags_json FROM main.brain_sticky_notes WHERE id = ?').get(note.id),
        db
          .prepare(
            'SELECT tag FROM main.brain_sticky_tags WHERE sticky_id = ? UNION ALL SELECT tag FROM temp.brain_sticky_tags WHERE sticky_id = ?',
          )
          .all(note.id, note.id),
      ]);
    const stickyBefore = stickyRows();
    await expect(
      brainAccessor.updateStickyNote(note.id, { tagsJson: JSON.stringify(['sdk-tag']) }),
    ).rejects.toMatchObject({ code: 55 });
    await expect(
      brainAccessor.addStickyNote({
        id: 'SN-sdk',
        content: 'x',
        tagsJson: '["t"]',
        status: 'active',
      }),
    ).rejects.toMatchObject({ code: 55 });
    await expect(brainAccessor.deleteStickyNote(note.id)).rejects.toMatchObject({ code: 55 });
    expect(stickyRows()).toBe(stickyBefore); // tags_json and the junction unchanged
    expect(
      db.prepare("SELECT 1 FROM main.brain_sticky_notes WHERE id = 'SN-sdk'").get(),
    ).toBeUndefined();
    // Backstop: a raw write that skips the accessors hits the shadow's trigger.
    expect(
      await refusal(
        Promise.resolve().then(() =>
          db.prepare("INSERT INTO tasks_schema_meta (key, value) VALUES ('raw', '1')").run(),
        ),
      ),
    ).toMatch(/E_TWIN_COLLAPSE_FAILED: store is read-only/);

    const blocked = await storeWriteBlock(projectDir);
    expect(blocked).toMatchObject({
      code: 55,
      details: {
        tables: ['schema_meta', 'sticky_tags'],
        snapshotPath: expect.stringContaining(
          join('.cleo', 'backups', 'sqlite', 'cleo.db.migration-'),
        ),
        requiredBytes: expect.any(Number),
        snapshotWritten: false,
      },
    });
    expect(String(blocked?.message)).toMatch(
      /writes are refused.*Snapshot would be written to .*cleo\.db\.migration-/,
    );

    const report = inspectProjectTwinCollapse(projectDir);
    expect(report.pairs[0]).toMatchObject({ state: 'failed' });
    expect(report.preflight).toMatchObject({
      ok: false,
      backupDirProblem: expect.stringMatching(/not a directory/),
    });
    expect(twinCollapseDoctorCheck(projectDir)).toMatchObject({
      check: 'twin_collapse',
      status: 'error',
      fix: expect.stringContaining('cleo doctor twin-collapse --retry'),
    });

    rmSync(backups);
    const receipts = await retryTwinCollapse(projectDir);
    expect(receipts[0]).toMatchObject({ table: 'schema_meta', status: 'initial' });
    expect(await storeWriteBlock(projectDir)).toBeNull();
    // After the retry, SDK writes land in the twin.
    await accessor.setMetaValue('focus_state', { currentTask: 'T9' });
    expect(
      db.prepare("SELECT value FROM main.tasks_schema_meta WHERE key = 'focus_state'").get(),
    ).toEqual({ value: '{"currentTask":"T9"}' });
    await brainAccessor.updateStickyNote(note.id, { tagsJson: JSON.stringify(['sdk-tag']) });
    expect(
      db.prepare('SELECT tag FROM main.brain_sticky_tags WHERE sticky_id = ?').all(note.id),
    ).toEqual([{ tag: 'sdk-tag' }]);
    expect(await reopen()).toBeUndefined();
    expect(await storeWriteBlock(projectDir)).toBeNull();
    expect(
      (getNativeDb(projectDir) as DatabaseSync)
        .prepare("SELECT value FROM main.tasks_schema_meta WHERE key = 'project_meta'")
        .get(),
    ).toEqual({ value: '{"name":"live"}' });
    expect(twinCollapseDoctorCheck(projectDir).status).toBe('ok');
  });
});

describe('not enough free space', () => {
  it('fails BEFORE writing the snapshot, names the space needed, reads stay available, retry succeeds once space is free', async () => {
    vi.mocked(fs.statfsSync).mockImplementation(
      () => ({ bavail: 1, bsize: 4096 }) as unknown as ReturnType<typeof fs.statfsSync>,
    );
    expect(await reopen()).toBeUndefined();
    const blocked = await storeWriteBlock(projectDir);
    expect(blocked).toMatchObject({
      code: 55,
      details: { availableBytes: 4096, requiredBytes: expect.any(Number) },
    });
    expect(String(blocked?.message)).toMatch(/not enough free space/);
    expect(fs.existsSync(join(projectDir, '.cleo', 'backups', 'sqlite'))).toBe(false);
    const accessor = await createSqliteDataAccessor(projectDir);
    expect(await accessor.getMetaValue('project_meta')).toEqual({ name: 'live' });
    expect(twinCollapseDoctorCheck(projectDir).status).toBe('error');

    vi.mocked(fs.statfsSync).mockRestore();
    expect((await retryTwinCollapse(projectDir))[0]?.status).toBe('initial');
    expect(await storeWriteBlock(projectDir)).toBeNull();
    expect(twinCollapseDoctorCheck(projectDir).status).toBe('ok');
  });
});

describe('doctor warnings', () => {
  it('warns about a pending collapse and about bare rows changed after the marker', async () => {
    expect(twinCollapseDoctorCheck(projectDir)).toMatchObject({
      status: 'warning',
      message: expect.stringMatching(/pending for schema_meta/),
    });
    expect(await reopen()).toBeUndefined();
    const db = getNativeDb(projectDir) as DatabaseSync;
    db.prepare(
      'UPDATE main.schema_meta SET value = \'{"name":"old"}\' WHERE key = \'project_meta\'',
    ).run();
    expect(twinCollapseDoctorCheck(projectDir)).toMatchObject({
      status: 'warning',
      message: expect.stringMatching(/older CLEO build changed schema_meta \(1\)/),
    });
  });
});
