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
  changedPathsSinceDefault,
  cleoConfigSchemaFor,
  deriveAffectedPackages,
  isCleoConfigOnlyChange,
  isNonCodeOnlyChange,
  isNonCodePath,
  MAX_UNTRACKED_SET_ASIDE,
  scopedChangedPaths,
} from '../affected-packages.js';
import {
  hasTreeBoundQaRun,
  type MergedVerdict,
  qaPassedSupersededReason,
  qaRunTreeMismatchReason,
  scopedRunStandsAfterRedCi,
  scopedRunSupersededReason,
  setAsideJoinedReason,
  testsPassedSupersededReason,
} from '../affected-scope.js';
import { isLandedOnOriginDefault } from '../change-set.js';
import { checkTaskEvidenceContext, validateAtom } from '../evidence.js';
import { parseQaRunReceipt, qaRunChecks, qaRunUnionGapReason } from '../qa-run-binding.js';
import { captureTreeHash } from '../tool-cache.js';

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

describe('a qa-run kind owes coverage only for what its tool reads (T13698)', () => {
  it('reads sources and the configs that change a check, nothing else', () => {
    expect(qaRunChecks('lint', 'src/a.tsx')).toBe(true);
    expect(qaRunChecks('lint', 'packages/a/eslint.config.mjs')).toBe(true);
    expect(qaRunChecks('lint', 'biome.json')).toBe(true);
    expect(qaRunChecks('lint', 'packages/a/package.json')).toBe(true);
    expect(qaRunChecks('typecheck', 'packages/a/tsconfig.build.json')).toBe(true);
    expect(qaRunChecks('typecheck', 'src/a.js')).toBe(false);
    expect(qaRunChecks('lint', 'scripts/INDEX.md')).toBe(false);
    expect(qaRunChecks('typecheck', 'data/fixture.json')).toBe(false);
    // T13745 allowlist: no non-code path is an input of either check (one classifier each, disjoint).
    for (const p of [
      'renovate.json',
      '.editorconfig',
      '.vscode/settings.json',
      'x.code-workspace',
      'docs/a.md',
    ]) {
      expect(isNonCodePath(p), p).toBe(true);
      expect(qaRunChecks('lint', p) || qaRunChecks('typecheck', p), p).toBe(false);
    }
  });

  // axiom T1984: ESLint over the changed TS entry files, plus a generated
  // scripts/INDEX.md that ESLint never reads (scripts/ is a CI code root, so
  // the .md is not set aside as documentation).
  beforeEach(() => {
    initRepo(() => {
      put('package.json', JSON.stringify({ name: 'solo' }));
      put('src/a/x.ts', 'export const x = 1;\n');
      put('src/b/y.ts', 'export const y = 1;\n');
      put('scripts/INDEX.md', '# index\n');
    });
    put('src/a/x.ts', 'export const x = 2;\n');
    put('src/b/y.ts', 'export const y = 2;\n');
    put('scripts/INDEX.md', '# index\n\n- x\n');
    git(root, ['commit', '-q', '-am', 'T1: change entries and regenerate the index']);
  });

  const ctx: EvidenceValidationContext = {
    task: { id: 'T1', kind: 'work', labels: [], files: [], acceptance: [] },
    gates: ['qaPassed'],
    criteria: [],
  };

  async function bound(fields: Record<string, unknown>, name: string): Promise<EvidenceAtom> {
    const r = await validateAtom({ kind: 'qa-run', path: receipt(fields, undefined, name) }, root);
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r.atom;
  }

  it('green: lint over the TS files passes with the .md left to the typecheck receipt that holds it', async () => {
    const lint = await bound(
      { kind: 'lint', command: ['eslint'], roots: ['src/a/x.ts', 'src/b/y.ts'] },
      'lint',
    );
    expect(lint).toMatchObject({ uncovered: ['scripts/INDEX.md'] });
    const types = await bound({ roots: ['src', 'scripts'] }, 'typecheck');
    expect(checkTaskEvidenceContext(ctx, 'qaPassed', [types, lint])).toBeNull();
  });

  it('red: a changed tsconfig is owed by a typecheck receipt; a lint receipt holding it does not stand in', async () => {
    put('tsconfig.json', '{"compilerOptions":{"strict":true}}\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'T1: tighten tsconfig']);
    const lint = await bound({ kind: 'lint', command: ['eslint'], roots: ['.'] }, 'lint');
    const types = await bound({ roots: ['src', 'scripts'] }, 'typecheck');
    expect(checkTaskEvidenceContext(ctx, 'qaPassed', [types, lint])).toMatch(
      /qa-run typecheck receipt \(roots scripts, src\) does not cover the changed path\(s\) tsconfig\.json\./,
    );
  });

  it('red: a lintable file the lint run missed is still refused, naming it', async () => {
    const lint = await bound({ kind: 'lint', command: ['eslint'], roots: ['src/a/x.ts'] }, 'lint');
    const types = await bound({ roots: ['src', 'scripts'] }, 'typecheck');
    expect(checkTaskEvidenceContext(ctx, 'qaPassed', [types, lint])).toMatch(
      /qa-run lint receipt \(roots src\/a\/x\.ts\) does not cover the changed path\(s\) src\/b\/y\.ts\./,
    );
  });

  it('red: a file neither check reads and no receipt holds is named as needing its own evidence', async () => {
    const lint = await bound(
      { kind: 'lint', command: ['eslint'], roots: ['src/a/x.ts', 'src/b/y.ts'] },
      'lint',
    );
    const types = await bound({ roots: ['src'] }, 'typecheck');
    const gap = checkTaskEvidenceContext(ctx, 'qaPassed', [types, lint]);
    expect(gap).toMatch(/^scripts\/INDEX\.md is not read by lint or typecheck/);
    expect(gap).toContain('Add evidence that does');
    // A whole-project tool: run speaks for it.
    expect(
      qaRunUnionGapReason(
        [types, lint].filter(
          (a): a is Extract<EvidenceAtom, { kind: 'qa-run' }> => a.kind === 'qa-run',
        ),
        true,
      ),
    ).toBeNull();
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
      put('tsconfig.json', '{}\n');
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
  /** The task's change as `cleo done` derives it before merge. */
  const unmerged = (files: string[]): MergedVerdict => ({
    state: 'unmerged',
    changeSet: {
      source: 'branch',
      executionRoot: root,
      rootSource: 'invocation-worktree',
      files,
      deletedFiles: [],
      docs: [],
      decisions: [],
      candidates: [],
      implementedEvidence: null,
      blockers: [],
      warnings: [],
    },
  });
  const judge = (atoms: EvidenceAtom[], verdict: MergedVerdict | 'unmerged') =>
    qaPassedSupersededReason(atoms, {
      mergeState: () => verdict,
      currentTree: () => git(root, ['rev-parse', 'HEAD^{tree}']),
      landed: isLandedOnOriginDefault,
    });
  function commitEdit(rel: string, body: string, msg: string): void {
    put(rel, body);
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', msg]);
  }

  it('an unrelated later commit leaves the receipts standing', async () => {
    const atoms = receipts();
    commitEdit('lib/z.ts', 'export const z = 2;\n', 'unrelated');
    expect(await judge(atoms, unmerged(['src/a/x.ts']))).toBeNull();
  });

  it('a later change to a checked path refuses, naming that path', async () => {
    const atoms = receipts();
    commitEdit('lib/z.ts', 'export const z = 2;\n', 'unrelated');
    commitEdit('src/a/x.ts', 'export const x = 3;\n', 'T1: edit a again');
    const why = await judge(atoms, unmerged(['src/a/x.ts']));
    expect(why).toMatch(/differ in the current tree [0-9a-f]{12}: src\/a\/x\.ts\./);
    expect(why).not.toMatch(/lib\/z\.ts/);
  });

  it('the change gaining a file outside the checked roots refuses, naming it (review of #2265)', async () => {
    const atoms = receipts();
    commitEdit('lib/new.ts', 'export const n: number = "type error";\n', 'T1: add lib/new');
    expect(await judge(atoms, unmerged(['src/a/x.ts', 'lib/new.ts']))).toMatch(
      /differ in the current tree [0-9a-f]{12}: lib\/new\.ts\./,
    );
  });

  it('a change to a shared tool config refuses, naming it', async () => {
    const atoms = receipts();
    commitEdit('tsconfig.json', '{ "compilerOptions": { "strict": false } }\n', 'loosen tsc');
    expect(await judge(atoms, unmerged(['src/a/x.ts']))).toMatch(/: tsconfig\.json\./);
  });

  it('with no change set to compare over, a moved tree refuses as before', async () => {
    const atoms = receipts();
    commitEdit('lib/z.ts', 'export const z = 2;\n', 'unrelated');
    expect(await judge(atoms, 'unmerged')).toMatch(/no longer describes this code/);
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
    expect(await judge(atoms, { state: 'merged', landing })).toBeNull();
  });
});

describe('T13745: a non-code-only change (editor settings, docs) completes with targeted evidence', () => {
  const ctx = (gate: 'testsPassed' | 'qaPassed'): EvidenceValidationContext => ({
    task: { id: 'T1', kind: 'work', labels: [], files: [], acceptance: [] },
    gates: [gate],
    criteria: [],
  });

  it('allowlists docs and known-inert editor/bot files; every other path is code', () => {
    for (const p of ['renovate.json', '.vscode/settings.json', '.editorconfig', 'docs/a.md'])
      expect(isNonCodePath(p), p).toBe(true);
    for (const p of [
      '.cleo/project-context.json',
      '.claude/settings.json',
      '.changeset/config.json',
      '.gitlab-ci.yml',
      '.circleci/config.yml',
      'wrangler.toml',
      'vercel.json',
      'docker-compose.yml',
      'package.json',
      'pnpm-lock.yaml',
      'tsconfig.json',
      'biome.json',
      '.github/workflows/ci.yml',
      'packages/a/fixture.json',
      'src/a.ts',
    ])
      expect(isNonCodePath(p), p).toBe(false);
    expect(isNonCodeOnlyChange([])).toBe(false);
    expect(isNonCodeOnlyChange(['.vscode/settings.json', 'src/a.ts'])).toBe(false);
  });

  beforeEach(() => {
    initRepo(() => {
      put('pnpm-workspace.yaml', 'packages:\n  - "packages/*"\n');
      put('packages/a/package.json', JSON.stringify({ name: '@x/a' }));
      put('packages/a/src/i.ts', 'export const a = 1;\n');
      put('.vscode/settings.json', '{}\n');
    });
    put('.vscode/settings.json', '{"editor.tabSize":2}\n');
    git(root, ['commit', '-q', '-am', 'T1: editor settings only']);
  });

  it('testsPassed: tool:test is not applicable, recorded with the paths, and stands for a code task', async () => {
    const r = await validateAtom({ kind: 'tool', tool: 'test' }, root);
    expect(r.ok && r.atom, JSON.stringify(r)).toMatchObject({
      kind: 'tool',
      tool: 'test',
      notApplicable: true,
      nonCodeChange: true,
      reason: expect.stringContaining('.vscode/settings.json'),
      treeHash: git(root, ['rev-parse', 'HEAD^{tree}']),
    });
    if (!r.ok) throw new Error('expected an atom');
    expect(checkTaskEvidenceContext(ctx('testsPassed'), 'testsPassed', [r.atom])).toBeNull();
    // A toolchain the project lacks still does not stand for a code task.
    expect(
      checkTaskEvidenceContext(ctx('testsPassed'), 'testsPassed', [
        { kind: 'tool', tool: 'test', exitCode: 0, notApplicable: true },
      ]),
    ).toMatch(/requires an actual verification result/);
  });

  it('review probe: verify on the settings-only change, then commit code: complete refuses the atom', async () => {
    const r = await validateAtom({ kind: 'tool', tool: 'test' }, root);
    if (!r.ok) throw new Error(JSON.stringify(r));
    const probe = {
      mergeState: () => 'unmerged' as const,
      currentTree: () => captureTreeHash(root),
    };
    expect(await testsPassedSupersededReason([r.atom], probe)).toBeNull();
    put('packages/a/src/i.ts', 'export const a: number = "x";\n');
    git(root, ['commit', '-q', '-am', 'T1: code with a type error']);
    expect(await testsPassedSupersededReason([r.atom], probe)).toMatch(
      /not applicable for a non-code-only change.*Re-verify testsPassed/,
    );
  });

  it('qaPassed: a lint (structural) receipt holding the file stands alone, no typecheck pair', async () => {
    const r = await validateAtom(
      {
        kind: 'qa-run',
        path: receipt(
          { kind: 'lint', command: ['biome', 'check'], roots: ['.vscode'] },
          undefined,
          'lint',
        ),
      },
      root,
    );
    expect(r.ok && r.atom, JSON.stringify(r)).toMatchObject({ nonCodeChange: true });
    if (!r.ok) throw new Error('expected an atom');
    expect(checkTaskEvidenceContext(ctx('qaPassed'), 'qaPassed', [r.atom])).toBeNull();
  });

  it('qaPassed: a lint receipt that does not hold the changed file is refused, naming it', async () => {
    const r = await validateAtom(
      { kind: 'qa-run', path: receipt({ kind: 'lint', roots: ['packages/a'] }, undefined, 'lint') },
      root,
    );
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(checkTaskEvidenceContext(ctx('qaPassed'), 'qaPassed', [r.atom])).toMatch(
      // T13698: lint never reads a .json setting, so no receipt holding it is named.
      /^\.vscode\/settings\.json is not read by lint or typecheck, and no qa-run receipt's roots hold it/,
    );
  });

  it('a change that also touches code still owes the typecheck pair and the workspace-wide refusal', async () => {
    put('packages/a/src/i.ts', 'export const a = 2;\n');
    git(root, ['commit', '-q', '-am', 'T1: and code']);
    const r = await validateAtom(
      { kind: 'qa-run', path: receipt({ kind: 'lint', roots: ['.'] }, undefined, 'lint') },
      root,
    );
    expect(!r.ok && r.reason, JSON.stringify(r)).toMatch(/workspace-wide/);
  });
});

describe('T13758: a change to CLEO-owned config alone is tested by CLEO schema validation', () => {
  const ctx = (gate: 'testsPassed' | 'qaPassed'): EvidenceValidationContext => ({
    task: { id: 'T1', kind: 'work', labels: [], files: [], acceptance: [] },
    gates: [gate],
    criteria: [],
  });
  const context = (body: Record<string, unknown>): string =>
    `${JSON.stringify({ schemaVersion: '1.0.0', detectedAt: '2026-10-15T00:00:00Z', projectTypes: ['node'], ...body })}\n`;

  it('names CLEO-owned config only; any other path removes the route', () => {
    expect(cleoConfigSchemaFor('.cleo/project-context.json')).toBe('project-context.schema.json');
    expect(cleoConfigSchemaFor('.cleo/config.json')).toBe('config.schema.json');
    expect(cleoConfigSchemaFor('.cleo/other.json')).toBeNull();
    expect(isCleoConfigOnlyChange(['.cleo/project-context.json'])).toBe(true);
    expect(isCleoConfigOnlyChange(['.cleo/project-context.json', 'README.md'])).toBe(false);
    expect(isCleoConfigOnlyChange([])).toBe(false);
  });

  beforeEach(() => {
    initRepo(() => {
      put('package.json', JSON.stringify({ name: 'solo' }));
      put('src/a.ts', 'export const a = 1;\n');
      put('.cleo/project-context.json', context({}));
    });
  });

  function change(body: string): void {
    put('.cleo/project-context.json', body);
    git(root, ['commit', '-q', '-am', 'T1: config']);
  }

  it('green: a valid file validates, tree-pinned, and stands for testsPassed and qaPassed on a code task', async () => {
    change(context({ release: { prRequiredWorkflows: [] } }));
    const r = await validateAtom({ kind: 'tool', tool: 'config-schema' }, root);
    expect(r.ok && r.atom, JSON.stringify(r)).toMatchObject({
      kind: 'tool',
      tool: 'config-schema',
      configSchema: ['.cleo/project-context.json'],
      treeHash: git(root, ['rev-parse', 'HEAD^{tree}']),
    });
    if (!r.ok) throw new Error('expected an atom');
    expect(checkTaskEvidenceContext(ctx('testsPassed'), 'testsPassed', [r.atom])).toBeNull();
    expect(checkTaskEvidenceContext(ctx('qaPassed'), 'qaPassed', [r.atom])).toBeNull();
  });

  it('red: a file that breaks the schema fails the check, naming the file', async () => {
    change(context({ test: { command: 'pnpm test' } }));
    const r = await validateAtom({ kind: 'tool', tool: 'config-schema' }, root);
    expect(!r.ok && r.codeName, JSON.stringify(r)).toBe('E_EVIDENCE_TOOL_FAILED');
    expect(!r.ok && r.reason).toMatch(/\.cleo\/project-context\.json/);
  });

  it('T13778: on a mixed change it validates the config and records the rest; alone it does not stand', async () => {
    put('src/a.ts', 'export const a = 2;\n');
    change(context({ release: { prRequiredWorkflows: [] } }));
    const r = await validateAtom({ kind: 'tool', tool: 'config-schema' }, root);
    expect(r.ok && r.atom, JSON.stringify(r)).toMatchObject({
      configSchema: ['.cleo/project-context.json'],
      otherPaths: ['src/a.ts'],
    });
    if (!r.ok) throw new Error('expected an atom');
    expect(checkTaskEvidenceContext(ctx('testsPassed'), 'testsPassed', [r.atom])).toMatch(
      /checks only the CLEO config of this change; the rest \(src\/a\.ts\).*test-run:<report>;tool:config-schema/,
    );
  });

  it('red: once the tree moves (code committed after verify), both gates refuse the result', async () => {
    change(context({ release: { prRequiredWorkflows: [] } }));
    const r = await validateAtom({ kind: 'tool', tool: 'config-schema' }, root);
    if (!r.ok) throw new Error(JSON.stringify(r));
    const probe = {
      mergeState: () => 'unmerged' as const,
      currentTree: () => captureTreeHash(root),
    };
    expect(await testsPassedSupersededReason([r.atom], probe)).toBeNull();
    expect(await qaPassedSupersededReason([r.atom], probe)).toBeNull();
    put('src/a.ts', 'export const a: number = "x";\n');
    git(root, ['commit', '-q', '-am', 'T1: code']);
    expect(await testsPassedSupersededReason([r.atom], probe)).toMatch(
      /CLEO's schema check of \.cleo\/project-context\.json.*Re-verify testsPassed/,
    );
    expect(await qaPassedSupersededReason([r.atom], probe)).toMatch(/Re-verify qaPassed/);
  });
});

/**
 * VidaPeps T2151 (T13778-T13781): a config edit plus the test that pins it,
 * with no CI and no whole-suite runs allowed. The config is judged by
 * tool:config-schema and the rest by a targeted test-run, composed in one
 * write; neither stands alone, and a config edit never hides untested code.
 */
describe('T13778-T13781: CLEO config composes with a targeted run (VidaPeps T2151 shape)', () => {
  const ctx: EvidenceValidationContext = {
    task: { id: 'T1', kind: 'work', labels: [], files: [], acceptance: [] },
    gates: ['testsPassed'],
    criteria: [],
  };
  const config = (body: Record<string, unknown>): string =>
    `${JSON.stringify({ schemaVersion: '1.0.0', detectedAt: '2026-10-15T00:00:00Z', projectTypes: ['node'], ...body })}\n`;
  const PARITY = 'scripts/src/test-command-parity.test.ts';
  const OTHER = 'packages/a/src/a.test.ts';

  beforeEach(() => {
    initRepo(() => {
      put('pnpm-workspace.yaml', 'packages:\n  - "scripts"\n  - "packages/*"\n');
      put('scripts/package.json', JSON.stringify({ name: '@x/scripts' }));
      put(PARITY, 'export {};\n');
      put('packages/a/package.json', JSON.stringify({ name: '@x/a' }));
      put('packages/a/src/i.ts', 'export const a = 1;\n');
      put(OTHER, 'export {};\n');
      put('.cleo/project-context.json', config({ evidence: { scopeExcludes: ['.opencode/**'] } }));
    });
    put(
      '.cleo/project-context.json',
      config({
        evidence: { scopeExcludes: ['.opencode/**'] },
        release: { prRequiredWorkflows: [] },
      }),
    );
    put(PARITY, 'export const pinned = 1;\n');
    git(root, ['commit', '-q', '-am', 'T1: config plus its parity test']);
  });

  /** A vitest-shaped report in which each file ran one passing test. */
  function report(files: string[]): string {
    mkdirSync(join(root, 'reports'), { recursive: true });
    const path = join(root, 'reports', 'vitest.json');
    writeFileSync(
      path,
      JSON.stringify({
        startTime: Date.now() + 5_000,
        numTotalTests: files.length,
        numPassedTests: files.length,
        numFailedTests: 0,
        numPendingTests: 0,
        numTodoTests: 0,
        testResults: files.map((name) => ({
          name: join(root, name),
          status: 'passed',
          assertionResults: [{ fullName: 't', status: 'passed' }],
        })),
      }),
    );
    return path;
  }
  async function atom(parsed: Parameters<typeof validateAtom>[0], sha?: string) {
    const r = await validateAtom(parsed, root, undefined, sha);
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r.atom;
  }

  it('T13779: the config edit does not make the change workspace-wide', () => {
    const changed = ['.cleo/project-context.json', PARITY];
    expect(deriveAffectedPackages(root, changed)).toEqual({
      scope: 'affected',
      direct: ['@x/scripts'],
      packages: ['@x/scripts'],
      cleoConfig: ['.cleo/project-context.json'],
    });
  });

  it('T13778/T13779 green: the changed test file plus config-schema satisfy testsPassed together', async () => {
    const run = await atom({ kind: 'test-run', path: report([PARITY]) });
    expect(run).toMatchObject({ configPaths: ['.cleo/project-context.json'] });
    const schema = await atom({ kind: 'tool', tool: 'config-schema' });
    expect(schema).toMatchObject({
      configSchema: ['.cleo/project-context.json'],
      otherPaths: [PARITY],
    });
    expect(checkTaskEvidenceContext(ctx, 'testsPassed', [run, schema])).toBeNull();
  });

  it('red: the test-run alone leaves the config unvalidated and names the composed route', async () => {
    const run = await atom({ kind: 'test-run', path: report([PARITY]) });
    expect(checkTaskEvidenceContext(ctx, 'testsPassed', [run])).toMatch(
      /also edits CLEO config \(\.cleo\/project-context\.json\).*tool:config-schema/,
    );
  });

  it('red (trust): a config edit does not hide an untested source change', async () => {
    put('packages/a/src/i.ts', 'export const a = 2;\n');
    git(root, ['commit', '-q', '-am', 'T1: and a source change']);
    const r = await validateAtom({ kind: 'test-run', path: report([PARITY]) }, root);
    expect(!r.ok && r.reason, JSON.stringify(r)).toMatch(
      /covers no test file of @x\/a \(changed\)/,
    );
    const schema = await atom({ kind: 'tool', tool: 'config-schema' });
    expect(schema).toMatchObject({ otherPaths: ['packages/a/src/i.ts', PARITY] });
    expect(checkTaskEvidenceContext(ctx, 'testsPassed', [schema])).toMatch(/needs its own result/);
  });

  it('T13780: untracked tool and session state does not change classification or config-schema', async () => {
    put('.opencode/goals/g.yaml', 'goal: x\n');
    put('.cleo/rcasd/T9/notes.md', '# other session\n');
    expect(changedPathsSinceDefault(root)).toEqual(['.cleo/project-context.json', PARITY]);
    const schema = await atom({ kind: 'tool', tool: 'config-schema' });
    expect(schema).toMatchObject({
      configSchema: ['.cleo/project-context.json'],
      otherPaths: [PARITY],
    });
  });

  it('T13780: an untracked source file outside a dot-directory still counts', () => {
    put('packages/a/src/new.ts', 'export const n = 1;\n');
    expect(changedPathsSinceDefault(root)).toContain('packages/a/src/new.ts');
  });

  it('red (review of #2302, T14000): an untracked file set aside at verify is refused at complete once committed', async () => {
    // A new workflow left untracked at verify joins the tree with the same hash
    // once committed. It is outside the change's directories, so the binding
    // sets it aside (a shared checkout's stray file never refuses the run) and
    // records it; the superseded check refuses the run once it is tracked.
    put('.github/workflows/new.yml', 'on: push\n');
    expect(changedPathsSinceDefault(root)).toContain('.github/workflows/new.yml');
    const run = await atom({ kind: 'test-run', path: report([PARITY]) });
    expect(run).toMatchObject({ untrackedSetAside: ['.github/workflows/new.yml'] });
    const probe = {
      mergeState: () => 'unmerged' as const,
      currentTree: () => captureTreeHash(root),
      root: () => root,
    };
    expect(await testsPassedSupersededReason([run], probe)).toBeNull();
    git(root, ['add', '.github/workflows/new.yml']);
    git(root, ['commit', '-q', '-m', 'T1: and a workflow']);
    expect(await testsPassedSupersededReason([run], probe)).toMatch(
      /\.github\/workflows\/new\.yml was untracked and outside the change.*now tracked/,
    );
  });

  it('T14000: an untracked file inside a directory the change touches still counts at verify', async () => {
    put('scripts/src/new-helper.test.ts', 'export {};\n');
    expect(scopedChangedPaths(root, { narrowUntracked: true })).toMatchObject({
      paths: expect.arrayContaining(['scripts/src/new-helper.test.ts']),
      untrackedSetAside: [],
    });
    const r = await validateAtom({ kind: 'test-run', path: report([PARITY]) }, root);
    expect(!r.ok && r.reason, JSON.stringify(r)).toMatch(/scripts\/src\/new-helper\.test\.ts/);
  });

  it('T14000: set-aside paths match literally, and git failing refuses the run', () => {
    put('routes/i/+page.svelte', '<p>i</p>\n');
    git(root, ['add', 'routes/i/+page.svelte']);
    git(root, ['commit', '-q', '-m', 'T1: a route']);
    const run: EvidenceAtom = {
      kind: 'test-run',
      path: 'report.json',
      sha256: 'x',
      passCount: 1,
      failCount: 0,
      skipCount: 0,
      untrackedSetAside: ['routes/[id]/+page.svelte'],
    };
    // As a pathspec, `[id]` would match the tracked routes/i/; literally it does not.
    expect(setAsideJoinedReason([run], () => root)).toBeNull();
    const outside = mkdtempSync(join(tmpdir(), 'cleo-t14000-nogit-'));
    try {
      expect(setAsideJoinedReason([run], () => outside)).toMatch(/git cannot list the tracked/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('T14000: too many stray untracked files are judged, not set aside', () => {
    for (let i = 0; i <= MAX_UNTRACKED_SET_ASIDE; i++) put(`stray/f${i}.txt`, 'x\n');
    const changes = scopedChangedPaths(root, { narrowUntracked: true });
    expect(changes?.untrackedSetAside).toEqual([]);
    expect(changes?.paths).toContain('stray/f0.txt');
  });

  describe('T13781: after the merge, config-schema judges the task\u2019s own merged change', () => {
    let merge = '';
    let own = '';
    /** The task's context, its implemented gate recording `commits`. */
    const owning = (commits: string[]): EvidenceValidationContext => ({
      ...ctx,
      task: {
        ...ctx.task,
        verification: {
          passed: false,
          round: 1,
          gates: {},
          lastAgent: null,
          lastUpdated: null,
          failureLog: [],
          evidence: {
            implemented: {
              atoms: commits.map((sha): EvidenceAtom => ({ kind: 'commit', sha })),
              capturedAt: '2026-10-16T00:00:00Z',
              capturedBy: 'test',
            },
          },
        },
      },
    });
    const schemaAt = async (sha: string, commits = [own]) => {
      const r = await validateAtom(
        { kind: 'tool', tool: 'config-schema' },
        root,
        undefined,
        sha,
        owning(commits),
      );
      if (!r.ok) throw new Error(JSON.stringify(r));
      return r.atom;
    };
    beforeEach(() => {
      own = git(root, ['rev-parse', 'HEAD']);
      git(root, ['switch', '-q', 'main']);
      git(root, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #803', 'task/T1']);
      merge = git(root, ['rev-parse', 'HEAD']);
      git(root, ['push', '-q', 'origin', 'main']);
    });

    it('with no commit named it refuses, naming commit:<sha> and pr:<n>', async () => {
      const r = await validateAtom({ kind: 'tool', tool: 'config-schema' }, root);
      expect(!r.ok && r.reason, JSON.stringify(r)).toMatch(
        /no change against the default branch.*commit:<sha>;tool:config-schema.*pr:<n>;tool:config-schema/,
      );
    });

    it('with its own commit:<sha> it validates the task\u2019s config, and stands after the merge', async () => {
      const schema = await schemaAt(own);
      expect(schema).toMatchObject({
        configSchema: ['.cleo/project-context.json'],
        configSchemaCommit: own,
        otherPaths: [PARITY],
      });
      const landing = {
        mergeCommitSha: merge,
        files: ['.cleo/project-context.json'],
        deletedFiles: [],
        executionRoot: root,
      };
      expect(
        await testsPassedSupersededReason([schema], {
          mergeState: () => ({ state: 'merged' as const, landing }),
          currentTree: () => git(root, ['rev-parse', 'HEAD^{tree}']),
          landed: isLandedOnOriginDefault,
        }),
      ).toBeNull();
    });

    it('red (review of #2302): an unrelated commit is refused, however its diff looks', async () => {
      // The probe: another change relaxes the test command; the task's own
      // merged change is code. Naming the unrelated commit must not let the
      // task complete on config-schema alone.
      put('.cleo/project-context.json', config({ testing: { command: 'true' } }));
      git(root, ['commit', '-q', '-am', 'someone else: relax the tests']);
      git(root, ['push', '-q', 'origin', 'main']);
      const unrelated = git(root, ['rev-parse', 'HEAD']);
      const r = await validateAtom(
        { kind: 'tool', tool: 'config-schema' },
        root,
        undefined,
        unrelated,
        owning([own]),
      );
      expect(!r.ok && r.reason, JSON.stringify(r)).toMatch(
        /only at the task's own commit.*neither a commit: nor a pr: merge recorded/,
      );
      const none = await validateAtom(
        { kind: 'tool', tool: 'config-schema' },
        root,
        undefined,
        unrelated,
      );
      expect(none.ok).toBe(false);
    });

    it('red (review of #2302): after the merge config-schema never carries the change\u2019s code files', async () => {
      const schema = await schemaAt(own);
      const landing = {
        mergeCommitSha: merge,
        files: ['.cleo/project-context.json', PARITY],
        deletedFiles: [],
        executionRoot: root,
      };
      expect(
        await testsPassedSupersededReason([schema], {
          mergeState: () => ({ state: 'merged' as const, landing }),
          currentTree: () => git(root, ['rev-parse', 'HEAD^{tree}']),
          landed: isLandedOnOriginDefault,
        }),
      ).toMatch(
        /checks only CLEO config, and nothing else covers the change's other file\(s\) scripts/,
      );
    });

    it('the post-merge stand-in needs config-schema for the merged config, beside the test-run', async () => {
      const run = await atom({ kind: 'test-run', path: report([PARITY]) });
      const schema = await schemaAt(own);
      const change = {
        mergeCommitSha: merge,
        files: ['.cleo/project-context.json', PARITY],
        executionRoot: root,
      };
      const tree = git(root, ['rev-parse', 'HEAD^{tree}']);
      expect(
        scopedRunStandsAfterRedCi([run, schema], change, tree, isLandedOnOriginDefault),
      ).toEqual({ ok: true });
      const alone = scopedRunStandsAfterRedCi([run], change, tree, isLandedOnOriginDefault);
      expect(!alone.ok && alone.why).toMatch(
        /also edits CLEO config \.cleo\/project-context\.json, and no tool:config-schema validated it/,
      );
    });

    it('red: a config file that breaks the schema at the task\u2019s commit fails', async () => {
      git(root, ['switch', '-q', '-c', 'task/T2']);
      put('.cleo/project-context.json', config({ test: { command: 'x' } }));
      git(root, ['commit', '-q', '-am', 'T2: bad config']);
      const bad = git(root, ['rev-parse', 'HEAD']);
      git(root, ['switch', '-q', 'main']);
      git(root, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #804', 'task/T2']);
      git(root, ['push', '-q', 'origin', 'main']);
      const r = await validateAtom(
        { kind: 'tool', tool: 'config-schema' },
        root,
        undefined,
        bad,
        owning([bad]),
      );
      expect(!r.ok && r.codeName, JSON.stringify(r)).toBe('E_EVIDENCE_TOOL_FAILED');
    });
  });
});

/**
 * VidaPeps PR #898 (T13783, owner decision): regenerating a shared generated
 * client must not owe a test file from every dependent. A package that
 * depends on the change only through a declared generated client owes a
 * typecheck naming it; anything else keeps owing tests.
 */
describe('T13783: dependents of a regenerated generated client owe a typecheck, not tests', () => {
  const ctx: EvidenceValidationContext = {
    task: { id: 'T1', kind: 'work', labels: [], files: [], acceptance: [] },
    gates: ['testsPassed'],
    criteria: [],
  };
  const pkg = (dir: string, name: string, deps: string[] = []) => {
    put(
      `${dir}/package.json`,
      JSON.stringify({
        name,
        dependencies: Object.fromEntries(deps.map((d) => [d, 'workspace:*'])),
      }),
    );
    put(`${dir}/src/index.ts`, 'export const v = 1;\n');
    put(`${dir}/src/index.test.ts`, 'export {};\n');
  };
  const contextFile = (evidence: Record<string, unknown>) =>
    `${JSON.stringify({ schemaVersion: '1.0.0', detectedAt: '2026-10-16T00:00:00Z', projectTypes: ['node'], evidence })}\n`;

  function setup(declared: boolean | string[]): void {
    initRepo(() => {
      put('pnpm-workspace.yaml', 'packages:\n  - "lib/*"\n  - "apps/*"\n');
      pkg('lib/api-zod', '@x/api-zod');
      pkg('lib/api-client-react', '@x/api-client-react', ['@x/api-zod']);
      pkg('lib/util', '@x/util');
      pkg('apps/web', '@x/web', ['@x/api-client-react', '@x/util']);
      put(
        '.cleo/project-context.json',
        contextFile(
          declared === false
            ? {}
            : { typecheckOnlyDependents: declared === true ? ['lib/api-zod/**'] : declared },
        ),
      );
    });
    put('lib/api-zod/src/index.ts', 'export const v = 2;\n');
    git(root, ['commit', '-q', '-am', 'T1: regenerate the client']);
  }
  function report(files: string[]): string {
    mkdirSync(join(root, 'reports'), { recursive: true });
    const path = join(root, 'reports', 'vitest.json');
    writeFileSync(
      path,
      JSON.stringify({
        startTime: Date.now() + 5_000,
        numTotalTests: files.length,
        numPassedTests: files.length,
        numFailedTests: 0,
        numPendingTests: 0,
        numTodoTests: 0,
        testResults: files.map((name) => ({
          name: join(root, name),
          status: 'passed',
          assertionResults: [{ fullName: 't', status: 'passed' }],
        })),
      }),
    );
    return path;
  }
  const ZOD_TEST = 'lib/api-zod/src/index.test.ts';

  it('green: the client\u2019s tests plus a typecheck naming its dependents satisfy testsPassed', async () => {
    setup(true);
    const run = await validateAtom({ kind: 'test-run', path: report([ZOD_TEST]) }, root);
    expect(run.ok && run.atom, JSON.stringify(run)).toMatchObject({
      typecheckDirs: ['apps/web', 'lib/api-client-react'],
    });
    const tc = await validateAtom(
      { kind: 'qa-run', path: receipt({ kind: 'typecheck', roots: ['lib', 'apps'] }) },
      root,
    );
    if (!run.ok || !tc.ok) throw new Error(JSON.stringify({ run, tc }));
    expect(checkTaskEvidenceContext(ctx, 'testsPassed', [run.atom, tc.atom])).toBeNull();
  });

  it('red: without a typecheck covering the dependents the gate refuses, naming them', async () => {
    setup(true);
    const run = await validateAtom({ kind: 'test-run', path: report([ZOD_TEST]) }, root);
    const narrow = await validateAtom(
      { kind: 'qa-run', path: receipt({ kind: 'typecheck', roots: ['lib'] }) },
      root,
    );
    if (!run.ok || !narrow.ok) throw new Error(JSON.stringify({ run, narrow }));
    expect(checkTaskEvidenceContext(ctx, 'testsPassed', [run.atom])).toMatch(
      /leaves apps\/web, lib\/api-client-react to a typecheck.*evidence\.typecheckOnlyDependents/,
    );
    expect(checkTaskEvidenceContext(ctx, 'testsPassed', [run.atom, narrow.atom])).toMatch(
      /leaves apps\/web to a typecheck/,
    );
  });

  it('red (review of #2302): a catch-all glob declares nothing', async () => {
    setup(['**']);
    const r = await validateAtom({ kind: 'test-run', path: report([ZOD_TEST]) }, root);
    expect(!r.ok && r.reason, JSON.stringify(r)).toMatch(/depends on a changed package/);
  });

  it('red: a dependent whose own source changed still owes its tests', async () => {
    setup(true);
    put('lib/api-client-react/src/index.ts', 'export const v = 3;\n');
    git(root, ['commit', '-q', '-am', 'T1: and the hooks']);
    const r = await validateAtom({ kind: 'test-run', path: report([ZOD_TEST]) }, root);
    expect(!r.ok && r.reason, JSON.stringify(r)).toMatch(
      /covers no test file of @x\/api-client-react \(changed\)/,
    );
  });

  it('red: a package with any changed path outside the declared globs is not typecheck-only', async () => {
    setup(false);
    put(
      '.cleo/project-context.json',
      contextFile({ typecheckOnlyDependents: ['lib/api-zod/src/index.ts'] }),
    );
    git(root, ['commit', '-q', '-am', 'declare']);
    git(root, ['push', '-q', 'origin', 'HEAD:main']);
    put('lib/api-zod/src/index.ts', 'export const v = 4;\n');
    put('lib/api-zod/src/extra.ts', 'export const e = 1;\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'T1: regenerate plus a hand-written file']);
    const r = await validateAtom({ kind: 'test-run', path: report([ZOD_TEST]) }, root);
    expect(!r.ok && r.reason, JSON.stringify(r)).toMatch(/depends on a changed package/);
  });

  it('red: a generated package declared only by the change itself counts for nothing', async () => {
    setup(false);
    put('.cleo/project-context.json', contextFile({ typecheckOnlyDependents: ['lib/api-zod/**'] }));
    git(root, ['commit', '-q', '-am', 'T1: declare my own package generated']);
    const r = await validateAtom({ kind: 'test-run', path: report([ZOD_TEST]) }, root);
    expect(!r.ok && r.reason, JSON.stringify(r)).toMatch(/depends on a changed package/);
  });

  it('a typecheck tool result is never a test run: scoped evidence beside it is still superseded after merge', () => {
    const run: EvidenceAtom = {
      kind: 'test-run',
      path: 'r.json',
      sha256: 'x',
      passCount: 1,
      failCount: 0,
      skipCount: 0,
    };
    const typecheck: EvidenceAtom = { kind: 'tool', tool: 'typecheck', exitCode: 0 };
    expect(scopedRunSupersededReason([run, typecheck], 'merged')).toMatch(/scoped run/);
  });
});

/**
 * VidaPeps T1305 / PR #875 (T13786, the T13783 owner decision extended to
 * declared seed/data paths): editing lib/db/src/seed-data/glp1.ts must not owe
 * a test file from every package that depends on lib/db. The declared glob
 * makes lib/db typecheck-only for its dependents; lib/db's own tests and every
 * edited test file are still owed.
 */
describe('T13786: declared seed/data globs owe dependents a typecheck, not tests', () => {
  const ctx: EvidenceValidationContext = {
    task: { id: 'T1305', kind: 'work', labels: [], files: [], acceptance: [] },
    gates: ['testsPassed'],
    criteria: [],
  };
  const pkg = (dir: string, name: string, deps: string[] = []) => {
    put(
      `${dir}/package.json`,
      JSON.stringify({
        name,
        dependencies: Object.fromEntries(deps.map((d) => [d, 'workspace:*'])),
      }),
    );
    put(`${dir}/src/index.ts`, 'export const v = 1;\n');
    put(`${dir}/src/index.test.ts`, 'export {};\n');
  };
  const DB_TEST = 'lib/db/src/index.test.ts';

  function setup(): void {
    initRepo(() => {
      put('pnpm-workspace.yaml', 'packages:\n  - "lib/*"\n  - "apps/*"\n');
      pkg('lib/db', '@workspace/db');
      put('lib/db/src/seed-data/glp1.ts', 'export const glp1 = ["a"];\n');
      put('lib/db/src/vp-registry.test.ts', 'export {};\n');
      pkg('lib/llm', '@workspace/llm', ['@workspace/db']);
      pkg('lib/ui', '@workspace/ui', ['@workspace/db']);
      pkg('apps/api-server', '@workspace/api-server', ['@workspace/db', '@workspace/llm']);
      put(
        '.cleo/project-context.json',
        `${JSON.stringify({
          schemaVersion: '1.0.0',
          detectedAt: '2026-10-16T00:00:00Z',
          projectTypes: ['node'],
          evidence: { typecheckOnlyDependents: ['lib/db/src/seed-data/**'] },
        })}\n`,
      );
    });
  }
  function report(files: string[]): string {
    mkdirSync(join(root, 'reports'), { recursive: true });
    const path = join(root, 'reports', 'vitest.json');
    writeFileSync(
      path,
      JSON.stringify({
        startTime: Date.now() + 5_000,
        numTotalTests: files.length,
        numPassedTests: files.length,
        numFailedTests: 0,
        numPendingTests: 0,
        numTodoTests: 0,
        testResults: files.map((name) => ({
          name: join(root, name),
          status: 'passed',
          assertionResults: [{ fullName: 't', status: 'passed' }],
        })),
      }),
    );
    return path;
  }

  it('green (repro #875): lib/db tests plus a typecheck covering its dependents close testsPassed', async () => {
    setup();
    put('lib/db/src/seed-data/glp1.ts', 'export const glp1 = ["a", "b"];\n');
    git(root, ['commit', '-q', '-am', 'T1305: seed text']);
    const run = await validateAtom({ kind: 'test-run', path: report([DB_TEST]) }, root);
    expect(run.ok && run.atom, JSON.stringify(run)).toMatchObject({
      typecheckDirs: ['apps/api-server', 'lib/llm', 'lib/ui'],
    });
    const tc = await validateAtom(
      { kind: 'qa-run', path: receipt({ kind: 'typecheck', roots: ['lib', 'apps'] }) },
      root,
    );
    if (!run.ok || !tc.ok) throw new Error(JSON.stringify({ run, tc }));
    expect(checkTaskEvidenceContext(ctx, 'testsPassed', [run.atom, tc.atom])).toBeNull();
    expect(checkTaskEvidenceContext(ctx, 'testsPassed', [run.atom])).toMatch(
      /leaves apps\/api-server, lib\/llm, lib\/ui to a typecheck/,
    );
  });

  it("red: the owning package's tests are still owed", async () => {
    setup();
    put('lib/db/src/seed-data/glp1.ts', 'export const glp1 = ["a", "b"];\n');
    git(root, ['commit', '-q', '-am', 'T1305: seed text']);
    const r = await validateAtom(
      { kind: 'test-run', path: report(['lib/llm/src/index.test.ts']) },
      root,
    );
    expect(!r.ok && r.reason, JSON.stringify(r)).toMatch(/@workspace\/db \(changed\)/);
  });

  it('red: an edited test file must be run', async () => {
    setup();
    put('lib/db/src/seed-data/glp1.ts', 'export const glp1 = ["a", "b"];\n');
    put('lib/db/src/vp-registry.test.ts', 'export const t = 2;\n');
    git(root, ['commit', '-q', '-am', 'T1305: seed text and its test']);
    const r = await validateAtom({ kind: 'test-run', path: report([DB_TEST]) }, root);
    expect(!r.ok && r.reason, JSON.stringify(r)).toMatch(
      /does not run the changed test file\(s\) lib\/db\/src\/vp-registry\.test\.ts/,
    );
  });

  it('red: a source edit beside the seed data makes the dependents owe tests again', async () => {
    setup();
    put('lib/db/src/seed-data/glp1.ts', 'export const glp1 = ["a", "b"];\n');
    put('lib/db/src/index.ts', 'export const v = 2;\n');
    git(root, ['commit', '-q', '-am', 'T1305: seed text and code']);
    const r = await validateAtom({ kind: 'test-run', path: report([DB_TEST]) }, root);
    expect(!r.ok && r.reason, JSON.stringify(r)).toMatch(/depends on a changed package/);
  });
});
