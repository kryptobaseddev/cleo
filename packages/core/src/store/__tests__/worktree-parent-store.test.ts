/**
 * T12460 — a CLEO worktree reads and writes its PARENT project's store.
 *
 * Before T12460 a `cleo` command run inside an orchestrate worktree resolved
 * the worktree's own `.cleo/` (the nearest-`.cleo` walk and the
 * `CLEO_WORKTREE_ROOT` scope both won before the gitlink step). The store
 * opened empty, `autoRecoverFromBackup` copied the parent's newest snapshot in,
 * and every write from the worktree landed in a copy nothing merges back.
 *
 * The fixture is a real `git worktree add` checkout of an initialised parent,
 * carrying the `.cleo/project-info.json` that `createWorktree` seeds (T11033).
 *
 * @task T12460
 */

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scanWorktreeStores } from '../../doctor/worktree-stores.js';
import { resolveCleoDir, worktreeScope } from '../../paths.js';
import { getTaskAccessor } from '../data-accessor.js';
import { openDualScopeDbAtPath, resolveDualScopeDbPath } from '../dual-scope-db.js';
import { bindBrainDomain } from '../memory-sqlite.js';
import { autoRecoverFromBackup, resetDbState } from '../sqlite.js';

/** Fixture layout: an initialised parent project and one linked worktree. */
interface Fixture {
  readonly tmp: string;
  readonly parent: string;
  readonly worktree: string;
  readonly worktreeBase: string;
}

const fixtures: string[] = [];

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** List every SQLite-ish file directly under a directory. */
function dbFilesUnder(dir: string): string[] {
  try {
    return readdirSync(dir).filter(
      (n) => n.endsWith('.db') || n.includes('.db-') || n.endsWith('.bak'),
    );
  } catch {
    return [];
  }
}

function makeFixture(): Fixture {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-t12460-')));
  fixtures.push(tmp);
  const parent = join(tmp, 'parent');
  const worktreeBase = join(tmp, 'xdg', 'cleo', 'worktrees', 'hash');
  const worktree = join(worktreeBase, 'T12460');

  mkdirSync(join(parent, '.cleo'), { recursive: true });
  const info = JSON.stringify({ projectId: 'proj-t12460', projectHash: 'hash-t12460' });
  writeFileSync(join(parent, '.cleo', 'project-info.json'), info);
  writeFileSync(join(parent, 'README.md'), '# parent\n');
  git(parent, ['init', '-b', 'main']);
  git(parent, ['config', 'user.email', 'cleo@example.test']);
  git(parent, ['config', 'user.name', 'Cleo Test']);
  git(parent, ['add', 'README.md']);
  git(parent, ['commit', '-m', 'initial']);
  git(parent, ['worktree', 'add', '-b', 'task/T12460', worktree, 'main']);

  // What createWorktree seeds for identity inheritance (T11033).
  mkdirSync(join(worktree, '.cleo'), { recursive: true });
  writeFileSync(join(worktree, '.cleo', 'project-info.json'), info);
  mkdirSync(join(worktree, 'packages', 'x'), { recursive: true });
  return { tmp, parent, worktree, worktreeBase };
}

beforeEach(() => {
  // Exercise the fixture itself, not the setup file's safe-project pins.
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  vi.stubEnv('CLEO_PROJECT_ROOT', undefined);
  vi.stubEnv('CLEO_WORKTREE_ROOT', undefined);
  vi.stubEnv('CLEO_ALLOW_WORKTREE_DB_CREATE', undefined);
  resetDbState();
});

afterEach(() => {
  resetDbState();
  vi.unstubAllEnvs();
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('T12460 — worktree store resolution', () => {
  it('resolves the parent .cleo from the worktree root, a subdirectory, and the worktree scope', () => {
    const f = makeFixture();
    const parentCleo = join(f.parent, '.cleo');

    expect(resolveCleoDir(f.worktree)).toBe(parentCleo);
    expect(resolveCleoDir(join(f.worktree, 'packages', 'x'))).toBe(parentCleo);
    expect(resolveDualScopeDbPath('project', f.worktree)).toBe(join(parentCleo, 'cleo.db'));

    // CLEO_WORKTREE_ROOT reaches resolution through this scope (runWithWorktreeScopeFromEnv).
    worktreeScope.run({ worktreeRoot: f.worktree, projectHash: 'hash' }, () => {
      expect(resolveCleoDir()).toBe(parentCleo);
      expect(resolveDualScopeDbPath('project')).toBe(join(parentCleo, 'cleo.db'));
    });
  });

  it('a write from inside the worktree lands in the parent store and creates nothing under <wt>/.cleo', async () => {
    const f = makeFixture();

    const fromWorktree = await getTaskAccessor(f.worktree);
    await fromWorktree.upsertSingleTask({
      id: 'T1',
      title: 'written from the worktree',
      description: 'T12460 regression fixture',
      status: 'pending',
      priority: 'medium',
      createdAt: '2026-09-27T00:00:00Z',
    });

    // Read it back from the worktree AND from the parent.
    expect((await fromWorktree.loadSingleTask('T1'))?.title).toBe('written from the worktree');
    const fromParent = await getTaskAccessor(f.parent);
    expect((await fromParent.loadSingleTask('T1'))?.title).toBe('written from the worktree');

    // Brain (and conduit) share the same chokepoint and the same parent file.
    const brain = await bindBrainDomain(f.worktree);
    expect(brain.store.dbPath).toBe(join(f.parent, '.cleo', 'cleo.db'));

    // The parent store holds the row; the worktree has no store of its own.
    const db = new DatabaseSync(join(f.parent, '.cleo', 'cleo.db'), { readOnly: true });
    try {
      const row = db.prepare("SELECT title FROM tasks_tasks WHERE id = 'T1'").get() as
        | { title: string }
        | undefined;
      expect(row?.title).toBe('written from the worktree');
    } finally {
      db.close();
    }
    expect(dbFilesUnder(join(f.worktree, '.cleo'))).toEqual([]);
  });

  it('writes from inside a CLEO_WORKTREE_ROOT scope land in the parent store', async () => {
    const f = makeFixture();
    await worktreeScope.run({ worktreeRoot: f.worktree, projectHash: 'hash' }, async () => {
      const accessor = await getTaskAccessor();
      await accessor.upsertSingleTask({
        id: 'T2',
        title: 'scoped write',
        description: 'T12460 scope fixture',
        status: 'pending',
        priority: 'medium',
        createdAt: '2026-09-27T00:00:00Z',
      });
    });
    const fromParent = await getTaskAccessor(f.parent);
    expect((await fromParent.loadSingleTask('T2'))?.title).toBe('scoped write');
    expect(dbFilesUnder(join(f.worktree, '.cleo'))).toEqual([]);
  });

  it('the isolation guard checks the path actually opened and refuses a worktree-resident store', async () => {
    const f = makeFixture();
    const wtStore = join(f.worktree, '.cleo', 'cleo.db');
    await expect(openDualScopeDbAtPath('project', wtStore)).rejects.toThrow(
      /E_WT_DB_ISOLATION_VIOLATION/,
    );
    expect(dbFilesUnder(join(f.worktree, '.cleo'))).toEqual([]);
  });

  it('autoRecoverFromBackup never restores into a worktree path', async () => {
    const f = makeFixture();
    const cleoDir = join(f.worktree, '.cleo');
    const stranded = join(cleoDir, 'cleo.db');
    const empty = new DatabaseSync(stranded);
    empty.exec('CREATE TABLE tasks_tasks (id TEXT PRIMARY KEY)');

    // A snapshot with enough rows to look like a valid recovery source.
    const backupDir = join(cleoDir, 'backups', 'sqlite');
    mkdirSync(backupDir, { recursive: true });
    const snapshot = new DatabaseSync(join(backupDir, 'tasks-20260101-000000.db'));
    snapshot.exec('CREATE TABLE tasks_tasks (id TEXT PRIMARY KEY)');
    for (let i = 0; i < 12; i++)
      snapshot.prepare('INSERT INTO tasks_tasks VALUES (?)').run(`T${i}`);
    snapshot.close();

    const sizeBefore = statSync(stranded).size;
    await expect(autoRecoverFromBackup(empty, stranded, f.worktree)).resolves.toBe(false);
    if (empty.isOpen) empty.close();

    const after = new DatabaseSync(stranded, { readOnly: true });
    try {
      expect(
        (after.prepare('SELECT COUNT(*) AS n FROM tasks_tasks').get() as { n: number }).n,
      ).toBe(0);
    } finally {
      after.close();
    }
    expect(statSync(stranded).size).toBe(sizeBefore);
  });
});

describe('T12460 — scanWorktreeStores (read-only stranded-copy report)', () => {
  it('lists worktree store files and reports whether each holds rows the parent lacks', async () => {
    const f = makeFixture();

    // Parent store with two tasks.
    const accessor = await getTaskAccessor(f.parent);
    for (const id of ['T1', 'T2']) {
      await accessor.upsertSingleTask({
        id,
        title: `parent task ${id}`,
        description: 'T12460 scan fixture',
        status: 'pending',
        priority: 'medium',
        createdAt: '2026-09-27T00:00:00Z',
      });
    }
    resetDbState();
    const parentStore = join(f.parent, '.cleo', 'cleo.db');

    // A stranded copy identical to the parent (nothing newer) ...
    const cleoDir = join(f.worktree, '.cleo');
    copyFileSync(parentStore, join(cleoDir, 'cleo-pre-cleo.db.bak'));
    // ... and a stranded copy holding a row the parent lacks (T999) and a later
    // update to a row the parent has (T1).
    copyFileSync(parentStore, join(cleoDir, 'cleo.db'));
    const copy = new DatabaseSync(join(cleoDir, 'cleo.db'));
    copy.exec("UPDATE tasks_tasks SET updated_at = '2999-01-01T00:00:00Z' WHERE id = 'T1'");
    copy.exec("UPDATE tasks_tasks SET id = 'T999' WHERE id = 'T2'");
    copy.close();

    const before = readdirSync(cleoDir).sort();
    const result = scanWorktreeStores(f.parent, { worktreeBase: f.worktreeBase });

    expect(result.parentStoreExists).toBe(true);
    expect(result.entries).toHaveLength(1);
    const [entry] = result.entries;
    expect(entry?.worktreePath).toBe(f.worktree);
    expect(entry?.registeredWithGit).toBe(true);

    const byName = new Map(entry?.files.map((file) => [file.name, file]));
    expect(byName.get('cleo.db')?.hasRowsNewerThanParent).toBe(true);
    const tasks = byName.get('cleo.db')?.tables.find((t) => t.table === 'tasks_tasks');
    expect(tasks).toMatchObject({ missingInParent: 1, newerThanParent: 1 });
    expect(byName.get('cleo-pre-cleo.db.bak')?.hasRowsNewerThanParent).toBe(false);
    expect(result.filesWithNewerRows).toEqual([join(cleoDir, 'cleo.db')]);

    // Read-only: nothing added, removed, or renamed.
    expect(readdirSync(cleoDir).sort()).toEqual(before);
  });
});
