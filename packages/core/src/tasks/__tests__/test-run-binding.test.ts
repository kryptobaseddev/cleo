/**
 * Targeted `test-run:` evidence is bound to the code it ran on (T12965):
 * verify records HEAD, the tracked tree hash and the covered test files, and
 * a moved tree no longer stands unless merged CI supersedes it.
 *
 * @task T12965
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceAtom } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testRunTreeMismatchReason } from '../affected-scope.js';
import { validateAtom } from '../evidence.js';
import { captureTreeIdentity } from '../tree-identity.js';

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();
}

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'test-run-binding-')));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'T']);
  git(root, ['config', 'user.email', 't@e.x']);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, '.gitignore'), 'reports/\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'init']);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function report(files: string[], startTime?: number): string {
  mkdirSync(join(root, 'reports'), { recursive: true });
  const path = join(root, 'reports', 'vitest.json');
  writeFileSync(
    path,
    JSON.stringify({
      ...(startTime !== undefined ? { startTime } : {}),
      numTotalTests: files.length,
      numPassedTests: files.length,
      numFailedTests: 0,
      testResults: files.map((name) => ({ name, status: 'passed' })),
    }),
  );
  return path;
}

describe('captureTreeIdentity', () => {
  it('ignores untracked files and changes on a tracked edit, staged or not', () => {
    const clean = captureTreeIdentity(root);
    expect(clean?.headSha).toBe(git(root, ['rev-parse', 'HEAD']));
    expect(clean?.treeHash).toBe(git(root, ['rev-parse', 'HEAD^{tree}']));
    writeFileSync(join(root, 'scratch.txt'), 'untracked\n');
    expect(captureTreeIdentity(root)?.treeHash).toBe(clean?.treeHash);
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 2;\n');
    const edited = captureTreeIdentity(root);
    expect(edited?.treeHash).not.toBe(clean?.treeHash);
    git(root, ['add', 'src/a.ts']);
    expect(captureTreeIdentity(root)?.treeHash).toBe(edited?.treeHash);
    // The live index is never touched by the capture.
    expect(git(root, ['diff', '--cached', '--name-only'])).toBe('src/a.ts');
  });

  it('two checkouts with the same tracked content share one tree hash', () => {
    const other = `${root}-clone`;
    try {
      execFileSync('git', ['clone', '-q', root, other]);
      expect(captureTreeIdentity(other)?.treeHash).toBe(captureTreeIdentity(root)?.treeHash);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('is null outside a git checkout', () => {
    const plain = mkdtempSync(join(tmpdir(), 'not-git-'));
    try {
      expect(captureTreeIdentity(plain)).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('test-run atoms are bound at verify time', () => {
  it('records HEAD, the tree hash and the covered test files', async () => {
    const path = report([join(root, 'src', 'b.test.ts'), join(root, 'src', 'a.test.ts')]);
    const r = await validateAtom({ kind: 'test-run', path }, root);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.ok && r.atom).toMatchObject({
      kind: 'test-run',
      headSha: git(root, ['rev-parse', 'HEAD']),
      treeHash: git(root, ['rev-parse', 'HEAD^{tree}']),
      testFiles: ['src/a.test.ts', 'src/b.test.ts'],
      testFileCount: 2,
    });
  });

  it('caps the listed files and keeps the true count', async () => {
    const names = Array.from({ length: 205 }, (_, i) => join(root, `t${i}.test.ts`));
    const r = await validateAtom({ kind: 'test-run', path: report(names) }, root);
    expect(r.ok && r.atom.kind === 'test-run' && r.atom.testFiles?.length).toBe(200);
    expect(r.ok && r.atom.kind === 'test-run' && r.atom.testFileCount).toBe(205);
  });
});

describe('testRunTreeMismatchReason', () => {
  const bound = (treeHash: string): EvidenceAtom => ({
    kind: 'test-run',
    path: 'reports/vitest.json',
    sha256: 'c'.repeat(64),
    passCount: 1,
    failCount: 0,
    skipCount: 0,
    treeHash,
  });
  const ci: EvidenceAtom = {
    kind: 'ci',
    prNumber: 42,
    mergeCommitSha: 'a'.repeat(40),
    checks: [],
    requiredSource: 'test',
  };

  it('stands while the tree matches and is refused once it moves', () => {
    expect(testRunTreeMismatchReason([bound('1'.repeat(40))], '1'.repeat(40))).toBeNull();
    expect(testRunTreeMismatchReason([bound('1'.repeat(40))], '2'.repeat(40))).toMatch(
      /recorded on tree 111111111111.*now 222222222222.*ci:<pr>/,
    );
  });

  it('an uncomputable current tree does not stand either', () => {
    expect(testRunTreeMismatchReason([bound('1'.repeat(40))], null)).toMatch(/cannot be computed/);
  });

  it('merged CI supersedes a moved tree; unbound legacy atoms are not judged', () => {
    expect(testRunTreeMismatchReason([bound('1'.repeat(40)), ci], '2'.repeat(40))).toBeNull();
    const legacy: EvidenceAtom = {
      kind: 'test-run',
      path: 'r.json',
      sha256: 'c'.repeat(64),
      passCount: 1,
      failCount: 0,
      skipCount: 0,
    };
    expect(testRunTreeMismatchReason([legacy], '2'.repeat(40))).toBeNull();
  });

  it('a real edit after verify moves the tree', async () => {
    const r = await validateAtom(
      { kind: 'test-run', path: report([join(root, 'x.test.ts')]) },
      root,
    );
    const atoms = r.ok ? [r.atom] : [];
    expect(
      testRunTreeMismatchReason(atoms, captureTreeIdentity(root)?.treeHash ?? null),
    ).toBeNull();
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 3;\n');
    expect(testRunTreeMismatchReason(atoms, captureTreeIdentity(root)?.treeHash ?? null)).toMatch(
      /no longer describes this code/,
    );
  });
});

describe('a report must be fresher than the change and cover it (T12965 review)', () => {
  it('refuses a report that started before a tracked file of the change was edited', async () => {
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 9;\n');
    const path = report([join(root, 'src', 'a.test.ts')], Date.now() - 60_000);
    const r = await validateAtom({ kind: 'test-run', path }, root);
    expect(!r.ok && r.codeName, JSON.stringify(r)).toBe('E_EVIDENCE_STALE');
    expect(!r.ok && r.reason).toMatch(/stale.*src\/a\.ts.*after the run/);
  });

  it('accepts a report that started after the last edit (committing later is fine)', async () => {
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 9;\n');
    const path = report([join(root, 'src', 'a.test.ts')], Date.now() + 5_000);
    const r = await validateAtom({ kind: 'test-run', path }, root);
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  describe('relevance in a workspace with an origin', () => {
    beforeEach(() => {
      writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
      for (const name of ['a', 'b']) {
        mkdirSync(join(root, 'packages', name, 'src'), { recursive: true });
        writeFileSync(
          join(root, 'packages', name, 'package.json'),
          JSON.stringify({ name: `@x/${name}`, scripts: { test: 'vitest run' } }),
        );
        writeFileSync(join(root, 'packages', name, 'src', 'index.ts'), 'export {};\n');
      }
      git(root, ['add', '.']);
      git(root, ['commit', '-q', '-m', 'workspace']);
      const origin = `${root}-origin.git`;
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
      git(root, ['remote', 'add', 'origin', origin]);
      git(root, ['push', '-q', '-u', 'origin', 'main']);
      git(root, ['remote', 'set-head', 'origin', 'main']);
      git(root, ['switch', '-q', '-c', 'task/T1']);
      writeFileSync(join(root, 'packages', 'a', 'src', 'index.ts'), 'export const x = 1;\n');
      git(root, ['commit', '-q', '-am', 'T1: change a']);
    });
    afterEach(() => rmSync(`${root}-origin.git`, { recursive: true, force: true }));

    it('refuses a report covering none of the changed packages', async () => {
      const path = report([join(root, 'packages', 'b', 'src', 'b.test.ts')], Date.now() + 5_000);
      const r = await validateAtom({ kind: 'test-run', path }, root);
      expect(!r.ok && r.reason, JSON.stringify(r)).toMatch(
        /covers none of the changed package\(s\) @x\/a/,
      );
    });

    it('accepts a report that covers a changed package', async () => {
      const path = report([join(root, 'packages', 'a', 'src', 'a.test.ts')], Date.now() + 5_000);
      const r = await validateAtom({ kind: 'test-run', path }, root);
      expect(r.ok && r.atom, JSON.stringify(r)).toMatchObject({
        testFiles: ['packages/a/src/a.test.ts'],
      });
    });
  });
});
