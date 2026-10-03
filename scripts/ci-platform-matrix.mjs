#!/usr/bin/env node
/**
 * Decide which operating systems CI builds and tests on, and how the unit
 * tests shard on each (T13143).
 *
 * macOS shards take 32–42 min at 4 shards and are 10x the runner cost, so
 * they stay off ordinary pull requests (T12177, 2026-09-29). This script is
 * the one place that decides when they run:
 *
 * - `schedule` (nightly) and `merge_group`: macOS always.
 * - `pull_request`: macOS when the change is darwin-specific, so a macOS-only
 *   regression is caught on its own PR instead of the next nightly. A
 *   platform-agnostic change that happens to break on macOS (realpath
 *   `/var` vs `/private/var`, spaces in "Application Support", the
 *   case-insensitive filesystem, BSD userland flags) is still found by the
 *   nightly or main-push macOS run:
 *   - a changed path names darwin or macOS (`resources/darwin-backend.ts`),
 *     outside `.changeset/` and `docs/`; or
 *   - a changed line of a code or workflow file adds or removes a platform
 *     check: `process.platform`, `os.platform()` / `platform()` from
 *     `node:os`, or a `'darwin'` literal.
 * - Anything else (`push`, `workflow_dispatch`): Linux only.
 *
 * macOS runs {@link MACOS_SHARDS} shards (Linux {@link LINUX_SHARDS}), so its
 * wall time drops to the Linux shards' range when it does run.
 *
 * Usage (the `changes` job):
 *
 *   node scripts/ci-platform-matrix.mjs <event> [<base-ref> <head-ref>]
 *
 * Writes to `$GITHUB_OUTPUT`: `darwin`, `build_os` (a JSON array of runner
 * labels) and `test_matrix` (a JSON array of `{os, shard, total}`). Always
 * exits 0; a detection error on a pull request means "darwin-specific", so
 * macOS runs: the safe direction.
 *
 * @task T13143
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Linux unit-test shards (keep in step with release-prepare's preflight
 * shards). 8, not 4: the repo is public, so runners cost nothing, and a full
 * suite then fits a PR's ~10-minute budget even when affected selection picks
 * everything (T13143).
 */
export const LINUX_SHARDS = 8;

/**
 * macOS unit-test shards. Also 8: the free plan runs at most 5 macOS jobs at
 * once, so more shards would only add waves and setup.
 */
export const MACOS_SHARDS = 8;

/** A path that is darwin-specific by name. */
const DARWIN_PATH = /(^|[/._-])(darwin|macos)([/._-]|$)/i;

/** The files whose changed lines are scanned for platform checks. */
export const CODE_PATHSPECS = [
  '*.ts',
  '*.tsx',
  '*.js',
  '*.mjs',
  '*.cjs',
  '*.rs',
  '*.sh',
  '*.yml',
  '*.yaml',
];

/**
 * A changed line that adds or removes a platform check: `process.platform`,
 * `os.platform()` / `platform()`, `os.type() === 'Darwin'`, a `'darwin'` or
 * `'macos'` literal, Rust `target_os`, a shell `uname`, or a macOS-only CI step
 * (`macos-latest`, `runner.os`).
 */
const PLATFORM_LINE =
  /process\.platform|\bos\.platform\(|\bplatform\(\)|['"`](darwin|macos)['"`]|\bDarwin\b|target_os|\buname\b|macos-latest|runner\.os/;

/**
 * Whether a change is darwin-specific.
 *
 * @param {readonly string[]} paths - Changed repo-relative paths.
 * @param {string} patch - `git diff -U0` of the change's code and workflow files ({@link CODE_PATHSPECS}).
 * @returns {{ darwin: boolean, reason: string }}
 */
export function detectDarwin(paths, patch) {
  const named = paths.find(
    (p) => DARWIN_PATH.test(p) && !p.startsWith('.changeset/') && !p.startsWith('docs/'),
  );
  if (named) return { darwin: true, reason: `darwin-specific path: ${named}` };
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if ((line.startsWith('+') || line.startsWith('-')) && PLATFORM_LINE.test(line)) {
      return {
        darwin: true,
        reason: `a changed line touches a platform check: ${line.slice(0, 160)}`,
      };
    }
  }
  return { darwin: false, reason: 'no darwin-specific path or platform check changed' };
}

/**
 * The OS list and unit-test matrix for an event.
 *
 * @param {string} event - `github.event_name`.
 * @param {boolean} darwin - Whether a pull request's change is darwin-specific.
 * @returns {{ buildOs: string[], testMatrix: Array<{ os: string, shard: number, total: number }> }}
 */
export function platformMatrix(event, darwin) {
  const macos =
    event === 'schedule' || event === 'merge_group' || (event === 'pull_request' && darwin);
  const buildOs = macos ? ['ubuntu-latest', 'macos-latest'] : ['ubuntu-latest'];
  const shards = (os, total) =>
    Array.from({ length: total }, (_, i) => ({ os, shard: i + 1, total }));
  const testMatrix = [
    ...shards('ubuntu-latest', LINUX_SHARDS),
    ...(macos ? shards('macos-latest', MACOS_SHARDS) : []),
  ];
  return { buildOs, testMatrix };
}

function git(/** @type {string[]} */ args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function main() {
  const [event = '', base, head] = process.argv.slice(2);
  let detection = { darwin: false, reason: 'not a pull request' };
  if (event === 'pull_request') {
    try {
      const paths = git(['diff', '--name-only', '--no-renames', base, head])
        .split('\n')
        .filter(Boolean);
      const patch = git(['diff', '-U0', '--no-renames', base, head, '--', ...CODE_PATHSPECS]);
      detection = detectDarwin(paths, patch);
    } catch (err) {
      detection = {
        darwin: true,
        reason: `darwin detection failed, so macOS runs: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  const { buildOs, testMatrix } = platformMatrix(event, detection.darwin);
  const lines = [
    `darwin=${detection.darwin}`,
    `build_os=${JSON.stringify(buildOs)}`,
    `test_matrix=${JSON.stringify(testMatrix)}`,
  ];
  console.log(`${detection.reason}\n${lines.join('\n')}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
