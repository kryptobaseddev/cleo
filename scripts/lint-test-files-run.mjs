#!/usr/bin/env node
/**
 * Gate 43: every tracked test file is collected by a vitest run CI performs (T14410).
 *
 * ## What this prevents
 *
 * The root and package vitest configs excluded `**\/*.integration.test.ts` and
 * `**\/*-integration.test.ts` "to run separately", and no CI job ever ran them:
 * 24 test files never executed (found during #2772, T14403). It is the fourth
 * silent-skip of its kind (T10177, T11414, T12067). Each was a test file that
 * matched no include, or an exclude, and nothing said so: a file that never
 * runs looks exactly like a file that passes.
 *
 * ## Checks
 *
 * 1. Every vitest config in {@link CI_RUNNERS} is invoked by a non-comment line
 *    of a `.github/workflows/*.yml` file (its `marker`).
 * 2. `vitest list --filesOnly` over those configs (the files CI collects) covers
 *    every tracked `*.test.*` / `*.spec.*` file, except:
 *    - files under an {@link IGNORED_PREFIXES} prefix (not repo test suites);
 *    - the `@cleocode/cleo` quarantine (`packages/cleo/vitest.quarantine.ts`,
 *      burn-down T12072), which CI excludes on purpose;
 *    - {@link BASELINE}: files that never ran before this gate, each with its
 *      reason and task. It may only shrink: an entry CI now collects, or whose
 *      file is gone, fails as stale; more entries than {@link BASELINE_PIN}
 *      fails; and with `--base <ref>` an entry the base's baseline lacks, or a
 *      pin above the base's, fails, so a PR cannot add an unrun test together
 *      with a matching baseline line.
 * 3. Every {@link SECRET_GATED} file is collected. Those suites skip without
 *    their credential or host, so the gate lists them as "collected but skipped
 *    without secrets" rather than letting them read as covered.
 *
 * `vitest list --filesOnly` resolves include/exclude/projects exactly as
 * `vitest run` does without importing a test file (about 2 s), so the gate
 * reads the configs instead of re-implementing their globs.
 *
 * `--check` (default) fails on an uncollected file outside the baseline or a
 * stale baseline entry. `--strict` also fails while the baseline is non-empty.
 *
 * Usage: node scripts/lint-test-files-run.mjs [--check|--strict] [--base <ref>]
 *
 * @task T14410
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** A tracked file is a test file when its name matches this. */
export const TEST_FILE = /\.(test|spec)\.(c|m)?[jt]sx?$/;

/**
 * The vitest configs CI runs, and the workflow text that proves it runs each.
 *
 * @type {ReadonlyArray<{ config: string, marker: string, job: string }>}
 */
export const CI_RUNNERS = [
  {
    config: 'vitest.config.ts',
    marker: 'node scripts/ci-flaky-quarantine.mjs run',
    job: 'ci.yml unit-tests (every vitest project, sharded)',
  },
  {
    config: 'packages/core/vitest.integration.config.ts',
    marker: '--config packages/core/vitest.integration.config.ts',
    job: 'ci.yml integration-tests (live-credential and VM suites, T14410)',
  },
];

/**
 * Collected files that skip in CI because CI holds no secret or host for them.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const SECRET_GATED = {
  'packages/core/src/llm/pi/__tests__/pi-anthropic-turn.integration.test.ts':
    'needs a resolvable Anthropic credential',
  'packages/core/src/llm/pi/__tests__/pi-gondolin-env.integration.test.ts':
    'needs CLEO_GONDOLIN_INTEGRATION=1, /dev/kvm and QEMU',
  'packages/core/src/llm/transports/__tests__/bedrock.integration.test.ts':
    'needs AWS_BEDROCK_TEST_KEY and AWS credentials',
};

/** Tracked paths that hold no repo test suite. */
export const IGNORED_PREFIXES = [
  // Agent run artifacts (benchmark apps an agent wrote), not this repo's tests.
  '.cleo/',
];

/**
 * Test files that ran in no CI job when this gate landed. MAY ONLY SHRINK.
 * Each reason names the task that brings the file into a CI run. The
 * `*-integration` / `*.integration` entries failed on main's code on their
 * first run (T14410); each task records whether the code or the test is wrong.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const BASELINE = {
  'packages/agents/tests/templates.test.ts':
    'packages/agents has no vitest config or test script (T14411)',
  'packages/cleo-os/test/empirical/wave-10-vision.test.ts':
    'cleo-os vitest include covers src/ only (T14411)',
  'packages/cleo-os/test/empirical/wave-3-launcher.test.ts':
    'cleo-os vitest include covers src/ only (T14411)',
  'packages/cleo-os/test/empirical/wave-7-chatroom.test.ts':
    'cleo-os vitest include covers src/ only (T14411)',
  'packages/cleo-os/test/empirical/wave-7-hierarchy.test.ts':
    'cleo-os vitest include covers src/ only (T14411)',
  'packages/cleo-os/test/empirical/wave-acl-paths.test.ts':
    'cleo-os vitest include covers src/ only (T14411)',
  'packages/cleo-os/test/pi-coding-agent.test.ts':
    'cleo-os vitest include covers src/ only (T14411)',
  'packages/cleo/test/fixtures/fixtures.test.ts':
    'cleo vitest include omits test/fixtures/ (T14411)',
  'packages/cleo/test/fixtures/release-test-npm-lib/src/index.test.ts':
    'fixture project content for the release-pipeline scenarios, not a suite (T14411)',
  'packages/core/packages/core/src/nexus/__tests__/t11024-move-rename.test.ts':
    'stray copy under a doubled packages/core/packages/core path (T14411)',
  'packages/studio/e2e/a11y.spec.ts': 'Playwright spec; no CI job runs Playwright (T14411)',
  'packages/studio/e2e/tasks-explorer.spec.ts':
    'Playwright spec; no CI job runs Playwright (T14411)',
  'packages/cleo/src/dispatch/domains/__tests__/docs-integration.test.ts':
    'fails on main: docs.add kind blob vs local-file (T14413)',
  'packages/cleo/src/dispatch/domains/__tests__/saga-lifecycle-integration.test.ts':
    'fails on main: saga.add reports success false (T14421)',
  'packages/core/src/lifecycle/__tests__/stage-record-provenance.integration.test.ts':
    'fails on main: artifact path and ADR mock root (T14414)',
  'packages/core/src/memory/__tests__/graph-memory-bridge-integration.test.ts':
    'fails on main: table brain_attention already exists (T14415)',
  'packages/core/src/sessions/__tests__/handoff-integration.test.ts':
    'fails on main: session-store mock lacks resolveBoundSessionId (T14416)',
  'packages/core/src/store/__tests__/database-topology-integration.test.ts':
    'fails on main: Scenario 5 no such table items (T14417)',
  'packages/core/src/store/__tests__/e2e-safety-integration.test.ts':
    'fails on main: Task ID collision T001 (T14418)',
  'packages/core/src/store/__tests__/migration-integration.test.ts':
    'fails on main: JSON to SQLite roundtrip reads null (T14419)',
  'packages/core/src/store/__tests__/t310-integration.test.ts':
    'fails on main: paths/conduit mocks lack new exports (T14420)',
};

/** Size of {@link BASELINE} when this gate landed. May only fall. */
export const BASELINE_PIN = 21;

/**
 * The BASELINE keys and pin in another revision of this script's source.
 *
 * @param {string} source - This script's source at some revision.
 * @returns {{ keys: Set<string>, pin: number }}
 */
export function parseBaseline(source) {
  const block = source.match(/export const BASELINE = \{([\s\S]*?)\n\};/);
  const keys = new Set(block ? [...block[1].matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]) : []);
  const pin = source.match(/export const BASELINE_PIN = (\d+);/);
  return { keys, pin: pin ? Number(pin[1]) : Number.NaN };
}

/**
 * Baseline growth against the base revision.
 *
 * @param {{ keys: Set<string>, pin: number }} head - This revision's baseline.
 * @param {{ keys: Set<string>, pin: number } | null} base - The base's, or null when the base has no gate.
 * @returns {string[]} One message per violation.
 */
export function baselineGrowth(head, base) {
  const out = [];
  if (head.keys.size > head.pin) {
    out.push(`BASELINE has ${head.keys.size} entries, above BASELINE_PIN ${head.pin}`);
  }
  if (!base) return out;
  for (const k of head.keys) {
    if (!base.keys.has(k))
      out.push(`${k}: BASELINE entry the base lacks (the baseline may only shrink)`);
  }
  if (head.pin > base.pin) out.push(`BASELINE_PIN rose from ${base.pin} to ${head.pin}`);
  return out;
}

/**
 * Whether a workflow source invokes `marker` on a line that is not a comment.
 *
 * @param {string} source - Workflow YAML text.
 * @param {string} marker - Command text that runs one config.
 * @returns {boolean}
 */
export function workflowInvokes(source, marker) {
  return source.split('\n').some((l) => !l.trimStart().startsWith('#') && l.includes(marker));
}

/**
 * Paths quarantined in `packages/cleo/vitest.quarantine.ts` (parsed, not imported:
 * this script runs without a TypeScript transform).
 *
 * @param {string} source - The quarantine module source.
 * @returns {string[]}
 */
export function quarantinedFiles(source) {
  const arr = source.match(/CLEO_TEST_QUARANTINE:\s*readonly string\[\]\s*=\s*\[([\s\S]*?)\n\];/);
  const body = arr ? arr[1].replace(/\/\/[^\n]*/g, '') : '';
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/**
 * Compare tracked test files with the collected set.
 *
 * @param {object} input
 * @param {string[]} input.tracked - Tracked test files (repo-relative).
 * @param {Set<string>} input.collected - Files some CI vitest run collects.
 * @param {Set<string>} input.quarantined - Files the cleo quarantine excludes.
 * @param {Readonly<Record<string, string>>} input.baseline - Known uncollected files.
 * @param {readonly string[]} input.ignoredPrefixes - Prefixes holding no suites.
 * @returns {{ uncollected: string[], stale: string[], baselined: string[] }}
 */
export function compare({ tracked, collected, quarantined, baseline, ignoredPrefixes }) {
  const trackedSet = new Set(tracked);
  const uncollected = [];
  const baselined = [];
  for (const file of tracked) {
    if (collected.has(file) || quarantined.has(file)) continue;
    if (ignoredPrefixes.some((p) => file.startsWith(p))) continue;
    if (Object.hasOwn(baseline, file)) baselined.push(file);
    else uncollected.push(file);
  }
  const stale = Object.keys(baseline).filter((f) => !trackedSet.has(f) || collected.has(f));
  return { uncollected, stale, baselined };
}

/**
 * Files one vitest config collects, repo-relative.
 *
 * @param {string} config - Config path relative to the repo root.
 * @returns {string[]}
 */
function listCollected(config) {
  const vitest = join(REPO_ROOT, 'node_modules/vitest/vitest.mjs');
  if (!existsSync(vitest)) {
    throw new Error('vitest is not installed: run `pnpm install` first');
  }
  const dir = mkdtempSync(join(tmpdir(), 'lint-test-files-run-'));
  const out = join(dir, 'list.json');
  try {
    // CI never lifts the cleo quarantine; neither does the gate.
    const env = { ...process.env };
    delete env.CLEO_RUN_QUARANTINED;
    const res = spawnSync(
      process.execPath,
      [vitest, 'list', '--filesOnly', `--json=${out}`, '--config', config],
      { cwd: REPO_ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    if (res.status !== 0 || !existsSync(out)) {
      throw new Error(`vitest list --config ${config} failed:\n${res.stderr}`);
    }
    /** @type {{ file: string }[]} */
    const entries = JSON.parse(readFileSync(out, 'utf8'));
    return entries.map((e) => relative(REPO_ROOT, e.file).split('\\').join('/'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const strict = process.argv.includes('--strict');
  const baseIdx = process.argv.indexOf('--base');
  const baseRef = baseIdx === -1 ? null : process.argv[baseIdx + 1];
  const failures = [];

  const headBaseline = parseBaseline(readFileSync(fileURLToPath(import.meta.url), 'utf8'));
  let baseBaseline = null;
  if (baseRef) {
    const shown = spawnSync('git', ['show', `${baseRef}:scripts/lint-test-files-run.mjs`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    // A base without this gate is the PR that adds it: nothing to compare.
    if (shown.status === 0) baseBaseline = parseBaseline(shown.stdout);
  }
  failures.push(...baselineGrowth(headBaseline, baseBaseline));

  const workflowsDir = join(REPO_ROOT, '.github/workflows');
  const workflows = readdirSync(workflowsDir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => readFileSync(join(workflowsDir, f), 'utf8'));
  for (const runner of CI_RUNNERS) {
    if (!workflows.some((w) => workflowInvokes(w, runner.marker))) {
      failures.push(
        `${runner.config}: no workflow line runs it (expected \`${runner.marker}\`, ${runner.job})`,
      );
    }
  }

  const collected = new Set(CI_RUNNERS.flatMap((r) => listCollected(r.config)));
  const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .stdout.split('\0')
    .filter((f) => TEST_FILE.test(f));
  const quarantined = new Set(
    quarantinedFiles(readFileSync(join(REPO_ROOT, 'packages/cleo/vitest.quarantine.ts'), 'utf8')),
  );
  const { uncollected, stale, baselined } = compare({
    tracked,
    collected,
    quarantined,
    baseline: BASELINE,
    ignoredPrefixes: IGNORED_PREFIXES,
  });

  for (const f of uncollected) {
    failures.push(
      `${f}: no CI vitest run collects it. Fix the name or the config include/exclude, or run it in a CI job listed in CI_RUNNERS.`,
    );
  }
  for (const f of stale) {
    failures.push(`${f}: stale BASELINE entry (CI collects it now, or it is gone). Remove it.`);
  }
  const skippedWithoutSecrets = Object.keys(SECRET_GATED).filter((f) => collected.has(f));
  for (const f of Object.keys(SECRET_GATED)) {
    if (!collected.has(f)) failures.push(`${f}: SECRET_GATED entry no CI run collects`);
  }
  if (strict) {
    for (const f of baselined) failures.push(`${f}: baselined, never runs in CI (--strict)`);
  }

  if (failures.length > 0) {
    console.error(`lint-test-files-run: FAIL — ${failures.length} problem(s):\n`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(
    `lint-test-files-run: OK — ${tracked.length} tracked test files; ${collected.size} collected by ${CI_RUNNERS.length} CI runs, ${quarantined.size} quarantined (T12072), ${baselined.length} baselined.`,
  );
  console.log(`  collected but skipped without secrets (${skippedWithoutSecrets.length}):`);
  for (const f of skippedWithoutSecrets) console.log(`    ${f} — ${SECRET_GATED[f]}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
