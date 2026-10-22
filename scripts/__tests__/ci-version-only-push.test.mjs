/**
 * T13833 — the main push of a merged release bump PR takes the version-only
 * CI set when its diff from the first parent is version-only AND that parent's
 * own ci.yml push run concluded success.
 *
 * The step's script runs against real git histories, with a fake `gh` on PATH
 * answering the parent-run query; anything short of `completed/success` for
 * the parent, or a non-version-only diff, is the full run.
 *
 * @task T13833
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DETECTOR = path.join(REPO_ROOT, 'scripts/ci-detect-version-only.mjs');
const ci = parseYaml(readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8'));
const changes = ci.jobs.changes;
const pushStep = changes.steps.find((s) => s.id === 'version-only-push');

describe('ci.yml wiring (T13833)', () => {
  it('runs on pushes to main only and feeds version_only', () => {
    expect(pushStep, 'the changes job has a version-only-push step').toBeDefined();
    expect(pushStep.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(changes.outputs.version_only).toContain(
      "steps.version-only-push.outputs.version_only == 'true'",
    );
    // The detector diffs HEAD^1..HEAD, so the checkout must hold the parent.
    expect(
      changes.steps.find((s) => s.uses?.startsWith('actions/checkout'))?.with?.['fetch-depth'],
    ).toBe(2);
  });
});

describe('the main-push detector script (T13833)', () => {
  let dir;
  const git = (cwd, ...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ci-version-only-push-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A repo whose HEAD is `change` applied on top of a seed commit (the first parent). */
  function repo(change) {
    const work = path.join(dir, 'work');
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
    change(work);
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'release bump');
    return work;
  }

  const bump = (work) => {
    const pkg = path.join(work, 'package.json');
    writeFileSync(pkg, readFileSync(pkg, 'utf8').replace('"1.0.0"', '"1.0.1"'));
    writeFileSync(path.join(work, 'CHANGELOG.md'), '## v1.0.1\n');
    mkdirSync(path.join(work, '.cleo/release'), { recursive: true });
    writeFileSync(path.join(work, '.cleo/release/v1.0.1.plan.json'), '{}\n');
  };

  /**
   * Run the step as GitHub would. `parentRun` is what the fake `gh api`
   * prints for the parent's newest ci.yml push run, or an Error to fail.
   */
  function runStep(cwd, parentRun) {
    const output = path.join(dir, 'github-output');
    writeFileSync(output, '');
    const bin = path.join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const parent = git(cwd, 'rev-parse', 'HEAD^1').trim();
    writeFileSync(
      path.join(bin, 'gh'),
      parentRun instanceof Error
        ? '#!/bin/sh\necho "HTTP 502" >&2\nexit 1\n'
        : `#!/bin/sh\ncase "$*" in *"head_sha=${parent}"*) echo "${parentRun}";; *) echo "null/null";; esac\n`,
    );
    chmodSync(path.join(bin, 'gh'), 0o755);
    const script = pushStep.run.replace(
      'node scripts/ci-detect-version-only.mjs',
      `node ${JSON.stringify(DETECTOR)}`,
    );
    const r = spawnSync('bash', ['-e', '-c', script], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        REPO: 'o/r',
        GITHUB_OUTPUT: output,
      },
    });
    expect(r.status, r.stderr).toBe(0);
    return /version_only=(\w+)/.exec(readFileSync(output, 'utf8'))?.[1];
  }

  it('a version-only bump merge over a green parent takes the fast path', () => {
    expect(runStep(repo(bump), 'completed/success')).toBe('true');
  });

  it('runs in full when the parent run is unfinished, failed, missing or unreadable', () => {
    const work = repo(bump);
    for (const run of [
      'in_progress/null',
      'completed/failure',
      'completed/cancelled',
      'null/null',
      new Error('502'),
    ]) {
      expect(runStep(work, run), String(run)).toBe('false');
    }
  });

  it('runs in full when the diff is not version-only, even over a green parent', () => {
    const code = repo((work) => {
      bump(work);
      writeFileSync(path.join(work, 'index.js'), 'export const x = 1;\n');
    });
    expect(runStep(code, 'completed/success')).toBe('false');
    const dep = repo((work) => {
      const pkg = path.join(work, 'package.json');
      writeFileSync(pkg, readFileSync(pkg, 'utf8').replace('"private": true', '"private": false'));
    });
    expect(runStep(dep, 'completed/success')).toBe('false');
  });
});
