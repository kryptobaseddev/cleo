/**
 * T12677 — a linked worktree of a CLEO project never gets a store of its own,
 * and every refusal names the owning project.
 *
 * Field report 2026-09-28: `cleo worktree adopt` run inside a fresh task
 * worktree (installed v2026.9.20, which predates T12460) resolved the
 * worktree's own `.cleo/` — it carried the project's tracked `.cleo/` files
 * plus the seeded `project-info.json` — as the project root. The store opened
 * empty and auto-recovery restored the parent's 1.3 GB snapshot into it, twice
 * (`cleo.db` + `cleo-pre-cleo.db.bak`).
 *
 * The fixture reproduces that layout: tracked `.cleo/` files committed in the
 * parent, a populated parent store with a recovery-grade backup, and a SIBLING
 * worktree (not under the CLEO worktree root) seeded with `project-info.json`.
 *
 * @task T12677
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeWorktreeOwner } from '../../project-scope.js';
import { adoptWorktree } from '../../worktree/worktree-adopt.js';
import { getTaskAccessor } from '../data-accessor.js';
import { openDualScopeDbAtPath, resolveDualScopeDbPath } from '../dual-scope-db.js';
import { autoRecoverFromBackup, resetDbState, worktreeRecoveryRefusal } from '../sqlite.js';

const PROJECT_ID = 'proj-t12677';
const fixtures: string[] = [];

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** SQLite files and backups directly under a directory. */
function storeFilesUnder(dir: string): string[] {
  try {
    return readdirSync(dir).filter(
      (n) => n.endsWith('.db') || n.includes('.db-') || n.endsWith('.bak'),
    );
  } catch {
    return [];
  }
}

/** Every task id in a store file, read-only. */
function taskIds(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare('SELECT id FROM tasks_tasks ORDER BY id').all() as { id: string }[]).map(
      (r) => r.id,
    );
  } finally {
    db.close();
  }
}

interface Fixture {
  readonly parent: string;
  readonly worktree: string;
}

async function makeFixture(): Promise<Fixture> {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-t12677-')));
  fixtures.push(tmp);
  const parent = join(tmp, 'parent');
  const worktree = join(tmp, 'sibling-worktree');

  // Tracked `.cleo/` content, as in a real repository (project-id is tracked, ADR-094).
  mkdirSync(join(parent, '.cleo'), { recursive: true });
  writeFileSync(join(parent, '.cleo', 'project-id'), `${PROJECT_ID}\n`);
  writeFileSync(join(parent, '.cleo', 'project-context.json'), '{"schemaVersion":"1.0.0"}\n');
  writeFileSync(join(parent, 'README.md'), '# parent\n');
  git(parent, ['init', '-b', 'main']);
  git(parent, ['config', 'user.email', 'cleo@example.test']);
  git(parent, ['config', 'user.name', 'Cleo Test']);
  git(parent, ['add', 'README.md', '.cleo/project-id', '.cleo/project-context.json']);
  git(parent, ['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', 'initial']);
  // Untracked identity, as `cleo init` writes it.
  const info = JSON.stringify({ projectId: PROJECT_ID, projectHash: 'hash-t12677' });
  writeFileSync(join(parent, '.cleo', 'project-info.json'), info);

  // A populated parent store...
  const accessor = await getTaskAccessor(parent);
  for (let i = 1; i <= 12; i++)
    await accessor.upsertSingleTask({
      id: `T${i}`,
      title: `parent task ${i}`,
      description: 'T12677 fixture',
      status: 'pending',
      priority: 'medium',
      createdAt: '2026-09-28T00:00:00Z',
    });
  // ...and a backup good enough for auto-recovery to use.
  const backupDir = join(parent, '.cleo', 'backups', 'sqlite');
  mkdirSync(backupDir, { recursive: true });
  const snapshot = new DatabaseSync(join(backupDir, 'tasks-20260928-000000.db'));
  snapshot.exec('CREATE TABLE tasks_tasks (id TEXT PRIMARY KEY)');
  for (let i = 0; i < 12; i++) snapshot.prepare('INSERT INTO tasks_tasks VALUES (?)').run(`T${i}`);
  snapshot.close();
  resetDbState();

  // A sibling linked worktree: tracked `.cleo/` files come along; identity is seeded.
  git(parent, ['worktree', 'add', '-b', 'task/T12677', worktree, 'main']);
  writeFileSync(join(worktree, '.cleo', 'project-info.json'), info);
  return { parent, worktree };
}

beforeEach(() => {
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

describe('T12677 — linked worktree of a CLEO project', () => {
  it('reads the owning store from the worktree, adopts it with an absolute path, and leaves no store in the worktree', async () => {
    const f = await makeFixture();
    const parentStore = join(f.parent, '.cleo', 'cleo.db');
    const before = taskIds(parentStore);
    expect(before).toHaveLength(12);

    expect(resolveDualScopeDbPath('project', f.worktree)).toBe(parentStore);
    const fromWorktree = await getTaskAccessor(f.worktree);
    expect((await fromWorktree.loadSingleTask('T1'))?.title).toBe('parent task 1');

    // The field trigger: `cleo worktree adopt .` run from inside the worktree.
    const cwd = process.cwd();
    process.chdir(f.worktree);
    try {
      const adopted = await adoptWorktree({ worktreePath: '.', projectRoot: f.parent });
      expect(adopted.success).toBe(true);
      expect(adopted.success && adopted.data.path).toBe(f.worktree);
    } finally {
      process.chdir(cwd);
    }

    expect(storeFilesUnder(join(f.worktree, '.cleo'))).toEqual([]);
    expect(taskIds(parentStore)).toEqual(before);
  });

  it('the store-open refusal names the owning project', async () => {
    const f = await makeFixture();
    const wtStore = join(f.worktree, '.cleo', 'cleo.db');
    await expect(openDualScopeDbAtPath('project', wtStore)).rejects.toThrow(
      `owning project ${f.parent} (projectId ${PROJECT_ID})`,
    );
    expect(storeFilesUnder(join(f.worktree, '.cleo'))).toEqual([]);
  });

  it('auto-recovery refuses to restore into the worktree and names the owning project', async () => {
    const f = await makeFixture();
    const wtStore = join(f.worktree, '.cleo', 'cleo.db');
    expect(worktreeRecoveryRefusal(wtStore)).toContain(
      `owning project ${f.parent} (projectId ${PROJECT_ID})`,
    );
    expect(worktreeRecoveryRefusal(join(f.parent, '.cleo', 'cleo.db'))).toBeNull();

    // Even handed an empty store at that path, with a valid backup in reach, nothing is restored.
    const empty = new DatabaseSync(wtStore);
    empty.exec('CREATE TABLE tasks_tasks (id TEXT PRIMARY KEY)');
    await expect(autoRecoverFromBackup(empty, wtStore, f.worktree)).resolves.toBe(false);
    if (empty.isOpen) empty.close();
    expect(taskIds(wtStore)).toEqual([]);
    expect(storeFilesUnder(join(f.worktree, '.cleo'))).toEqual(['cleo.db']);
  });

  it('names an owning repository that is not an initialised CLEO project', () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-t12677-plain-')));
    fixtures.push(tmp);
    const repo = join(tmp, 'repo');
    mkdirSync(repo);
    writeFileSync(join(repo, 'README.md'), 'x\n');
    git(repo, ['init', '-b', 'main']);
    git(repo, ['add', 'README.md']);
    git(repo, [
      '-c',
      'user.email=cleo@example.test',
      '-c',
      'user.name=Cleo Test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--no-verify',
      '-m',
      'initial',
    ]);
    git(repo, ['worktree', 'add', '-b', 'wt', join(tmp, 'wt'), 'main']);
    expect(describeWorktreeOwner(join(tmp, 'wt'))).toBe(
      `owning repository ${repo} (not an initialised CLEO project)`,
    );
  });
});
