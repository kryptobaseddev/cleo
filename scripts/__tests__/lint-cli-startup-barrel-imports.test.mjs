/**
 * T12203 / gh#1439 — exercise the actual required workflow command, including
 * a prohibited importer and the aggregate's response to its failed job.
 * This certifies local command behavior, not an observed GitHub execution.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const SCRIPT = 'scripts/lint-cli-startup-barrel-imports.mjs';
const BASELINE = 'scripts/.lint-cli-startup-barrel-baseline.json';
const JOB = 'cli-boundary-lint';
const WORKFLOW = '.github/workflows/ci.yml';
let directory;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'cleo-startup-barrel-ci-'));
  mkdirSync(join(directory, 'scripts'), { recursive: true });
  mkdirSync(join(directory, 'packages/cleo/src'), { recursive: true });
  copyFileSync(SCRIPT, join(directory, SCRIPT));
  copyFileSync(BASELINE, join(directory, BASELINE));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** Read the shipped workflow for every assertion rather than keeping a command copy. */
function workflow() {
  return parseYaml(readFileSync(WORKFLOW, 'utf8'));
}

/** Locate the real run step; a missing/disabled gate is a failure, never a skipped test. */
function gateStep() {
  const step = workflow().jobs[JOB].steps.find((candidate) => candidate.run?.includes(SCRIPT));
  if (!step) throw new Error('Required CI job does not invoke the startup barrel gate');
  expect(step.if).toBeUndefined();
  expect(step['continue-on-error']).toBeUndefined();
  return step;
}

/** Execute the workflow shell command in a disposable project with a hard deadline. */
function run(command, extraEnv = {}) {
  const result = spawnSync(
    'bash',
    ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', command],
    {
      cwd: directory,
      env: { ...process.env, ...extraEnv },
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 100_000,
    },
  );
  if (result.error) throw result.error;
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

/** Independent importer fixture at the unchanged committed count, plus an optional regression. */
function seed(extraImport = '') {
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')).total;
  const imports = Array.from(
    { length: baseline },
    (_, index) => `import { getProjectRoot as existing${index} } from '@cleocode/core';`,
  );
  writeFileSync(join(directory, 'packages/cleo/src/existing.ts'), `${imports.join('\n')}\n`);
  writeFileSync(join(directory, 'packages/cleo/src/regression.ts'), `${extraImport}\n`);
  return baseline;
}

describe('startup barrel ratchet reaches required CI', () => {
  it('runs unconditionally on PRs to main and merge groups, feeding the required aggregate', () => {
    const document = workflow();
    expect(document.on.pull_request.branches).toContain('main');
    expect(Object.hasOwn(document.on, 'merge_group')).toBe(true);
    expect(document.on.pull_request.paths).toBeUndefined();
    expect(document.jobs[JOB].if).toBeUndefined();
    expect(document.jobs[JOB]['continue-on-error']).toBeUndefined();
    expect(document.jobs.ci.name).toBe('CI');
    expect(document.jobs.ci.needs).toContain(JOB);
    expect(gateStep().run).not.toMatch(/--(?:update-baseline|baseline)/);
  });

  it('accepts exactly the committed baseline without rewriting it', () => {
    const baseline = seed();
    const before = readFileSync(join(directory, BASELINE), 'utf8');
    const result = run(gateStep().run);
    expect(result.code).toBe(0);
    expect(result.output).toContain(`OK — ${baseline} static core-barrel import(s)`);
    expect(readFileSync(join(directory, BASELINE), 'utf8')).toBe(before);
  });

  it.each([
    '@cleocode/core',
    '@cleocode/core/internal',
  ])('fails the actual job command for one added %s importer', (specifier) => {
    const baseline = seed(`import { getProjectRoot } from '${specifier}';`);
    const result = run(gateStep().run);
    expect(result.code).toBe(1);
    expect(result.output).toContain(`${baseline + 1} static core-barrel import(s)`);
    expect(result.output).toContain(`baseline ${baseline}`);
    expect(result.output).toContain('packages/cleo/src/regression.ts');
  });

  it('accepts a deep import and a lazy barrel import through that same command', () => {
    seed(
      "import { getTaskAccessor } from '@cleocode/core/store/data-accessor';\nconst load = () => import('@cleocode/core');",
    );
    expect(run(gateStep().run).code).toBe(0);
  });

  it('propagates the deliberate gate failure through the actual CI aggregate shell', () => {
    seed("import { getProjectRoot } from '@cleocode/core';");
    const result = run(gateStep().run);
    expect(result.code).toBe(1);
    const aggregate = workflow().jobs.ci.steps.find((step) => step.run);
    const outcome = run(aggregate.run, {
      RESULTS: 'failure,success',
      NEEDS_JSON: JSON.stringify({
        [JOB]: { result: 'failure' },
        'forge-ts-check': { result: 'success' },
      }),
      ADVISORY_RESULT: 'success',
      GITHUB_STEP_SUMMARY: join(directory, 'step-summary.md'),
    });
    expect(outcome.code).toBe(1);
    expect(outcome.output).toContain(JOB);
  });

  it('keeps the committed ratchet at or below the original 106 ceiling', () => {
    expect(JSON.parse(readFileSync(BASELINE, 'utf8')).total).toBeLessThanOrEqual(106);
  });

  it('allows the actual CI aggregate to pass when the required job succeeds', () => {
    seed();
    expect(run(gateStep().run).code).toBe(0);
    const aggregate = workflow().jobs.ci.steps.find((step) => step.run);
    const outcome = run(aggregate.run, {
      RESULTS: 'success,success',
      NEEDS_JSON: JSON.stringify({
        [JOB]: { result: 'success' },
        'forge-ts-check': { result: 'success' },
      }),
      ADVISORY_RESULT: 'success',
      GITHUB_STEP_SUMMARY: join(directory, 'step-summary.md'),
    });
    expect(outcome.code).toBe(0);
    expect(outcome.output).toContain('All required CI jobs succeeded or were skipped.');
  });
});
