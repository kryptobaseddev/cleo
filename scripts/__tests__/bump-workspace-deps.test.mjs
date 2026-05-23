/**
 * Regression tests for scripts/bump-workspace-deps.mjs (T10177).
 *
 * Critical guarantee under test: the release-prepare workflow's "Bump workspace
 * @cleocode/* dependency refs" step MUST only touch keys matching @cleocode/*.
 * External deps (tree-sitter, drizzle-orm, @forge-ts/cli, @biomejs/biome,
 * @types/node, typedoc, simple-git, etc.) MUST be left exactly as written —
 * regardless of whether their pinned value starts with a digit.
 *
 * Background: in v2026.5.100 the in-workflow jq filter bumped 10 external deps
 * to the workspace CalVer version. PR #480/#481 reverted them. v2026.5.101 hit
 * the same bug again (surgical revert at commit d26b76751). T10177 entrenches
 * the fix by extracting the bump logic to this script + tests.
 *
 * Strategy:
 *   - Build a synthetic monorepo under a tmpdir with the exact pathological
 *     deps the workflow ate in v5.100 (tree-sitter@0.21.1, drizzle-orm@0.30.0,
 *     @forge-ts/cli@^0.4.0, @types/node@^22.0.0).
 *   - Also pin synthetic @cleocode/* numeric deps that MUST move.
 *   - Run the script via both the API surface (bumpWorkspaceDeps) and the CLI
 *     surface (node scripts/bump-workspace-deps.mjs --version --root ...).
 *   - Assert ZERO external dep movement and EXACT @cleocode/* dep movement.
 *
 * @task T10177
 * @saga T10176
 * @decision D010
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bumpWorkspaceDeps, rewriteDepMap, shouldBump } from '../bump-workspace-deps.mjs';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT_PATH = resolve(REPO_ROOT, 'scripts/bump-workspace-deps.mjs');

/** Build a synthetic monorepo. Returns the tmpdir root. */
function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'bump-deps-test-'));
  mkdirSync(join(root, 'packages'), { recursive: true });

  // packages/alpha — has the v5.100 pathological external deps + valid @cleocode/* deps.
  mkdirSync(join(root, 'packages/alpha'), { recursive: true });
  writeFileSync(
    join(root, 'packages/alpha/package.json'),
    `${JSON.stringify(
      {
        name: '@cleocode/alpha',
        version: '2026.5.99',
        dependencies: {
          // External deps that v5.100 ate (must NOT bump):
          'tree-sitter': '0.21.1',
          'tree-sitter-c': '0.23.2',
          'tree-sitter-python': '0.23.4',
          'tree-sitter-rust': '0.23.1',
          'tree-sitter-cpp': '^0.23.4',
          'drizzle-orm': '0.30.0',
          'simple-git': '^3.20.0',
          '@forge-ts/cli': '^0.4.0',
          '@biomejs/biome': '^1.9.0',
          '@types/node': '^22.0.0',
          typedoc: '^0.26.0',
          '@aflsolutions/graphology-communities-leiden': '0.1.0',
          // Workspace refs (must remain workspace:*):
          '@cleocode/core': 'workspace:*',
          '@cleocode/contracts': 'workspace:*',
          // file: refs (must NOT bump):
          '@cleocode/worktree-napi': 'file:../../crates/worktree-napi',
          // Numeric @cleocode/* deps (MUST bump to new version):
          '@cleocode/legacy-numeric': '2026.5.99',
          '@cleocode/legacy-caret': '^2026.4.13',
        },
        devDependencies: {
          // External (must NOT bump):
          vitest: '^2.0.0',
          // Numeric @cleocode/* (MUST bump):
          '@cleocode/dev-tool': '2026.5.99',
        },
        peerDependencies: {
          // Numeric @cleocode/* (MUST bump):
          '@cleocode/peer': '2026.5.99',
        },
      },
      null,
      2,
    )}\n`,
  );

  // packages/beta — workspace-only, nothing to bump.
  mkdirSync(join(root, 'packages/beta'), { recursive: true });
  writeFileSync(
    join(root, 'packages/beta/package.json'),
    `${JSON.stringify(
      {
        name: '@cleocode/beta',
        version: '2026.5.99',
        dependencies: { '@cleocode/core': 'workspace:*' },
      },
      null,
      2,
    )}\n`,
  );

  // packages/gamma — empty package.json with only name+version, no deps section.
  mkdirSync(join(root, 'packages/gamma'), { recursive: true });
  writeFileSync(
    join(root, 'packages/gamma/package.json'),
    `${JSON.stringify({ name: '@cleocode/gamma', version: '2026.5.99' }, null, 2)}\n`,
  );

  return root;
}

describe('shouldBump (T10177 — unit-level guard)', () => {
  it('returns true for @cleocode/* with bare CalVer value', () => {
    expect(shouldBump('@cleocode/core', '2026.5.99')).toBe(true);
  });

  it('returns true for @cleocode/* with caret-pinned value', () => {
    expect(shouldBump('@cleocode/core', '^2026.5.99')).toBe(true);
  });

  it('returns false for @cleocode/* with workspace:* value', () => {
    expect(shouldBump('@cleocode/core', 'workspace:*')).toBe(false);
  });

  it('returns false for @cleocode/* with file: ref', () => {
    expect(shouldBump('@cleocode/worktree-napi', 'file:../../crates/worktree-napi')).toBe(false);
  });

  it('returns false for tree-sitter@0.21.1 (the v5.100 bug class)', () => {
    expect(shouldBump('tree-sitter', '0.21.1')).toBe(false);
  });

  it('returns false for drizzle-orm@0.30.0', () => {
    expect(shouldBump('drizzle-orm', '0.30.0')).toBe(false);
  });

  it('returns false for @forge-ts/cli (different scope)', () => {
    expect(shouldBump('@forge-ts/cli', '^0.4.0')).toBe(false);
  });

  it('returns false for @types/node', () => {
    expect(shouldBump('@types/node', '^22.0.0')).toBe(false);
  });

  it('returns false for @biomejs/biome', () => {
    expect(shouldBump('@biomejs/biome', '^1.9.0')).toBe(false);
  });

  it('returns false for non-string inputs', () => {
    expect(shouldBump(null, '2026.5.99')).toBe(false);
    expect(shouldBump('@cleocode/x', null)).toBe(false);
  });
});

describe('rewriteDepMap (T10177 — section-level guard)', () => {
  it('rewrites only @cleocode/* numeric refs, leaving externals untouched', () => {
    const map = {
      '@cleocode/core': '2026.5.99',
      '@cleocode/api': '^2026.4.13',
      '@cleocode/runtime': 'workspace:*',
      'tree-sitter': '0.21.1',
      'drizzle-orm': '0.30.0',
      '@forge-ts/cli': '^0.4.0',
    };
    const changes = rewriteDepMap(map, '2026.5.100');
    expect(changes).toEqual([
      { key: '@cleocode/core', from: '2026.5.99', to: '2026.5.100' },
      { key: '@cleocode/api', from: '^2026.4.13', to: '2026.5.100' },
    ]);
    expect(map).toEqual({
      '@cleocode/core': '2026.5.100',
      '@cleocode/api': '2026.5.100',
      '@cleocode/runtime': 'workspace:*',
      'tree-sitter': '0.21.1',
      'drizzle-orm': '0.30.0',
      '@forge-ts/cli': '^0.4.0',
    });
  });

  it('is a no-op on empty / missing dep map', () => {
    expect(rewriteDepMap({}, '2026.5.99')).toEqual([]);
    expect(rewriteDepMap(null, '2026.5.99')).toEqual([]);
    expect(rewriteDepMap(undefined, '2026.5.99')).toEqual([]);
  });
});

describe('bumpWorkspaceDeps (T10177 — integration against synthetic monorepo)', () => {
  /** @type {string} */
  let fixtureRoot;

  beforeEach(() => {
    fixtureRoot = buildFixture();
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('leaves ALL external deps untouched on alpha', async () => {
    await bumpWorkspaceDeps({ version: '2026.6.1', root: fixtureRoot });
    const alpha = JSON.parse(
      readFileSync(join(fixtureRoot, 'packages/alpha/package.json'), 'utf8'),
    );
    expect(alpha.dependencies['tree-sitter']).toBe('0.21.1');
    expect(alpha.dependencies['tree-sitter-c']).toBe('0.23.2');
    expect(alpha.dependencies['tree-sitter-python']).toBe('0.23.4');
    expect(alpha.dependencies['tree-sitter-rust']).toBe('0.23.1');
    expect(alpha.dependencies['tree-sitter-cpp']).toBe('^0.23.4');
    expect(alpha.dependencies['drizzle-orm']).toBe('0.30.0');
    expect(alpha.dependencies['simple-git']).toBe('^3.20.0');
    expect(alpha.dependencies['@forge-ts/cli']).toBe('^0.4.0');
    expect(alpha.dependencies['@biomejs/biome']).toBe('^1.9.0');
    expect(alpha.dependencies['@types/node']).toBe('^22.0.0');
    expect(alpha.dependencies['typedoc']).toBe('^0.26.0');
    expect(alpha.dependencies['@aflsolutions/graphology-communities-leiden']).toBe('0.1.0');
    expect(alpha.devDependencies['vitest']).toBe('^2.0.0');
  });

  it('moves every @cleocode/* numeric ref to the new version', async () => {
    await bumpWorkspaceDeps({ version: '2026.6.1', root: fixtureRoot });
    const alpha = JSON.parse(
      readFileSync(join(fixtureRoot, 'packages/alpha/package.json'), 'utf8'),
    );
    expect(alpha.dependencies['@cleocode/legacy-numeric']).toBe('2026.6.1');
    expect(alpha.dependencies['@cleocode/legacy-caret']).toBe('2026.6.1');
    expect(alpha.devDependencies['@cleocode/dev-tool']).toBe('2026.6.1');
    expect(alpha.peerDependencies['@cleocode/peer']).toBe('2026.6.1');
  });

  it('leaves workspace:* and file: refs untouched', async () => {
    await bumpWorkspaceDeps({ version: '2026.6.1', root: fixtureRoot });
    const alpha = JSON.parse(
      readFileSync(join(fixtureRoot, 'packages/alpha/package.json'), 'utf8'),
    );
    expect(alpha.dependencies['@cleocode/core']).toBe('workspace:*');
    expect(alpha.dependencies['@cleocode/contracts']).toBe('workspace:*');
    expect(alpha.dependencies['@cleocode/worktree-napi']).toBe('file:../../crates/worktree-napi');
  });

  it('returns an accurate change report', async () => {
    const report = await bumpWorkspaceDeps({ version: '2026.6.1', root: fixtureRoot });
    expect(report.version).toBe('2026.6.1');
    expect(report.filesScanned).toBe(3);
    expect(report.filesChanged).toBe(1); // only alpha has bumpable refs
    expect(report.changes.length).toBe(4);
    const keys = report.changes.map((c) => `${c.kind}.${c.key}`).sort();
    expect(keys).toEqual([
      'dependencies.@cleocode/legacy-caret',
      'dependencies.@cleocode/legacy-numeric',
      'devDependencies.@cleocode/dev-tool',
      'peerDependencies.@cleocode/peer',
    ]);
  });

  it('does not write files in dry-run mode', async () => {
    const before = readFileSync(join(fixtureRoot, 'packages/alpha/package.json'), 'utf8');
    const report = await bumpWorkspaceDeps({
      version: '2026.6.1',
      root: fixtureRoot,
      dryRun: true,
    });
    const after = readFileSync(join(fixtureRoot, 'packages/alpha/package.json'), 'utf8');
    expect(after).toBe(before);
    expect(report.changes.length).toBe(4);
  });

  it('throws on invalid version', async () => {
    await expect(bumpWorkspaceDeps({ version: 'not-calver', root: fixtureRoot })).rejects.toThrow(
      /Invalid version/,
    );
  });

  it('CLI invocation produces the same report and leaves externals alone', () => {
    const result = spawnSync(
      'node',
      [SCRIPT_PATH, '--version', '2026.6.1', '--root', fixtureRoot, '--json'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.version).toBe('2026.6.1');
    expect(report.changes.length).toBe(4);
    const alpha = JSON.parse(
      readFileSync(join(fixtureRoot, 'packages/alpha/package.json'), 'utf8'),
    );
    expect(alpha.dependencies['tree-sitter']).toBe('0.21.1');
    expect(alpha.dependencies['drizzle-orm']).toBe('0.30.0');
    expect(alpha.dependencies['@cleocode/legacy-numeric']).toBe('2026.6.1');
  });

  it('CLI rejects invalid version with exit 1', () => {
    const result = spawnSync(
      'node',
      [SCRIPT_PATH, '--version', 'not-calver', '--root', fixtureRoot],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Invalid version/);
  });
});

describe('Regression guard: real repo packages/* (T10177)', () => {
  it('script exists and is executable as a module', () => {
    // Sanity: importing the named exports above succeeded — this test asserts
    // the file is wired and prevents an accidental rename without test update.
    expect(typeof bumpWorkspaceDeps).toBe('function');
    expect(typeof rewriteDepMap).toBe('function');
    expect(typeof shouldBump).toBe('function');
  });
});
