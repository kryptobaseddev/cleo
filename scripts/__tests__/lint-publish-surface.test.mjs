/**
 * Tests for scripts/lint-publish-surface.mjs (T11400 · E1 · SG-PACKAGE-ARCH).
 *
 * Strategy
 * --------
 *   - The bulk of the logic is the pure exported `checkPublishSurface({ repoRoot })`.
 *     Each test builds a synthetic tree under a tmpdir (a `.github/workflows/
 *     release.yml` with N `publish_pkg` lines + `packages/<name>/package.json`
 *     for each) and asserts on the returned `{ violations, count }`. This
 *     exercises every branch without touching the real release.yml.
 *   - One integration smoke test spawns the real script against the real repo
 *     root and asserts exit 0 — proving the committed surface is clean.
 *
 * Cases (AC4): a clean surface passes; injecting a 19th entry, a private
 * package, a misnamed package, or a re-added worktree-napi-* stub (in the list
 * OR on disk) each produces a violation.
 *
 * @task T11400
 * @epic T11388
 * @saga T11387
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkPublishSurface,
  EXPECTED_PUBLISH_COUNT,
  parsePublishCalls,
} from '../lint-publish-surface.mjs';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/lint-publish-surface.mjs');

/** @type {string} */
let tmpRoot;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-publish-surface-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Build a synthetic repo tree.
 *
 * @param {object} opts
 * @param {Array<{ dir: string, npmName?: string }>} opts.publishes - publish_pkg lines
 * @param {Array<{ dir: string, name: string, private?: boolean }>} opts.packages - on-disk packages
 * @param {string[]} [opts.extraPackageDirs] - extra empty `packages/<x>/` dirs (e.g. napi stubs)
 */
function buildTree({ publishes, packages, extraPackageDirs = [] }) {
  const wfDir = join(tmpRoot, '.github', 'workflows');
  mkdirSync(wfDir, { recursive: true });
  const lines = [
    'jobs:',
    '  publish:',
    '    steps:',
    '      - run: |',
    '          publish_pkg() {',
    '            echo "noop"',
    '          }',
    ...publishes.map((p) => `          publish_pkg ${p.dir}${p.npmName ? ` ${p.npmName}` : ''}`),
  ];
  writeFileSync(join(wfDir, 'release.yml'), `${lines.join('\n')}\n`, 'utf8');

  for (const pkg of packages) {
    const dir = join(tmpRoot, 'packages', pkg.dir);
    mkdirSync(dir, { recursive: true });
    const manifest = { name: pkg.name, version: '0.0.0' };
    if (pkg.private) manifest.private = true;
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest), 'utf8');
  }
  for (const d of extraPackageDirs) {
    mkdirSync(join(tmpRoot, 'packages', d), { recursive: true });
  }
}

/** Generate N clean, valid, public package specs + matching publish lines. */
function cleanSurface(n) {
  const dirs = Array.from({ length: n }, (_, i) => `pkg${i}`);
  return {
    publishes: dirs.map((dir) => ({ dir })),
    packages: dirs.map((dir) => ({ dir, name: `@cleocode/${dir}` })),
  };
}

describe('parsePublishCalls', () => {
  it('ignores the publish_pkg() definition line and comments', () => {
    const text = [
      '          publish_pkg() {',
      '          # publish_pkg commented-out',
      '          publish_pkg contracts',
      '          publish_pkg cleo-os',
      '          publish_pkg cleo-git-shim git-shim', // 2-token form: dir + prefix-less npm name
    ].join('\n');
    const calls = parsePublishCalls(text);
    expect(calls.map((c) => c.dir)).toEqual(['contracts', 'cleo-os', 'cleo-git-shim']);
    expect(calls[2].npmName).toBe('git-shim');
  });
});

describe('checkPublishSurface', () => {
  it('passes on a clean surface of exactly EXPECTED_PUBLISH_COUNT public packages', () => {
    buildTree(cleanSurface(EXPECTED_PUBLISH_COUNT));
    const { violations, count } = checkPublishSurface({ repoRoot: tmpRoot });
    expect(count).toBe(EXPECTED_PUBLISH_COUNT);
    expect(violations).toEqual([]);
  });

  it('FAILS when a 19th entry is added (count regression)', () => {
    buildTree(cleanSurface(EXPECTED_PUBLISH_COUNT + 1));
    const { violations, count } = checkPublishSurface({ repoRoot: tmpRoot });
    expect(count).toBe(EXPECTED_PUBLISH_COUNT + 1);
    expect(violations.some((v) => /count grew|REGRESSION/i.test(v))).toBe(true);
  });

  it('FAILS when a listed package is private', () => {
    const tree = cleanSurface(EXPECTED_PUBLISH_COUNT);
    tree.packages[0] = { dir: 'pkg0', name: '@cleocode/pkg0', private: true };
    buildTree(tree);
    const { violations } = checkPublishSurface({ repoRoot: tmpRoot });
    expect(violations.some((v) => /private/i.test(v))).toBe(true);
  });

  it('FAILS when a listed package name does not match @cleocode/<arg>', () => {
    const tree = cleanSurface(EXPECTED_PUBLISH_COUNT);
    tree.packages[0] = { dir: 'pkg0', name: '@wrong/pkg0' };
    buildTree(tree);
    const { violations } = checkPublishSurface({ repoRoot: tmpRoot });
    expect(violations.some((v) => /!==.*expected/i.test(v))).toBe(true);
  });

  it('FAILS when a worktree-napi-* stub is in the publish list', () => {
    const tree = cleanSurface(EXPECTED_PUBLISH_COUNT - 1);
    tree.publishes.push({ dir: 'worktree-napi-linux-x64-gnu' });
    tree.packages.push({
      dir: 'worktree-napi-linux-x64-gnu',
      name: '@cleocode/worktree-napi-linux-x64-gnu',
    });
    buildTree(tree);
    const { violations } = checkPublishSurface({ repoRoot: tmpRoot });
    expect(violations.some((v) => /napi stub is forbidden/i.test(v))).toBe(true);
  });

  it('FAILS when a worktree-napi-* stub dir exists on disk (even if not published)', () => {
    const tree = cleanSurface(EXPECTED_PUBLISH_COUNT);
    tree.extraPackageDirs = ['worktree-napi-darwin-arm64'];
    buildTree(tree);
    const { violations } = checkPublishSurface({ repoRoot: tmpRoot });
    expect(violations.some((v) => /exists on disk/i.test(v))).toBe(true);
  });
});

describe('integration: real repo tree', () => {
  it('the committed publish surface passes (exit 0)', () => {
    const res = spawnSync('node', [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/publish-surface:/);
  });
});
