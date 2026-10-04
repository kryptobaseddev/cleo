/**
 * Tests for the CI platform and shard decision (T13143): when macOS runs, how
 * each OS shards, darwin detection on a pull request's diff, and the ci.yml
 * wiring that every OS-matrixed job reads it from.
 *
 * @task T13143
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  detectDarwin,
  LINUX_SHARDS,
  MACOS_PR_SHARDS,
  MACOS_SHARDS,
  platformMatrix,
  touchesMacos,
} from '../ci-platform-matrix.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/ci-platform-matrix.mjs');

describe('platformMatrix', () => {
  const oses = (m) => [...new Set(m.testMatrix.map((j) => j.os))];

  it('runs macOS nightly, in merge groups and on a darwin-specific pull request only', () => {
    expect(platformMatrix('schedule', false).buildOs).toEqual(['ubuntu-latest', 'macos-latest']);
    expect(platformMatrix('merge_group', false).buildOs).toEqual(['ubuntu-latest', 'macos-latest']);
    expect(platformMatrix('pull_request', true).buildOs).toEqual(['ubuntu-latest', 'macos-latest']);
    expect(platformMatrix('pull_request', false).buildOs).toEqual(['ubuntu-latest']);
    expect(platformMatrix('push', true).buildOs).toEqual(['ubuntu-latest']);
    expect(oses(platformMatrix('workflow_dispatch', false))).toEqual(['ubuntu-latest']);
  });

  it(`shards Linux ${LINUX_SHARDS} ways and macOS ${MACOS_SHARDS} ways, each a complete 1..N set`, () => {
    const m = platformMatrix('schedule', false).testMatrix;
    for (const [os, total] of [
      ['ubuntu-latest', LINUX_SHARDS],
      ['macos-latest', MACOS_SHARDS],
    ]) {
      const jobs = m.filter((j) => j.os === os);
      expect(jobs.map((j) => j.shard)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
      expect(jobs.every((j) => j.total === total)).toBe(true);
    }
  });

  it(`a darwin pull request runs a reduced ${MACOS_PR_SHARDS}-shard macOS set (T13198)`, () => {
    const macos = (event) =>
      platformMatrix(event, true).testMatrix.filter((j) => j.os === 'macos-latest');
    expect(MACOS_PR_SHARDS).toBe(2);
    expect(macos('pull_request')).toEqual([
      { os: 'macos-latest', shard: 1, total: 2 },
      { os: 'macos-latest', shard: 2, total: 2 },
    ]);
    // Linux is unchanged, and the nightly and merge-group runs keep all 8.
    expect(
      platformMatrix('pull_request', true).testMatrix.filter((j) => j.os === 'ubuntu-latest'),
    ).toHaveLength(LINUX_SHARDS);
    expect(macos('schedule')).toHaveLength(MACOS_SHARDS);
    expect(macos('merge_group')).toHaveLength(MACOS_SHARDS);
    // Two shards and the two macOS builds fit the free plan's 5-job pool.
    expect(MACOS_PR_SHARDS + 2).toBeLessThanOrEqual(5);
  });
});

describe('detectDarwin', () => {
  it('a darwin- or macOS-named path is darwin-specific; a changeset or doc is not', () => {
    expect(detectDarwin(['packages/core/src/resources/darwin-backend.ts'], '').darwin).toBe(true);
    expect(detectDarwin(['packages/x/src/macos/paths.ts'], '').darwin).toBe(true);
    expect(detectDarwin(['.changeset/macos-suite-green.md'], '').darwin).toBe(false);
    expect(detectDarwin(['docs/macos-notes.md'], '').darwin).toBe(false);
    expect(detectDarwin(['packages/core/src/darwinism.ts'], '').darwin).toBe(false);
  });

  it('a changed line that adds or removes a platform check is darwin-specific', () => {
    const patch = (line) => `--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n${line}\n`;
    for (const line of [
      "+if (process.platform === 'darwin') return;",
      '-  const p = os.platform();',
      "+  case 'darwin':",
      '+#[cfg(target_os = "macos")]',
      "+if (os.type() === 'Darwin') {",
      '+if [ "$(uname)" = "Darwin" ]; then',
      "+    if: matrix.os == 'macos-latest'",
      "+    if: runner.os == 'macOS'",
      "+  if (process.platform === 'linux') return;",
      "+  return process.platform !== 'win32' && process.platform !== 'linux';",
      '+  switch (process.platform) {',
    ]) {
      expect(detectDarwin(['packages/core/src/x.ts'], patch(line)).darwin, line).toBe(true);
    }
    expect(
      detectDarwin(['packages/core/src/x.ts'], patch('+const a = detectPlatform();')).darwin,
    ).toBe(false);
    // T13198: a check that only splits Windows from POSIX, a runner.os cache
    // key and a comment do not touch macOS behaviour that Linux misses.
    for (const line of [
      "+  if (process.platform === 'win32') {",
      "-const posix = process.platform !== 'win32';",
      "+  const bin = os.platform() === 'win32' ? 'vitest.cmd' : 'vitest';",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, matched literally
      "+          key: ${{ runner.os }}-pnpm-store-${{ hashFiles('**/pnpm-lock.yaml') }}",
      '+        # Measured: `Unit Tests (macos-latest, shard 1)` took 33 min',
      "+  // on 'darwin' the realpath differs",
      "-   * macOS (process.platform === 'darwin') resolves /var",
    ]) {
      expect(detectDarwin(['packages/core/src/x.ts'], patch(line)).darwin, line).toBe(false);
    }
    // An unchanged context line with a platform check is not a change to it.
    expect(
      detectDarwin(['packages/core/src/x.ts'], " if (process.platform === 'darwin') {}\n").darwin,
    ).toBe(false);
  });
});

describe('touchesMacos (T13198)', () => {
  it('names macOS, or a platform check that is not only a win32 comparison', () => {
    expect(touchesMacos("if (os.type() === 'Darwin') {")).toBe(true);
    expect(touchesMacos("platform: 'darwin',")).toBe(true);
    expect(touchesMacos('#[cfg(target_os = "macos")]')).toBe(true);
    expect(touchesMacos("if (process.platform === 'win32') {")).toBe(false);
    expect(touchesMacos("process.platform === 'win32' || process.platform === 'darwin'")).toBe(
      true,
    );
    expect(touchesMacos('const p = os.platform();')).toBe(true);
    // A lower-case word `darwin` outside a quoted literal is not a macOS reference.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, matched literally
    expect(touchesMacos('darwin: ${{ steps.platform.outputs.darwin }}')).toBe(false);
  });

  it('macos-main.yml is not darwin-specific: a pull request does not run it', () => {
    const patch = [
      'diff --git a/.github/workflows/macos-main.yml b/.github/workflows/macos-main.yml',
      '--- a/.github/workflows/macos-main.yml',
      '+++ b/.github/workflows/macos-main.yml',
      '@@ -1 +1 @@',
      '+    runs-on: macos-latest',
    ].join('\n');
    expect(detectDarwin(['.github/workflows/macos-main.yml'], patch).darwin).toBe(false);
    // The same line in ci.yml still turns macOS on.
    const ci = patch.replaceAll('macos-main.yml', 'ci.yml');
    expect(detectDarwin(['.github/workflows/ci.yml'], ci).darwin).toBe(true);
  });
});

describe('the script on a real diff', () => {
  let dir;
  const git = (...args) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ci-platform-matrix-'));
    git('init', '-q', '--initial-branch=main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    git('config', 'commit.gpgsign', 'false');
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(path.join(dir, 'notes.md'), "Use 'darwin' builds.\n");
    git('add', '.');
    git('commit', '-q', '-m', 'seed');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(event) {
    const out = path.join(dir, 'out');
    writeFileSync(out, '');
    const r = spawnSync(process.execPath, [SCRIPT, event, 'HEAD^1', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: out },
    });
    expect(r.status).toBe(0);
    return Object.fromEntries(
      readFileSync(out, 'utf8')
        .trim()
        .split('\n')
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
  }

  it('a platform check in code turns macOS on for the pull request; a doc mention does not', () => {
    writeFileSync(path.join(dir, 'notes.md'), "Use 'darwin' builds. Really 'darwin'.\n");
    git('commit', '-q', '-am', 'docs');
    expect(run('pull_request').darwin).toBe('false');

    writeFileSync(
      path.join(dir, 'src/a.ts'),
      "export const a = process.platform === 'darwin' ? 2 : 1;\n",
    );
    git('commit', '-q', '-am', 'platform');
    const out = run('pull_request');
    expect(out.darwin).toBe('true');
    expect(JSON.parse(out.build_os)).toEqual(['ubuntu-latest', 'macos-latest']);
    expect(JSON.parse(out.test_matrix)).toHaveLength(LINUX_SHARDS + MACOS_PR_SHARDS);
    // The same commit pushed to main stays on Linux.
    expect(JSON.parse(run('push').build_os)).toEqual(['ubuntu-latest']);
  });

  it('a diff that cannot be read turns macOS on (the safe direction)', () => {
    const out = path.join(dir, 'out');
    writeFileSync(out, '');
    spawnSync(process.execPath, [SCRIPT, 'pull_request', 'no-such-ref', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: out },
    });
    expect(readFileSync(out, 'utf8')).toContain('darwin=true');
  });
});

describe('ci.yml wiring (T13143)', () => {
  const ci = parseYaml(readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8'));

  it('the changes job decides the platforms, and every OS-matrixed job reads its answer', () => {
    const step = ci.jobs.changes.steps.find((s) => s.id === 'platform');
    expect(step.run).toContain('node scripts/ci-platform-matrix.mjs');
    for (const key of ['darwin', 'build_os', 'test_matrix']) {
      expect(ci.jobs.changes.outputs[key]).toContain(`steps.platform.outputs.${key}`);
    }
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, matched literally in ci.yml
    const buildOs = '${{ fromJson(needs.changes.outputs.build_os) }}';
    expect(ci.jobs.build.strategy.matrix.os).toBe(buildOs);
    expect(ci.jobs['build-verify'].strategy.matrix.os).toBe(buildOs);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, matched literally in ci.yml
    const testMatrix = '${{ fromJson(needs.changes.outputs.test_matrix) }}';
    expect(ci.jobs['unit-tests'].strategy.matrix.include).toBe(testMatrix);
  });

  it('the unit tests shard by the matrix total, not a fixed count', () => {
    const run = ci.jobs['unit-tests'].steps.find((s) =>
      String(s.name).startsWith('Run unit tests'),
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, matched literally in ci.yml
    expect(run.run).toContain('--shard=${{ matrix.shard }}/${{ matrix.total }}');
    expect(JSON.stringify(ci)).not.toMatch(/matrix\.shard \}\}\/4/);
  });

  it('the reduced macOS pull-request legs get a longer timeout (T13198)', () => {
    expect(ci.jobs['unit-tests']['timeout-minutes']).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, matched literally in ci.yml
      "${{ matrix.os == 'macos-latest' && matrix.total <= 2 && 90 || 55 }}",
    );
    expect(MACOS_PR_SHARDS).toBeLessThanOrEqual(2);
  });
});

describe('macos-main.yml: the newest main push gets a macOS result (T13143, option B)', () => {
  const read = (p) => readFileSync(path.join(REPO_ROOT, p), 'utf8');
  const wf = parseYaml(read('.github/workflows/macos-main.yml'));
  const ci = parseYaml(read('.github/workflows/ci.yml'));

  it('runs on main pushes only, cancels a superseded run, and is read by the release preflight', () => {
    expect(wf.on.push.branches).toEqual(['main']);
    expect(wf.concurrency).toEqual({ group: 'macos-main', 'cancel-in-progress': true });
    expect(read('packages/core/src/release/preflight-skip.ts')).toContain("'macos-main.yml'");
  });

  it(`shards ${MACOS_SHARDS} ways on macOS with the same node and pnpm pins as ci.yml`, () => {
    const tests = wf.jobs['unit-tests'];
    expect(tests['runs-on']).toBe('macos-latest');
    expect(tests.strategy.matrix.shard).toEqual(
      Array.from({ length: MACOS_SHARDS }, (_, i) => i + 1),
    );
    const run = tests.steps.find((s) => String(s.name).startsWith('Run unit tests'));
    expect(run.run).toContain(`/${MACOS_SHARDS} --retry=2`);
    const pin = (steps, action, key) => steps.find((s) => s.uses?.startsWith(action))?.with?.[key];
    for (const [action, key] of [
      ['actions/setup-node', 'node-version'],
      ['pnpm/action-setup', 'version'],
    ]) {
      expect(pin(tests.steps, action, key), action).toBe(
        pin(ci.jobs['unit-tests'].steps, action, key),
      );
      expect(pin(wf.jobs.build.steps, action, key), action).toBe(
        pin(ci.jobs.build.steps, action, key),
      );
    }
  });

  it("runs on every path ci.yml's code filter tests", () => {
    const filters = parseYaml(ci.jobs.changes.steps.find((s) => s.id === 'filter').with.filters);
    for (const p of filters.code) {
      if (p === '.github/workflows/ci.yml') continue;
      expect(wf.on.push.paths, p).toContain(p);
    }
  });
});
