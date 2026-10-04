/**
 * Every repo-root script a package unit test depends on is in ci.yml's `code`
 * filter (T13175 review).
 *
 * `scripts/**` is deliberately outside `code` (gh#1403): a scripts-only change
 * runs Scripts Tests, not the package unit shards, and `ci:<pr>` may attest it
 * through `evidence.ciChecks.covering`. That is only sound when no package test
 * imports or runs the changed script. Several do (store fingerprint gates,
 * nested-nexus migration, injection flags, ...), so each such script must be
 * listed under `code`, where a change to it runs the unit tests.
 *
 * A dependency here is a relative import, dynamic import or require from any
 * package file, or a `scripts/...` path a package TEST file names (the tests
 * that spawn a script with `join(REPO_ROOT, 'scripts/x.mjs')`).
 *
 * T13177: the PR-affected selection (`ci-affected-test-projects.mjs`, T13142)
 * must not narrow such a change to the `scripts` project either, or Unit Tests
 * would succeed without running the importing packages' tests. It treats any
 * path outside every workspace package as workspace-wide and runs the full
 * suite; `packages/core/src/tasks/__tests__/affected-packages.test.ts` pins
 * that (this job runs without a build, so it cannot import core).
 *
 * @task T13175
 * @task T13177
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Repo-root scripts that package files import, or package tests name. */
function scriptDependencies() {
  const files = execFileSync('git', ['ls-files', 'packages'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.(m?ts|m?js|cjs)$/.test(f));
  const isTest = (f) => /(__tests__\/|\.test\.|\.spec\.)/.test(f);
  /** @type {Map<string, string>} */
  const deps = new Map();
  const add = (rel, from) => {
    if (rel.startsWith('scripts/') && existsSync(path.join(REPO_ROOT, rel)) && !deps.has(rel))
      deps.set(rel, from);
  };
  for (const f of files) {
    const src = readFileSync(path.join(REPO_ROOT, f), 'utf8');
    const resolveRel = (spec) =>
      path.relative(REPO_ROOT, path.resolve(path.dirname(path.join(REPO_ROOT, f)), spec));
    for (const m of src.matchAll(
      /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"`](\.{1,2}\/[^'"`]+)['"`]/g,
    ))
      add(resolveRel(m[1]), f);
    if (isTest(f)) {
      for (const m of src.matchAll(/['"`]((?:\.\.\/)+scripts\/[\w./-]+)['"`]/g))
        add(resolveRel(m[1]), f);
      for (const m of src.matchAll(/['"`](scripts\/[\w./-]+\.(?:mjs|cjs|js|ts|sh))['"`]/g))
        add(m[1], f);
    }
  }
  return deps;
}

/** paths-filter glob (`**` any depth, `*` within a segment) to a RegExp. */
function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      out += '.*';
      i++;
    } else if (ch === '*') out += '[^/]*';
    else out += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** The `code` filter of ci.yml's paths-filter step. */
function codeFilter() {
  const ci = parseYaml(readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8'));
  for (const job of Object.values(ci.jobs)) {
    for (const step of job.steps ?? []) {
      if (typeof step.with?.filters === 'string' && step.with.filters.includes('code:')) {
        return parseYaml(step.with.filters).code;
      }
    }
  }
  throw new Error('ci.yml has no paths-filter step with a `code` filter');
}

describe('ci.yml `code` filter covers the scripts package tests depend on (T13175)', () => {
  const code = codeFilter().map(globToRegExp);
  const deps = scriptDependencies();

  it('finds the known dependencies (the scan works)', () => {
    expect([...deps.keys()]).toEqual(
      expect.arrayContaining([
        'scripts/lib/path-containment.mjs',
        'scripts/migrate-nested-nexus.mjs',
        'scripts/lint-injection-flags.mjs',
      ]),
    );
  });

  it('every such script is listed under `code`', () => {
    const missing = [...deps]
      .filter(([script]) => !code.some((re) => re.test(script)))
      .map(([script, from]) => `${script} (used by ${from})`);
    expect(missing, 'add each to the `code` filter in ci.yml and macos-main.yml').toEqual([]);
  });
});
