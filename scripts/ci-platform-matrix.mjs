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
 * - `pull_request`: a reduced macOS set ({@link MACOS_PR_SHARDS} shards) when
 *   the change is darwin-specific, so a macOS-only regression is caught on its
 *   own PR instead of the next nightly. A
 *   platform-agnostic change that happens to break on macOS (realpath
 *   `/var` vs `/private/var`, spaces in "Application Support", the
 *   case-insensitive filesystem, BSD userland flags) is still found by the
 *   nightly or main-push macOS run:
 *   - a changed path names darwin or macOS (`resources/darwin-backend.ts`),
 *     outside `.changeset/`, `docs/` and `macos-main.yml`; or
 *   - a changed, non-comment line of a code or workflow file names macOS (a
 *     `'darwin'` / `'macos'` literal, `Darwin`, `target_os`, `uname`,
 *     `macos-latest`), or adds or removes a platform check that is not only a
 *     `'win32'` comparison (see {@link touchesMacos}).
 * - Anything else (`push`, `workflow_dispatch`): Linux only.
 *
 * The free plan runs at most 5 macOS jobs at once, shared by every pull
 * request and every main push, so the full {@link MACOS_SHARDS}-shard set is
 * kept for the nightly and merge-group runs (and macos-main.yml); a darwin
 * pull request runs {@link MACOS_PR_SHARDS} shards plus its two macOS builds,
 * which fits the pool in one wave (T13198).
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
 * macOS unit-test shards nightly, in merge groups and in macos-main.yml. Also
 * 8: the free plan runs at most 5 macOS jobs at once, so more shards would
 * only add waves and setup.
 */
export const MACOS_SHARDS = 8;

/**
 * macOS unit-test shards on a darwin-specific pull request (T13198). Two
 * shards and the two macOS build jobs fit the 5-job macOS pool in one wave,
 * so one darwin pull request no longer starves every other PR's macOS legs.
 * ci.yml gives these legs a longer timeout (each runs half the suite).
 */
export const MACOS_PR_SHARDS = 2;

/** A path that is darwin-specific by name. */
const DARWIN_PATH = /(^|[/._-])(darwin|macos)([/._-]|$)/i;

/**
 * Paths never treated as darwin-specific: prose, and macos-main.yml, which a
 * pull request's CI does not run (its own main-push run validates it).
 */
const NOT_DARWIN_PATH = /^(\.changeset\/|docs\/|\.github\/workflows\/macos-main\.yml$)/;

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
 * A line that names macOS: a `'darwin'` / `'macos'` / `'macOS'` literal,
 * `os.type() === 'Darwin'`, Rust `target_os`, a shell `uname`, or a macOS CI
 * runner (`macos-latest`).
 */
const MACOS_LINE = /['"`](darwin|macos)['"`]|\bDarwin\b|target_os|\buname\b|macos-latest/;

/** A quoted `'macOS'` in any case (`runner.os == 'macOS'`). */
const MACOS_LITERAL = /['"`]macos['"`]/i;

/** A runtime platform check: `process.platform`, `os.platform()` / `platform()`. */
const PLATFORM_CHECK = /process\.platform|\bos\.platform\(|\bplatform\(\)/;

/**
 * A `runner.os` comparison (`if: runner.os != 'Linux'`). With the Windows
 * shards disabled, `!= 'Linux'` means macOS only. A cache key
 * (`${{ runner.os }}-pnpm-store-…`) has no comparison, so it never counts.
 */
const RUNNER_OS_CHECK = /runner\.os\s*[!=]=/;

/** Every quoted runner OS name on a line. */
const RUNNER_OS_LITERAL = /['"`](Linux|Windows|macOS)['"`]/gi;

/** Every quoted platform name on a line. */
const PLATFORM_LITERAL =
  /['"`](aix|android|darwin|freebsd|linux|openbsd|sunos|win32|cygwin|netbsd)['"`]/g;

/** A comment-only line (`//`, `/*`, `*`, or `#` other than a Rust `#[...]` attribute). */
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#(?!\[))/;

/**
 * Whether one changed line (without its `+`/`-`) touches macOS behaviour.
 *
 * A platform check counts unless every platform it names is `'win32'`: such a
 * check only splits Windows from POSIX, and the POSIX side is the one Linux
 * already runs. A check naming no platform (`switch (process.platform)`) or
 * naming `'linux'` (whose else-branch is macOS) counts. A `runner.os`
 * comparison follows the same rule (only `'Windows'` does not count). Comment
 * lines and `runner.os` cache keys never count.
 *
 * @param {string} line - The changed line's content.
 * @returns {boolean}
 */
export function touchesMacos(line) {
  if (COMMENT_LINE.test(line)) return false;
  if (MACOS_LINE.test(line) || MACOS_LITERAL.test(line)) return true;
  if (RUNNER_OS_CHECK.test(line)) {
    const oses = [...line.matchAll(RUNNER_OS_LITERAL)].map((m) => m[1].toLowerCase());
    if (oses.length === 0 || oses.some((o) => o !== 'windows')) return true;
  }
  if (!PLATFORM_CHECK.test(line)) return false;
  const named = [...line.matchAll(PLATFORM_LITERAL)].map((m) => m[1]);
  return named.length === 0 || named.some((p) => p !== 'win32');
}

/**
 * Whether a change is darwin-specific.
 *
 * @param {readonly string[]} paths - Changed repo-relative paths.
 * @param {string} patch - `git diff -U0` of the change's code and workflow files ({@link CODE_PATHSPECS}).
 * @returns {{ darwin: boolean, reason: string }}
 */
export function detectDarwin(paths, patch) {
  const named = paths.find((p) => DARWIN_PATH.test(p) && !NOT_DARWIN_PATH.test(p));
  if (named) return { darwin: true, reason: `darwin-specific path: ${named}` };
  let file = '';
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) file = line.slice(line.lastIndexOf(' b/') + 3);
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (NOT_DARWIN_PATH.test(file)) continue;
    if ((line.startsWith('+') || line.startsWith('-')) && touchesMacos(line.slice(1))) {
      return {
        darwin: true,
        reason: `a changed line touches macOS: ${line.slice(0, 160)}`,
      };
    }
  }
  return { darwin: false, reason: 'no darwin-specific path or macOS-relevant line changed' };
}

/**
 * The OS list and unit-test matrix for an event.
 *
 * @param {string} event - `github.event_name`.
 * @param {boolean} darwin - Whether a pull request's change is darwin-specific.
 *   A darwin pull request gets {@link MACOS_PR_SHARDS} macOS shards; the
 *   nightly and merge-group runs get {@link MACOS_SHARDS}.
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
    ...(macos
      ? shards('macos-latest', event === 'pull_request' ? MACOS_PR_SHARDS : MACOS_SHARDS)
      : []),
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
