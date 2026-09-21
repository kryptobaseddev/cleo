/**
 * T12259 — execute the real gate against independent workflow fixtures.
 * A passing unrelated job must never hide the payload's broken budget.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const GATE = resolve('scripts/lint-postdeploy-budget.mjs');
let directory;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'cleo-postdeploy-budget-'));
  mkdirSync(join(directory, '.github/workflows'), { recursive: true });
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** Run the actual CLI gate with an isolated workflow and a bounded child process. */
function check(source) {
  writeFileSync(join(directory, '.github/workflows/release.yml'), source);
  const result = spawnSync(process.execPath, [GATE], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 100_000,
  });
  if (result.error) throw result.error;
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

/** Minimal independently chosen valid workflow, without the historical banner. */
function fixture() {
  return {
    name: 'Release',
    jobs: {
      renamed_payload: {
        name: 'Verify registry',
        'timeout-minutes': 25,
        steps: [
          {
            env: { POSTDEPLOY_JOB_CAP_MINUTES: '25', POSTDEPLOY_TIMEOUT_MS: '900000' },
            run: 'node scripts/execute-payload.mjs --version 2026.9.8',
          },
        ],
      },
    },
  };
}

describe('post-deploy budget structural ownership', () => {
  it('accepts the shipped workflow', () => {
    expect(check(readFileSync('.github/workflows/release.yml', 'utf8')).code).toBe(0);
  });

  it('accepts renamed job IDs and display names without the historical comment', () => {
    expect(check(stringifyYaml(fixture())).code).toBe(0);
  });

  it.each(['before', 'after'])('finds the payload when moved %s an unrelated job', (position) => {
    const document = fixture();
    const unrelated = {
      name: 'Post-Deploy Execution Payload',
      'timeout-minutes': 1,
      steps: [{ run: 'echo unrelated' }],
    };
    document.jobs =
      position === 'before' ? { unrelated, ...document.jobs } : { ...document.jobs, unrelated };
    expect(check(`# Post-Deploy Execution Payload\n${stringifyYaml(document)}`).code).toBe(0);
  });

  it('does not let a valid unrelated job hide an invalid payload after a misleading banner', () => {
    const document = fixture();
    document.jobs.renamed_payload['timeout-minutes'] = 10;
    document.jobs = { decoy: fixture().jobs.renamed_payload, ...document.jobs };
    document.jobs.decoy.steps[0].run = 'echo unrelated';
    const result = check(
      `# Post-Deploy Execution Payload\n${stringifyYaml(document, { singleQuote: true })}`,
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain('timeout-minutes (10) !=');
    expect(result.output).toContain('>= effective cap');
  });

  it('ignores timeout-like text inside shell scripts', () => {
    const document = fixture();
    document.jobs.renamed_payload.steps.unshift({
      run: "cat <<'TEXT'\nPost-Deploy Execution Payload\ntimeout-minutes: 1\nTEXT",
    });
    expect(check(stringifyYaml(document)).code).toBe(0);
  });

  it('resolves workflow/job/step environment precedence', () => {
    const document = fixture();
    const job = document.jobs.renamed_payload;
    document.env = { POSTDEPLOY_JOB_CAP_MINUTES: '25', POSTDEPLOY_TIMEOUT_MS: '1500000' };
    job.env = { POSTDEPLOY_TIMEOUT_MS: '1400000' };
    job.steps[0].env = { POSTDEPLOY_TIMEOUT_MS: '900000' };
    expect(check(stringifyYaml(document)).code).toBe(0);
  });

  it.each(['number', 'double quote', 'single quote'])('accepts %s scalar encoding', (encoding) => {
    const source = `jobs:\n  payload:\n    timeout-minutes: 25\n    steps:\n      - env:\n          POSTDEPLOY_JOB_CAP_MINUTES: ${encoding === 'number' ? '25' : encoding === 'double quote' ? '"25"' : "'25'"}\n          POSTDEPLOY_TIMEOUT_MS: 900000\n        run: node scripts/execute-payload.mjs\n`;
    expect(check(source).code).toBe(0);
  });
});

describe('post-deploy budget refusal paths', () => {
  it.each([
    ['cap mismatch', 25, '20', '900000', 'timeout-minutes (25) !='],
    ['budget equals cap', 25, '25', '1500000', '>= effective cap'],
    ['budget exceeds cap', 25, '25', '1600000', '>= effective cap'],
    ['insufficient headroom', 25, '25', '1200001', 'need >= 300000ms'],
  ])('rejects %s', (_name, cap, capEnv, budget, diagnostic) => {
    const document = fixture();
    const job = document.jobs.renamed_payload;
    job['timeout-minutes'] = cap;
    job.steps[0].env = {
      POSTDEPLOY_JOB_CAP_MINUTES: capEnv,
      POSTDEPLOY_TIMEOUT_MS: budget,
    };
    const result = check(stringifyYaml(document));
    expect(result.code).toBe(1);
    expect(result.output).toContain(diagnostic);
  });

  it('accepts exactly the required headroom', () => {
    const document = fixture();
    document.jobs.renamed_payload.steps[0].env.POSTDEPLOY_TIMEOUT_MS = '1200000';
    expect(check(stringifyYaml(document)).code).toBe(0);
  });

  it('checks a tighter timeout on the payload step', () => {
    const document = fixture();
    document.jobs.renamed_payload.steps[0]['timeout-minutes'] = 10;
    const result = check(stringifyYaml(document));
    expect(result.code).toBe(1);
    expect(result.output).toContain('>= effective cap (10min');
  });

  it.each([
    undefined,
    '25minutes',
    `$\{{ inputs.cap }}`,
    true,
    0,
    -1,
    1.5,
  ])('fails closed on unsupported cap %s', (cap) => {
    const document = fixture();
    document.jobs.renamed_payload['timeout-minutes'] = cap;
    expect(check(stringifyYaml(document)).code).toBe(2);
  });

  it.each([
    '# node scripts/execute-payload.mjs',
    'echo node scripts/execute-payload.mjs',
  ])('cannot identify a payload through non-command text %s', (run) => {
    const document = fixture();
    document.jobs.renamed_payload.steps[0].run = run;
    const result = check(stringifyYaml(document));
    expect(result.code).toBe(2);
    expect(result.output).toContain('found 0');
  });

  it('rejects ambiguous multiple payload jobs', () => {
    const document = fixture();
    document.jobs.second = fixture().jobs.renamed_payload;
    const result = check(stringifyYaml(document));
    expect(result.code).toBe(2);
    expect(result.output).toContain('found 2');
  });

  it('rejects missing budget instead of borrowing it from another step', () => {
    const document = fixture();
    const job = document.jobs.renamed_payload;
    delete job.steps[0].env.POSTDEPLOY_TIMEOUT_MS;
    job.steps.push({ env: { POSTDEPLOY_TIMEOUT_MS: '900000' }, run: 'echo unrelated' });
    const result = check(stringifyYaml(document));
    expect(result.code).toBe(2);
    expect(result.output).toContain('POSTDEPLOY_TIMEOUT_MS');
  });

  it('rejects duplicate YAML keys', () => {
    const source = stringifyYaml(fixture()).replace(
      'timeout-minutes: 25',
      'timeout-minutes: 25\n    timeout-minutes: 1',
    );
    expect(check(source).code).toBe(2);
  });

  it('runs in CI after locked dependency installation', () => {
    const workflow = parseYaml(readFileSync('.github/workflows/arch-boundary-check.yml', 'utf8'));
    const steps = workflow.jobs['postdeploy-budget'].steps;
    const install = steps.findIndex((step) => step.run === 'pnpm install --frozen-lockfile');
    const gate = steps.findIndex((step) => step.run === 'node scripts/lint-postdeploy-budget.mjs');
    expect(install).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(install);
  });
});
