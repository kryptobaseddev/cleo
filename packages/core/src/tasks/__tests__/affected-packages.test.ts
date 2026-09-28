/**
 * Affected-package test runs (owner decision D11150, T12635).
 *
 * Pinned:
 *  1. the affected set is the packages the diff touches plus every workspace
 *     package that depends on them, transitively;
 *  2. a change outside every package that can affect them all (lockfile,
 *     workspace config, root build/test config) demands a full run;
 *  3. documentation outside the code roots is ignored;
 *  4. `tool:test-affected` runs the configured command over that set and
 *     records `scope: 'affected'` plus the packages on the atom.
 *
 * @task T12635
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildAffectedTestCommand,
  deriveAffectedPackages,
  listWorkspacePackages,
} from '../affected-packages.js';
import { validateAtom } from '../evidence.js';

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();
}

let root: string;

function pkg(dir: string, name: string, deps: Record<string, string> = {}): void {
  mkdirSync(join(root, dir, 'src'), { recursive: true });
  writeFileSync(
    join(root, dir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', dependencies: deps }),
  );
  writeFileSync(join(root, dir, 'src', 'index.ts'), `export const n = '${name}';\n`);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'affected-')));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root', private: true }));
  writeFileSync(
    join(root, 'pnpm-workspace.yaml'),
    'packages:\n  - "packages/*"\n  - "tools/one"\n',
  );
  pkg('packages/a', '@x/a');
  pkg('packages/b', '@x/b', { '@x/a': 'workspace:*' });
  // A longer directory is visited before packages/b: a single pass would miss
  // this second-order dependent.
  pkg('packages/dependent-of-b', '@x/d', { '@x/b': 'workspace:^' });
  pkg('packages/c', '@x/c', { lodash: '^4' });
  pkg('tools/one', '@x/tool');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('workspace discovery', () => {
  it('reads packages/* globs and exact entries from pnpm-workspace.yaml', () => {
    const names = listWorkspacePackages(root).map((p) => p.name);
    expect(names.sort()).toEqual(['@x/a', '@x/b', '@x/c', '@x/d', '@x/tool']);
  });
});

describe('deriveAffectedPackages', () => {
  it('includes every dependent, transitively', () => {
    const r = deriveAffectedPackages(root, ['packages/a/src/index.ts']);
    expect(r).toEqual({ scope: 'affected', direct: ['@x/a'], packages: ['@x/a', '@x/b', '@x/d'] });
  });

  it('a leaf change affects only its own package', () => {
    expect(deriveAffectedPackages(root, ['packages/c/src/index.ts'])).toEqual({
      scope: 'affected',
      direct: ['@x/c'],
      packages: ['@x/c'],
    });
  });

  it('ignores documentation outside the code roots', () => {
    const r = deriveAffectedPackages(root, ['README.md', 'docs/x.md', 'packages/c/src/index.ts']);
    expect(r.scope === 'affected' && r.packages).toEqual(['@x/c']);
  });

  it.each([
    ['pnpm-lock.yaml'],
    ['package.json'],
    ['tsconfig.base.json'],
    ['vitest.config.ts'],
    ['scripts/x.mjs'],
  ])('a workspace-wide change (%s) demands a full run', (path) => {
    const r = deriveAffectedPackages(root, [path, 'packages/c/src/index.ts']);
    expect(r.scope).toBe('full');
    expect(r.scope === 'full' && r.reason).toContain(path);
  });

  it('a documentation-only diff affects nothing', () => {
    expect(deriveAffectedPackages(root, ['README.md'])).toEqual({
      scope: 'affected',
      direct: [],
      packages: [],
    });
  });
});

describe('buildAffectedTestCommand', () => {
  it('expands {projects}, {filters} and {packages} into separate arguments', () => {
    expect(buildAffectedTestCommand('pnpm exec vitest run {projects}', ['@x/a', '@x/b'])).toEqual({
      cmd: 'pnpm',
      args: ['exec', 'vitest', 'run', '--project', '@x/a', '--project', '@x/b'],
    });
    expect(buildAffectedTestCommand('pnpm {filters} test', ['@x/a']).args).toEqual([
      '--filter',
      '@x/a',
      'test',
    ]);
    expect(buildAffectedTestCommand('run {packages}', ['@x/a', '@x/b']).args).toEqual([
      '@x/a',
      '@x/b',
    ]);
  });
});

describe('tool:test-affected evidence', () => {
  function initRepo(affectedCommand?: string): void {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.name', 'T']);
    git(root, ['config', 'user.email', 't@e.x']);
    mkdirSync(join(root, '.cleo'), { recursive: true });
    writeFileSync(join(root, '.gitignore'), '.cleo/\n');
    writeFileSync(
      join(root, '.cleo', 'project-context.json'),
      JSON.stringify({
        primaryType: 'node',
        testing: { command: 'node -e 0', ...(affectedCommand ? { affectedCommand } : {}) },
      }),
    );
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'init']);
    const origin = `${root}-origin.git`;
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    git(root, ['remote', 'add', 'origin', origin]);
    git(root, ['push', '-q', '-u', 'origin', 'main']);
    git(root, ['remote', 'set-head', 'origin', 'main']);
    git(root, ['switch', '-q', '-c', 'task/T1']);
  }
  afterEach(() => rmSync(`${root}-origin.git`, { recursive: true, force: true }));

  it('runs the configured command over the affected set and records scope:affected', async () => {
    // The command itself asserts it received exactly the affected packages.
    initRepo(
      "node -e process.exit(process.argv.slice(1).join(',')==='@x/a,@x/b,@x/d'?0:3) {packages}",
    );
    writeFileSync(join(root, 'packages/a/src/index.ts'), "export const n = 'changed';\n");
    git(root, ['commit', '-q', '-am', 'T1: change a']);
    const r = await validateAtom({ kind: 'tool', tool: 'test-affected' }, root);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.ok && r.atom).toMatchObject({
      kind: 'tool',
      tool: 'test-affected',
      exitCode: 0,
      scope: 'affected',
      affectedPackages: ['@x/a', '@x/b', '@x/d'],
    });
  });

  it('a failing affected run is E_EVIDENCE_TOOL_FAILED', async () => {
    initRepo('node -e process.exit(1) {packages}');
    writeFileSync(join(root, 'packages/c/src/index.ts'), "export const n = 'changed';\n");
    git(root, ['commit', '-q', '-am', 'T1: change c']);
    const r = await validateAtom({ kind: 'tool', tool: 'test-affected' }, root);
    expect(!r.ok && r.codeName).toBe('E_EVIDENCE_TOOL_FAILED');
  });

  it('refuses a workspace-wide change, pointing at tool:test', async () => {
    initRepo('node -e 0 {packages}');
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    git(root, ['add', 'pnpm-lock.yaml']);
    git(root, ['commit', '-q', '-m', 'T1: lock']);
    const r = await validateAtom({ kind: 'tool', tool: 'test-affected' }, root);
    expect(!r.ok && r.reason).toMatch(/pnpm-lock\.yaml.*tool:test/s);
  });

  it('refuses when testing.affectedCommand is not configured', async () => {
    initRepo();
    writeFileSync(join(root, 'packages/c/src/index.ts'), "export const n = 'changed';\n");
    git(root, ['commit', '-q', '-am', 'T1: change c']);
    const r = await validateAtom({ kind: 'tool', tool: 'test-affected' }, root);
    expect(!r.ok && r.reason).toMatch(/testing\.affectedCommand/);
  });
});
