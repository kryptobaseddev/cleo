/**
 * Tests for `scripts/lint-row-identity-coverage.mjs` (T12897, arch gate 37).
 *
 * Fixture registries prove both failure modes: a syncing table with neither a
 * declared uid nor an exemption, and an exemption that is stale (its table is
 * gone, no longer syncs, or is declared). The #1764 review fixes are covered
 * too: PR mode against a base ref (M1), the open-task check (L3), the
 * names-digest pin that catches a swap (L4) and strict argument parsing (L6).
 * The repository itself must pass.
 *
 * @task T12897
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ROW_IDENTITY_EXEMPT_PINNED,
  rowIdentityExemptDigest,
  rowIdentityExemptionSummary,
} from '../../packages/core/src/store/row-identity-registry.ts';
import {
  baseProblems,
  loadBaseRegistry,
  main,
  parseArgs,
  registrySyncTables,
  scopeProblems,
  taskProblems,
} from '../lint-row-identity-coverage.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO, 'scripts', 'lint-row-identity-coverage.mjs');

const entry = (cls, status = 'draft') => ({ class: cls, status, source: 'fixture' });

/** a, b sync; c is local-only; d is a frozen twin; e is derived. */
const REGISTRY = {
  scope: 'project',
  tables: {
    a: entry('portable-project'),
    b: entry('portable-personal'),
    c: entry('local-only'),
    d: entry('local-only', 'frozen-legacy'),
    e: entry('derived'),
    f: entry('portable-project', 'frozen-legacy'),
  },
  patterns: [],
  pending: [],
};

const WHY = { category: 'planned', reason: 'fixture', task: 'T1' };
const kinds = (problems) => problems.map((p) => `${p.kind}:${p.table ?? ''}`);

describe('registrySyncTables', () => {
  it('takes portable, non-frozen entries only', () => {
    expect(registrySyncTables(REGISTRY).sort()).toEqual(['a', 'b']);
  });
});

describe('scopeProblems', () => {
  it('passes when every syncing table is declared or exempt', () => {
    expect(
      scopeProblems({ registry: REGISTRY, declared: [{ table: 'a' }], exempt: { b: WHY } }),
    ).toEqual([]);
  });

  it('fails on a syncing table with neither a declaration nor an exemption', () => {
    expect(
      kinds(scopeProblems({ registry: REGISTRY, declared: [{ table: 'a' }], exempt: {} })),
    ).toEqual(['missing:b']);
    expect(kinds(scopeProblems({ registry: REGISTRY, declared: [], exempt: {} }))).toEqual([
      'missing:a',
      'missing:b',
    ]);
  });

  it('fails on a stale exemption: table gone or no longer syncing', () => {
    const problems = scopeProblems({
      registry: REGISTRY,
      declared: [{ table: 'a' }],
      exempt: { b: WHY, c: WHY, f: WHY, gone: WHY },
    });
    expect(kinds(problems)).toEqual(['stale:c', 'stale:f', 'stale:gone']);
  });

  it('fails on an exemption for a declared table', () => {
    expect(
      kinds(
        scopeProblems({
          registry: REGISTRY,
          declared: [{ table: 'a' }],
          exempt: { a: WHY, b: WHY },
        }),
      ),
    ).toEqual(['declared:a']);
  });

  it('fails on an exemption without a reason or a task', () => {
    const problems = scopeProblems({
      registry: REGISTRY,
      declared: [],
      exempt: { a: { ...WHY, reason: '  ' }, b: { ...WHY, task: 'soon' } },
    });
    expect(kinds(problems)).toEqual(['invalid:a', 'invalid:b']);
  });

  it('fails when the exemption count moves off its pin, either way', () => {
    const run = (pinned) =>
      scopeProblems({ registry: REGISTRY, declared: [], exempt: { a: WHY, b: WHY }, pinned });
    expect(run(2)).toEqual([]);
    expect(run(1).map((p) => p.message)).toEqual([
      expect.stringContaining('declare the new table'),
    ]);
    expect(run(3).map((p) => p.message)).toEqual([
      expect.stringContaining('lower ROW_IDENTITY_EXEMPT_PINNED to 2'),
    ]);
  });

  it('fails on a portable pattern rule, whose tables it cannot enumerate', () => {
    const registry = {
      ...REGISTRY,
      patterns: [{ match: '^x_.+$', class: 'portable-project', reason: 'fixture' }],
    };
    const problems = scopeProblems({ registry, declared: [{ table: 'a' }], exempt: { b: WHY } });
    expect(kinds(problems)).toEqual(['pattern:']);
  });
});

describe('names digest pin (L4)', () => {
  it('fails a swap at the same count, passes the pinned set', () => {
    const declared = [];
    const pinnedDigest = rowIdentityExemptDigest(['a', 'b']);
    expect(
      scopeProblems({
        registry: REGISTRY,
        declared,
        exempt: { a: WHY, b: WHY },
        pinned: 2,
        pinnedDigest,
      }),
    ).toEqual([]);
    const swapped = {
      ...REGISTRY,
      tables: { ...REGISTRY.tables, b: entry('local-only'), g: entry('portable-project') },
    };
    const problems = scopeProblems({
      registry: swapped,
      declared,
      exempt: { a: WHY, g: WHY },
      pinned: 2,
      pinnedDigest,
    });
    expect(problems.map((p) => p.message)).toEqual([expect.stringContaining('a swap')]);
  });

  it('is order-independent', () => {
    expect(rowIdentityExemptDigest(['b', 'a'])).toBe(rowIdentityExemptDigest(['a', 'b']));
  });
});

describe('PR mode against a base ref (M1)', () => {
  const reg = (project, global, pinned) => ({
    exempt: {
      project: Object.fromEntries(project.map((t) => [t, WHY])),
      global: Object.fromEntries(global.map((t) => [t, WHY])),
    },
    pinned,
  });
  const base = reg(['a', 'b'], ['x'], { project: 2, global: 1 });

  it('passes an unchanged or shrinking registry, and a base without exemptions', () => {
    expect(baseProblems(base, base)).toEqual([]);
    expect(baseProblems(reg(['a'], [], { project: 1, global: 0 }), base)).toEqual([]);
    expect(baseProblems(reg(['a', 'b', 'c'], ['x'], { project: 3, global: 1 }), null)).toEqual([]);
  });

  it('fails when a pin rose against the base', () => {
    expect(baseProblems(reg(['a', 'b'], ['x'], { project: 3, global: 1 }), base)).toEqual([
      expect.stringContaining('[project] ROW_IDENTITY_EXEMPT_PINNED rose from 2 to 3'),
    ]);
  });

  it('fails when the exempt name set grew against the base, even at the same count', () => {
    expect(baseProblems(reg(['a', 'c'], ['x'], { project: 2, global: 1 }), base)).toEqual([
      expect.stringContaining('[project] new exemption(s) against the base: c'),
    ]);
  });

  it('reads the registry at a git ref, and returns null where it has no exemptions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'row-identity-base-repo-'));
    try {
      const rel = 'packages/core/src/store/row-identity-registry.ts';
      const git = (...args) =>
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
          cwd: root,
          stdio: 'pipe',
        });
      git('init', '-q');
      mkdirSync(join(root, dirname(rel)), { recursive: true });
      writeFileSync(join(root, rel), 'export const ROW_IDENTITY = {};\n');
      git('add', '.');
      git('commit', '-qm', 'before the gate');
      writeFileSync(join(root, rel), readFileSync(join(REPO, rel), 'utf8'));
      git('commit', '-qam', 'with the gate');
      expect(await loadBaseRegistry(root, 'HEAD~1')).toBeNull();
      const loaded = await loadBaseRegistry(root, 'HEAD');
      expect(loaded?.pinned).toEqual(ROW_IDENTITY_EXEMPT_PINNED);
      expect(baseProblems(loaded, loaded)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('main() --base end to end (LOW-1)', () => {
  const REL = 'packages/core/src/store/row-identity-registry.ts';

  /** A temp git repo whose HEAD holds `source` at the registry path. */
  function repoWith(source) {
    const root = mkdtempSync(join(tmpdir(), 'row-identity-main-'));
    const git = (...args) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd: root,
        stdio: 'pipe',
      });
    git('init', '-q');
    mkdirSync(join(root, dirname(REL)), { recursive: true });
    writeFileSync(join(root, REL), source);
    git('add', '.');
    git('commit', '-qm', 'base');
    return root;
  }

  /** Run main() with stdout/stderr captured. */
  async function run(argv, root) {
    const out = [];
    const write = (chunk) => {
      out.push(String(chunk));
      return true;
    };
    const so = process.stdout.write;
    const se = process.stderr.write;
    process.stdout.write = write;
    process.stderr.write = write;
    try {
      return { code: await main(argv, { root }), text: out.join('') };
    } finally {
      process.stdout.write = so;
      process.stderr.write = se;
    }
  }

  it('passes against a base identical to head', async () => {
    const root = repoWith(readFileSync(join(REPO, REL), 'utf8'));
    try {
      const { code, text } = await run(['--check', '--base', 'HEAD'], root);
      expect(text).not.toContain('FAIL');
      expect(code).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when head raised the pin and exempted a table the base did not', async () => {
    const head = readFileSync(join(REPO, REL), 'utf8');
    const base = head
      .replace(
        /(ROW_IDENTITY_EXEMPT_PINNED[^=]*=\s*\{\s*project:\s*)(\d+)/,
        (_, a, n) => `${a}${Number(n) - 1}`,
      )
      .replace("        'schedules',\n", '');
    expect(base).not.toBe(head);
    const root = repoWith(base);
    try {
      const { code, text } = await run(['--check', '--base', 'HEAD'], root);
      expect(code).toBe(1);
      expect(text).toContain('[project] ROW_IDENTITY_EXEMPT_PINNED rose');
      expect(text).toContain('[project] new exemption(s) against the base: schedules');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('exemption tasks (L3)', () => {
  it('fails on a missing or closed task, passes open ones, checks each task once', () => {
    const seen = [];
    const statusOf = (task) => {
      seen.push(task);
      return (
        { T1: { status: 'pending' }, T2: { status: 'done' }, T3: { error: 'not found' } }[task] ?? {
          status: 'active',
        }
      );
    };
    expect(taskProblems(['T1', 'T2', 'T3', 'T1', 'T4'], statusOf)).toEqual([
      'task T2 is done: an exemption must name an open task',
      'task T3: not found',
    ]);
    expect(seen).toEqual(['T1', 'T2', 'T3', 'T4']);
  });
});

describe('arguments (L6)', () => {
  it('accepts only --check, --strict, --base <ref> and --verify-tasks', () => {
    expect(parseArgs(['--check'])).toEqual({ ok: true, base: undefined, verifyTasks: false });
    expect(parseArgs(['--strict', '--base', 'origin/main', '--verify-tasks'])).toEqual({
      ok: true,
      base: 'origin/main',
      verifyTasks: true,
    });
    expect(parseArgs(['--update-baseline'])).toMatchObject({ ok: false });
    expect(parseArgs(['--base'])).toMatchObject({ ok: false, error: '--base needs a git ref' });
    expect(parseArgs(['--base='])).toMatchObject({ ok: false, error: '--base needs a git ref' });
    expect(parseArgs(['--base=origin/main'])).toMatchObject({ ok: true, base: 'origin/main' });
    expect(parseArgs(['check'])).toMatchObject({ ok: false });
  });

  it('exits 2 on an unknown flag, and on an empty --base= (LOW-2)', () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--bogus'], { cwd: REPO, encoding: 'utf8' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('unknown argument --bogus');
    const empty = spawnSync(process.execPath, [SCRIPT, '--check', '--base='], {
      cwd: REPO,
      encoding: 'utf8',
    });
    expect(empty.status).toBe(2);
    expect(empty.stderr).toContain('--base needs a git ref');
  });
});

describe('the repository', () => {
  it('summarises exemptions consistently with the pin', () => {
    for (const scope of ['project', 'global']) {
      const summary = rowIdentityExemptionSummary(scope);
      expect(summary.total).toBe(ROW_IDENTITY_EXEMPT_PINNED[scope]);
      const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
      expect(sum(summary.byCategory)).toBe(summary.total);
      expect(sum(summary.byTask)).toBe(summary.total);
    }
  });

  it('passes the gate', () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--check'], { cwd: REPO, encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('every syncing table is declared or exempt');
  });
});
