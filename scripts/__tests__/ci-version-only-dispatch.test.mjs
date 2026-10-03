/**
 * T13141 — the release bump-PR's dispatched CI runs the version-only (reduced)
 * set.
 *
 * The bump-PR's `pull_request` runs come back `action_required`, so its only
 * CI is the `workflow_dispatch` run release-prepare starts on `release/v*`.
 * The `changes` job ran the version-only detector for `pull_request` only, so
 * that run took the whole ~22 min suite for 21 one-line version bumps. These
 * tests pin the dispatch step's wiring and run its shell script against real
 * git histories: a bump is version-only; anything else, or no merge-base, is
 * the full run.
 *
 * @task T13141
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DETECTOR = path.join(REPO_ROOT, 'scripts/ci-detect-version-only.mjs');
const ci = parseYaml(readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8'));
const changes = ci.jobs.changes;
const dispatchStep = changes.steps.find((s) => s.id === 'version-only-dispatch');

describe('ci.yml wiring (T13141)', () => {
  it('runs the detector on a release/v* workflow_dispatch and feeds version_only from it', () => {
    expect(dispatchStep, 'the changes job has a version-only-dispatch step').toBeDefined();
    expect(dispatchStep.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(dispatchStep.if).toContain("startsWith(github.ref, 'refs/heads/release/v')");
    expect(changes.outputs.version_only).toContain(
      "steps.version-only-dispatch.outputs.version_only == 'true'",
    );
    // The pull_request detector is untouched.
    const prStep = changes.steps.find((s) => s.id === 'version-only');
    expect(prStep.if).toBe("github.event_name == 'pull_request'");
  });

  it('keeps the heavy jobs gated on version_only', () => {
    for (const job of ['unit-tests', 'build', 'packed-artifact', 'install-test']) {
      expect(ci.jobs[job]?.if, job).toContain("needs.changes.outputs.version_only != 'true'");
    }
  });
});

describe('the dispatch detector script (T13141)', () => {
  let dir;
  const git = (cwd, ...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ci-version-only-dispatch-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** An origin with `main` (one package.json) and a `release/v1` branch built by `onBranch`. */
  function origin(onBranch) {
    const work = path.join(dir, 'work');
    const bare = path.join(dir, 'origin.git');
    git(dir, 'init', '-q', '--bare', '--initial-branch=main', bare);
    git(dir, 'init', '-q', '--initial-branch=main', work);
    for (const [k, v] of [
      ['user.email', 't@example.com'],
      ['user.name', 'T'],
      ['commit.gpgsign', 'false'],
    ])
      git(work, 'config', k, v);
    writeFileSync(
      path.join(work, 'package.json'),
      `${JSON.stringify({ name: 'x', version: '1.0.0', private: true }, null, 2)}\n`,
    );
    writeFileSync(path.join(work, 'index.js'), 'export {};\n');
    git(work, 'add', '.');
    git(work, 'commit', '-q', '-m', 'seed');
    git(work, 'remote', 'add', 'origin', bare);
    git(work, 'push', '-q', 'origin', 'main');
    git(work, 'checkout', '-q', '-b', 'release/v1');
    onBranch(work);
    git(work, 'commit', '-q', '-am', 'bump');
    git(work, 'push', '-q', 'origin', 'release/v1');
    // What actions/checkout leaves behind: a depth-2 clone of the branch.
    const checkout = path.join(dir, 'checkout');
    git(dir, 'clone', '-q', '--depth=2', '--branch', 'release/v1', `file://${bare}`, checkout);
    return checkout;
  }

  /** Run the step's script as GitHub would, returning its `version_only` output. */
  function runStep(cwd) {
    const output = path.join(dir, 'github-output');
    writeFileSync(output, '');
    const script = dispatchStep.run.replace(
      'node scripts/ci-detect-version-only.mjs',
      `node ${JSON.stringify(DETECTOR)}`,
    );
    const r = spawnSync('bash', ['-e', '-c', script], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        DEFAULT_BRANCH: 'main',
        GITHUB_REF: 'refs/heads/release/v1',
        GITHUB_OUTPUT: output,
      },
    });
    expect(r.status, r.stderr).toBe(0);
    return /version_only=(\w+)/.exec(readFileSync(output, 'utf8'))?.[1];
  }

  it('a version bump is version-only', () => {
    const checkout = origin((work) => {
      const pkg = path.join(work, 'package.json');
      writeFileSync(pkg, readFileSync(pkg, 'utf8').replace('"1.0.0"', '"1.0.1"'));
    });
    expect(runStep(checkout)).toBe('true');
  });

  it('main moving on after the cut does not count against the bump', () => {
    const checkout = origin((work) => {
      const pkg = path.join(work, 'package.json');
      writeFileSync(pkg, readFileSync(pkg, 'utf8').replace('"1.0.0"', '"1.0.1"'));
    });
    // After release-prepare cuts the branch, main keeps merging code.
    const work = path.join(dir, 'work');
    git(work, 'checkout', '-q', 'main');
    for (let i = 1; i <= 5; i++) {
      writeFileSync(path.join(work, 'index.js'), `export const v = ${i};\n`);
      git(work, 'commit', '-q', '-am', `main ${i}`);
    }
    git(work, 'push', '-q', 'origin', 'main');
    expect(runStep(checkout)).toBe('true');
  });

  it('a bump that also changes code is the full run', () => {
    const checkout = origin((work) => {
      const pkg = path.join(work, 'package.json');
      writeFileSync(pkg, readFileSync(pkg, 'utf8').replace('"1.0.0"', '"1.0.1"'));
      writeFileSync(path.join(work, 'index.js'), 'export const x = 1;\n');
    });
    expect(runStep(checkout)).toBe('false');
  });

  it('no merge-base with the default branch is the full run', () => {
    const checkout = origin((work) => {
      const pkg = path.join(work, 'package.json');
      writeFileSync(pkg, readFileSync(pkg, 'utf8').replace('"1.0.0"', '"1.0.1"'));
    });
    // Point the default branch at an unrelated history.
    const lone = path.join(dir, 'lone');
    git(dir, 'init', '-q', '--initial-branch=main', lone);
    git(lone, 'config', 'user.email', 't@example.com');
    git(lone, 'config', 'user.name', 'T');
    git(lone, 'config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(lone, 'other.txt'), 'x\n');
    git(lone, 'add', '.');
    git(lone, 'commit', '-q', '-m', 'unrelated');
    git(lone, 'push', '-q', '--force', path.join(dir, 'origin.git'), 'main');
    expect(runStep(checkout)).toBe('false');
  });
});
