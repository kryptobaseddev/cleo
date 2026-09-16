/**
 * `commit:` and `files:` atoms must be validated against the repo under test,
 * not the CLEO store root (gh#1365).
 *
 * ## The defect
 *
 * `resolveEvidenceExecutionRoot()` existed, was correct, and was wired to the
 * `tool:` path only. `validateCommit` and `validateFiles` received a bare
 * `projectRoot`, so when the store root and the caller's tree differed the same
 * broken resolution produced a false negative on one gate and a false positive
 * on another, in one task, in one output:
 *
 * ```
 * "failedAtoms": [
 *   {"kind":"commit","reason":"Commit not found in repository: 80b1faa5…"},
 *   {"kind":"files","reason":"File removed since verify: docs/compliance/t167-…md"}
 * ]
 * ```
 *
 * Both claims were false — the commit was an ancestor of `origin/main` and the
 * file was present at 5,176 bytes.
 *
 * ## Why this fixture uses a WORKTREE, and why it tests `files:`
 *
 * `resolveEvidenceExecutionRoot` only redirects when the caller's git toplevel
 * belongs to the SAME project as the store root — an unrelated directory falls
 * back, by design, so an unrelated tmpdir would not exercise the redirect at
 * all and the test would pass vacuously.
 *
 * Within that constraint `files:` is the discriminating atom. Worktrees SHARE
 * an object database, so a commit is reachable by `cat-file` from either root
 * and a `commit:` atom cannot tell them apart. What genuinely differs is the
 * working tree on disk — which is exactly what the reporter saw.
 *
 * @task T12218 (gh#1365)
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateAtom } from '../evidence.js';

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
}

const ONLY_IN_WORKTREE = 'docs/only-on-the-branch.md';

let storeRoot: string;
let worktree: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  storeRoot = mkdtempSync(join(tmpdir(), 'exec-root-store-'));
  git(storeRoot, ['init', '-q', '-b', 'main']);
  git(storeRoot, ['config', 'user.name', 'Test']);
  git(storeRoot, ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(storeRoot, 'README.md'), 'base\n');
  git(storeRoot, ['add', 'README.md']);
  git(storeRoot, ['commit', '-q', '-m', 'base']);

  // A worktree of the SAME project, carrying a file the main checkout lacks.
  worktree = `${storeRoot}-wt`;
  git(storeRoot, ['worktree', 'add', '-q', '-b', 'feature', worktree]);
  execFileSync('mkdir', ['-p', join(worktree, 'docs')]);
  writeFileSync(join(worktree, ONLY_IN_WORKTREE), 'present in the worktree\n');
  git(worktree, ['add', ONLY_IN_WORKTREE]);
  git(worktree, ['commit', '-q', '-m', 'add doc on the branch']);
});

afterEach(() => {
  process.chdir(originalCwd);
  try {
    git(storeRoot, ['worktree', 'remove', '--force', worktree]);
  } catch {
    // best effort — the tmpdir removal below is the real cleanup
  }
  rmSync(storeRoot, { recursive: true, force: true });
  rmSync(worktree, { recursive: true, force: true });
});

describe('atoms resolve against the repo under test (gh#1365)', () => {
  it('validates a files: atom present ONLY in the caller worktree', async () => {
    // The whole defect in one assertion. Invoked from the worktree, the file is
    // right there; resolved from the store root it does not exist, and CLEO
    // reported that absence as the operator's problem.
    process.chdir(worktree);
    const r = await validateAtom({ kind: 'files', paths: [ONLY_IN_WORKTREE] }, storeRoot);
    if (!r.ok) {
      throw new Error(`expected the worktree file to validate, got: ${r.reason}`);
    }
    expect(r.atom.kind).toBe('files');
  });

  it('still fails honestly for a path that exists in NEITHER tree', async () => {
    // The control. A fix that resolved everything optimistically would pass the
    // case above and this one too, which would make the first assertion
    // meaningless.
    process.chdir(worktree);
    const r = await validateAtom({ kind: 'files', paths: ['docs/no-such-file.md'] }, storeRoot);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codeName).toBe('E_EVIDENCE_INVALID');
  });

  it('names BOTH roots it searched when a path is missing', async () => {
    // gh#1365's complaint was as much about the diagnosis as the verdict: the
    // operator could not tell a worktree miss from a store miss.
    process.chdir(worktree);
    const r = await validateAtom({ kind: 'files', paths: ['docs/no-such-file.md'] }, storeRoot);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain(worktree);
      expect(r.reason).toContain(storeRoot);
    }
  });
});
