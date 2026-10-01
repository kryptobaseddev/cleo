/**
 * Targeted `test-run:` evidence is bound to the code it ran on (T12965):
 * verify records HEAD, the tracked tree hash and the covered test files, and
 * a moved tree no longer stands unless merged CI supersedes it.
 *
 * @task T12965
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceAtom } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testRunTreeMismatchReason } from '../affected-scope.js';
import { validateAtom } from '../evidence.js';
import { captureTreeHash } from '../tool-cache.js';

function git(dir: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  }).trim();
}

/** Commit everything as of `at` (epoch ms): committer, author and reflog time. */
function commitAt(dir: string, message: string, at: number): void {
  const date = `@${Math.floor(at / 1000)} +0000`;
  git(dir, ['commit', '-q', '-am', message], {
    GIT_COMMITTER_DATE: date,
    GIT_AUTHOR_DATE: date,
  });
}

function touch(path: string, at: number): void {
  utimesSync(path, new Date(at), new Date(at));
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
    expect(testRunTreeMismatchReason(atoms, await captureTreeHash(root))).toBeNull();
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 3;\n');
    expect(testRunTreeMismatchReason(atoms, await captureTreeHash(root))).toMatch(
      /no longer describes this code/,
    );
  });
});

describe('a report must be fresher than the change and cover it (T12965 review)', () => {
  it('refuses a report that started before a tracked file of the change was edited', async () => {
    // The run starts after the last commit; the edit is dated after the run.
    const ranAt = Date.now() + 2_000;
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 9;\n');
    utimesSync(join(root, 'src', 'a.ts'), new Date(ranAt + 10_000), new Date(ranAt + 10_000));
    const path = report([join(root, 'src', 'a.test.ts')], ranAt);
    const r = await validateAtom({ kind: 'test-run', path }, root);
    expect(!r.ok && r.codeName, JSON.stringify(r)).toBe('E_EVIDENCE_STALE');
    expect(!r.ok && r.reason).toMatch(/stale.*src\/a\.ts.*after the run/);
  });

  it('accepts a report that started after the last edit, before any commit', async () => {
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 9;\n');
    const path = report([join(root, 'src', 'a.test.ts')], Date.now() + 5_000);
    const r = await validateAtom({ kind: 'test-run', path }, root);
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it('refuses a report older than HEAD: a commit after the run is not covered by it', async () => {
    const path = report([join(root, 'src', 'a.test.ts')], Date.now() - 60_000);
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 4;\n');
    git(root, ['commit', '-q', '-am', 'after the run']);
    // The edited file's mtime is pushed back too, so only the commit time can tell.
    utimesSync(
      join(root, 'src', 'a.ts'),
      new Date(Date.now() - 120_000),
      new Date(Date.now() - 120_000),
    );
    const r = await validateAtom({ kind: 'test-run', path }, root);
    expect(!r.ok && r.codeName, JSON.stringify(r)).toBe('E_EVIDENCE_STALE');
    expect(!r.ok && r.reason).toMatch(
      /stale.*commit [0-9a-f]{12} of the change was made.*after the run/,
    );
  });

  it('refuses a report that predates an uncommitted deletion (no mtime of its own)', async () => {
    writeFileSync(join(root, 'src', 'gone.ts'), 'export {};\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'add gone']);
    const ranAt = Date.now() + 2_000;
    const path = report([join(root, 'src', 'a.test.ts')], ranAt);
    expect((await validateAtom({ kind: 'test-run', path }, root)).ok).toBe(true);
    rmSync(join(root, 'src', 'gone.ts'));
    // The directory records the deletion; date it after the run.
    utimesSync(join(root, 'src'), new Date(ranAt + 10_000), new Date(ranAt + 10_000));
    const r = await validateAtom({ kind: 'test-run', path }, root);
    expect(!r.ok && r.reason, JSON.stringify(r)).toMatch(/src\/gone\.ts was deleted or moved/);
  });

  it('refuses a report that predates a git mv (the moved file keeps its old mtime)', async () => {
    const ranAt = Date.now() + 2_000;
    const path = report([join(root, 'src', 'a.test.ts')], ranAt);
    mkdirSync(join(root, 'lib'), { recursive: true });
    git(root, ['mv', 'src/a.ts', 'lib/a.ts']);
    utimesSync(join(root, 'src'), new Date(ranAt + 10_000), new Date(ranAt + 10_000));
    utimesSync(join(root, 'lib', 'a.ts'), new Date(ranAt - 60_000), new Date(ranAt - 60_000));
    const r = await validateAtom({ kind: 'test-run', path }, root);
    expect(!r.ok && r.reason, JSON.stringify(r)).toMatch(/src\/a\.ts was deleted or moved/);
  });

  describe('edit, run the tests, commit, then verify (T12965 review)', () => {
    it('accepts a commit after the run that only records what the run saw', async () => {
      const t0 = Date.now();
      writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 5;\n');
      touch(join(root, 'src', 'a.ts'), t0 + 5_000);
      const path = report([join(root, 'src', 'a.test.ts')], t0 + 10_000);
      commitAt(root, 'after the run', t0 + 20_000);
      const r = await validateAtom({ kind: 'test-run', path }, root);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.ok && r.atom).toMatchObject({ treeHash: git(root, ['rev-parse', 'HEAD^{tree}']) });
    });

    it('refuses it when a committed file was edited again after the run', async () => {
      const t0 = Date.now();
      writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 5;\n');
      touch(join(root, 'src', 'a.ts'), t0 + 5_000);
      const path = report([join(root, 'src', 'a.test.ts')], t0 + 10_000);
      writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 6;\n');
      touch(join(root, 'src', 'a.ts'), t0 + 15_000);
      commitAt(root, 'edited after the run', t0 + 20_000);
      const r = await validateAtom({ kind: 'test-run', path }, root);
      expect(!r.ok && r.reason, JSON.stringify(r)).toMatch(
        /commit [0-9a-f]{12} of the change was made.*src\/a\.ts was modified.*Bind test-run before committing.*or re-run/,
      );
    });

    it('refuses it when a file was deleted after the run and the deletion committed', async () => {
      writeFileSync(join(root, 'src', 'gone.ts'), 'export {};\n');
      git(root, ['add', '.']);
      git(root, ['commit', '-q', '-m', 'add gone']);
      const t0 = Date.now();
      const path = report([join(root, 'src', 'a.test.ts')], t0 + 10_000);
      rmSync(join(root, 'src', 'gone.ts'));
      touch(join(root, 'src'), t0 + 15_000);
      commitAt(root, 'delete after the run', t0 + 20_000);
      const r = await validateAtom({ kind: 'test-run', path }, root);
      expect(!r.ok && r.reason, JSON.stringify(r)).toMatch(
        /src\/gone\.ts was deleted or moved.*Bind test-run before committing/,
      );
    });
  });

  describe('relevance in a workspace with an origin', () => {
    const pkgTest = (name: string): string =>
      join(root, 'packages', name, 'src', `${name}.test.ts`);

    beforeEach(() => {
      writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
      // c depends on a; d depends on a and has no test file.
      for (const [name, deps] of [
        ['a', {}],
        ['b', {}],
        ['c', { '@x/a': 'workspace:*' }],
        ['d', { '@x/a': 'workspace:*' }],
      ] as const) {
        mkdirSync(join(root, 'packages', name, 'src'), { recursive: true });
        writeFileSync(
          join(root, 'packages', name, 'package.json'),
          JSON.stringify({
            name: `@x/${name}`,
            dependencies: deps,
            scripts: { test: 'vitest run' },
          }),
        );
        writeFileSync(join(root, 'packages', name, 'src', 'index.ts'), 'export {};\n');
        if (name !== 'd') writeFileSync(pkgTest(name), 'export {};\n');
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
      const path = report([pkgTest('b')], Date.now() + 5_000);
      const r = await validateAtom({ kind: 'test-run', path }, root);
      expect(!r.ok && r.reason, JSON.stringify(r)).toMatch(
        /covers no test file of @x\/a \(changed\)/,
      );
    });

    it('red: a report covering one changed package of two does not stand for both', async () => {
      writeFileSync(join(root, 'packages', 'b', 'src', 'index.ts'), 'export const y = 1;\n');
      git(root, ['commit', '-q', '-am', 'T1: change b too']);
      const path = report([pkgTest('a'), pkgTest('c')], Date.now() + 5_000);
      const r = await validateAtom({ kind: 'test-run', path }, root);
      expect(!r.ok && r.reason, JSON.stringify(r)).toMatch(
        /covers no test file of @x\/b \(changed\).*tool:test-affected/,
      );
    });

    it('green: a report covering both changed packages and the dependent stands', async () => {
      writeFileSync(join(root, 'packages', 'b', 'src', 'index.ts'), 'export const y = 1;\n');
      git(root, ['commit', '-q', '-am', 'T1: change b too']);
      const path = report([pkgTest('a'), pkgTest('b'), pkgTest('c')], Date.now() + 5_000);
      const r = await validateAtom({ kind: 'test-run', path }, root);
      expect(r.ok, JSON.stringify(r)).toBe(true);
    });

    it('red: a dependent with tests must be covered, as tool:test-affected runs it', async () => {
      const path = report([pkgTest('a')], Date.now() + 5_000);
      const r = await validateAtom({ kind: 'test-run', path }, root);
      expect(!r.ok && r.reason, JSON.stringify(r)).toMatch(
        /covers no test file of @x\/c \(depends on a changed package\)/,
      );
    });

    it('green: covering the changed package and its tested dependent; the untested one is recorded', async () => {
      const path = report([pkgTest('a'), pkgTest('c')], Date.now() + 5_000);
      const r = await validateAtom({ kind: 'test-run', path }, root);
      expect(r.ok && r.atom, JSON.stringify(r)).toMatchObject({
        testFiles: ['packages/a/src/a.test.ts', 'packages/c/src/c.test.ts'],
        untestedPackages: ['@x/d'],
      });
    });

    it('a changed package with no test file is recorded untested, not required', async () => {
      writeFileSync(join(root, 'packages', 'd', 'src', 'index.ts'), 'export const z = 1;\n');
      git(root, ['commit', '-q', '-am', 'T1: change d too']);
      const path = report([pkgTest('a'), pkgTest('c')], Date.now() + 5_000);
      const r = await validateAtom({ kind: 'test-run', path }, root);
      expect(r.ok && r.atom, JSON.stringify(r)).toMatchObject({ untestedPackages: ['@x/d'] });
    });

    describe('a workspace-wide change needs tool:test (T12965 review)', () => {
      beforeEach(() => {
        writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
        git(root, ['add', '.']);
        git(root, ['commit', '-q', '-m', 'T1: lockfile']);
      });

      it('refuses a targeted report', async () => {
        const path = report([pkgTest('a')], Date.now() + 5_000);
        const r = await validateAtom({ kind: 'test-run', path }, root);
        expect(!r.ok && r.codeName).toBe('E_EVIDENCE_INSUFFICIENT');
        expect(!r.ok && r.reason, JSON.stringify(r)).toMatch(
          /workspace-wide.*pnpm-lock\.yaml.*cannot show that it ran the whole suite.*Record tool:test/,
        );
      });

      it('refuses a report with one test file per package: that is not a full suite', async () => {
        const path = report([pkgTest('a'), pkgTest('b'), pkgTest('c')], Date.now() + 5_000);
        const r = await validateAtom({ kind: 'test-run', path }, root);
        expect(!r.ok && r.reason, JSON.stringify(r)).toMatch(/workspace-wide.*Record tool:test/);
      });
    });
  });
});
