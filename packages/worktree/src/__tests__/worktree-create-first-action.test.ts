/**
 * `createWorktree`'s preamble must emit a `FIRST ACTION: cd …` line a shell
 * can run when the worktree root contains a space (T12528).
 *
 * The macOS default root is `~/Library/Application Support/cleo/worktrees`,
 * so the previous unquoted `cd ${worktreePath}` split on the space.
 *
 * Uses a real temporary git repository (same harness as
 * `worktree-branch-reuse.test.ts`); CLEO_HOME is routed to a temp dir whose
 * name contains a space.
 *
 * @task T12528
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktree } from '../worktree-create.js';

/** Initialise a bare-minimum git repository in a temp directory. */
function initTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cleo-wt-first-action-'));
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'README.md'), '# test\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'pipe' });
  return dir;
}

describe('createWorktree — FIRST ACTION quoting (T12528)', () => {
  let projectRoot: string;
  let tempBase: string;
  let originalCleoHome: string | undefined;

  beforeEach(() => {
    projectRoot = initTempRepo();
    tempBase = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-home-')));
    const cleoHome = join(tempBase, 'Application Support', 'cleo');
    mkdirSync(cleoHome, { recursive: true });
    originalCleoHome = process.env['CLEO_HOME'];
    process.env['CLEO_HOME'] = cleoHome;
  });

  afterEach(() => {
    if (originalCleoHome === undefined) {
      delete process.env['CLEO_HOME'];
    } else {
      process.env['CLEO_HOME'] = originalCleoHome;
    }
    rmSync(tempBase, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('emits a single-quoted cd that lands in a worktree path containing a space', async () => {
    const result = await createWorktree(projectRoot, { taskId: 'T9101', lockWorktree: false });
    expect(result.path).toContain(' ');

    const line = result.preamble.split('\n').find((l) => l.startsWith('FIRST ACTION: '));
    if (!line) throw new Error('preamble has no FIRST ACTION line');
    const command = line.slice('FIRST ACTION: '.length);
    expect(command).toBe(`cd '${result.path}'`);

    const landed = execFileSync('bash', ['--noprofile', '--norc', '-c', `${command} && pwd -P`], {
      encoding: 'utf8',
    }).trim();
    expect(landed).toBe(realpathSync(result.path));
  });
});
