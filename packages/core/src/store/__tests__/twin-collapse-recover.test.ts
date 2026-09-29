/**
 * Recovery of what a 2026.9.21 collapse dropped or replaced (T12727):
 * `cleo doctor twin-collapse --recover [--dry-run]` and `--rollback <id>`.
 *
 * Each case builds the state 9.21 leaves behind: a pre-collapse snapshot
 * (the store with the twin's own values), a marker naming it, and a live
 * store where the bare values won (twin-only keys and tags deleted, twin
 * values replaced). The recovery reads the snapshot read-only and restores
 * every lost twin value into `twin_collapse_archive:*`, merging the
 * `focus_state` session notes into the live value once.
 *
 * @task T12727
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  recoverTwinCollapse,
  retryTwinCollapse,
  rollbackTwinCollapse,
} from '../../doctor/twin-collapse.js';
import { addSticky } from '../../sticky/create.js';
import { closeBrainDb, getBrainDb } from '../memory-sqlite.js';
import { openCleoDbSnapshot } from '../open-cleo-db.js';
import { getDb, getNativeDb, resetDbState } from '../sqlite.js';
import {
  applyTwinCollapseRecovery,
  planTwinCollapseRecovery,
  TWIN_COLLAPSE_MARKER_PREFIX,
  TWIN_COLLAPSE_RECOVERY_PREFIX,
} from '../twin-collapse.js';

let root: string;
let projectDir: string;

const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const backupDir = (): string => join(projectDir, '.cleo', 'backups', 'sqlite');
const snapshotPath = (): string => join(backupDir(), 'cleo.db.migration-20260928-153200');
const opts = () => ({ cwd: projectDir });

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

const focus = () => JSON.parse(meta('tasks_schema_meta', 'focus_state') ?? '{}');
const receiptKeys = () =>
  (
    db()
      .prepare('SELECT key FROM main.tasks_schema_meta WHERE key LIKE ? ORDER BY key')
      .all(`${TWIN_COLLAPSE_RECOVERY_PREFIX}%`) as Array<{ key: string }>
  ).map((r) => r.key);

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
 * values. `editSnapshot` alters the snapshot fixture before it is hashed.
 */
async function cleocodeShape(editSnapshot?: (snap: DatabaseSync) => void): Promise<{
  snapshotSha: string;
  twinFocus: string;
  bareFocus: string;
  note: string;
}> {
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
  if (editSnapshot) {
    const snap = new DatabaseSync(snapshotPath());
    editSnapshot(snap);
    snap.close();
  }
  // What 9.21 left: the bare values won, twin-only rows deleted.
  setMeta('tasks_schema_meta', 'focus_state', bareFocus);
  db().prepare("DELETE FROM main.tasks_schema_meta WHERE key = 'release_plan'").run();
  db()
    .prepare("DELETE FROM main.brain_sticky_tags WHERE sticky_id = ? AND tag = 'history-tag'")
    .run(note);
  markersNaming(snapshotPath());
  return { snapshotSha: sha(readFileSync(snapshotPath())), twinFocus, bareFocus, note };
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
    const result = await recoverTwinCollapse(projectDir, { ...opts(), dryRun: true });
    expect(result).toMatchObject({
      dryRun: true,
      receipt: null,
      plan: {
        snapshot: snapshotPath(),
        snapshotExists: true,
        changes: true,
        focusNotesAdded: 1099, // the twin's history minus the one note already live
        stickyArchived: [expect.stringMatching(/\thistory-tag$/)],
        receipts: [],
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
    const { snapshotSha, twinFocus, bareFocus, note } = await cleocodeShape();
    const files = readdirSync(backupDir()).sort();
    const result = await recoverTwinCollapse(projectDir, opts());
    expect(result.receipt).toMatchObject({
      task: 'T12727',
      snapshot: snapshotPath(),
      archived: [
        {
          key: 'focus_state',
          archiveKey: 'twin_collapse_archive:focus_state',
          sha: sha(twinFocus),
        },
        { key: 'release_plan', archiveKey: 'twin_collapse_archive:release_plan' },
      ],
      focusNotesAdded: 1099,
      stickyArchived: [`${note}\thistory-tag`],
      before: { focusState: bareFocus, stickyArchive: null },
      rolledBackAt: null,
    });
    expect(meta('tasks_schema_meta', 'twin_collapse_archive:focus_state')).toBe(twinFocus);
    expect(meta('tasks_schema_meta', 'twin_collapse_archive:release_plan')).toBe(
      '{"only":"in the twin"}',
    );
    expect(focus().currentTask).toBe('T12100'); // the live fields win
    expect(focus().sessionNotes).toHaveLength(1100 + 3);
    const stamps = focus().sessionNotes.map((n: { timestamp: string }) => n.timestamp);
    expect([...stamps].sort()).toEqual(stamps);
    expect(
      JSON.parse(meta('brain_schema_meta', 'twin_collapse_archive:sticky_tags') ?? '[]'),
    ).toEqual([`${note}\thistory-tag`]);
    expect(receiptKeys()).toEqual([result.receipt?.id]);
    // The snapshot is never modified, and no file appears beside it.
    expect(sha(readFileSync(snapshotPath()))).toBe(snapshotSha);
    expect(readdirSync(backupDir()).sort()).toEqual(files);
  });

  it('a second apply finds nothing to do and writes nothing', async () => {
    await cleocodeShape();
    await recoverTwinCollapse(projectDir, opts());
    const after = kvDigest();
    const again = await recoverTwinCollapse(projectDir, opts());
    expect(again.receipt).toBeNull();
    expect(again.plan.changes).toBe(false);
    expect(again.plan.receipts).toHaveLength(1);
    expect(kvDigest()).toBe(after);
  });

  it('notes pruned after a recovery stay pruned on a re-run (review 1)', async () => {
    await cleocodeShape();
    await recoverTwinCollapse(projectDir, opts());
    setMeta(
      'tasks_schema_meta',
      'focus_state',
      JSON.stringify({ ...focus(), sessionNotes: focus().sessionNotes.slice(-2) }),
    );
    const pruned = kvDigest();
    const again = await recoverTwinCollapse(projectDir, opts());
    expect(again.plan).toMatchObject({ changes: false, focusNotesAdded: 0 });
    expect(again.receipt).toBeNull();
    expect(kvDigest()).toBe(pruned);
    expect(focus().sessionNotes).toHaveLength(2);
  });

  it('a note written between the plan and the apply is kept (review 2)', async () => {
    await cleocodeShape();
    const snap = openCleoDbSnapshot(snapshotPath(), { readOnly: true, applyPragmas: false });
    try {
      const preview = planTwinCollapseRecovery(db(), snap.db);
      const late = { note: 'written mid-run', timestamp: '2027-01-01T00:00:00.000Z' };
      setMeta(
        'tasks_schema_meta',
        'focus_state',
        JSON.stringify({ ...focus(), sessionNotes: [...focus().sessionNotes, late] }),
      );
      const applied = applyTwinCollapseRecovery(db(), preview);
      expect(applied.receipt?.focusNotesAdded).toBe(1099);
      expect(focus().sessionNotes).toContainEqual(late);
      expect(focus().sessionNotes).toHaveLength(1100 + 3 + 1);
    } finally {
      snap.close();
    }
  });
});

describe('--rollback <receiptId> (review 3)', () => {
  it('restores the pre-merge focus_state and sticky archive, deletes the archive keys, keeps the receipt', async () => {
    const { bareFocus } = await cleocodeShape();
    const before = kvDigest();
    const { receipt } = await recoverTwinCollapse(projectDir, opts());
    const id = receipt?.id as string;
    const undo = await rollbackTwinCollapse(projectDir, id, opts());
    expect(undo).toMatchObject({
      focusState: 'restored',
      notesRemoved: 1099,
      stickyRemoved: 1,
      archiveKept: [],
      archiveDeleted: ['twin_collapse_archive:focus_state', 'twin_collapse_archive:release_plan'],
    });
    expect(meta('tasks_schema_meta', 'focus_state')).toBe(bareFocus);
    expect(meta('brain_schema_meta', 'twin_collapse_archive:sticky_tags')).toBeUndefined();
    const kept = JSON.parse(meta('tasks_schema_meta', id) ?? '{}');
    expect(kept.rolledBackAt).toEqual(expect.any(String));
    // Apart from the stamped receipt, the store is as it was before the apply.
    db().prepare('DELETE FROM main.tasks_schema_meta WHERE key = ?').run(id);
    expect(kvDigest()).toBe(before);
  });

  it('removes only the recovered notes when focus_state changed since; notes written since stay', async () => {
    await cleocodeShape();
    const { receipt } = await recoverTwinCollapse(projectDir, opts());
    const late = { note: 'after the recovery', timestamp: '2027-01-01T00:00:00.000Z' };
    setMeta(
      'tasks_schema_meta',
      'focus_state',
      JSON.stringify({ ...focus(), sessionNotes: [...focus().sessionNotes, late] }),
    );
    const undo = await rollbackTwinCollapse(projectDir, receipt?.id as string, opts());
    expect(undo).toMatchObject({ focusState: 'notes-removed', notesRemoved: 1099 });
    expect(focus().sessionNotes).toHaveLength(1 + 3 + 1); // the shared note, live 3, the late one
    expect(focus().sessionNotes).toContainEqual(late);
  });

  it('a later apply gets its own receipt; unknown or rolled-back ids are refused', async () => {
    await cleocodeShape();
    const first = (await recoverTwinCollapse(projectDir, opts())).receipt?.id as string;
    await rollbackTwinCollapse(projectDir, first, opts());
    const again = (await recoverTwinCollapse(projectDir, opts())).receipt;
    const second = again?.id as string;
    expect(second).not.toBe(first);
    // A rolled-back apply does not count: the notes are merged again.
    expect(again?.focusNotesAdded).toBe(1099);
    expect(focus().sessionNotes).toHaveLength(1100 + 3);
    expect(receiptKeys()).toEqual([first, second].sort());
    expect(JSON.parse(meta('tasks_schema_meta', first) ?? '{}').rolledBackAt).not.toBeNull();
    const digest = kvDigest();
    await expect(rollbackTwinCollapse(projectDir, first, opts())).rejects.toThrow(
      /E_TWIN_COLLAPSE_RECOVER: already rolled back/,
    );
    await expect(
      rollbackTwinCollapse(projectDir, `${TWIN_COLLAPSE_RECOVERY_PREFIX}nope`, opts()),
    ).rejects.toThrow(/E_TWIN_COLLAPSE_RECOVER: no recovery receipt/);
    expect(kvDigest()).toBe(digest);
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
    const result = await recoverTwinCollapse(projectDir, opts());
    expect(result.plan).toMatchObject({ snapshotExists: true, changes: false, archive: [] });
    expect(result.receipt).toBeNull();
    expect(kvDigest()).toBe(before);
  });

  it('a missing snapshot is an E_TWIN_COLLAPSE_RECOVER error, dry run included; nothing changes (review 4)', async () => {
    markersNaming(snapshotPath()); // recorded, but never written / since deleted
    expect(existsSync(snapshotPath())).toBe(false);
    const before = kvDigest();
    for (const dryRun of [true, false])
      await expect(recoverTwinCollapse(projectDir, { ...opts(), dryRun })).rejects.toThrow(
        /E_TWIN_COLLAPSE_RECOVER: the pre-collapse snapshot .*cleo\.db\.migration-20260928-153200 is missing; nothing was recovered/,
      );
    expect(kvDigest()).toBe(before);
  });

  it('a store never collapsed (no marker) is a clean no-op (review 4)', async () => {
    db()
      .prepare('DELETE FROM main.tasks_schema_meta WHERE key LIKE ?')
      .run(`${TWIN_COLLAPSE_MARKER_PREFIX}%`);
    const before = kvDigest();
    for (const dryRun of [true, false]) {
      const result = await recoverTwinCollapse(projectDir, { ...opts(), dryRun });
      expect(result.plan).toMatchObject({ snapshot: null, changes: false });
      expect(result.receipt).toBeNull();
    }
    expect(kvDigest()).toBe(before);
  });

  it('an archive key already holding another value is never overwritten', async () => {
    const { twinFocus } = await cleocodeShape();
    setMeta('tasks_schema_meta', 'twin_collapse_archive:focus_state', '{"other":"value"}');
    const result = await recoverTwinCollapse(projectDir, opts());
    const key = result.receipt?.archived.find((a) => a.key === 'focus_state')?.archiveKey;
    expect(key).toMatch(/^twin_collapse_archive:focus_state:[0-9a-f]{8}$/);
    expect(meta('tasks_schema_meta', key as string)).toBe(twinFocus);
    expect(meta('tasks_schema_meta', 'twin_collapse_archive:focus_state')).toBe(
      '{"other":"value"}',
    );
  });

  it('a sticky archive row that is not a list of tags is never overwritten (review 7)', async () => {
    const { note } = await cleocodeShape();
    setMeta('brain_schema_meta', 'twin_collapse_archive:sticky_tags', '{"x":1}');
    const result = await recoverTwinCollapse(projectDir, opts());
    expect(meta('brain_schema_meta', 'twin_collapse_archive:sticky_tags')).toBe('{"x":1}');
    const key = result.plan.stickyArchiveKey;
    expect(key).toMatch(/^twin_collapse_archive:sticky_tags:[0-9a-f]{8}$/);
    expect(JSON.parse(meta('brain_schema_meta', key) ?? '[]')).toEqual([`${note}\thistory-tag`]);
  });

  it('a live focus_state whose sessionNotes is not an array counts only the twin notes (review 7)', async () => {
    await cleocodeShape();
    setMeta('tasks_schema_meta', 'focus_state', '{"currentTask":"T9","sessionNotes":"oops"}');
    const result = await recoverTwinCollapse(projectDir, { ...opts(), dryRun: true });
    expect(result.plan.focusNotesAdded).toBe(1100);
  });

  it('a snapshot without a bare or twin table skips that pair (review 6)', async () => {
    await cleocodeShape((snap) => {
      snap.exec('DROP TABLE sticky_tags');
      snap.exec('DROP TABLE schema_meta');
    });
    const result = await recoverTwinCollapse(projectDir, { ...opts(), dryRun: true });
    expect(result.plan).toMatchObject({ archive: [], stickyArchived: [], changes: false });
  });
});

describe('from a git worktree of the project (review 5)', () => {
  function git(cwd: string, ...args: string[]): void {
    execFileSync(
      'git',
      [
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=t',
        '-c',
        'init.defaultBranch=main',
        ...args,
      ],
      { cwd, stdio: 'ignore' },
    );
  }

  it('--recover, --rollback and --retry refuse to write the live store without --confirm-owner-store', async () => {
    await cleocodeShape();
    git(projectDir, 'init', '-q');
    writeFileSync(join(projectDir, 'README'), 'x');
    git(projectDir, 'add', 'README');
    git(projectDir, 'commit', '-qm', 'init');
    const worktree = join(root, 'wt');
    git(projectDir, 'worktree', 'add', '-q', worktree);
    const before = kvDigest();
    const from = { cwd: worktree };
    await expect(recoverTwinCollapse(projectDir, from)).rejects.toThrow(
      /E_WT_STORE_REWRITE_CONFIRM_REQUIRED/,
    );
    await expect(
      rollbackTwinCollapse(projectDir, `${TWIN_COLLAPSE_RECOVERY_PREFIX}x`, from),
    ).rejects.toThrow(/E_WT_STORE_REWRITE_CONFIRM_REQUIRED/);
    await expect(retryTwinCollapse(projectDir, from)).rejects.toThrow(
      /E_WT_STORE_REWRITE_CONFIRM_REQUIRED/,
    );
    expect(kvDigest()).toBe(before);
    // A dry run only reads; confirmed, the apply runs.
    await expect(recoverTwinCollapse(projectDir, { ...from, dryRun: true })).resolves.toBeDefined();
    const confirmed = await recoverTwinCollapse(projectDir, { ...from, confirmOwnerStore: true });
    expect(confirmed.receipt).not.toBeNull();
  });
});
