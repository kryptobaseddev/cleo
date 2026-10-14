/**
 * `qa-run:` receipts bind a native typecheck or lint run to the change it
 * checks (T13427, owner decision option 1 of `t13427-qa-run-binding-design`):
 * exit 0 with no errors, fresh, covering every changed code path (and, in a
 * workspace, every dependent package), tree-pinned, and only as a
 * typecheck + lint pair for qaPassed.
 *
 * @task T13427
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceAtom, EvidenceValidationContext } from '@cleocode/contracts';
import { parseEvidenceString, validateEvidenceForGate } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasTreeBoundQaRun, qaRunTreeMismatchReason } from '../affected-scope.js';
import { checkTaskEvidenceContext, validateAtom } from '../evidence.js';
import { parseQaRunReceipt, qaRunChecks, qaRunUnionGapReason } from '../qa-run-binding.js';

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
