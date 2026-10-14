/**
 * `pruneWorktree` — the removal `cleo complete` runs — keeps a worktree that
 * something outside it still needs (T13696). axiom's `cleo complete T1968`
 * deleted the physical node_modules five sibling worktrees symlinked into,
 * and the raw evidence the task's own receipts pointed at.
 *
 * @task T13696
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceAtom } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pruneWorktree, resolveAgentWorktreeRoot } from '../branch-lock.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

const sha256 = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

const prevCleoHome = process.env['CLEO_HOME'];
let base: string;
let repo: string;

/** A git worktree for `taskId` under the sandboxed worktree root. */
function addWorktree(taskId: string): string {
  const wt = join(resolveAgentWorktreeRoot(repo), taskId);
  git(repo, ['worktree', 'add', '-q', '-b', `task/${taskId}`, wt]);
  return wt;
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'dispose-guard-')));
  process.env['CLEO_HOME'] = join(base, 'cleo-home');
  repo = join(base, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'T']);
  git(repo, ['config', 'user.email', 't@e.x']);
  writeFileSync(join(repo, '.gitignore'), 'node_modules\ntmp\n');
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'T960: init']);
});

afterEach(() => {
  if (prevCleoHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = prevCleoHome;
  rmSync(base, { recursive: true, force: true });
});

describe('pruneWorktree disposal guard (T13696)', () => {
  it('keeps a worktree whose node_modules another worktree links to, and the link still resolves', () => {
    const owner = addWorktree('T961');
    const sibling = addWorktree('T962');
    mkdirSync(join(owner, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(owner, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
    const link = join(sibling, 'node_modules');
    symlinkSync(join(owner, 'node_modules'), link);

    const result = pruneWorktree('T961', repo);

    expect(result.worktreeRemoved).toBe(false);
    expect(result.kept?.dependents).toEqual([link]);
    expect(result.error).toContain('kept');
    expect(existsSync(owner)).toBe(true);
    expect(readFileSync(join(link, 'dep', 'index.js'), 'utf-8')).toBe('module.exports = 1;\n');

    // The guard lasts only while the link does.
    unlinkSync(link);
    expect(pruneWorktree('T961', repo).worktreeRemoved).toBe(true);
    expect(existsSync(owner)).toBe(false);
  });

  it('keeps a worktree holding the only copy of a recorded evidence file, sha256 intact', () => {
    const wt = addWorktree('T963');
    mkdirSync(join(wt, 'tmp'));
    const receipt = join(wt, 'tmp', 'vitest.json');
    writeFileSync(receipt, '{"numPassedTests":3}\n');
    const recorded = sha256(receipt);
    const evidence: EvidenceAtom[] = [
      {
        kind: 'test-run',
        path: 'tmp/vitest.json',
        resolvedPath: receipt,
        sha256: recorded,
        passCount: 3,
        failCount: 0,
        skipCount: 0,
      },
    ];

    const result = pruneWorktree('T963', repo, { evidence });

    expect(result.worktreeRemoved).toBe(false);
    expect(result.kept?.evidence).toEqual([receipt]);
    expect(sha256(receipt)).toBe(recorded);
  });

  it('still removes a worktree whose evidence has an identical copy under the project root', () => {
    const wt = addWorktree('T964');
    const evidence: EvidenceAtom[] = [
      {
        kind: 'files',
        files: [
          { path: 'a.ts', resolvedPath: join(wt, 'a.ts'), sha256: sha256(join(repo, 'a.ts')) },
        ],
      },
    ];

    const result = pruneWorktree('T964', repo, { evidence });

    expect(result.kept).toBeUndefined();
    expect(result.worktreeRemoved).toBe(true);
  });
});
