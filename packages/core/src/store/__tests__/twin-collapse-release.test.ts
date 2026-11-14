/**
 * Releasing a pre-collapse snapshot (T12767):
 * `cleo doctor twin-collapse --release-snapshot <id> [--dry-run] --confirm`.
 *
 * A snapshot a twin-collapse marker references is pinned and never rotated
 * (T12535, T12727). Once a recovery has run (or nothing needed recovering)
 * the owner may release it: the markers' reference and the sidecar pin are
 * cleared, an audit row is written, and it rotates like any backup.
 *
 * Every store here is a temp project; no real store is touched.
 *
 * @task T12767
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  recoverTwinCollapse,
  releaseProjectTwinCollapseSnapshot,
  rollbackTwinCollapse,
  TWIN_COLLAPSE_RELEASE_AUDIT_FILE,
} from '../../doctor/twin-collapse.js';
import { addSticky } from '../../sticky/create.js';
import { rotateBackupDir } from '../backup-sidecar.js';
import { closeBrainDb, getBrainDb } from '../memory-sqlite.js';
import { getDb, getNativeDb, resetDbState } from '../sqlite.js';
import {
  collapseTwinTables,
  pinRecoverySnapshot,
  TWIN_COLLAPSE_MARKER_PREFIX,
} from '../twin-collapse.js';

let root: string;
let projectDir: string;

const ID = 'migration-20260101-000000';
const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const backupDir = (): string => join(projectDir, '.cleo', 'backups', 'sqlite');
const snapshotPath = (): string => join(backupDir(), `cleo.db.${ID}`);
const sidecarPath = (): string => join(backupDir(), `${ID}.meta.json`);
const auditPath = (): string =>
  join(projectDir, '.cleo', 'audit', TWIN_COLLAPSE_RELEASE_AUDIT_FILE);
const opts = () => ({ cwd: projectDir });
const sidecar = () => JSON.parse(readFileSync(sidecarPath(), 'utf8'));

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

function marker(table: string, pair: string): { snapshot?: string | null } {
  const row = db()
    .prepare(`SELECT value FROM main.${table} WHERE key = ?`)
    .get(`${TWIN_COLLAPSE_MARKER_PREFIX}${pair}`) as { value: string } | undefined;
  return JSON.parse(row?.value ?? '{}');
}

/** Point the markers at the snapshot, as 2026.9.21 recorded them. */
function markersNaming(snapshot: string): void {
  const value = JSON.stringify({
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
  setMeta('tasks_schema_meta', `${TWIN_COLLAPSE_MARKER_PREFIX}schema_meta`, value);
  setMeta('brain_schema_meta', `${TWIN_COLLAPSE_MARKER_PREFIX}sticky_tags`, value);
}

/** A 9.21 collapse that replaced a twin focus_state and dropped a twin-only key. */
function collapsedWithLoss(): string {
  setMeta('schema_meta', 'focus_state', '{"currentTask":"T2","sessionNotes":[]}');
  setMeta(
    'tasks_schema_meta',
    'focus_state',
    '{"currentTask":"T1","sessionNotes":[{"note":"old","timestamp":"2026-01-01T00:00:00Z"}]}',
  );
  setMeta('tasks_schema_meta', 'release_plan', '{"only":"twin"}');
  mkdirSync(backupDir(), { recursive: true });
  db().exec(`VACUUM INTO '${snapshotPath()}'`);
  pinRecoverySnapshot(snapshotPath());
  setMeta('tasks_schema_meta', 'focus_state', '{"currentTask":"T2","sessionNotes":[]}');
  db().prepare("DELETE FROM main.tasks_schema_meta WHERE key = 'release_plan'").run();
  markersNaming(snapshotPath());
  return sha(readFileSync(snapshotPath()));
}

/** A 9.21 collapse that lost nothing (the axiom-app shape). */
function collapsedWithoutLoss(): void {
  db().prepare("DELETE FROM main.tasks_schema_meta WHERE key NOT LIKE 'twin_collapse%'").run();
  mkdirSync(backupDir(), { recursive: true });
  db().exec(`VACUUM INTO '${snapshotPath()}'`);
  pinRecoverySnapshot(snapshotPath());
  markersNaming(snapshotPath());
}

/** `n` newer unpinned migration backups, so rotation at cap `n` must drop one. */
function newerBackups(n: number): void {
  const t0 = new Date(Date.UTC(2020, 0, 1));
  utimesSync(snapshotPath(), t0, t0); // the released snapshot is the oldest
  for (let i = 1; i <= n; i++) {
    const file = join(backupDir(), `cleo.db.migration-20270101-0000${String(i).padStart(2, '0')}`);
    writeFileSync(file, `backup ${i}`);
    const at = new Date(Date.UTC(2027, 0, 1, 0, 0, i));
    utimesSync(file, at, at);
  }
}

beforeEach(async () => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  resetDbState();
  root = join(tmpdir(), `release-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe('refused before a recovery', () => {
  it('--dry-run shows the bytes and why; a confirmed release changes nothing', async () => {
    const snapSha = collapsedWithLoss();
    const dry = await releaseProjectTwinCollapseSnapshot(projectDir, ID, {
      ...opts(),
      dryRun: true,
    });
    expect(dry.plan).toMatchObject({
      snapshot: snapshotPath(),
      exists: true,
      basis: null,
      markers: [
        `tasks_schema_meta:${TWIN_COLLAPSE_MARKER_PREFIX}schema_meta`,
        `brain_schema_meta:${TWIN_COLLAPSE_MARKER_PREFIX}sticky_tags`,
      ],
      blockers: [expect.stringMatching(/still holds 2 value\(s\).*run --recover first/)],
    });
    expect(dry.plan.bytes).toBe(readFileSync(snapshotPath()).length);
    await expect(
      releaseProjectTwinCollapseSnapshot(projectDir, ID, { ...opts(), confirm: true }),
    ).rejects.toThrow(/E_TWIN_COLLAPSE_RELEASE: .* cannot be released: .*run --recover first/);
    expect(marker('tasks_schema_meta', 'schema_meta').snapshot).toBe(snapshotPath());
    expect(sidecar()).toMatchObject({ pinned: true });
    expect(existsSync(auditPath())).toBe(false);
    expect(sha(readFileSync(snapshotPath()))).toBe(snapSha);
  });

  it('a rolled-back recovery makes it unreleasable again', async () => {
    collapsedWithLoss();
    const { receipt } = await recoverTwinCollapse(projectDir, opts());
    await rollbackTwinCollapse(projectDir, receipt?.id as string, opts());
    await expect(
      releaseProjectTwinCollapseSnapshot(projectDir, ID, { ...opts(), confirm: true }),
    ).rejects.toThrow(/run --recover first/);
  });

  it('without --confirm nothing is written, even when it is releasable', async () => {
    collapsedWithoutLoss();
    await expect(releaseProjectTwinCollapseSnapshot(projectDir, ID, opts())).rejects.toThrow(
      /E_TWIN_COLLAPSE_RELEASE: releasing .* needs the owner's decision \(--confirm\); nothing was changed/,
    );
    expect(marker('tasks_schema_meta', 'schema_meta').snapshot).toBe(snapshotPath());
    expect(sidecar()).toMatchObject({ pinned: true });
    expect(existsSync(auditPath())).toBe(false);
  });

  it('an unknown id, a missing snapshot, or a marker the recovery does not cover is refused', async () => {
    collapsedWithoutLoss();
    await expect(
      releaseProjectTwinCollapseSnapshot(projectDir, 'migration-19990101-000000', {
        ...opts(),
        confirm: true,
      }),
    ).rejects.toThrow(/no twin-collapse marker references migration-19990101-000000/);
    setMeta(
      'tasks_schema_meta',
      `${TWIN_COLLAPSE_MARKER_PREFIX}attachments`,
      JSON.stringify({ version: 3, snapshot: snapshotPath() }),
    );
    await expect(
      releaseProjectTwinCollapseSnapshot(projectDir, ID, { ...opts(), confirm: true }),
    ).rejects.toThrow(/the attachments marker references it, and the recovery does not cover/);
    db()
      .prepare('DELETE FROM main.tasks_schema_meta WHERE key = ?')
      .run(`${TWIN_COLLAPSE_MARKER_PREFIX}attachments`);
    rmSync(snapshotPath());
    await expect(
      releaseProjectTwinCollapseSnapshot(projectDir, ID, { ...opts(), confirm: true }),
    ).rejects.toThrow(/not on disk, so no recovery check can run/);
    expect(marker('tasks_schema_meta', 'schema_meta').snapshot).toBe(snapshotPath());
  });

  it("a marker naming a snapshot outside this store's backups/sqlite is refused (T12772)", async () => {
    collapsedWithoutLoss();
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    const foreign = join(elsewhere, `cleo.db.${ID}`);
    writeFileSync(foreign, readFileSync(snapshotPath()));
    rmSync(snapshotPath()); // no copy of that name in this store's backups (T12788)
    markersNaming(foreign);
    for (const o of [
      { ...opts(), dryRun: true },
      { ...opts(), confirm: true },
    ])
      await expect(releaseProjectTwinCollapseSnapshot(projectDir, ID, o)).rejects.toThrow(
        /E_TWIN_COLLAPSE_RELEASE: the marker names .*elsewhere.*, outside this store's backup directory .*does not exist/,
      );
    expect(marker('tasks_schema_meta', 'schema_meta').snapshot).toBe(foreign);
    expect(existsSync(join(elsewhere, `${ID}.meta.json`))).toBe(false);
    expect(existsSync(auditPath())).toBe(false);
  });

  it('a failed audit write refuses the release and restores the pin', async () => {
    collapsedWithoutLoss();
    writeFileSync(join(projectDir, '.cleo', 'audit'), 'not a directory');
    await expect(
      releaseProjectTwinCollapseSnapshot(projectDir, ID, { ...opts(), confirm: true }),
    ).rejects.toThrow();
    expect(marker('tasks_schema_meta', 'schema_meta').snapshot).toBe(snapshotPath());
    expect(marker('brain_schema_meta', 'sticky_tags').snapshot).toBe(snapshotPath());
    expect(sidecar()).toMatchObject({ pinned: true });
  });
});

describe('released after a recovery, or when nothing needed recovering', () => {
  it('clears the references and the pin, writes an audit row, and the snapshot then rotates', async () => {
    const snapSha = collapsedWithLoss();
    const { receipt } = await recoverTwinCollapse(projectDir, opts());
    const dry = await releaseProjectTwinCollapseSnapshot(projectDir, ID, {
      ...opts(),
      dryRun: true,
    });
    expect(dry.plan).toMatchObject({ basis: 'recovered', receipts: [receipt?.id], blockers: [] });
    newerBackups(10);
    rotateBackupDir(backupDir(), 10, 'migration');
    expect(existsSync(snapshotPath())).toBe(true); // still pinned and referenced

    const result = await releaseProjectTwinCollapseSnapshot(projectDir, ID, {
      ...opts(),
      confirm: true,
    });
    expect(result.release).toMatchObject({
      snapshot: snapshotPath(),
      basis: 'recovered',
      bytes: dry.plan.bytes,
    });
    expect(marker('tasks_schema_meta', 'schema_meta').snapshot).toBeNull();
    expect(marker('brain_schema_meta', 'sticky_tags').snapshot).toBeNull();
    expect(sidecar()).toMatchObject({ pinned: false, releasedAt: expect.any(String) });
    expect(sidecar().pinnedReason).toBeUndefined();
    const rows = readFileSync(auditPath(), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(rows).toEqual([
      expect.objectContaining({
        operation: 'doctor twin-collapse --release-snapshot',
        snapshot: snapshotPath(),
        basis: 'recovered',
        bytes: dry.plan.bytes,
        receipts: [receipt?.id],
      }),
    ]);
    expect(sha(readFileSync(snapshotPath()))).toBe(snapSha); // the release never touches it

    // A later open does not pin it again, and the recovery sees nothing to do.
    resetDbState();
    await getDb(projectDir);
    expect(sidecar()).toMatchObject({ pinned: false });
    expect((await recoverTwinCollapse(projectDir, opts())).plan).toMatchObject({
      snapshot: null,
      changes: false,
    });

    rotateBackupDir(backupDir(), 10, 'migration');
    expect(existsSync(snapshotPath())).toBe(false);
  });

  it('a released marker stays released when a later collapse takes a snapshot for another pair', async () => {
    const note = (await addSticky({ content: 'n', tags: [] }, projectDir)).id;
    collapsedWithoutLoss();
    await releaseProjectTwinCollapseSnapshot(projectDir, ID, { ...opts(), confirm: true });
    // schema_meta: an incremental change (an older build wrote the bare table).
    setMeta('schema_meta', 'written_by_an_older_build', '"x"');
    // sticky_tags: its initial collapse again, with a bare-only tag, so it takes a snapshot.
    db()
      .prepare('DELETE FROM main.brain_schema_meta WHERE key = ?')
      .run(`${TWIN_COLLAPSE_MARKER_PREFIX}sticky_tags`);
    db()
      .prepare('INSERT INTO main.sticky_tags (sticky_id, tag) VALUES (?, ?)')
      .run(note, 'bare-only');
    const receipts = collapseTwinTables(db(), join(projectDir, '.cleo', 'cleo.db'));
    const taken = receipts.find((r) => r.table === 'sticky_tags')?.snapshotPath;
    expect(taken).toEqual(expect.stringContaining('.migration-'));
    expect(receipts.find((r) => r.table === 'schema_meta')?.status).not.toBe('unchanged');
    expect(marker('tasks_schema_meta', 'schema_meta').snapshot).toBeNull();
    expect(marker('brain_schema_meta', 'sticky_tags').snapshot).toBe(taken);
  });

  it('a store that lost nothing is released on the no-recovery-needed check', async () => {
    collapsedWithoutLoss();
    const result = await releaseProjectTwinCollapseSnapshot(projectDir, ID, {
      ...opts(),
      confirm: true,
    });
    expect(result.release).toMatchObject({ basis: 'no-recovery-needed' });
    expect(result.plan.receipts).toEqual([]);
    expect(marker('tasks_schema_meta', 'schema_meta').snapshot).toBeNull();
  });
});

describe('a moved store (T12788)', () => {
  /** Move the whole project directory, as /mnt → /home or Linux → Mac; the markers keep the old path. */
  async function move(): Promise<string> {
    const old = snapshotPath();
    closeBrainDb();
    resetDbState();
    const moved = join(root, 'moved', 'project');
    mkdirSync(join(root, 'moved'), { recursive: true });
    renameSync(projectDir, moved);
    projectDir = moved;
    await getDb(projectDir);
    await getBrainDb(projectDir);
    expect(marker('tasks_schema_meta', 'schema_meta').snapshot).toBe(old);
    return old;
  }

  it('releases the local file on a no-recovery-needed check, and audits where it moved from', async () => {
    collapsedWithoutLoss();
    const old = await move();
    const dry = await releaseProjectTwinCollapseSnapshot(projectDir, ID, {
      ...opts(),
      dryRun: true,
    });
    expect(dry.plan).toMatchObject({
      snapshot: snapshotPath(),
      movedFrom: old,
      exists: true,
      basis: 'no-recovery-needed',
      blockers: [],
    });
    const result = await releaseProjectTwinCollapseSnapshot(projectDir, ID, {
      ...opts(),
      confirm: true,
    });
    expect(result.release).toMatchObject({ snapshot: snapshotPath(), movedFrom: old });
    expect(marker('tasks_schema_meta', 'schema_meta').snapshot).toBeNull();
    expect(sidecar()).toMatchObject({ pinned: false });
    const [row] = readFileSync(auditPath(), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(row).toMatchObject({ snapshot: snapshotPath(), movedFrom: old });
  });

  it('a store that still holds losses is refused until recovered, then released as recovered', async () => {
    collapsedWithLoss();
    await move();
    await expect(
      releaseProjectTwinCollapseSnapshot(projectDir, ID, { ...opts(), confirm: true }),
    ).rejects.toThrow(/run --recover first/);
    const { receipt } = await recoverTwinCollapse(projectDir, opts()); // also re-points the markers
    expect(marker('tasks_schema_meta', 'schema_meta').snapshot).toBe(snapshotPath());
    const result = await releaseProjectTwinCollapseSnapshot(projectDir, ID, {
      ...opts(),
      confirm: true,
    });
    expect(result.release).toMatchObject({ basis: 'recovered', movedFrom: null });
    expect(result.plan.receipts).toEqual([receipt?.id]);
  });
});

describe('from a git worktree of the project', () => {
  it('needs --confirm-owner-store to write the live store', async () => {
    collapsedWithoutLoss();
    const git = (cwd: string, ...args: string[]) =>
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
    git(projectDir, 'init', '-q');
    writeFileSync(join(projectDir, 'README'), 'x');
    git(projectDir, 'add', 'README');
    git(projectDir, 'commit', '-qm', 'init');
    const worktree = join(root, 'wt');
    git(projectDir, 'worktree', 'add', '-q', worktree);
    await expect(
      releaseProjectTwinCollapseSnapshot(projectDir, ID, { cwd: worktree, confirm: true }),
    ).rejects.toThrow(/E_WT_STORE_REWRITE_CONFIRM_REQUIRED/);
    expect(marker('tasks_schema_meta', 'schema_meta').snapshot).toBe(snapshotPath());
    const ok = await releaseProjectTwinCollapseSnapshot(projectDir, ID, {
      cwd: worktree,
      confirm: true,
      confirmOwnerStore: true,
    });
    expect(ok.release).not.toBeNull();
  });
});
