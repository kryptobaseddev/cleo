/**
 * `pr:` and `commit:` must find the git checkout when the CLEO root is a PARENT
 * of it (gh#1462).
 *
 * ## The defect
 *
 * Layout: CLEO root `/mnt/projects/axiom-analytics`, git repo in the
 * `axiom-app/` subdirectory. Invoked from the CLEO root:
 *
 * ```
 * $ cleo verify T404 --gate testsPassed --evidence "pr:689"
 * E_EVIDENCE_TOOL_FAILED: gh pr view failed: failed to run git:
 *   fatal: not a git repository (or any parent up to mount point /mnt)
 * ```
 *
 * `gh` did its own repo discovery from the CLEO root, found no repository
 * before the mount point, and failed. The code was the same one a tool that
 * genuinely ran and failed produces, so the failure read as a broken `gh` or an
 * atom this project cannot satisfy — and the reader goes looking for a
 * different gate instead of fixing the directory. `commit:` failed the same
 * way, reporting "Commit not found in repository" for a commit that was right
 * there in the child checkout.
 *
 * `resolveEvidenceExecutionRoot` already knew about worktrees and the caller's
 * cwd; it had no answer for the parent layout, because neither the CLEO root
 * nor a cwd AT the CLEO root is a git work tree.
 *
 * ## What these tests pin
 *
 * 1. The resolver walks down to the single git work tree directly below the
 *    CLEO root, and leaves the root alone when the choice is ambiguous.
 * 2. Both atoms then work from the CLEO root: `commit:` validates a real
 *    commit, and `pr:` hands `gh` the checkout (captured by a fake `gh` on
 *    PATH, so the assertion is about the cwd that reached the tool).
 * 3. When no checkout can be found, both atoms fail with
 *    `E_EVIDENCE_GIT_ROOT` and name `GIT_DIR`/`GIT_WORK_TREE` — distinct from
 *    `E_EVIDENCE_TOOL_FAILED`, which is the whole point of the issue.
 *
 * @task gh#1462
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateAtom } from '../evidence.js';

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'user.email', 'test@example.com']);
}

/**
 * Writes an executable `gh` that records the cwd it ran in and prints the
 * canned MERGED payload. `gh --version` answers so `isGhCliAvailable()` passes.
 */
function installFakeGh(binDir: string, payloadPath: string, cwdRecordPath: string): void {
  mkdirSync(binDir, { recursive: true });
  const script = join(binDir, 'gh');
  writeFileSync(
    script,
    '#!/bin/sh\n' +
      'if [ "$1" = "--version" ]; then echo "gh version 99.0.0 (test)"; exit 0; fi\n' +
      'printf "%s" "$PWD" > "$CLEO_TEST_GH_CWD"\n' +
      'cat "$CLEO_TEST_GH_PAYLOAD"\n' +
      'exit 0\n',
    'utf-8',
  );
  chmodSync(script, 0o755);
  process.env.CLEO_TEST_GH_CWD = cwdRecordPath;
  process.env.CLEO_TEST_GH_PAYLOAD = payloadPath;
}

let storeRoot: string;
let originalCwd: string;
let originalPath: string | undefined;

beforeEach(() => {
  originalCwd = process.cwd();
  originalPath = process.env.PATH;
  storeRoot = mkdtempSync(join(tmpdir(), 'nested-root-'));
  mkdirSync(join(storeRoot, '.cleo'), { recursive: true });
  // Declared empty so a MERGED PR satisfies pr: without a branch-protection
  // lookup — the atom under test here is the directory, not the check list.
  writeFileSync(
    join(storeRoot, '.cleo', 'project-context.json'),
    JSON.stringify({ schemaVersion: '1.0.0', release: { prRequiredWorkflows: [] } }),
    'utf-8',
  );
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.CLEO_TEST_GH_CWD;
  delete process.env.CLEO_TEST_GH_PAYLOAD;
  rmSync(storeRoot, { recursive: true, force: true });
});

describe('resolveEvidenceExecutionRoot finds the checkout below the CLEO root (gh#1462)', () => {
  it('resolves the single child work tree when invoked from the CLEO root', async () => {
    const repo = join(storeRoot, 'axiom-app');
    initRepo(repo);
    process.chdir(storeRoot);

    const { resolveEvidenceExecutionRoot } = await import('../evidence.js');
    expect(resolveEvidenceExecutionRoot(storeRoot)).toBe(repo);
  });

  it('does not guess when two child checkouts are present', async () => {
    initRepo(join(storeRoot, 'app-a'));
    initRepo(join(storeRoot, 'app-b'));
    process.chdir(storeRoot);

    const { resolveEvidenceExecutionRoot } = await import('../evidence.js');
    // Ambiguity is reported through the atoms, not resolved by picking one.
    expect(resolveEvidenceExecutionRoot(storeRoot)).toBe(storeRoot);
  });
});

describe('commit: from a CLEO root that parents the checkout (gh#1462)', () => {
  it('validates a commit that exists in the child checkout', async () => {
    const repo = join(storeRoot, 'axiom-app');
    initRepo(repo);
    writeFileSync(join(repo, 'a.txt'), 'hello\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'base']);
    const sha = git(repo, ['rev-parse', 'HEAD']).trim();
    process.chdir(storeRoot);

    const r = await validateAtom({ kind: 'commit', sha }, storeRoot);
    if (!r.ok) throw new Error(`expected the child checkout commit to validate, got: ${r.reason}`);
    expect(r.atom.kind).toBe('commit');
  });
});

describe('pr: from a CLEO root that parents the checkout (gh#1462)', () => {
  it('runs gh inside the child checkout, not the CLEO root', async () => {
    const repo = join(storeRoot, 'axiom-app');
    initRepo(repo);
    writeFileSync(join(repo, 'a.txt'), 'hello\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'base']);
    const sha = git(repo, ['rev-parse', 'HEAD']).trim();

    const binDir = join(storeRoot, 'bin');
    const payloadPath = join(storeRoot, 'payload.json');
    const cwdRecordPath = join(storeRoot, 'gh-cwd.txt');
    writeFileSync(
      payloadPath,
      JSON.stringify({
        state: 'MERGED',
        mergedAt: '2026-09-16T00:00:00Z',
        headRefOid: sha,
        statusCheckRollup: [],
      }),
      'utf-8',
    );
    installFakeGh(binDir, payloadPath, cwdRecordPath);
    process.env.PATH = `${binDir}:${originalPath ?? ''}`;
    process.chdir(storeRoot);

    const r = await validateAtom({ kind: 'pr', prNumber: 689 }, storeRoot);
    if (!r.ok) throw new Error(`expected pr: to validate from the CLEO root, got: ${r.reason}`);
    // The single value that decided the production failure: gh walked up from
    // its cwd. From the CLEO root it found nothing; from the checkout it does.
    expect(readFileSync(cwdRecordPath, 'utf-8')).toBe(repo);
  });
});

describe('a genuinely missing work tree fails distinctly (gh#1462)', () => {
  it('commit: reports E_EVIDENCE_GIT_ROOT, not a missing commit', async () => {
    process.chdir(storeRoot);

    const r = await validateAtom({ kind: 'commit', sha: 'a'.repeat(40) }, storeRoot);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.codeName).toBe('E_EVIDENCE_GIT_ROOT');
      expect(r.reason).toContain('GIT_DIR');
      expect(r.reason).toContain('GIT_WORK_TREE');
    }
  });

  it('pr: reports E_EVIDENCE_GIT_ROOT, not a tool failure', async () => {
    // No fake gh: the work-tree question is answered before gh is consulted.
    process.env.PATH = join(storeRoot, 'empty-bin');
    process.chdir(storeRoot);

    const r = await validateAtom({ kind: 'pr', prNumber: 689 }, storeRoot);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.codeName).toBe('E_EVIDENCE_GIT_ROOT');
      expect(r.reason).not.toContain('not available on PATH');
    }
  });

  it('pr: says the same when two child checkouts make the choice ambiguous', async () => {
    initRepo(join(storeRoot, 'app-a'));
    initRepo(join(storeRoot, 'app-b'));
    process.env.PATH = join(storeRoot, 'empty-bin');
    process.chdir(storeRoot);

    const r = await validateAtom({ kind: 'pr', prNumber: 689 }, storeRoot);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codeName).toBe('E_EVIDENCE_GIT_ROOT');
  });
});
