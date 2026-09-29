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
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HEAD = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);

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

/** Run the step with the given inputs; returns its `linux` / `macos` outputs. */
function decide({ skipTests = false, skipMacos = false, verifiedSha = '' }) {
  const out = join(dir, 'out');
  const summary = join(dir, 'summary');
  writeFileSync(out, '');
  writeFileSync(summary, '');
  execFileSync('bash', ['-eo', 'pipefail', '-c', decisionScript()], {
    env: {
      PATH: process.env.PATH,
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
      .map((l) => l.split('=')),
  );
  return { ...outputs, summary: readFileSync(summary, 'utf8') };
}

describe('release-prepare preflight test decision', () => {
  it('honours skips verified against the checked-out commit', () => {
    const d = decide({ skipTests: true, skipMacos: true, verifiedSha: HEAD });
    expect(d.linux).toBe('false');
    expect(d.macos).toBe('false');
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
