/**
 * T14385: a draft pull request runs only the cheap lint and admission jobs,
 * `ready_for_review` starts the full pipeline, and the required `CI` context
 * is never reported for a draft (so it stays pending and cannot pass).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ci = parseYaml(readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8'));
const DRAFT_GATE = "needs.changes.outputs.draft != 'true'";

/** A job that runs the build, the test suites or a native/smoke gate. */
const HEAVY = [
  'build',
  'typecheck',
  'build-verify',
  'packed-artifact',
  'forge-ts-check',
  'scripts-tests',
  // T14368: one job replaced Manual Write Sweep, both Canon Drift Checks and
  // the Docs SSoT Drift Gate.
  'post-build-checks',
  'exodus-parity-gate',
  'row-identity-gate-b',
  'worktree-napi-gate',
  'worktrunk-core-tests',
  'cant-napi-gate',
  'cleo-supervisor-smoke-gate',
  'release-pipeline-matrix-gate',
  'arch-gates',
];

describe('draft pull requests (T14385)', () => {
  it('triggers on the default pull_request types plus ready_for_review', () => {
    expect(ci.on.pull_request.types).toEqual(
      expect.arrayContaining(['opened', 'synchronize', 'reopened', 'ready_for_review']),
    );
  });

  it('exposes the draft flag from the changes job', () => {
    expect(ci.jobs.changes.outputs.draft).toContain('github.event.pull_request.draft');
  });

  it.each(HEAVY)('%s skips on a draft', (job) => {
    expect(ci.jobs[job].if).toContain(DRAFT_GATE);
  });

  it('jobs needing build skip with it, never running under always()', () => {
    for (const job of ['unit-tests', 'install-test', 'core-bundle-budget']) {
      expect(ci.jobs[job].needs).toContain('build');
      expect(ci.jobs[job].if ?? '').not.toContain('always()');
    }
  });

  it('the aggregate reports `CI` only for a non-draft run', () => {
    const name = ci.jobs.ci.name;
    expect(name).toContain('github.event.pull_request.draft');
    expect(name).toMatch(/\|\| 'CI' \}\}$/);
    expect(ci.jobs.ci.if).toBe('always()');
  });

  it('keeps the cheap lint and admission jobs ungated', () => {
    for (const job of ['biome', 'repo-lints', 'contracts-dep-lint', 'changes']) {
      expect(ci.jobs[job].if ?? '').not.toContain(DRAFT_GATE);
    }
  });
});
