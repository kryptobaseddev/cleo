/**
 * Tests for the PR unit-shard project selection (T13142): which projects an
 * affected run selects, every fall-back to the full suite, and the ci.yml
 * wiring that keeps main, nightly, merge-group and dispatch runs full.
 *
 * @task T13142
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
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
