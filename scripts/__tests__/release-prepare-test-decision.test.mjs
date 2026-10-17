/**
 * Tests for the "Decide which preflight test suites run" step of
 * .github/workflows/release-prepare.yml — the ONE place that turns the
 * `skip-tests` / `skip-macos-tests` / `verified-sha` inputs into the
 * `linux` / `macos` outputs the preflight test jobs read.
 *
 * The step's own `run:` script is extracted from the workflow and executed
 * under bash, so the test exercises the shipped text, not a copy of it.
 * A skip is honoured only when `verified-sha` names the commit the run
 * checked out; an empty `verified-sha` must never let a skip through.
 *
 * T13823: a Linux skip also needs `reused-ci-run`, which the step re-reads
 * through `gh api`; a fake `gh` on PATH serves the run, its jobs and the
 * compare from fixtures.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HEAD = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);
const RUN_ID = '4242';

/** Every Linux Unit Tests shard green, as `gh api --paginate --jq` prints them (name TAB conclusion). */
const GREEN_JOBS = [
  'Detect Changes\tsuccess',
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `Unit Tests (ubuntu-latest, shard ${n})\tsuccess`),
].join('\n');

/** A green ci.yml push run on main for `sha`. */
function greenRun(sha = HEAD, over = {}) {
  return {
    id: Number(RUN_ID),
    path: '.github/workflows/ci.yml',
    event: 'push',
    head_branch: 'main',
    status: 'completed',
    conclusion: 'success',
    head_sha: sha,
    html_url: `https://github.com/o/r/actions/runs/${RUN_ID}`,
    ...over,
  };
}

/** A fake `gh api`: run, jobs and compare answers come from FAKE_GH_* files; a missing file fails. */
const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs');
const endpoint = process.argv.find((a) => a.startsWith('repos/')) || '';
const file = endpoint.includes('/jobs') ? 'jobs' : endpoint.includes('/compare/') ? 'compare' : 'run';
const path = process.env.FAKE_GH_DIR + '/' + file;
if (!fs.existsSync(path)) { console.error('HTTP 404'); process.exit(1); }
process.stdout.write(fs.readFileSync(path, 'utf8') + '\\n');
`;

function decisionScript() {
  const wf = parseYaml(readFileSync(join(REPO, '.github/workflows/release-prepare.yml'), 'utf8'));
  for (const job of Object.values(wf.jobs)) {
    for (const step of job.steps ?? []) {
      if (step.name === 'Decide which preflight test suites run') return step.run;
    }
  }
  throw new Error('decision step not found in release-prepare.yml');
}

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rp-decision-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Run the step with the given inputs; returns its `linux` / `macos` /
 * `reused_url` outputs. `gh` holds the fake API's answers (`run` and
 * `compare` objects, `jobs` TSV); an absent answer is an API error.
 */
function decide({
  skipTests = false,
  skipMacos = false,
  verifiedSha = '',
  reusedRun = '',
  gh = { run: greenRun(), jobs: GREEN_JOBS },
}) {
  const out = join(dir, 'out');
  const summary = join(dir, 'summary');
  writeFileSync(out, '');
  writeFileSync(summary, '');
  const ghDir = mkdtempSync(join(dir, 'gh-'));
  writeFileSync(join(ghDir, 'gh'), FAKE_GH);
  chmodSync(join(ghDir, 'gh'), 0o755);
  for (const [name, value] of Object.entries(gh)) {
    writeFileSync(join(ghDir, name), typeof value === 'string' ? value : JSON.stringify(value));
  }
  execFileSync('bash', ['-eo', 'pipefail', '-c', decisionScript()], {
    env: {
      PATH: `${ghDir}:${process.env.PATH}`,
      FAKE_GH_DIR: ghDir,
      REUSED_RUN: reusedRun,
      REPO: 'o/r',
      DEFAULT_BRANCH: 'main',
      SKIP_TESTS: String(skipTests),
      SKIP_MACOS_TESTS: String(skipMacos),
      VERIFIED_SHA: verifiedSha,
      SKIP_REASON: '',
      HEAD_SHA: HEAD,
      GITHUB_OUTPUT: out,
      GITHUB_STEP_SUMMARY: summary,
    },
    stdio: 'pipe',
  });
  const outputs = Object.fromEntries(
    readFileSync(out, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  return { ...outputs, summary: readFileSync(summary, 'utf8') };
}

describe('release-prepare preflight test decision', () => {
  it('honours skips verified against the checked-out commit, and names the reused run', () => {
    const d = decide({ skipTests: true, skipMacos: true, verifiedSha: HEAD, reusedRun: RUN_ID });
    expect(d.linux).toBe('false');
    expect(d.macos).toBe('false');
    expect(d.reused_url).toBe(`https://github.com/o/r/actions/runs/${RUN_ID}`);
    expect(d.summary).toContain(
      `Linux shards reused from main CI run: https://github.com/o/r/actions/runs/${RUN_ID}`,
    );
  });

  it('refuses a Linux skip that names no reused-ci-run, but still honours the macOS skip', () => {
    const d = decide({ skipTests: true, skipMacos: true, verifiedSha: HEAD });
    expect(d.linux).toBe('true');
    expect(d.macos).toBe('false');
    expect(d.reused_url).toBe('');
    expect(d.summary).toContain('without reused-ci-run');
  });

  it('re-verifies the reused run and runs the shards on any doubt (T13823)', () => {
    const red = GREEN_JOBS.replace('shard 3)\tsuccess', 'shard 3)\tfailure');
    const cases = [
      ['a PR run', { run: greenRun(HEAD, { event: 'pull_request' }), jobs: GREEN_JOBS }],
      [
        'another workflow',
        { run: greenRun(HEAD, { path: '.github/workflows/release.yml' }), jobs: GREEN_JOBS },
      ],
      ['another branch', { run: greenRun(HEAD, { head_branch: 'feat/x' }), jobs: GREEN_JOBS }],
      ['a failed run', { run: greenRun(HEAD, { conclusion: 'failure' }), jobs: GREEN_JOBS }],
      [
        'an unfinished run',
        { run: greenRun(HEAD, { status: 'in_progress', conclusion: null }), jobs: GREEN_JOBS },
      ],
      ['a red shard', { run: greenRun(), jobs: red }],
      [
        'a missing shard',
        { run: greenRun(), jobs: GREEN_JOBS.replace(/\n[^\n]*shard 2\)[^\n]*/, '') },
      ],
      ['no Linux shards', { run: greenRun(), jobs: 'Detect Changes\tsuccess' }],
      ['unreadable jobs', { run: greenRun() }],
      ['unreadable run', { jobs: GREEN_JOBS }],
      ['another commit, no compare', { run: greenRun(OTHER), jobs: GREEN_JOBS }],
      [
        'another commit plus code',
        {
          run: greenRun(OTHER),
          jobs: GREEN_JOBS,
          compare: {
            status: 'ahead',
            files: [{ filename: 'CHANGELOG.md' }, { filename: 'packages/core/src/x.ts' }],
          },
        },
      ],
      [
        'a diverged commit',
        {
          run: greenRun(OTHER),
          jobs: GREEN_JOBS,
          compare: { status: 'diverged', files: [{ filename: 'CHANGELOG.md' }] },
        },
      ],
    ];
    for (const [label, gh] of cases) {
      const d = decide({ skipTests: true, verifiedSha: HEAD, reusedRun: RUN_ID, gh });
      expect(d.linux, label).toBe('true');
      expect(d.reused_url, label).toBe('');
      expect(d.summary, label).toContain('does not prove this commit');
    }
    expect(decide({ skipTests: true, verifiedSha: HEAD, reusedRun: 'x; rm -rf /' }).linux).toBe(
      'true',
    );
  });

  it('reuses the run of a commit this one extends only by release-plan files (T13140)', () => {
    const d = decide({
      skipTests: true,
      verifiedSha: HEAD,
      reusedRun: RUN_ID,
      gh: {
        run: greenRun(OTHER),
        jobs: GREEN_JOBS,
        compare: {
          status: 'ahead',
          files: [
            { filename: '.cleo/release/v2026.10.19.plan.json' },
            { filename: 'CHANGELOG.md' },
          ],
        },
      },
    });
    expect(d.linux).toBe('false');
    expect(d.reused_url).toContain(RUN_ID);
  });

  it('refuses a skip that carries no verified-sha', () => {
    const d = decide({ skipTests: true, skipMacos: true, verifiedSha: '' });
    expect(d.linux).toBe('true');
    expect(d.macos).toBe('true');
    expect(d.summary).toContain('without verified-sha');
  });

  it('refuses a skip verified against a different commit', () => {
    const d = decide({ skipTests: true, verifiedSha: OTHER });
    expect(d.linux).toBe('true');
    expect(d.summary).toContain('main moved after the check');
  });

  it('runs everything when no skip was requested', () => {
    const d = decide({});
    expect(d.linux).toBe('true');
    expect(d.macos).toBe('true');
  });
});
