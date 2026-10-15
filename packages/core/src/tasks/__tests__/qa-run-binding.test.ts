/**
 * `qa-run:` receipts bind a native typecheck or lint run to the change it
 * checks (T13427, owner decision option 1 of `t13427-qa-run-binding-design`):
 * exit 0 with no errors, fresh, covering every changed code path (and, in a
 * workspace, every dependent package), tree-pinned, and only as a
 * typecheck + lint pair for qaPassed.
 *
 * @task T13427
 * @task T13644
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceAtom, EvidenceValidationContext } from '@cleocode/contracts';
import { parseEvidenceString, validateEvidenceForGate } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hasTreeBoundQaRun,
  qaPassedSupersededReason,
  qaRunTreeMismatchReason,
  scopedRunStandsAfterRedCi,
} from '../affected-scope.js';
import { isLandedOnOriginDefault } from '../change-set.js';
import { checkTaskEvidenceContext, validateAtom } from '../evidence.js';
import { parseQaRunReceipt, qaRunUnionGapReason } from '../qa-run-binding.js';

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();
}

const ok = { exitCode: 0, diagnostics: { errors: 0 } };

describe('parseQaRunReceipt', () => {
  const base = { kind: 'typecheck', command: ['tsc', '--noEmit'], roots: ['src/a'], ...ok };

  it('accepts a passing receipt and normalises its roots', () => {
    const r = parseQaRunReceipt({
      ...base,
      roots: ['./src/a/', 'src/a', '.'],
      tool: { name: 'tsc', version: '5.9.3' },
      startTime: 1,
    });
    expect(r).toEqual({
      ok: true,
      receipt: {
        kind: 'typecheck',
        command: ['tsc', '--noEmit'],
        roots: ['', 'src/a'],
        startTime: 1,
        toolName: 'tsc',
        toolVersion: '5.9.3',
      },
    });
  });

  it('a failing run is E_EVIDENCE_TOOL_FAILED: non-zero exit, or any error diagnostic', () => {
    for (const bad of [
      { exitCode: 1, diagnostics: { errors: 0 } },
      { exitCode: 0, diagnostics: { errors: 2 } },
    ]) {
      const r = parseQaRunReceipt({ ...base, ...bad });
      expect(!r.ok && r.codeName).toBe('E_EVIDENCE_TOOL_FAILED');
    }
  });

  it('refuses malformed receipts as E_EVIDENCE_INVALID', () => {
    for (const bad of [
      null,
      [],
      { ...base, kind: 'test' },
      { ...base, command: [] },
      { ...base, exitCode: '0' },
      { ...base, diagnostics: {} },
      { ...base, roots: [] },
      { ...base, roots: ['../elsewhere'] },
      { ...base, roots: ['/abs/src'] },
      { ...base, startTime: 'yesterday' },
    ]) {
      const r = parseQaRunReceipt(bad);
      expect(!r.ok && r.codeName, JSON.stringify(bad)).toBe('E_EVIDENCE_INVALID');
    }
  });
});

describe('qaPassed accepts qa-run receipts as a typecheck + lint pair', () => {
  const ctx: EvidenceValidationContext = {
    task: { id: 'T1', kind: 'work', labels: [], files: [], acceptance: [] },
    gates: ['qaPassed'],
    criteria: [],
  };
  const qa = (check: 'typecheck' | 'lint'): EvidenceAtom => ({
    kind: 'qa-run',
    path: `${check}.json`,
    sha256: 'c'.repeat(64),
    check,
    command: [check],
    roots: ['src'],
  });
  const tool = (name: string, notApplicable = false): EvidenceAtom => ({
    kind: 'tool',
    tool: name,
    exitCode: 0,
    ...(notApplicable ? { notApplicable } : {}),
  });

  it('the gate minimum accepts qa-run; the parser reads it', () => {
    const atoms = parseEvidenceString('qa-run:/tmp/t.json;qa-run:/tmp/l.json');
    expect(atoms).toEqual([
      { kind: 'qa-run', path: '/tmp/t.json' },
      { kind: 'qa-run', path: '/tmp/l.json' },
    ]);
    expect(validateEvidenceForGate('qaPassed', atoms)).toMatchObject({ ok: true });
  });

  it('green: both receipts, or one receipt plus the other check as tool: (an alias, or not applicable)', () => {
    expect(checkTaskEvidenceContext(ctx, 'qaPassed', [qa('typecheck'), qa('lint')])).toBeNull();
    expect(
      checkTaskEvidenceContext(ctx, 'qaPassed', [qa('typecheck'), tool('lint', true)]),
    ).toBeNull();
    expect(checkTaskEvidenceContext(ctx, 'qaPassed', [qa('lint'), tool('tsc')])).toBeNull();
  });

  it('red: one receipt alone does not stand for qaPassed', () => {
    expect(checkTaskEvidenceContext(ctx, 'qaPassed', [qa('typecheck')])).toMatch(
      /needs a typecheck and a lint result; missing lint/,
    );
    expect(checkTaskEvidenceContext(ctx, 'qaPassed', [qa('lint'), tool('test')])).toMatch(
      /missing typecheck/,
    );
  });
});

describe('qaRunTreeMismatchReason', () => {
  const bound: EvidenceAtom = {
    kind: 'qa-run',
    path: 'r/typecheck.json',
    sha256: 'c'.repeat(64),
    check: 'typecheck',
    command: ['tsc'],
    roots: ['src'],
    treeHash: 'a'.repeat(40),
  };

  it('stands while the tree matches; refused once it moves or cannot be computed', () => {
    expect(hasTreeBoundQaRun([bound])).toBe(true);
    expect(qaRunTreeMismatchReason([bound], 'a'.repeat(40))).toBeNull();
    expect(qaRunTreeMismatchReason([bound], 'b'.repeat(40))).toMatch(
      /qaPassed rests on qa-run:r\/typecheck\.json.*no longer describes this code/,
    );
    expect(qaRunTreeMismatchReason([bound], null)).toMatch(/cannot be computed/);
  });

  it('merged CI carries the gate; an unbound receipt is not judged', () => {
    const ci = { kind: 'ci', prNumber: 1 } as EvidenceAtom;
    expect(qaRunTreeMismatchReason([bound, ci], 'b'.repeat(40))).toBeNull();
    const { treeHash: _drop, ...unbound } = bound as Extract<EvidenceAtom, { kind: 'qa-run' }>;
    expect(hasTreeBoundQaRun([unbound])).toBe(false);
    expect(qaRunTreeMismatchReason([unbound], 'b'.repeat(40))).toBeNull();
  });
});

let root: string;

/** A repo on task/T1 with an origin whose HEAD is main. */
function initRepo(setup: () => void): void {
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'T']);
  git(root, ['config', 'user.email', 't@e.x']);
  writeFileSync(join(root, '.gitignore'), 'reports/\n');
  setup();
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'init']);
  const origin = `${root}-origin.git`;
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  git(root, ['remote', 'add', 'origin', origin]);
  git(root, ['push', '-q', '-u', 'origin', 'main']);
  git(root, ['remote', 'set-head', 'origin', 'main']);
  git(root, ['switch', '-q', '-c', 'task/T1']);
}

function put(rel: string, body: string): void {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), body);
}

/** Write a receipt under the gitignored reports/ dir. */
function receipt(
  fields: Record<string, unknown>,
  startTime = Date.now() + 5_000,
  name = String(fields['kind'] ?? 'typecheck'),
): string {
  mkdirSync(join(root, 'reports'), { recursive: true });
  const path = join(root, 'reports', `${name}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      kind: 'typecheck',
      command: ['tsc', '--noEmit'],
      startTime,
      ...ok,
      ...fields,
    }),
  );
  return path;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'qa-run-binding-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(`${root}-origin.git`, { recursive: true, force: true });
});

describe('a qa-run receipt in a standalone project', () => {
  beforeEach(() => {
    initRepo(() => {
      put('package.json', JSON.stringify({ name: 'solo' }));
      put('src/a/x.ts', 'export const x = 1;\n');
      put('src/b/y.ts', 'export const y = 1;\n');
      put('src/c/z.ts', 'export const z = 1;\n');
    });
    put('src/a/x.ts', 'export const x = 2;\n');
    put('src/b/y.ts', 'export const y = 2;\n');
    git(root, ['commit', '-q', '-am', 'T1: change a and b']);
  });

  it('green: a fresh passing receipt whose roots hold every changed file binds, tree-pinned', async () => {
    const path = receipt({ roots: ['src/a', 'src/b'], tool: { name: 'tsc', version: '5.9.3' } });
    const r = await validateAtom({ kind: 'qa-run', path }, root);
    expect(r.ok && r.atom, JSON.stringify(r)).toMatchObject({
      kind: 'qa-run',
      check: 'typecheck',
      roots: ['src/a', 'src/b'],
      toolName: 'tsc',
      toolVersion: '5.9.3',
      headSha: git(root, ['rev-parse', 'HEAD']),
      treeHash: git(root, ['rev-parse', 'HEAD^{tree}']),
    });
  });

  it('green: a whole-project root covers everything', async () => {
    const r = await validateAtom({ kind: 'qa-run', path: receipt({ roots: ['.'] }) }, root);
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it('red: a receipt that misses a changed root records the gap, and the gate refuses it naming the path', async () => {
    const r = await validateAtom(
      { kind: 'qa-run', path: receipt({ roots: ['src/a', 'src/c'] }) },
      root,
    );
    expect(r.ok && r.atom, JSON.stringify(r)).toMatchObject({ uncovered: ['src/b/y.ts'] });
    if (!r.ok || r.atom.kind !== 'qa-run') throw new Error('expected a qa-run atom');
    expect(qaRunUnionGapReason([r.atom])).toMatch(
      /does not cover the changed path\(s\) src\/b\/y\.ts/,
    );
  });

  it('green: two lint receipts whose roots together cover the change satisfy lint, each fresh on its own (T13580)', async () => {
    const lintA = await validateAtom(
      { kind: 'qa-run', path: receipt({ kind: 'lint', roots: ['src/a'] }, undefined, 'lint-a') },
      root,
    );
    const lintB = await validateAtom(
      { kind: 'qa-run', path: receipt({ kind: 'lint', roots: ['src/b'] }, undefined, 'lint-b') },
      root,
    );
    const types = await validateAtom({ kind: 'qa-run', path: receipt({ roots: ['src'] }) }, root);
    if (!lintA.ok || !lintB.ok || !types.ok) throw new Error(JSON.stringify([lintA, lintB, types]));
    expect(lintA.atom).toMatchObject({ uncovered: ['src/b/y.ts'] });
    expect(lintB.atom).toMatchObject({ uncovered: ['src/a/x.ts'] });
    const ctx: EvidenceValidationContext = {
      task: { id: 'T1', kind: 'work', labels: [], files: [], acceptance: [] },
      gates: ['qaPassed'],
      criteria: [],
    };
    expect(
      checkTaskEvidenceContext(ctx, 'qaPassed', [types.atom, lintA.atom, lintB.atom]),
    ).toBeNull();
  });

  it('red: lint receipts that leave a path uncovered between them are refused, naming it (T13580)', async () => {
    const lintA = await validateAtom(
      { kind: 'qa-run', path: receipt({ kind: 'lint', roots: ['src/a'] }, undefined, 'lint-a') },
      root,
    );
    const lintC = await validateAtom(
      { kind: 'qa-run', path: receipt({ kind: 'lint', roots: ['src/c'] }, undefined, 'lint-c') },
      root,
    );
    const types = await validateAtom({ kind: 'qa-run', path: receipt({ roots: ['src'] }) }, root);
    if (!lintA.ok || !lintC.ok || !types.ok) throw new Error(JSON.stringify([lintA, lintC, types]));
    const ctx: EvidenceValidationContext = {
      task: { id: 'T1', kind: 'work', labels: [], files: [], acceptance: [] },
      gates: ['qaPassed'],
      criteria: [],
    };
    expect(checkTaskEvidenceContext(ctx, 'qaPassed', [types.atom, lintA.atom, lintC.atom])).toMatch(
      /qa-run lint receipts \(roots src\/a, src\/c\) together do not cover the changed path\(s\) src\/b\/y\.ts/,
    );
  });

  it('red: a receipt older than the change is stale', async () => {
    const path = receipt({ roots: ['src'] }, Date.now() - 60_000);
    const later = new Date();
    utimesSync(join(root, 'src/a/x.ts'), later, later);
    const r = await validateAtom({ kind: 'qa-run', path }, root);
    expect(!r.ok && r.codeName, JSON.stringify(r)).toBe('E_EVIDENCE_STALE');
  });

  it('red: a failing receipt is refused before any binding', async () => {
    const path = receipt({ roots: ['src'], exitCode: 2, diagnostics: { errors: 3 } });
    const r = await validateAtom({ kind: 'qa-run', path }, root);
    expect(!r.ok && r.codeName).toBe('E_EVIDENCE_TOOL_FAILED');
  });

  it('documentation is not code: a receipt need not cover a changed README', async () => {
    put('README.md', '# solo\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'T1: readme']);
    const r = await validateAtom({ kind: 'qa-run', path: receipt({ roots: ['src'] }) }, root);
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
});

describe('a qa-run receipt in a workspace', () => {
  beforeEach(() => {
    initRepo(() => {
      put('pnpm-workspace.yaml', 'packages:\n  - "packages/*"\n');
      put('packages/a/package.json', JSON.stringify({ name: '@x/a' }));
      put('packages/a/src/i.ts', 'export const a = 1;\n');
      put(
        'packages/b/package.json',
        JSON.stringify({ name: '@x/b', dependencies: { '@x/a': 'workspace:*' } }),
      );
      put('packages/b/src/i.ts', 'export const b = 1;\n');
    });
    put('packages/a/src/i.ts', 'export const a = 2;\n');
    git(root, ['commit', '-q', '-am', 'T1: change a']);
  });

  it('red: a dependent package must be covered too, since a type change breaks importers', async () => {
    const r = await validateAtom(
      { kind: 'qa-run', path: receipt({ roots: ['packages/a'] }) },
      root,
    );
    expect(r.ok && r.atom, JSON.stringify(r)).toMatchObject({ uncoveredPackages: ['@x/b'] });
    if (!r.ok || r.atom.kind !== 'qa-run') throw new Error('expected a qa-run atom');
    expect(qaRunUnionGapReason([r.atom])).toMatch(/does not cover package\(s\) @x\/b/);
  });

  it('green: covering the changed package and its dependent binds', async () => {
    const path = receipt({ roots: ['packages/a', 'packages/b'] });
    const r = await validateAtom({ kind: 'qa-run', path }, root);
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it('red: a workspace-wide change needs a whole-project run', async () => {
    put('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'T1: lockfile']);
    const path = receipt({ roots: ['packages/a', 'packages/b'] });
    const r = await validateAtom({ kind: 'qa-run', path }, root);
    expect(!r.ok && r.reason, JSON.stringify(r)).toMatch(/workspace-wide.*Record tool:typecheck/);
  });
});

describe('T13644: qa-run receipts recorded on main after the merge (T13224 shape)', () => {
  let merge = '';
  let branchHead = '';
  beforeEach(() => {
    initRepo(() => {
      put('package.json', JSON.stringify({ name: 'solo' }));
      put('src/a/x.ts', 'export const x = 1;\n');
    });
    put('src/a/x.ts', 'export const x = 2;\n');
    git(root, ['commit', '-q', '-am', 'T1: change a']);
    branchHead = git(root, ['rev-parse', 'HEAD']);
    git(root, ['switch', '-q', 'main']);
    git(root, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #1910', 'task/T1']);
    merge = git(root, ['rev-parse', 'HEAD']);
    // A later PR edits the same file, so byte-identity carry cannot hold.
    put('src/a/x.ts', 'export const x = 3;\n');
    git(root, ['commit', '-q', '-am', 'a later PR']);
    git(root, ['push', '-q', 'origin', 'main']);
  });

  const target = () => ({ mergeCommitSha: merge, files: ['src/a/x.ts'], executionRoot: root });
  const judge = (atoms: EvidenceAtom[]) =>
    qaPassedSupersededReason(atoms, {
      mergeState: () => ({ state: 'merged' as const, landing: { ...target(), deletedFiles: [] } }),
      currentTree: () => git(root, ['rev-parse', 'HEAD^{tree}']),
      landed: isLandedOnOriginDefault,
    });
  async function bound(kind: 'typecheck' | 'lint', roots: string[]): Promise<EvidenceAtom> {
    const r = await validateAtom({ kind: 'qa-run', path: receipt({ kind, roots }) }, root);
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r.atom;
  }

  it('verify binds both receipts on main, and plan/complete let them stand for qaPassed', async () => {
    const atoms = [await bound('typecheck', ['src']), await bound('lint', ['src'])];
    expect(atoms[0]).toMatchObject({ headSha: git(root, ['rev-parse', 'HEAD']) });
    expect(await judge(atoms)).toBeNull();
  });

  it('refuses receipts that do not cover the change, naming the path', async () => {
    const atoms = [await bound('typecheck', ['lib']), await bound('lint', ['src'])];
    expect(await judge(atoms)).toMatch(
      /differ from the tree.*no qa-run on main after the merge stands in.*typecheck receipt \(roots lib\) does not cover the changed path\(s\) src\/a\/x\.ts/s,
    );
  });

  it('refuses receipts bound to a commit that does not descend from the merge', async () => {
    const tree = git(root, ['rev-parse', 'HEAD^{tree}']);
    const atoms = (['typecheck', 'lint'] as const).map(
      (check): EvidenceAtom => ({
        kind: 'qa-run',
        path: `${check}.json`,
        sha256: 'c'.repeat(64),
        check,
        command: ['x'],
        roots: ['src'],
        headSha: branchHead,
        treeHash: tree,
      }),
    );
    expect(await judge(atoms)).toMatch(/which does not descend from merge commit/);
  });

  it('pre-merge receipts still carry when the change merged byte for byte (T13495 rule)', async () => {
    const branchTree = git(root, ['rev-parse', `${branchHead}^{tree}`]);
    const atoms = (['typecheck', 'lint'] as const).map(
      (check): EvidenceAtom => ({
        kind: 'qa-run',
        path: `${check}.json`,
        sha256: 'c'.repeat(64),
        check,
        command: ['x'],
        roots: ['src'],
        headSha: branchHead,
        treeHash: branchTree,
      }),
    );
    expect(
      await qaPassedSupersededReason(atoms, {
        mergeState: () => ({
          state: 'merged' as const,
          landing: { ...target(), deletedFiles: [] },
        }),
        currentTree: () => branchTree,
        landed: isLandedOnOriginDefault,
      }),
    ).toBeNull();
  });

  it('needs both a typecheck and a lint receipt, as the verify-time pair rule does', async () => {
    const atoms = [await bound('typecheck', ['src'])];
    expect(
      scopedRunStandsAfterRedCi(
        atoms,
        target(),
        git(root, ['rev-parse', 'HEAD^{tree}']),
        isLandedOnOriginDefault,
        'qaPassed',
      ),
    ).toEqual({ ok: false, why: 'no qa-run lint receipt is on record' });
  });

  it('a whole-project tool: run beside the receipts is not judged after merge (it pins no tree)', async () => {
    const atoms = [
      await bound('typecheck', ['lib']),
      { kind: 'tool', tool: 'lint', exitCode: 0 } as EvidenceAtom,
    ];
    expect(await judge(atoms)).toBeNull();
  });
});

describe('T13644: an earlier-tree qa-run receipt carries while the files it checked are unchanged', () => {
  let receiptTree = '';
  beforeEach(() => {
    initRepo(() => {
      put('package.json', JSON.stringify({ name: 'solo' }));
      put('src/a/x.ts', 'export const x = 1;\n');
      put('lib/z.ts', 'export const z = 1;\n');
    });
    put('src/a/x.ts', 'export const x = 2;\n');
    git(root, ['commit', '-q', '-am', 'T1: change a']);
    receiptTree = git(root, ['rev-parse', 'HEAD^{tree}']);
  });

  const receipts = (): EvidenceAtom[] =>
    (['typecheck', 'lint'] as const).map((check) => ({
      kind: 'qa-run',
      path: `${check}.json`,
      sha256: 'c'.repeat(64),
      check,
      command: ['x'],
      roots: ['src'],
      headSha: git(root, ['rev-parse', 'HEAD']),
      treeHash: receiptTree,
    }));
  const judge = (
    atoms: EvidenceAtom[],
    mergeState: Parameters<typeof qaPassedSupersededReason>[1]['mergeState'],
  ) =>
    qaPassedSupersededReason(atoms, {
      mergeState,
      currentTree: () => git(root, ['rev-parse', 'HEAD^{tree}']),
      landed: isLandedOnOriginDefault,
      root: () => root,
    });
  function commitEdit(rel: string, body: string, msg: string): void {
    put(rel, body);
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', msg]);
  }

  it('an unrelated later commit leaves the receipts standing', async () => {
    const atoms = receipts();
    commitEdit('lib/z.ts', 'export const z = 2;\n', 'unrelated');
    expect(await judge(atoms, () => 'unmerged')).toBeNull();
  });

  it('a later change to a checked path refuses, naming that path', async () => {
    const atoms = receipts();
    commitEdit('lib/z.ts', 'export const z = 2;\n', 'unrelated');
    commitEdit('src/a/x.ts', 'export const x = 3;\n', 'T1: edit a again');
    const why = await judge(atoms, () => 'unmerged');
    expect(why).toMatch(
      /files it checked changed in the current tree [0-9a-f]{12}: src\/a\/x\.ts\./,
    );
    expect(why).not.toMatch(/lib\/z\.ts/);
  });

  it('after the merge, unrelated commits on main leave earlier-head receipts standing', async () => {
    const atoms = receipts();
    git(root, ['switch', '-q', 'main']);
    git(root, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #1911', 'task/T1']);
    const merge = git(root, ['rev-parse', 'HEAD']);
    commitEdit('lib/z.ts', 'export const z = 2;\n', 'a later unrelated PR');
    git(root, ['push', '-q', 'origin', 'main']);
    const landing = {
      mergeCommitSha: merge,
      files: ['src/a/x.ts'],
      deletedFiles: [],
      executionRoot: root,
    };
    expect(await judge(atoms, () => ({ state: 'merged' as const, landing }))).toBeNull();
  });
});
