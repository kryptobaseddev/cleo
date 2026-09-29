/**
 * Recovery of what a 2026.9.21 collapse dropped or replaced (T12727):
 * `cleo doctor twin-collapse --recover [--dry-run]`.
 *
 * Each case builds the state 9.21 leaves behind: a pre-collapse snapshot
 * (the store with the twin's own values), a marker naming it, and a live
 * store where the bare values won (twin-only keys and tags deleted, twin
 * values replaced). The recovery reads the snapshot read-only and restores
 * every lost twin value into `twin_collapse_archive:*`, merging the
 * `focus_state` session notes into the live value.
 *
 * @task T12727
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recoverTwinCollapse } from '../../doctor/twin-collapse.js';
import { addSticky } from '../../sticky/create.js';
import { closeBrainDb, getBrainDb } from '../memory-sqlite.js';
import { getDb, getNativeDb, resetDbState } from '../sqlite.js';
import { TWIN_COLLAPSE_MARKER_PREFIX } from '../twin-collapse.js';

let root: string;
let projectDir: string;

const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const backupDir = (): string => join(projectDir, '.cleo', 'backups', 'sqlite');
const snapshotPath = (): string => join(backupDir(), 'cleo.db.migration-20260928-153200');

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

/** A session-note list like the live stores carry. */
const notes = (from: number, count: number, prefix: string) =>
  Array.from({ length: count }, (_, i) => ({
    note: `${prefix} note ${from + i}: ${'work on the store '.repeat(6)}`,
    timestamp: new Date(Date.UTC(2026, 0, 1) + (from + i) * 3_600_000).toISOString(),
  }));

/** Every row of the kv tables the recovery writes, as one digest. */
function kvDigest(): string {
  return sha(
    JSON.stringify([
      db().prepare('SELECT key, value FROM main.tasks_schema_meta ORDER BY key').all(),
      db().prepare('SELECT key, value FROM main.brain_schema_meta ORDER BY key').all(),
    ]),
  );
}

/** Point the markers at `snapshot`, as 9.21 recorded them. */
function markersNaming(snapshot: string): void {
  const marker = JSON.stringify({
    version: 3,
    task: 'T12535',
    collapsedAt: '2026-09-28T22:32:02.516Z',
    lastMergedAt: '2026-09-28T22:32:02.516Z',
    snapshot,
    hashes: { bare: {}, twin: {} },
    dropped: [],
    conflicts: [],
    conflictsAt: null,
  });
  setMeta('tasks_schema_meta', `${TWIN_COLLAPSE_MARKER_PREFIX}schema_meta`, marker);
  setMeta('brain_schema_meta', `${TWIN_COLLAPSE_MARKER_PREFIX}sticky_tags`, marker);
}

/**
 * The cleocode shape: before the collapse the twin held a 178 KB focus_state
 * history, a twin-only key and a twin-only sticky tag; 9.21 kept the bare
 * values. Returns the snapshot's sha256 and the twin values.
 */
async function cleocodeShape(): Promise<{ snapshotSha: string; twinFocus: string; note: string }> {
  const note = (await addSticky({ content: 'n', tags: ['alpha'] }, projectDir)).id;
  const twinFocus = JSON.stringify({
    currentTask: null,
    currentPhase: 'core',
    sessionNotes: notes(0, 1100, 'history'),
  });
  expect(twinFocus.length).toBeGreaterThan(170_000);
  const bareFocus = JSON.stringify({
    currentTask: 'T12100',
    currentPhase: null,
    sessionNotes: [...notes(1099, 1, 'history'), ...notes(2000, 3, 'live')],
  });
  // The store before the collapse.
  setMeta('schema_meta', 'focus_state', bareFocus);
  setMeta('tasks_schema_meta', 'focus_state', twinFocus);
  setMeta('schema_meta', 'schemaVersion', '"live"');
  setMeta('tasks_schema_meta', 'release_plan', '{"only":"in the twin"}');
  db().prepare('INSERT INTO main.sticky_tags (sticky_id, tag) VALUES (?, ?)').run(note, 'alpha');
  db()
    .prepare('INSERT OR IGNORE INTO main.brain_sticky_tags (sticky_id, tag) VALUES (?, ?)')
    .run(note, 'history-tag');
  mkdirSync(backupDir(), { recursive: true });
  db().exec(`VACUUM INTO '${snapshotPath()}'`);
  // What 9.21 left: the bare values won, twin-only rows deleted.
  setMeta('tasks_schema_meta', 'focus_state', bareFocus);
  db().prepare("DELETE FROM main.tasks_schema_meta WHERE key = 'release_plan'").run();
  db()
    .prepare("DELETE FROM main.brain_sticky_tags WHERE sticky_id = ? AND tag = 'history-tag'")
    .run(note);
  markersNaming(snapshotPath());
  return { snapshotSha: sha(readFileSync(snapshotPath())), twinFocus, note };
}

beforeEach(async () => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  resetDbState();
  root = join(tmpdir(), `recover-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe('recover what 2026.9.21 dropped or replaced (cleocode shape)', () => {
  it('--dry-run prints the exact plan and writes nothing', async () => {
    const { snapshotSha } = await cleocodeShape();
    const before = kvDigest();
    const result = await recoverTwinCollapse(projectDir, { dryRun: true });
    expect(result).toMatchObject({
      dryRun: true,
      receipt: null,
      plan: {
        snapshot: snapshotPath(),
        snapshotExists: true,
        changes: true,
        focusNotesAdded: 1099, // the twin's history minus the one note already live
        stickyArchived: [expect.stringMatching(/\thistory-tag$/)],
      },
    });
    expect(result.plan.archive.map((a) => [a.key, a.reason])).toEqual([
      ['focus_state', 'replaced'],
      ['release_plan', 'dropped'],
    ]);
    expect(kvDigest()).toBe(before);
    expect(sha(readFileSync(snapshotPath()))).toBe(snapshotSha);
  });

  it('apply restores every lost twin value, merges the history, writes a receipt; the snapshot is untouched', async () => {
    const { snapshotSha, twinFocus, note } = await cleocodeShape();
    const files = readdirSync(backupDir()).sort();
    const result = await recoverTwinCollapse(projectDir);
    expect(result.receipt).toMatchObject({
      task: 'T12727',
      snapshot: snapshotPath(),
      archived: ['twin_collapse_archive:focus_state', 'twin_collapse_archive:release_plan'],
      focusNotesAdded: 1099,
      stickyArchived: 1,
    });
    expect(meta('tasks_schema_meta', 'twin_collapse_archive:focus_state')).toBe(twinFocus);
    expect(meta('tasks_schema_meta', 'twin_collapse_archive:release_plan')).toBe(
      '{"only":"in the twin"}',
    );
    const focus = JSON.parse(meta('tasks_schema_meta', 'focus_state') ?? '{}');
    expect(focus.currentTask).toBe('T12100'); // the live fields win
    expect(focus.sessionNotes).toHaveLength(1100 + 3);
    const stamps = focus.sessionNotes.map((n: { timestamp: string }) => n.timestamp);
    expect([...stamps].sort()).toEqual(stamps);
    expect(
      JSON.parse(meta('brain_schema_meta', 'twin_collapse_archive:sticky_tags') ?? '[]'),
    ).toEqual([`${note}\thistory-tag`]);
    expect(JSON.parse(meta('tasks_schema_meta', 'twin_collapse_recovery') ?? '{}')).toMatchObject({
      task: 'T12727',
    });
    // The snapshot is never modified, and no file appears beside it.
    expect(sha(readFileSync(snapshotPath()))).toBe(snapshotSha);
    expect(readdirSync(backupDir()).sort()).toEqual(files);
  });

  it('a second apply finds nothing to do and writes nothing', async () => {
    await cleocodeShape();
    await recoverTwinCollapse(projectDir);
    const after = kvDigest();
    const again = await recoverTwinCollapse(projectDir);
    expect(again.receipt).toBeNull();
    expect(again.plan.changes).toBe(false);
    expect(again.plan.previousReceipt).not.toBeNull();
    expect(kvDigest()).toBe(after);
  });
});

describe('stores with nothing to recover, and a missing snapshot', () => {
  it('axiom-app shape (the twin was empty): a no-op, nothing written', async () => {
    setMeta('schema_meta', 'schemaVersion', '"live"');
    setMeta('schema_meta', 'focus_state', '{"currentTask":"T1"}');
    db().prepare("DELETE FROM main.tasks_schema_meta WHERE key NOT LIKE 'twin_collapse%'").run();
    mkdirSync(backupDir(), { recursive: true });
    db().exec(`VACUUM INTO '${snapshotPath()}'`);
    setMeta('tasks_schema_meta', 'focus_state', '{"currentTask":"T1"}');
    markersNaming(snapshotPath());
    const before = kvDigest();
    const result = await recoverTwinCollapse(projectDir);
    expect(result.plan).toMatchObject({ snapshotExists: true, changes: false, archive: [] });
    expect(result.receipt).toBeNull();
    expect(kvDigest()).toBe(before);
  });

  it('a missing snapshot is reported clearly and nothing is changed', async () => {
    markersNaming(snapshotPath()); // recorded, but never written / since deleted
    expect(existsSync(snapshotPath())).toBe(false);
    const before = kvDigest();
    const dry = await recoverTwinCollapse(projectDir, { dryRun: true });
    expect(dry.plan).toMatchObject({
      snapshot: snapshotPath(),
      snapshotExists: false,
      changes: false,
    });
    await expect(recoverTwinCollapse(projectDir)).rejects.toThrow(
      /pre-collapse snapshot .*cleo\.db\.migration-20260928-153200 is missing; nothing was recovered/,
    );
    expect(kvDigest()).toBe(before);
  });

  it('an archive key already holding another value is never overwritten', async () => {
    const { twinFocus } = await cleocodeShape();
    setMeta('tasks_schema_meta', 'twin_collapse_archive:focus_state', '{"other":"value"}');
    const result = await recoverTwinCollapse(projectDir);
    const key = result.receipt?.archived.find((k) =>
      k.startsWith('twin_collapse_archive:focus_state:'),
    );
    expect(key).toBeDefined();
    expect(meta('tasks_schema_meta', key as string)).toBe(twinFocus);
    expect(meta('tasks_schema_meta', 'twin_collapse_archive:focus_state')).toBe(
      '{"other":"value"}',
    );
  });
});
