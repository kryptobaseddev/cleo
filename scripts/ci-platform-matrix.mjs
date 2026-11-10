#!/usr/bin/env node
/**
 * Decide which operating systems CI builds and tests on, and how the unit
 * tests shard on each (T13143).
 *
 * macOS shards take 32–42 min at 4 shards and are 10x the runner cost, so
 * they stay off ordinary pull requests (T12177, 2026-09-29). This script is
 * the one place that decides when they run:
 *
 * - `merge_group`: macOS always. The nightly macOS run lives in macos-main.yml
 *   (T14104), which also files a `macos-regression` issue when it fails, so
 *   ci.yml's `schedule` run is Linux only and nothing runs macOS twice.
 * - `pull_request`: a reduced macOS set ({@link MACOS_PR_SHARDS} shards) only
 *   when the pull request carries the {@link MACOS_LABEL} label (T14367, owner
 *   D11238). A darwin-specific change gets the label added by this run (the
 *   `changes` job, from `add_macos_label`) and runs the macOS legs at once;
 *   a person can add it to any other PR. The label is read when the
 *   `changes` job runs, so a hand-added label takes effect on the next push
 *   or re-run. macos-main.yml's main-push and nightly runs cover the rest: a
 *   platform-agnostic change that happens to break on macOS (realpath `/var`
 *   vs `/private/var`, spaces in "Application Support", the
 *   case-insensitive filesystem, BSD userland flags). A change is
 *   darwin-specific when:
 *   - a changed path names darwin or macOS (`resources/darwin-backend.ts`),
 *     outside `.changeset/`, `docs/` and `macos-main.yml`; or
 *   - a changed, non-comment line of a code or workflow file names macOS (a
 *     `'darwin'` / `'macos'` literal, `Darwin`, `target_os`, `uname`,
 *     `macos-latest`), or adds or removes a platform check that is not only a
 *     `'win32'` comparison (see {@link touchesMacos}).
 * - Anything else (`push`, `schedule`, `workflow_dispatch`): Linux only.
 *
 * The free plan runs at most 5 macOS jobs at once, shared by every pull
 * request and every main push, so the full {@link MACOS_SHARDS}-shard set is
 * kept for the merge-group runs (and macos-main.yml); a labelled
 * pull request runs {@link MACOS_PR_SHARDS} shards, which start after its
 * macOS `build` and share the pool with `Build & Verify` only: one wave
 * (T13198, T14104).
 *
 * Usage (the `changes` job):
 *
 *   node scripts/ci-platform-matrix.mjs <event> [<base-ref> <head-ref>]
 *
 * `PR_LABELS` (env, a JSON array of label names) carries a pull request's
 * labels.
 *
 * Writes to `$GITHUB_OUTPUT`: `darwin`, `build_os` (a JSON array of runner
 * labels), `test_matrix` (a JSON array of `{os, shard, total, node}`) and
 * `node_versions` (the Node versions Type Check runs on) and `add_macos_label`
 * (whether the `changes` job adds {@link MACOS_LABEL}, see {@link macosDecision}).
 * Always exits 0; a detection error on a pull request counts as
 * darwin-specific, so macOS runs: the safe direction.
 *
 * Node (T14055, owner decision D11196; T14367): Type Check and the Linux unit
 * shards run on the engines floor ({@link NODE_FLOOR}) and on Node 26 on every
 * event except `pull_request`, which runs the floor only (see
 * {@link nodeVersions}); macOS runs the floor only.
 * `scripts/lint-node-engine-ssot.mjs` holds every version here to the root
 * `engines.node` floor.
 *
 * @task T13143
 * @task T14055
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
 * macOS unit-test shards in merge groups and in macos-main.yml. Also
 * 8: the free plan runs at most 5 macOS jobs at once, so more shards would
 * only add waves and setup.
 */
export const MACOS_SHARDS = 8;

/**
 * macOS unit-test shards on a darwin-specific pull request (T13198). The
 * shards start after the macOS `build` job, so they share the 5-job macOS
 * pool with `Build & Verify` only: four shards plus that job fit one wave.
 * T14104: two shards (half the suite each) hit ci.yml's 90-minute ceiling
 * on 2026-10-28 while still passing; four split the work instead. ci.yml
 * keeps these legs at 90 minutes.
 */
export const MACOS_PR_SHARDS = 4;

/** The root `engines.node` floor CI runs on everywhere (gate 8 checks it against root). */
export const NODE_FLOOR = '24.16.0';

/**
 * The Node versions Type Check and the Linux unit shards run on (T14055):
 * the floor, and Node 26 so a Node-26-only break fails CI rather than a
 * developer's machine. Ordered floor first.
 */
export const NODE_VERSIONS = [NODE_FLOOR, '26'];

/** The pull request label that turns the macOS legs on (T14367). */
export const MACOS_LABEL = 'macos';

/**
 * The Node versions Type Check and the Linux unit shards run on for an event
 * (T14367): a pull request runs the floor only, since its Node 26 shards
 * duplicated the floor's at about 95 runner-minutes per run; main pushes, the
 * nightly schedule, merge groups and dispatches run every {@link NODE_VERSIONS}
 * entry, so a Node-26-only break still fails main's own CI.
 *
 * @param {string} event - `github.event_name`.
 * @returns {string[]}
 */
export function nodeVersions(event) {
  return event === 'pull_request' ? [NODE_FLOOR] : [...NODE_VERSIONS];
}

/**
 * Whether an event runs the macOS legs, and whether CI adds the
 * {@link MACOS_LABEL} label (T14367, owner D11238): a pull request runs them
 * when it carries the label or its change is darwin-specific, and a
 * darwin-specific pull request without the label gets it, so the PR shows
 * why macOS ran and keeps running it. Merge groups always run macOS; any
 * other event runs it in macos-main.yml, not here.
 *
 * @param {string} event - `github.event_name`.
 * @param {boolean} darwin - Whether the change is darwin-specific ({@link detectDarwin}).
 * @param {boolean} labelled - Whether the pull request carries {@link MACOS_LABEL}.
 * @returns {{ runMacos: boolean, addLabel: boolean }}
 */
export function macosDecision(event, darwin, labelled) {
  if (event === 'merge_group') return { runMacos: true, addLabel: false };
  if (event !== 'pull_request') return { runMacos: false, addLabel: false };
  return { runMacos: darwin || labelled, addLabel: darwin && !labelled };
}

/**
 * Whether a pull request's labels ask for the macOS legs.
 *
 * @param {string | undefined} json - `PR_LABELS`: a JSON array of label names.
 * @returns {boolean} False for a missing or unreadable list.
 */
export function hasMacosLabel(json) {
  try {
    const labels = JSON.parse(json ?? '[]');
    return Array.isArray(labels) && labels.includes(MACOS_LABEL);
  } catch {
    return false;
  }
}

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
 * @param {boolean} runMacos - Whether a pull request runs the macOS legs
 *   ({@link macosDecision}). Such a pull request gets {@link MACOS_PR_SHARDS}
 *   macOS shards; the merge-group runs get {@link MACOS_SHARDS}.
 * @returns {{ buildOs: string[], testMatrix: Array<{ os: string, shard: number, total: number, node: string }> }}
 */
export function platformMatrix(event, runMacos) {
  const macos = event === 'merge_group' || (event === 'pull_request' && runMacos);
  const buildOs = macos ? ['ubuntu-latest', 'macos-latest'] : ['ubuntu-latest'];
  const shards = (os, total, node) =>
    Array.from({ length: total }, (_, i) => ({ os, shard: i + 1, total, node }));
  const testMatrix = [
    ...nodeVersions(event).flatMap((node) => shards('ubuntu-latest', LINUX_SHARDS, node)),
    ...(macos
      ? shards(
          'macos-latest',
          event === 'pull_request' ? MACOS_PR_SHARDS : MACOS_SHARDS,
          NODE_FLOOR,
        )
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
        reason: `darwin detection failed, so the change counts as darwin-specific: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  const labelled = event === 'pull_request' && hasMacosLabel(process.env.PR_LABELS);
  const decision = macosDecision(event, detection.darwin, labelled);
  const { buildOs, testMatrix } = platformMatrix(event, decision.runMacos);
  const lines = [
    `darwin=${detection.darwin}`,
    `build_os=${JSON.stringify(buildOs)}`,
    `test_matrix=${JSON.stringify(testMatrix)}`,
    `node_versions=${JSON.stringify(nodeVersions(event))}`,
    `add_macos_label=${decision.addLabel}`,
  ];
  console.log(`${detection.reason}\n${lines.join('\n')}`);
  if (decision.addLabel) {
    console.log(
      `::notice title=macOS runs on this PR::${detection.reason}. CI adds the '${MACOS_LABEL}' label (owner D11238).`,
    );
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
