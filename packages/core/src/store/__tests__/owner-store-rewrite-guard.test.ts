/**
 * T12708 — every whole-store rewrite run from a linked git worktree shares one
 * guard: it refuses a store inside the worktree, needs `--confirm-owner-store`
 * (or refuses, when the rewrite runs implicitly) for the owning project's live
 * store, and audits a confirmed overwrite.
 *
 * Every repository is a scratch repo under a temp dir, with real
 * `git worktree add`; no real store is touched.
 *
 * @task T12708
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resolveMainRepoFromGitlink, resolveStoreOwnerRoot } from '../../project-scope.js';
import { restoreBackup } from '../../system/backup.js';
import { repairMalformedDbs } from '../repair-malformed-dbs.js';
import { autoRecoverFromBackup, resetDbState } from '../sqlite.js';
import {
  OWNER_STORE_REWRITE_AUDIT_FILE,
  type OwnerStoreRewriteAuditRow,
  ownerStoreRewriteRefusal,
} from '../worktree-isolation-guard.js';

let dir: string;
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };

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
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, stdio: 'ignore' },
  );
}

/** A committed repo; `cleo` makes it an initialised CLEO project. */
function makeRepo(root: string, cleo: boolean): string {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q');
  writeFileSync(join(root, 'README'), 'x');
  git(root, 'add', 'README');
  git(root, 'commit', '-qm', 'init', '--no-verify');
  if (cleo) {
    mkdirSync(join(root, '.cleo'), { recursive: true });
    writeFileSync(
      join(root, '.cleo', 'project-info.json'),
      JSON.stringify({ projectId: 'proj-live', projectHash: 'hash-live' }),
    );
  }
  return root;
}

/** A self-contained SQLite file holding `rows` rows in `table`. */
function writeDb(path: string, table: string, rows: number): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`);
    const insert = db.prepare(`INSERT INTO ${table} VALUES (?)`);
    for (let i = 0; i < rows; i++) insert.run(`T${i}`);
  } finally {
    db.close();
  }
}

function auditRows(root: string): OwnerStoreRewriteAuditRow[] {
  const file = join(root, '.cleo', 'audit', OWNER_STORE_REWRITE_AUDIT_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as OwnerStoreRewriteAuditRow);
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-t12708-')));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  vi.stubEnv('CLEO_PROJECT_ROOT', undefined);
  vi.stubEnv('CLEO_WORKTREE_ROOT', undefined);
  resetDbState();
});

afterEach(() => {
  resetDbState();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('T12708 — one guard, one message, for every whole-store rewrite', () => {
  let main: string;
  let wt: string;
  beforeEach(() => {
    main = makeRepo(join(dir, 'main'), true);
    wt = join(dir, 'wt');
    git(main, 'worktree', 'add', '-q', wt);
  });

  it('names the owner store with the same message for every operation', () => {
    const target = join(main, '.cleo', 'cleo.db');
    for (const op of ['restore', 'backup recover tasks', 'backup import', 'auto-recovery']) {
      const refusal = ownerStoreRewriteRefusal(op, target, { cwd: wt });
      expect(refusal?.message).toBe(
        `E_WT_STORE_REWRITE_CONFIRM_REQUIRED: ${op} run from git worktree ${wt} would overwrite ` +
          `the LIVE store ${target}; this worktree's owning project ${main} (projectId proj-live).`,
      );
      expect(refusal?.fix).toContain('--confirm-owner-store');
    }
    // An implicit rewrite has no flag to offer.
    expect(
      ownerStoreRewriteRefusal('auto-recovery', target, { cwd: wt, confirmable: false })?.fix,
    ).toContain(`Run it from ${main}`);
  });

  it('allows the rewrite from the project itself, from a subdirectory of it, or when confirmed', () => {
    const target = join(main, '.cleo', 'cleo.db');
    expect(ownerStoreRewriteRefusal('restore', target, { cwd: main })).toBeNull();
    mkdirSync(join(main, 'sub'));
    expect(ownerStoreRewriteRefusal('restore', target, { cwd: join(main, 'sub') })).toBeNull();
    expect(
      ownerStoreRewriteRefusal('restore', target, { cwd: wt, confirmOwnerStore: true }),
    ).toBeNull();
  });

  it('refuses a store inside the worktree even when confirmed', () => {
    const target = join(wt, '.cleo', 'cleo.db');
    const refusal = ownerStoreRewriteRefusal('backup import', target, {
      cwd: wt,
      confirmOwnerStore: true,
    });
    expect(refusal?.message).toMatch(
      /^E_WT_STORE_REWRITE_REFUSED: backup import run from git worktree .*wt would write .*wt\/\.cleo\/cleo\.db, a store CLEO never reads — owning project .*main \(projectId proj-live\)\.$/,
    );
  });

  it('doctor repair / backup recover: refused without confirmation, audited with it', () => {
    const live = join(main, '.cleo', 'tasks.db');
    writeFileSync(live, 'not a sqlite file at all, corrupt');
    const vacuumDir = join(main, '.cleo', 'backups', 'sqlite');
    mkdirSync(vacuumDir, { recursive: true });
    writeDb(join(vacuumDir, 'tasks-20260101-120000.db'), 'tasks', 5);

    const refused = repairMalformedDbs({ projectRoot: main, cwd: wt, roles: ['tasks'], logger });
    const row = refused.roles.find((r) => r.role === 'tasks');
    expect(row?.action).toBe('failed');
    expect(row?.detail).toContain('E_WT_STORE_REWRITE_CONFIRM_REQUIRED: backup recover tasks');
    expect(readFileSync(live, 'utf8')).toBe('not a sqlite file at all, corrupt');
    expect(auditRows(main)).toEqual([]);

    const repaired = repairMalformedDbs({
      projectRoot: main,
      cwd: wt,
      confirmOwnerStore: true,
      roles: ['tasks'],
      logger,
    });
    expect(repaired.repairedCount).toBe(1);
    const audit = auditRows(main);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      operation: 'backup recover tasks',
      worktree: wt,
      store: live,
      cwd: wt,
    });
  });

  it('a confirmed restore writes an audit row naming worktree, store and operation', () => {
    const cleo = join(main, '.cleo');
    mkdirSync(join(cleo, 'backups', 'sqlite'), { recursive: true });
    writeFileSync(join(cleo, 'config.json'), '{"live":true}');
    writeFileSync(
      join(cleo, 'backups', 'sqlite', 'b1.meta.json'),
      JSON.stringify({ files: ['config.json'], timestamp: '2026-09-01T00:00:00Z' }),
    );
    writeFileSync(join(cleo, 'backups', 'sqlite', 'config.json.b1'), '{"restored":true}');

    expect(() => restoreBackup(main, { backupId: 'b1', cwd: wt })).toThrow(
      /E_WT_STORE_REWRITE_CONFIRM_REQUIRED: restore run from git worktree/,
    );
    expect(auditRows(main)).toEqual([]);

    restoreBackup(main, { backupId: 'b1', cwd: wt, confirmOwnerStore: true });
    expect(readFileSync(join(cleo, 'config.json'), 'utf8')).toBe('{"restored":true}');
    expect(auditRows(main)).toEqual([
      expect.objectContaining({ operation: 'restore', worktree: wt, store: cleo }),
    ]);

    // Run from the project itself: no confirmation, nothing audited.
    restoreBackup(main, { backupId: 'b1', cwd: main });
    expect(auditRows(main)).toHaveLength(1);
  });

  it('auto-recovery of the owning store is refused from the worktree and runs from the project', async () => {
    const store = join(main, '.cleo', 'cleo.db');
    const vacuumDir = join(main, '.cleo', 'backups', 'sqlite');
    mkdirSync(vacuumDir, { recursive: true });
    writeDb(join(vacuumDir, 'tasks-20260928-000000.db'), 'tasks_tasks', 12);

    const count = (): number => {
      const db = new DatabaseSync(store, { readOnly: true });
      try {
        return (db.prepare('SELECT COUNT(*) AS n FROM tasks_tasks').get() as { n: number }).n;
      } finally {
        db.close();
      }
    };

    const fromWorktree = new DatabaseSync(store);
    fromWorktree.exec('CREATE TABLE tasks_tasks (id TEXT PRIMARY KEY)');
    await expect(autoRecoverFromBackup(fromWorktree, store, wt)).resolves.toBe(false);
    if (fromWorktree.isOpen) fromWorktree.close();
    expect(count()).toBe(0);
    expect(existsSync(join(wt, '.cleo'))).toBe(false);

    const fromProject = new DatabaseSync(store);
    await expect(autoRecoverFromBackup(fromProject, store, main)).resolves.toBe(true);
    if (fromProject.isOpen) fromProject.close();
    expect(count()).toBe(12);
  });
});

describe('T12708 — a bare repository never binds its worktrees to its parent directory', () => {
  it('resolves no owner for a worktree of /p/app.git even when /p is a CLEO project', () => {
    const p = makeRepo(join(dir, 'p'), true);
    const source = makeRepo(join(dir, 'src'), false);
    const bare = join(p, 'app.git');
    git(dir, 'clone', '-q', '--bare', source, bare);
    const wt = join(dir, 'bare-wt');
    git(bare, 'worktree', 'add', '-q', wt);

    expect(_resolveMainRepoFromGitlink(wt)).toBeNull();
    expect(resolveStoreOwnerRoot(wt)).toBe(wt);
  });
});
