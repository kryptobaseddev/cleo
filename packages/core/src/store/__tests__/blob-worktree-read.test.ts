/**
 * T14127 — a doc's blob bytes read from a CLEO worktree are the bytes the
 * project root reads.
 *
 * The writers put bytes under the project's store (`resolveCleoDir`, which
 * maps a linked worktree to its parent project), but `blobReadBySha` and
 * `CleoBlobStore` joined `<projectRoot>/.cleo` literally, so a fetch from a
 * worktree looked in the worktree's own seeded `.cleo/` and found nothing.
 *
 * @task T14127
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blobReadBySha } from '../blob-ops.js';
import { CleoBlobStore } from '../llmtxt-blob-adapter.js';
import { resetDbState } from '../sqlite.js';

const fixtures: string[] = [];

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, stdio: 'ignore' });
}

/** An initialised parent project and one linked worktree carrying a seeded `.cleo/`. */
function makeFixture(): { parent: string; worktree: string } {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-t14127-')));
  fixtures.push(tmp);
  const parent = join(tmp, 'parent');
  const worktree = join(tmp, 'xdg', 'cleo', 'worktrees', 'hash', 'T14127');
  mkdirSync(join(parent, '.cleo'), { recursive: true });
  const info = JSON.stringify({ projectId: 'proj-t14127', projectHash: 'hash-t14127' });
  writeFileSync(join(parent, '.cleo', 'project-info.json'), info);
  writeFileSync(join(parent, 'README.md'), '# parent\n');
  git(parent, ['init', '-b', 'main']);
  git(parent, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', 'README.md']);
  git(parent, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'initial']);
  git(parent, ['worktree', 'add', '-b', 'task/T14127', worktree, 'main']);
  // What createWorktree seeds for identity inheritance (T11033).
  mkdirSync(join(worktree, '.cleo'), { recursive: true });
  writeFileSync(join(worktree, '.cleo', 'project-info.json'), info);
  return { parent, worktree };
}

beforeEach(() => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  vi.stubEnv('CLEO_PROJECT_ROOT', undefined);
  vi.stubEnv('CLEO_WORKTREE_ROOT', undefined);
  resetDbState();
});

afterEach(() => {
  resetDbState();
  vi.unstubAllEnvs();
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('T14127 — blob reads from a worktree resolve the project store', () => {
  it('blobReadBySha returns the same bytes from the worktree and from the root', async () => {
    const { parent, worktree } = makeFixture();
    const body = Buffer.from('# A doc\n\nbytes written by the project store\n');
    const sha = createHash('sha256').update(body).digest('hex');
    // Where the writers put it: the project's `.cleo/blobs/blobs/<sha>`.
    mkdirSync(join(parent, '.cleo', 'blobs', 'blobs'), { recursive: true });
    writeFileSync(join(parent, '.cleo', 'blobs', 'blobs', sha), body);

    const fromRoot = await blobReadBySha(sha, parent);
    const fromWorktree = await blobReadBySha(sha, worktree);
    expect(fromRoot).not.toBeNull();
    expect(fromWorktree).not.toBeNull();
    const digest = (b: Uint8Array | null) =>
      createHash('sha256')
        .update(b ?? new Uint8Array())
        .digest('hex');
    expect(digest(fromWorktree)).toBe(digest(fromRoot));
    expect(digest(fromWorktree)).toBe(sha);
  });

  it('CleoBlobStore opened from a worktree uses the project store directory', async () => {
    const { parent, worktree } = makeFixture();
    const store = new CleoBlobStore({ projectRoot: worktree });
    await store.open();
    try {
      expect(existsSync(join(parent, '.cleo', 'blobs', 'manifest.db'))).toBe(true);
      expect(existsSync(join(worktree, '.cleo', 'blobs'))).toBe(false);
    } finally {
      await store.close();
    }
  });
});
