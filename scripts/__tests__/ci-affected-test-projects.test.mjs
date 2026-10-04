/**
 * Tests for the PR unit-shard project selection (T13142): which projects an
 * affected run selects, every fall-back to the full suite, and the ci.yml
 * wiring that keeps main, nightly, merge-group and dispatch runs full.
 *
 * @task T13142
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { REPO_GUARD_TESTS } from '../../vitest.repo-guards.ts';
import { projectArgs, selectTestProjects } from '../ci-affected-test-projects.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** A derive stand-in: paths under packages/<x>/ belong to @x; anything else is workspace-wide. */
function derive(changed) {
  const direct = new Set();
  for (const p of changed) {
    const m = /^packages\/([^/]+)\//.exec(p);
    if (m) direct.add(`@${m[1]}`);
    else if (!p.startsWith('docs/'))
      return { scope: 'full', reason: `outside every workspace package: ${p}` };
  }
  const packages = [...direct];
  if (direct.has('@core')) packages.push('@cleo');
  return { scope: 'affected', direct: [...direct], packages };
}

const targets =
  (projects, untested = []) =>
  async () => ({ ok: true, projects, untested });

describe('selectTestProjects', () => {
  it('selects the affected projects and says why', async () => {
    const s = await selectTestProjects(
      ['packages/core/src/a.ts'],
      derive,
      targets(['@core', '@cleo', 'scripts'], ['@nodeps']),
    );
    expect(s).toEqual({
      mode: 'affected',
      projects: ['@core', '@cleo', 'scripts'],
      reason: 'changed @core; affected @core, @cleo; no tests in @nodeps',
    });
  });

  it('runs the full suite for a workspace-wide change, an empty or unreadable diff, or a docs-only diff', async () => {
    const never = async () => {
      throw new Error('targets must not be asked');
    };
    expect(await selectTestProjects(['pnpm-lock.yaml'], derive, never)).toMatchObject({
      mode: 'full',
    });
    expect(await selectTestProjects(null, derive, never)).toMatchObject({ mode: 'full' });
    expect(await selectTestProjects([], derive, never)).toMatchObject({ mode: 'full' });
    expect(await selectTestProjects(['docs/x.md'], derive, never)).toMatchObject({ mode: 'full' });
  });

  it('runs the full suite when the projects cannot be resolved or none is selected', async () => {
    const refused = async () => ({
      ok: false,
      reason: 'no vitest project runs the tests of changed package(s) @x',
    });
    expect(await selectTestProjects(['packages/x/a.ts'], derive, refused)).toEqual({
      mode: 'full',
      reason: 'no vitest project runs the tests of changed package(s) @x',
    });
    expect(await selectTestProjects(['packages/x/a.ts'], derive, targets([]))).toMatchObject({
      mode: 'full',
    });
  });
});

describe('projectArgs', () => {
  it('renders --project per name and refuses anything shell-unsafe', () => {
    expect(projectArgs(['@cleocode/core', 'scripts'])).toBe(
      '--project @cleocode/core --project scripts',
    );
    expect(() => projectArgs(['a; rm -rf /'])).toThrow(/unexpected vitest project name/);
  });
});

describe('ci.yml wiring (T13142)', () => {
  const ci = parseYaml(readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8'));
  const steps = ci.jobs['unit-tests'].steps;

  it('selects affected projects on pull requests only, from the merge commit against its base', () => {
    const select = steps.find((s) => s.id === 'affected');
    expect(select?.if).toBe("github.event_name == 'pull_request'");
    expect(select?.run).toBe('node scripts/ci-affected-test-projects.mjs HEAD^1 HEAD');
    expect(steps[0].with?.['fetch-depth']).toBe(2);
    // It runs after the build output and dependencies are in place, before the tests.
    const at = (pred) => steps.findIndex(pred);
    expect(at((s) => s.id === 'affected')).toBeGreaterThan(
      at((s) => s.run === 'pnpm install --frozen-lockfile'),
    );
    expect(at((s) => s.id === 'affected')).toBeLessThan(
      at((s) => String(s.name).startsWith('Run unit tests')),
    );
  });

  it('passes the selection to vitest only when there is one', () => {
    const run = steps.find((s) => String(s.name).startsWith('Run unit tests'));
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, matched literally in ci.yml
    expect(run.env?.AFFECTED_ARGS).toBe('${{ steps.affected.outputs.args }}');
    expect(run.run).toContain('SCOPE_FLAGS="$AFFECTED_ARGS --passWithNoTests"');
    expect(run.run).toContain('$RETRY_FLAG $SCOPE_FLAGS');
  });
});

describe('repo-guard tests run in the always-selected repo-guards project (T13142 review)', () => {
  const read = (p) => readFileSync(path.join(REPO_ROOT, p), 'utf8');

  it('every listed guard test exists and is not quarantined', () => {
    const quarantine = read('packages/cleo/vitest.quarantine.ts');
    for (const file of REPO_GUARD_TESTS) {
      expect(existsSync(path.join(REPO_ROOT, file)), file).toBe(true);
      expect(quarantine.includes(file), file).toBe(false);
    }
  });

  it('the root config declares the package-less repo-guards project from the list', () => {
    const root = read('vitest.config.ts');
    expect(root).toContain("name: 'repo-guards'");
    expect(root).toContain('include: [...REPO_GUARD_TESTS]');
  });

  it("each guard test's home project excludes it", () => {
    for (const file of REPO_GUARD_TESTS) {
      const pkg = /^packages\/([^/]+)\//.exec(file)?.[1];
      expect(pkg, file).toBeDefined();
      expect(read(`packages/${pkg}/vitest.config.ts`), file).toContain(
        `repoGuardsUnder('packages/${pkg}/')`,
      );
    }
  });
});
