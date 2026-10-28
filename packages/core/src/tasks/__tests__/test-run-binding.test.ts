/**
 * Targeted `test-run:` evidence is bound to the code it ran on (T12965):
 * verify records HEAD, the tracked tree hash and the covered test files, and
 * a moved tree no longer stands unless merged CI supersedes it.
 *
 * @task T12965
 */

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvidenceAtom, EvidenceValidationContext } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testRunTreeMismatchReason } from '../affected-scope.js';
import { validateAtom } from '../evidence.js';
import { reportFreshness, testRunCoversChange } from '../test-run-binding.js';
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

/** Per-file assertion statuses, keyed by test file path. */
type FileAssertions = Record<string, string[]>;

/**
 * A report in vitest's JSON shape: a file's `status` is `passed` even when a
 * `-t` filter skipped every test in it — only `assertionResults` say what ran.
 */
function reportOf(files: FileAssertions, startTime?: number): string {
  mkdirSync(join(root, 'reports'), { recursive: true });
  const path = join(root, 'reports', 'vitest.json');
  const statuses = Object.values(files).flat();
  const count = (status: string): number => statuses.filter((s) => s === status).length;
  writeFileSync(
    path,
    JSON.stringify({
      ...(startTime !== undefined ? { startTime } : {}),
      numTotalTests: statuses.length,
      numPassedTests: count('passed'),
      numFailedTests: count('failed'),
      // As vitest/jest count them: skipped and pending are pending, todo is its
      // own bucket, so the counts add up to the total (T13136 checks that).
      numPendingTests: count('skipped') + count('pending'),
      numTodoTests: count('todo'),
      testResults: Object.entries(files).map(([name, assertions]) => ({
        name,
        status: 'passed',
        assertionResults: assertions.map((status, i) => ({ fullName: `t${i}`, status })),
      })),
    }),
  );
  return path;
}

/** A report in which every listed file ran one passing test. */
function report(files: string[], startTime?: number): string {
  return reportOf(Object.fromEntries(files.map((f) => [f, ['passed']])), startTime);
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

describe('a report must show tests that passed (T12965 review N1)', () => {
  it('refuses a report whose every test was skipped or filtered out', async () => {
    const path = reportOf({ [join(root, 'src', 'a.test.ts')]: ['skipped', 'skipped'] });
    const r = await validateAtom({ kind: 'test-run', path }, root);
    expect(!r.ok && r.codeName, JSON.stringify(r)).toBe('E_EVIDENCE_TESTS_FAILED');
    expect(!r.ok && r.reason).toMatch(/no passed tests/);
  });

  it('jest marks a skipped test pending; only passed files are recorded', async () => {
    const path = reportOf({
      [join(root, 'src', 'a.test.ts')]: ['passed'],
      [join(root, 'src', 'b.test.ts')]: ['pending'],
    });
    const r = await validateAtom({ kind: 'test-run', path }, root);
    expect(r.ok && r.atom, JSON.stringify(r)).toMatchObject({ testFiles: ['src/a.test.ts'] });
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

  describe('main moving on after a run on the default branch (T13784)', () => {
    /** Run at t0+10s on main; then main gains an unrelated commit at t0+20s (a pull). */
    function pullAfterRun(landOnOrigin: boolean) {
      const t0 = Date.now();
      const before = git(root, ['rev-parse', 'HEAD']);
      git(root, ['update-ref', 'refs/remotes/origin/main', before]);
      const path = report([join(root, 'src', 'a.test.ts')], t0 + 10_000);
      mkdirSync(join(root, 'tooling'), { recursive: true });
      writeFileSync(join(root, 'tooling', 'print-bridge.mjs'), 'export {};\n');
      touch(join(root, 'tooling', 'print-bridge.mjs'), t0 + 15_000);
      git(root, ['add', '.']);
      commitAt(root, 'print-bridge: unrelated', t0 + 20_000);
      const after = git(root, ['rev-parse', 'HEAD']);
      if (landOnOrigin) git(root, ['update-ref', 'refs/remotes/origin/main', after]);
      return { path, before, after };
    }

    it('green: a landed commit after the run does not stale it; HEAD as of the run is recorded', async () => {
      const { path, before, after } = pullAfterRun(true);
      const r = await validateAtom({ kind: 'test-run', path }, root);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.ok && r.atom).toMatchObject({ headSha: after, runHeadSha: before });
    });

    it('red: a commit after the run that is not on origin is the change, and stales it', async () => {
      const { path } = pullAfterRun(false);
      const r = await validateAtom({ kind: 'test-run', path }, root);
      expect(!r.ok && r.codeName, JSON.stringify(r)).toBe('E_EVIDENCE_STALE');
    });

    it('red: a qa-run receipt keeps the strict rule (test-run only)', () => {
      const { path } = pullAfterRun(true);
      expect(reportFreshness(undefined, path, root, 'qa-run')).toMatchObject({
        ok: false,
        codeName: 'E_EVIDENCE_STALE',
      });
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

    it('red (review of #1823): a change cannot exclude its own code from scope', async () => {
      // review-p0's probe: the change itself declares packages/a and .cleo out
      // of scope, then binds a report that covers only packages/b.
      mkdirSync(join(root, '.cleo'), { recursive: true });
      writeFileSync(
        join(root, '.cleo', 'project-context.json'),
        JSON.stringify({ evidence: { scopeExcludes: ['packages/a/**', '.cleo/**'] } }),
      );
      git(root, ['add', '-f', '.cleo/project-context.json']);
      git(root, ['commit', '-q', '-m', 'T1: exclude my own change']);
      const path = report([pkgTest('b')], Date.now() + 5_000);
      const r = await validateAtom({ kind: 'test-run', path }, root);
      expect(r.ok, JSON.stringify(r)).toBe(false);
    });

    it('red (T13135): a change whose every path is excluded does not pass vacuously', async () => {
      git(root, ['switch', '-q', '-c', 'task/T2', 'main']);
      mkdirSync(join(root, '.claude'), { recursive: true });
      writeFileSync(join(root, '.claude', 'settings.local.json'), '{"hooks":{}}\n');
      git(root, ['add', '-f', '.claude/settings.local.json']);
      git(root, ['commit', '-q', '-m', 'T2: hook settings only']);
      const path = report([pkgTest('b')], Date.now() + 5_000);
      const r = await validateAtom({ kind: 'test-run', path }, root);
      expect(!r.ok && r.reason, JSON.stringify(r)).toMatch(
        /Every path this change touches is excluded from evidence scope \(\.claude\/settings\.local\.json\).*tool:test, or ci:<pr>/,
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

    it('red (N1): a file whose every test a -t filter skipped covers nothing', async () => {
      writeFileSync(join(root, 'packages', 'b', 'src', 'index.ts'), 'export const y = 1;\n');
      git(root, ['commit', '-q', '-am', 'T1: change b too']);
      // `vitest run -t alpha` over a, b and c: b's only test is filtered out.
      const path = reportOf(
        { [pkgTest('a')]: ['passed'], [pkgTest('b')]: ['skipped'], [pkgTest('c')]: ['passed'] },
        Date.now() + 5_000,
      );
      const r = await validateAtom({ kind: 'test-run', path }, root);
      expect(!r.ok && r.reason, JSON.stringify(r)).toMatch(
        /covers no test file of @x\/b \(changed\)/,
      );
    });

    it('green (N1): one passed test in the file is enough', async () => {
      writeFileSync(join(root, 'packages', 'b', 'src', 'index.ts'), 'export const y = 1;\n');
      git(root, ['commit', '-q', '-am', 'T1: change b too']);
      const path = reportOf(
        {
          [pkgTest('a')]: ['passed'],
          [pkgTest('b')]: ['skipped', 'passed'],
          [pkgTest('c')]: ['passed', 'todo'],
        },
        Date.now() + 5_000,
      );
      const r = await validateAtom({ kind: 'test-run', path }, root);
      expect(r.ok && r.atom, JSON.stringify(r)).toMatchObject({
        testFiles: [
          'packages/a/src/a.test.ts',
          'packages/b/src/b.test.ts',
          'packages/c/src/c.test.ts',
        ],
      });
    });

    it('a changed package with no test file is recorded untested, not required', async () => {
      writeFileSync(join(root, 'packages', 'd', 'src', 'index.ts'), 'export const z = 1;\n');
      git(root, ['commit', '-q', '-am', 'T1: change d too']);
      const path = report([pkgTest('a'), pkgTest('c')], Date.now() + 5_000);
      const r = await validateAtom({ kind: 'test-run', path }, root);
      expect(r.ok && r.atom, JSON.stringify(r)).toMatchObject({ untestedPackages: ['@x/d'] });
    });

    describe('a change outside every package, in a directory with tests (T13754)', () => {
      const tool = (f: string): string => join(root, 'tooling', 'bridge', f);
      beforeEach(() => {
        // The tool and its tests are on main; the task branch edits the tool
        // and one of its tests (VidaPeps T2063: tooling/print-bridge/*).
        git(root, ['switch', '-q', 'main']);
        mkdirSync(join(root, 'tooling', 'bridge'), { recursive: true });
        writeFileSync(tool('bridge.mjs'), 'export const b = 1;\n');
        writeFileSync(tool('bridge.test.mjs'), 'export {};\n');
        writeFileSync(tool('queue.test.mjs'), 'export {};\n');
        git(root, ['add', '.']);
        git(root, ['commit', '-q', '-m', 'tooling']);
        git(root, ['push', '-q', 'origin', 'main']);
        git(root, ['switch', '-q', '-c', 'task/T3']);
        writeFileSync(tool('bridge.mjs'), 'export const b = 2;\n');
        writeFileSync(tool('bridge.test.mjs'), 'export const t = 2;\n');
        git(root, ['commit', '-q', '-am', 'T3: change the bridge']);
      });

      it('green: a report passing every test file of the directory stands', async () => {
        const path = report([tool('bridge.test.mjs'), tool('queue.test.mjs')], Date.now() + 5_000);
        const r = await validateAtom({ kind: 'test-run', path }, root);
        expect(r.ok, JSON.stringify(r)).toBe(true);
      });

      it('red: running only the edited test file leaves the directory uncovered', async () => {
        const path = report([tool('bridge.test.mjs')], Date.now() + 5_000);
        const r = await validateAtom({ kind: 'test-run', path }, root);
        expect(!r.ok && r.reason, JSON.stringify(r)).toMatch(
          /does not run tooling\/bridge\/queue\.test\.mjs.*outside every workspace package/,
        );
      });

      it('red: a mixed change must also cover the changed package', async () => {
        writeFileSync(join(root, 'packages', 'a', 'src', 'index.ts'), 'export const x = 2;\n');
        git(root, ['commit', '-q', '-am', 'T3: change a too']);
        const tooling = [tool('bridge.test.mjs'), tool('queue.test.mjs')];
        const short = await validateAtom(
          { kind: 'test-run', path: report(tooling, Date.now() + 5_000) },
          root,
        );
        expect(!short.ok && short.reason).toMatch(/covers no test file of @x\/a \(changed\)/);
        const full = await validateAtom(
          {
            kind: 'test-run',
            path: report([...tooling, pkgTest('a'), pkgTest('c')], Date.now() + 5_000),
          },
          root,
        );
        expect(full.ok, JSON.stringify(full)).toBe(true);
      });

      it('red (review of #2283): a sibling test beside a shared module does not skip its consumers', async () => {
        // bridge.test.mjs imports ../shared/util.mjs; a trivial util.test.mjs
        // added beside it must not narrow the owed run to tooling/shared.
        mkdirSync(join(root, 'tooling', 'shared'), { recursive: true });
        writeFileSync(join(root, 'tooling', 'shared', 'util.mjs'), 'export const u = 1;\n');
        writeFileSync(tool('bridge.test.mjs'), "import '../shared/util.mjs';\n");
        git(root, ['add', '.']);
        git(root, ['commit', '-q', '-m', 'T3: shared util']);
        writeFileSync(join(root, 'tooling', 'shared', 'util.mjs'), 'export const u = 2;\n');
        writeFileSync(join(root, 'tooling', 'shared', 'util.test.mjs'), 'export {};\n');
        git(root, ['add', '.']);
        git(root, ['commit', '-q', '-m', 'T3: change util, add a trivial test']);
        const changed = ['tooling/shared/util.mjs', 'tooling/shared/util.test.mjs'];
        const narrow = testRunCoversChange(root, changed, ['tooling/shared/util.test.mjs']);
        expect(!narrow.ok && narrow.reason, JSON.stringify(narrow)).toMatch(
          /does not run tooling\/bridge\/bridge\.test\.mjs/,
        );
        const whole = testRunCoversChange(root, changed, [
          'tooling/bridge/bridge.test.mjs',
          'tooling/bridge/queue.test.mjs',
          'tooling/shared/util.test.mjs',
        ]);
        expect(whole.ok, JSON.stringify(whole)).toBe(true);
      });

      it('the post-merge stand-in rule judges the same coverage', () => {
        const changed = ['tooling/bridge/bridge.mjs', 'tooling/bridge/bridge.test.mjs'];
        expect(
          testRunCoversChange(root, changed, [
            'tooling/bridge/bridge.test.mjs',
            'tooling/bridge/queue.test.mjs',
          ]).ok,
        ).toBe(true);
        expect(testRunCoversChange(root, changed, ['tooling/bridge/bridge.test.mjs']).ok).toBe(
          false,
        );
        expect(
          testRunCoversChange(
            root,
            ['pnpm-lock.yaml', ...changed],
            ['tooling/bridge/bridge.test.mjs', 'tooling/bridge/queue.test.mjs'],
          ).ok,
        ).toBe(false);
      });
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

describe('relevance in a standalone single-package project (T13403)', () => {
  const file = (rel: string): string => join(root, rel);

  beforeEach(() => {
    // No pnpm-workspace.yaml and no package.json#workspaces: one package.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'solo', scripts: { test: 'vitest run' } }),
    );
    writeFileSync(file('src/a.test.ts'), 'export {};\n');
    writeFileSync(file('src/b.test.ts'), 'export {};\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'solo']);
    const origin = `${root}-origin.git`;
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    git(root, ['remote', 'add', 'origin', origin]);
    git(root, ['push', '-q', '-u', 'origin', 'main']);
    git(root, ['remote', 'set-head', 'origin', 'main']);
    git(root, ['switch', '-q', '-c', 'task/T1']);
    writeFileSync(file('src/a.ts'), 'export const a = 2;\n');
    writeFileSync(file('src/a.test.ts'), 'export const t = 1;\n');
    git(root, ['commit', '-q', '-am', 'T1: change a and its test']);
  });
  afterEach(() => rmSync(`${root}-origin.git`, { recursive: true, force: true }));

  it('green: a targeted report that runs the changed test file stands', async () => {
    const path = report([file('src/a.test.ts')], Date.now() + 5_000);
    const r = await validateAtom({ kind: 'test-run', path }, root);
    expect(r.ok && r.atom, JSON.stringify(r)).toMatchObject({ testFiles: ['src/a.test.ts'] });
    expect(r.ok && r.atom.kind === 'test-run' && r.atom.untestedPackages).toBeFalsy();
  });

  it('a checkout after the run that rewrites a file with the same bytes keeps the report (T13567, T13569)', async () => {
    // A side branch with the same content, made before the run.
    git(root, ['switch', '-q', '-c', 'side']);
    git(root, ['commit', '-q', '--allow-empty', '-m', 'same content']);
    git(root, ['switch', '-q', 'task/T1']);
    const ranAt = Date.now() + 5_000;
    const path = report([file('src/a.test.ts')], ranAt);
    const afterRun = { GIT_COMMITTER_DATE: `@${Math.floor((ranAt + 20_000) / 1000)} +0000` };

    // A bare touch with the same bytes is indistinguishable from a revert of an
    // edit made during the run, so it still stales (T13569).
    touch(file('src/a.ts'), ranAt + 30_000);
    const touched = await validateAtom({ kind: 'test-run', path }, root);
    expect(!touched.ok && touched.codeName, JSON.stringify(touched)).toBe('E_EVIDENCE_STALE');

    // HEAD moves after the run (a checkout or merge) and the file equals its
    // blob at both HEADs: the receipt stands.
    git(root, ['switch', '-q', 'side'], afterRun);
    writeFileSync(file('src/a.ts'), 'export const a = 2;\n');
    touch(file('src/a.ts'), ranAt + 30_000);
    const kept = await validateAtom({ kind: 'test-run', path }, root);
    expect(kept.ok, JSON.stringify(kept)).toBe(true);

    writeFileSync(file('src/a.ts'), 'export const a = 3;\n');
    touch(file('src/a.ts'), ranAt + 30_000);
    const edited = await validateAtom({ kind: 'test-run', path }, root);
    expect(!edited.ok && edited.codeName, JSON.stringify(edited)).toBe('E_EVIDENCE_STALE');
    expect(!edited.ok && edited.reason).toMatch(/src\/a\.ts was modified/);
  });

  it('a checkout after the run to different content of the file stales the report (T13569)', async () => {
    git(root, ['switch', '-q', '-c', 'other']);
    writeFileSync(file('src/a.ts'), 'export const a = 7;\n');
    git(root, ['commit', '-q', '-am', 'different a']);
    git(root, ['switch', '-q', 'task/T1']);
    const ranAt = Date.now() + 5_000;
    const path = report([file('src/a.test.ts')], ranAt);
    git(root, ['switch', '-q', 'other'], {
      GIT_COMMITTER_DATE: `@${Math.floor((ranAt + 20_000) / 1000)} +0000`,
    });
    touch(file('src/a.ts'), ranAt + 30_000);
    const moved = await validateAtom({ kind: 'test-run', path }, root);
    expect(!moved.ok && moved.codeName, JSON.stringify(moved)).toBe('E_EVIDENCE_STALE');
  });

  it('a file edited during the run and reverted afterwards still stales (T13569)', async () => {
    writeFileSync(file('src/a.ts'), 'export const a = 99;\n');
    const ranAt = Date.now() + 5_000;
    const path = report([file('src/a.test.ts')], ranAt);
    writeFileSync(file('src/a.ts'), 'export const a = 2;\n');
    touch(file('src/a.ts'), ranAt + 30_000);
    const reverted = await validateAtom({ kind: 'test-run', path }, root);
    expect(!reverted.ok && reverted.codeName, JSON.stringify(reverted)).toBe('E_EVIDENCE_STALE');
  });

  it('a report produced in an older worktree is judged against that worktree reflog (T13579)', () => {
    const old = `${root}-old`;
    const fresh = `${root}-fresh`;
    try {
      git(root, ['worktree', 'add', '-q', '--detach', old, 'HEAD']);
      const ranAt = Date.now() + 5_000;
      mkdirSync(join(old, 'reports'), { recursive: true });
      const path = join(old, 'reports', 'vitest.json');
      writeFileSync(path, '{}');
      const at = (ms: number) => {
        const date = `@${Math.floor(ms / 1000)} +0000`;
        return { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date };
      };
      // After the run: the implementing commit records what was on disk, and
      // a new worktree is made from it, whose reflog starts after the run.
      git(old, ['commit', '-q', '--allow-empty', '-m', 'T1: implement'], at(ranAt + 20_000));
      const implemented = git(old, ['rev-parse', 'HEAD']);
      git(root, ['worktree', 'add', '-q', '--detach', fresh, implemented], at(ranAt + 30_000));
      expect(reportFreshness(ranAt, path, fresh, 'test-run')).toMatchObject({ ok: true });
    } finally {
      rmSync(old, { recursive: true, force: true });
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('red: an unrelated report (another test file of the package) is refused', async () => {
    const path = report([file('src/b.test.ts')], Date.now() + 5_000);
    const r = await validateAtom({ kind: 'test-run', path }, root);
    expect(!r.ok && r.codeName, JSON.stringify(r)).toBe('E_EVIDENCE_INSUFFICIENT');
    expect(!r.ok && r.reason).toMatch(
      /does not run the changed test file\(s\) src\/a\.test\.ts.*single-package project/,
    );
  });

  it('red: a partial report missing one of two changed test files is refused', async () => {
    writeFileSync(file('src/c.test.ts'), 'export {};\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'T1: add c test']);
    const path = report([file('src/a.test.ts'), file('src/b.test.ts')], Date.now() + 5_000);
    const r = await validateAtom({ kind: 'test-run', path }, root);
    expect(!r.ok && r.reason, JSON.stringify(r)).toMatch(
      /does not run the changed test file\(s\) src\/c\.test\.ts\./,
    );
  });

  it('red: a changed test file whose every test a -t filter skipped is not run', async () => {
    const path = reportOf(
      { [file('src/a.test.ts')]: ['skipped'], [file('src/b.test.ts')]: ['passed'] },
      Date.now() + 5_000,
    );
    const r = await validateAtom({ kind: 'test-run', path }, root);
    expect(!r.ok && r.reason, JSON.stringify(r)).toMatch(/does not run the changed test file/);
  });

  it('red: a report older than the change is still refused as stale', async () => {
    const path = report([file('src/a.test.ts')], Date.now() - 60_000);
    touch(file('src/a.test.ts'), Date.now());
    const r = await validateAtom({ kind: 'test-run', path }, root);
    expect(!r.ok && r.codeName, JSON.stringify(r)).toBe('E_EVIDENCE_STALE');
  });

  it('red: once a workspace is declared, root paths are workspace-wide again (no fallback)', async () => {
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'T1: declare a workspace']);
    const path = report([file('src/a.test.ts')], Date.now() + 5_000);
    const r = await validateAtom({ kind: 'test-run', path }, root);
    expect(!r.ok && r.reason, JSON.stringify(r)).toMatch(/workspace-wide.*Record tool:test/);
  });

  it('a source-only change needs a test file of the package, as a workspace package does', async () => {
    git(root, ['switch', '-q', '-c', 'task/T2', 'main']);
    writeFileSync(file('src/a.ts'), 'export const a = 3;\n');
    git(root, ['commit', '-q', '-am', 'T2: change a only']);
    const ok = await validateAtom(
      { kind: 'test-run', path: report([file('src/b.test.ts')], Date.now() + 5_000) },
      root,
    );
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    const none = await validateAtom(
      { kind: 'test-run', path: report(['/elsewhere/x.test.ts'], Date.now() + 5_000) },
      root,
    );
    expect(!none.ok && none.reason, JSON.stringify(none)).toMatch(
      /covers no test file of solo \(changed\)/,
    );
  });
});

/**
 * A real Playwright 1.59 JSON report (`fixtures/playwright-json`), re-rooted at
 * this checkout's `e2e/` and stamped as run at `startTime`.
 */
function playwrightReport(name: string, startTime: number, edit?: (r: PwReport) => void): string {
  const fixture = fileURLToPath(
    new URL(`./fixtures/playwright-json/${name}.json`, import.meta.url),
  );
  const parsed: PwReport = JSON.parse(readFileSync(fixture, 'utf-8'));
  parsed.config.rootDir = join(root, 'e2e');
  parsed.stats.startTime = new Date(startTime).toISOString();
  edit?.(parsed);
  mkdirSync(join(root, 'reports'), { recursive: true });
  const path = join(root, 'reports', `playwright-${name}.json`);
  writeFileSync(path, JSON.stringify(parsed));
  return path;
}

/** The fields of a Playwright JSON report these tests rewrite. */
interface PwReport {
  config: { rootDir: string };
  stats: { startTime: string; expected: number };
}

/**
 * EscapePlan T732: a change adding an e2e spec could never prove testsPassed,
 * because only vitest/jest reports were read (T14031).
 */
describe('Playwright JSON reports are test-run evidence (T14031)', () => {
  it('AC1: files from suites[].file, counts from spec results, time from stats.startTime', async () => {
    const r = await validateAtom(
      { kind: 'test-run', path: playwrightReport('pass', Date.now() + 5_000) },
      root,
    );
    expect(r.ok && r.atom, JSON.stringify(r)).toMatchObject({
      testFiles: ['e2e/density.spec.mjs', 'e2e/venue.spec.mjs'],
      passCount: 3,
      failCount: 0,
      skipCount: 1,
    });
  });

  it('AC1: a run that started before the change is stale by stats.startTime', async () => {
    const r = await validateAtom(
      { kind: 'test-run', path: playwrightReport('pass', Date.now() - 60_000) },
      root,
    );
    expect(!r.ok && r.codeName, JSON.stringify(r)).toBe('E_EVIDENCE_STALE');
  });

  it('AC2: a failing run is refused', async () => {
    const r = await validateAtom(
      { kind: 'test-run', path: playwrightReport('fail', Date.now() + 5_000) },
      root,
    );
    expect(!r.ok && r.codeName, JSON.stringify(r)).toBe('E_EVIDENCE_TESTS_FAILED');
    expect(!r.ok && r.reason).toMatch(/numFailedTests = 1/);
  });

  it('AC2: a skipped-only run is refused', async () => {
    const r = await validateAtom(
      { kind: 'test-run', path: playwrightReport('skipped', Date.now() + 5_000) },
      root,
    );
    expect(!r.ok && r.reason, JSON.stringify(r)).toMatch(/no passed tests/);
  });

  it('AC2: a vacuous run (no tests found) is refused', async () => {
    const r = await validateAtom(
      { kind: 'test-run', path: playwrightReport('none', Date.now() + 5_000) },
      root,
    );
    expect(!r.ok && r.codeName, JSON.stringify(r)).toBe('E_EVIDENCE_TESTS_FAILED');
    expect(!r.ok && r.reason).toMatch(/No tests found/);
  });

  it('AC2: stats that disagree with the spec results are refused', async () => {
    const path = playwrightReport('pass', Date.now() + 5_000, (r) => {
      r.stats.expected = 9;
    });
    const r = await validateAtom({ kind: 'test-run', path }, root);
    expect(!r.ok && r.codeName, JSON.stringify(r)).toBe('E_EVIDENCE_INVALID');
    expect(!r.ok && r.reason).toMatch(/stats\.expected is 9, but its spec results count 3/);
  });

  it('a test that passed on retry (flaky) counts as passed', async () => {
    const r = await validateAtom(
      { kind: 'test-run', path: playwrightReport('flaky', Date.now() + 5_000) },
      root,
    );
    expect(r.ok && r.atom, JSON.stringify(r)).toMatchObject({ passCount: 2, failCount: 0 });
  });

  describe('AC3: a vitest and a Playwright report of one write cover the change together', () => {
    const file = (rel: string): string => join(root, rel);
    const context = (paths: string[]): EvidenceValidationContext => ({
      task: {
        id: 'T1',
        kind: 'work',
        labels: [],
        files: [],
        acceptance: ['unit and e2e tests pass'],
        verification: undefined,
      },
      gates: ['testsPassed'],
      criteria: [],
      testRunPaths: paths,
    });

    beforeEach(() => {
      writeFileSync(join(root, '.gitignore'), 'reports/\n.cleo/\n');
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'solo', scripts: { test: 'vitest run' } }),
      );
      writeFileSync(file('src/a.test.ts'), 'export {};\n');
      git(root, ['add', '.']);
      git(root, ['commit', '-q', '-m', 'solo']);
      const origin = `${root}-origin.git`;
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
      git(root, ['remote', 'add', 'origin', origin]);
      git(root, ['push', '-q', '-u', 'origin', 'main']);
      git(root, ['remote', 'set-head', 'origin', 'main']);
      git(root, ['switch', '-q', '-c', 'task/T1']);
      writeFileSync(file('src/a.ts'), 'export const a = 2;\n');
      writeFileSync(file('src/a.test.ts'), 'export const t = 1;\n');
      mkdirSync(file('e2e'), { recursive: true });
      writeFileSync(file('e2e/density.spec.mjs'), 'export {};\n');
      git(root, ['add', '.']);
      git(root, ['commit', '-q', '-m', 'T1: change a, its test and an e2e spec']);
    });
    afterEach(() => rmSync(`${root}-origin.git`, { recursive: true, force: true }));

    it('red: either report alone misses the other half of the change', async () => {
      const unit = report([file('src/a.test.ts')], Date.now() + 5_000);
      const e2e = playwrightReport('pass', Date.now() + 5_000);
      const alone = await validateAtom({ kind: 'test-run', path: unit }, root);
      expect(!alone.ok && alone.reason, JSON.stringify(alone)).toMatch(
        /does not run the changed test file\(s\) e2e\/density\.spec\.mjs/,
      );
      const e2eAlone = await validateAtom({ kind: 'test-run', path: e2e }, root);
      expect(!e2eAlone.ok && e2eAlone.reason, JSON.stringify(e2eAlone)).toMatch(
        /does not run the changed test file\(s\) src\/a\.test\.ts/,
      );
    });

    it('green: together each report stands and records its own files', async () => {
      const unit = report([file('src/a.test.ts')], Date.now() + 5_000);
      const e2e = playwrightReport('pass', Date.now() + 5_000);
      const both = context([unit, e2e]);
      const u = await validateAtom(
        { kind: 'test-run', path: unit },
        root,
        undefined,
        undefined,
        both,
      );
      expect(u.ok && u.atom, JSON.stringify(u)).toMatchObject({ testFiles: ['src/a.test.ts'] });
      const e = await validateAtom(
        { kind: 'test-run', path: e2e },
        root,
        undefined,
        undefined,
        both,
      );
      expect(e.ok && e.atom, JSON.stringify(e)).toMatchObject({
        testFiles: ['e2e/density.spec.mjs', 'e2e/venue.spec.mjs'],
      });
    });
  });
});

/**
 * T14084: Rust and Python projects had no test-run route (21 audited owner
 * overrides): cargo nextest and pytest write JUnit XML, cargo test writes
 * libtest JSON lines.
 */
describe('JUnit XML and libtest JSON reports are test-run evidence (T14084)', () => {
  function write(name: string, text: string): string {
    mkdirSync(join(root, 'reports'), { recursive: true });
    const path = join(root, 'reports', name);
    writeFileSync(path, text);
    return path;
  }

  const stamp = (): string => new Date(Date.now() + 5_000).toISOString();

  /** A pytest-style JUnit report: one suite, testcases with `file` attributes. */
  function junit(cases: string, totals = 'tests="3" failures="0" errors="0" skipped="1"'): string {
    return write(
      'junit.xml',
      `<?xml version="1.0" encoding="utf-8"?>\n<testsuites><testsuite name="pytest" ${totals} timestamp="${stamp()}">\n${cases}\n</testsuite></testsuites>\n`,
    );
  }

  const passing =
    '<testcase classname="tests.test_a" name="test_one" file="tests/test_a.py" time="0.01"/>\n' +
    '<testcase classname="tests.test_a" name="test_two" file="tests/test_a.py" time="0.01"></testcase>\n' +
    '<testcase classname="tests.test_b" name="test_skip" file="tests/test_b.py"><skipped message="later"/></testcase>';

  it('a passing JUnit report binds like a vitest report: HEAD, tree and covered files', async () => {
    const r = await validateAtom({ kind: 'test-run', path: junit(passing) }, root);
    expect(r.ok && r.atom, JSON.stringify(r)).toMatchObject({
      kind: 'test-run',
      passCount: 2,
      failCount: 0,
      skipCount: 1,
      headSha: git(root, ['rev-parse', 'HEAD']),
      treeHash: git(root, ['rev-parse', 'HEAD^{tree}']),
      testFiles: ['tests/test_a.py'],
    });
  });

  it('a JUnit report with a failure or an error is refused', async () => {
    const failing = passing.replace(
      '<skipped message="later"/>',
      '<failure message="assert 1 == 2">trace &lt;here&gt;</failure>',
    );
    const r = await validateAtom(
      {
        kind: 'test-run',
        path: junit(failing, 'tests="3" failures="1" errors="0" skipped="0"'),
      },
      root,
    );
    expect(!r.ok && r.codeName, JSON.stringify(r)).toBe('E_EVIDENCE_TESTS_FAILED');
  });

  it('JUnit totals that disagree with the testcases are refused', async () => {
    const r = await validateAtom(
      { kind: 'test-run', path: junit(passing, 'tests="9" failures="0" errors="0" skipped="1"') },
      root,
    );
    expect(!r.ok && r.codeName, JSON.stringify(r)).toBe('E_EVIDENCE_INVALID');
    expect(!r.ok && r.reason).toMatch(/states 9 tests .* but its testcases count 3/);
  });

  /** cargo test / nextest libtest JSON lines. */
  function libtest(events: object[]): string {
    return write('libtest.json', `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  }

  it('passing libtest JSON lines bind, grouped by binary', async () => {
    const r = await validateAtom(
      {
        kind: 'test-run',
        path: libtest([
          { type: 'suite', event: 'started', test_count: 3 },
          { type: 'test', event: 'started', name: 'parser::tests::reads' },
          { type: 'test', event: 'ok', name: 'parser::tests::reads' },
          { type: 'test', event: 'ok', name: 'parser::tests::writes' },
          { type: 'test', event: 'ignored', name: 'parser::tests::slow' },
          { type: 'suite', event: 'ok', passed: 2, failed: 0, ignored: 1, measured: 0 },
        ]),
      },
      root,
    );
    expect(r.ok && r.atom, JSON.stringify(r)).toMatchObject({
      kind: 'test-run',
      passCount: 2,
      failCount: 0,
      skipCount: 1,
      headSha: git(root, ['rev-parse', 'HEAD']),
    });
  });

  it('a failed libtest test, or a summary that disagrees with the events, is refused', async () => {
    const failed = await validateAtom(
      {
        kind: 'test-run',
        path: libtest([
          { type: 'test', event: 'ok', name: 'a::one' },
          { type: 'test', event: 'failed', name: 'a::two', stdout: 'panicked' },
          { type: 'suite', event: 'failed', passed: 1, failed: 1, ignored: 0 },
        ]),
      },
      root,
    );
    expect(!failed.ok && failed.codeName, JSON.stringify(failed)).toBe('E_EVIDENCE_TESTS_FAILED');
    const lying = await validateAtom(
      {
        kind: 'test-run',
        path: libtest([
          { type: 'test', event: 'ok', name: 'a::one' },
          { type: 'suite', event: 'ok', passed: 5, failed: 0, ignored: 0 },
        ]),
      },
      root,
    );
    expect(!lying.ok && lying.codeName, JSON.stringify(lying)).toBe('E_EVIDENCE_INVALID');
    expect(!lying.ok && lying.reason).toMatch(/summary states 5 passed/);
  });

  /** A JUnit fixture with its timestamps moved to just after the change. */
  function fixture(name: string): string {
    const text = readFileSync(
      fileURLToPath(new URL(`./fixtures/junit/${name}.xml`, import.meta.url)),
      'utf-8',
    ).replace(/timestamp="[^"]*"/g, `timestamp="${stamp()}"`);
    return write(`${name}.xml`, text);
  }

  it("pytest's <testsuites> wrapper: counts and files from each testcase", async () => {
    const r = await validateAtom({ kind: 'test-run', path: fixture('pytest') }, root);
    expect(r.ok && r.atom, JSON.stringify(r)).toMatchObject({
      passCount: 3,
      failCount: 0,
      skipCount: 1,
      testFiles: ['tests/test_parser.py', 'tests/test_writer.py'],
    });
  });

  it("nextest's one suite per binary: every suite's tests are counted", async () => {
    const r = await validateAtom({ kind: 'test-run', path: fixture('nextest') }, root);
    expect(r.ok && r.atom, JSON.stringify(r)).toMatchObject({
      passCount: 3,
      failCount: 0,
      skipCount: 0,
    });
  });

  it('nested <testsuite> elements are refused with the reason, never undercounted', async () => {
    const r = await validateAtom({ kind: 'test-run', path: fixture('nested') }, root);
    expect(!r.ok && r.codeName, JSON.stringify(r)).toBe('E_EVIDENCE_INVALID');
    expect(!r.ok && r.reason).toMatch(/nests <testsuite> elements/);
  });

  it('text that is none of the formats is refused by name', async () => {
    const r = await validateAtom({ kind: 'test-run', path: write('junk.txt', 'ok 1\n') }, root);
    expect(!r.ok && r.reason, JSON.stringify(r)).toMatch(
      /not valid JSON, JUnit XML or libtest JSON lines/,
    );
  });
});
