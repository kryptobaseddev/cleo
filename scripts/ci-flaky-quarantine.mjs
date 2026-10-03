#!/usr/bin/env node
/**
 * Flaky-test quarantine for the CI unit-test shards (T13145).
 *
 * Three flakes in one day (T13130 tarball ESRCH, T13138 affected-packages
 * busy, T13119 exodus-reconcile on macOS) each cost a 20–50 min re-run of a
 * whole CI run. A test that fails and then passes on a re-run says nothing
 * about the change under review, so it no longer blocks CI. It is filed and
 * quarantined instead, and the quarantine is bounded both ways.
 *
 * Subcommands:
 *
 *   run  --log <file> --report <file> -- <vitest args...>
 *     Runs `pnpm exec vitest run <vitest args>` with a JSON report.
 *     - Exit 0 from vitest: pass.
 *     - A failing test listed in the quarantine: reported, not blocking.
 *     - Any other failing test: its FILES are re-run once (without --shard).
 *       If every one of those tests passes on the re-run it is a flake:
 *       reported, not blocking. A test that fails twice blocks.
 *     - vitest failed without a readable report, or with no failing test in
 *       it (a crash, a heap kill, an unhandled error): blocks, not retried.
 *     - More than {@link MAX_QUARANTINE} quarantined tests: blocks, so the
 *       quarantine cannot grow without someone fixing tests.
 *     The first run's output is teed to --log, so a later step can scan it. The
 *     flakes and quarantined failures go to --report as JSON (no file when
 *     there are none).
 *
 *   file --reports <dir> --run-url <url> --sha <sha> [--expire]
 *     On main (push or nightly) only. Each reported test gets an open issue
 *     labelled {@link LABEL} (created, or updated with the new observation);
 *     the open issues ARE the quarantine. With --expire (the nightly run), an
 *     issue whose last observation is older than {@link EXPIRE_AFTER_DAYS}
 *     days is closed, so the test leaves quarantine. Never fails the job: a
 *     `gh` error is printed as a warning.
 *
 * The quarantine is read with `gh issue list` (GH_TOKEN). A failure to read it
 * means an empty quarantine, so failures block: the safe direction.
 *
 * @task T13145
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Label of the issues that make up the quarantine. */
export const LABEL = 'flaky-quarantine';

/** Most quarantined tests before CI fails. */
export const MAX_QUARANTINE = 10;

/** Days without a confirmed flake after which a quarantined test leaves quarantine. */
export const EXPIRE_AFTER_DAYS = 14;

/** More files with failing tests than this is a broad failure: it blocks without a re-run. */
export const MAX_RERUN_FILES = 10;

/** Events whose run enforces the quarantine budget (main's own runs). */
const BUDGET_EVENTS = new Set(['push', 'schedule']);

/** The test a whole-file failure (a collect or import error) is recorded as. */
export const WHOLE_FILE = '*';

/** Marker carrying an issue's machine-readable state. */
const MARKER = /<!-- flaky-quarantine (\{.*?\}) -->/s;

/** GitHub's title limit is 256; keep a margin. */
const MAX_TITLE = 240;

/**
 * @typedef {{ file: string, test: string }} TestRef
 * @typedef {{ file: string, test: string, firstSeenAt: string, lastSeenAt: string, observations: number }} QuarantineState
 * @typedef {{ number: number, title: string, body: string, state: QuarantineState | null }} QuarantineIssue
 * @typedef {{ kind: 'flaky' | 'quarantined', file: string, test: string, message: string }} Observation
 */

/** Stable key of a test. */
export const keyOf = (/** @type {TestRef} */ t) => `${t.file}\u0000${t.test}`;

/**
 * Read a vitest (jest-shaped) JSON report into its failing tests.
 *
 * @param {string} raw - The report file's contents.
 * @param {string} repoRoot - Absolute repository root; file paths become relative to it.
 * @returns {{ failures: TestRef[], messages: Map<string, string> } | null} `null` when
 *   the report is not a vitest JSON report.
 */
export function parseVitestReport(raw, repoRoot) {
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    return null;
  }
  if (report === null || typeof report !== 'object' || !Array.isArray(report.testResults)) {
    return null;
  }
  /** @type {TestRef[]} */
  const failures = [];
  const messages = new Map();
  for (const result of report.testResults) {
    if (result === null || typeof result !== 'object' || typeof result.name !== 'string') continue;
    const rel = path.isAbsolute(result.name) ? path.relative(repoRoot, result.name) : result.name;
    const file = rel.split(path.sep).join('/');
    const asserts = Array.isArray(result.assertionResults) ? result.assertionResults : [];
    const failed = asserts.filter((a) => a && a.status === 'failed');
    for (const a of failed) {
      const test =
        typeof a.fullName === 'string' && a.fullName !== '' ? a.fullName : String(a.title);
      const ref = { file, test };
      failures.push(ref);
      const msg = Array.isArray(a.failureMessages) ? String(a.failureMessages[0] ?? '') : '';
      messages.set(keyOf(ref), msg.split('\n')[0].slice(0, 300));
    }
    if (failed.length === 0 && result.status === 'failed') {
      const ref = { file, test: WHOLE_FILE };
      failures.push(ref);
      messages.set(
        keyOf(ref),
        String(result.message ?? '')
          .split('\n')[0]
          .slice(0, 300),
      );
    }
  }
  return { failures, messages };
}

/**
 * Whether a failing test is quarantined.
 *
 * @param {TestRef} failure
 * @param {readonly TestRef[]} quarantine
 */
export function isQuarantined(failure, quarantine) {
  // Exact: a whole-file entry ('*') excuses only a whole-file failure, never a
  // test that a later change adds to that file (T13145 review).
  return quarantine.some((q) => q.file === failure.file && q.test === failure.test);
}

/**
 * Decide a shard's outcome from its first run and, when it happened, the
 * re-run of the failing files. Every failing test is re-run, quarantined or
 * not (T13145 review):
 *
 * - failed, then passed → `flaky` (a confirmed flake: not blocking; it files
 *   or renews the test's quarantine);
 * - failed twice and quarantined → `quarantined` (not blocking, but it does
 *   NOT renew the quarantine, so a test that is broken rather than flaky
 *   leaves quarantine within {@link EXPIRE_AFTER_DAYS} days and then blocks);
 * - failed twice otherwise → `blocking`.
 *
 * @param {TestRef[]} first - Failing tests of the first run.
 * @param {readonly TestRef[]} quarantine - Quarantined tests.
 * @param {TestRef[] | null} rerun - Failing tests of the re-run; `null` when there was none
 *   or its report was unreadable (then every failure counts as failing twice).
 * @returns {{ blocking: TestRef[], flaky: TestRef[], quarantined: TestRef[] }}
 */
export function classify(first, quarantine, rerun) {
  const still = rerun === null ? new Set(first.map(keyOf)) : new Set(rerun.map(keyOf));
  const flaky = first.filter((f) => !still.has(keyOf(f)));
  const failing = first.filter((f) => still.has(keyOf(f)));
  // A test that failed only in the re-run was not in the first failure set;
  // it failed, so it counts as failing.
  for (const f of rerun ?? []) {
    if (!first.some((r) => keyOf(r) === keyOf(f))) failing.push(f);
  }
  return {
    blocking: failing.filter((f) => !isQuarantined(f, quarantine)),
    flaky,
    quarantined: failing.filter((f) => isQuarantined(f, quarantine)),
  };
}

/**
 * Drop a `--shard=<n>/<m>` (or `--shard <n>/<m>`) argument: the re-run names files.
 *
 * @param {readonly string[]} args
 */
export function withoutShard(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--shard=')) continue;
    if (args[i] === '--shard') {
      i++;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

/**
 * Read an issue's quarantine state from its body marker.
 *
 * @param {{ number: number, title: string, body?: string | null }} issue
 * @returns {QuarantineIssue}
 */
export function parseIssue(issue) {
  const body = issue.body ?? '';
  const match = MARKER.exec(body);
  let state = null;
  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      if (typeof parsed.file === 'string' && typeof parsed.test === 'string') state = parsed;
    } catch {
      state = null;
    }
  }
  return { number: issue.number, title: issue.title, body, state };
}

/** The issue title for a test. */
export function titleOf(/** @type {TestRef} */ t) {
  const title = `flaky: ${t.file} > ${t.test}`;
  return title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1)}…` : title;
}

/**
 * The body of a quarantine issue.
 *
 * @param {QuarantineState} state
 * @param {string} note - The latest observation, one line.
 */
export function bodyOf(state, note) {
  return [
    `\`${state.test}\` in \`${state.file}\` failed in CI and then passed on a re-run: a flake.`,
    '',
    `While this issue is open the test is **quarantined**: a failure of it that also fails its re-run does not block CI (scripts/ci-flaky-quarantine.mjs, T13145). Only a confirmed flake (fail, then pass) renews the quarantine; ${EXPIRE_AFTER_DAYS} days without one close this issue automatically, and the test blocks again. Close it by hand once the flake is fixed. Main CI fails while more than ${MAX_QUARANTINE} tests are quarantined. Only issues github-actions files count.`,
    '',
    `Confirmed flakes: ${state.observations} (first ${state.firstSeenAt}, last ${state.lastSeenAt}).`,
    `Latest: ${note}`,
    '',
    // `>` is escaped so no test name can end the comment early.
    `<!-- flaky-quarantine ${JSON.stringify(state).replace(/>/g, '\\u003e')} -->`,
  ].join('\n');
}

/**
 * Plan the issue writes for a set of observations.
 *
 * @param {readonly Observation[]} observations
 * @param {readonly QuarantineIssue[]} open - Open quarantine issues.
 * @param {string} now - ISO timestamp.
 * @param {string} note - Run URL and SHA, for the observation line.
 * @returns {{ create: Array<{ title: string, body: string }>, update: Array<{ number: number, body: string }> }}
 */
export function planFiling(observations, open, now, note) {
  /** @type {Map<string, Observation>} */
  const byKey = new Map();
  // A confirmed flake in any shard outranks a quarantined test failing twice in another.
  for (const o of observations) {
    if (byKey.get(keyOf(o))?.kind !== 'flaky') byKey.set(keyOf(o), o);
  }
  const create = [];
  const update = [];
  for (const [key, o] of byKey) {
    const issue = open.find((i) => i.state !== null && keyOf(i.state) === key);
    const line = `${o.kind} on ${note}${o.message ? `: ${o.message}` : ''}`;
    if (o.kind === 'quarantined') {
      // Failing twice is not a flake: record it, never renew the quarantine.
      if (issue?.state) {
        update.push({
          number: issue.number,
          body: bodyOf(
            issue.state,
            `${line} (failed its re-run too; the quarantine is not renewed)`,
          ),
        });
      }
      continue;
    }
    if (issue?.state) {
      const state = {
        ...issue.state,
        lastSeenAt: now,
        observations: issue.state.observations + 1,
      };
      update.push({ number: issue.number, body: bodyOf(state, line) });
    } else {
      const state = {
        file: o.file,
        test: o.test,
        firstSeenAt: now,
        lastSeenAt: now,
        observations: 1,
      };
      create.push({ title: titleOf(o), body: bodyOf(state, line) });
    }
  }
  return { create, update };
}

/**
 * Open quarantine issues to close: no observation for {@link EXPIRE_AFTER_DAYS}
 * days, and none in this run.
 *
 * @param {readonly QuarantineIssue[]} open
 * @param {ReadonlySet<string>} observedNow - Keys observed in this run.
 * @param {Date} now
 * @param {number} [days]
 */
export function planExpiry(open, observedNow, now, days = EXPIRE_AFTER_DAYS) {
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  return open.filter((i) => {
    if (i.state === null || observedNow.has(keyOf(i.state))) return false;
    const last = Date.parse(i.state.lastSeenAt);
    return Number.isFinite(last) && last < cutoff;
  });
}

// ── I/O ──────────────────────────────────────────────────────────────────────

/** Run `gh <args>` (FLAKY_QUARANTINE_GH names a stand-in, for tests); returns stdout, or `null` on any failure. */
function gh(/** @type {string[]} */ args) {
  const r = spawnSync(process.env.FLAKY_QUARANTINE_GH || 'gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  if (r.status !== 0) {
    console.warn(
      `::warning::gh ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.error?.message || '').trim()}`,
    );
    return null;
  }
  return r.stdout;
}

/** Whether an issue author is the GitHub Actions bot (as `gh` reports it). */
const isActionsBot = (/** @type {{ login?: string, is_bot?: boolean } | undefined} */ author) =>
  author?.is_bot === true && /^(app\/)?github-actions(\[bot\])?$/.test(author.login ?? '');

/**
 * The quarantine from `gh issue list` rows: only issues the GitHub Actions bot
 * filed count (a collaborator's label is not a CI bypass, T13145 review), and
 * each test counts once — the oldest issue wins; later ones are `duplicates`.
 *
 * @param {Array<{ number: number, title: string, body?: string | null, author?: { login?: string, is_bot?: boolean } }>} rows
 * @returns {{ issues: QuarantineIssue[], duplicates: Array<{ number: number, of: number }> }}
 */
export function trustedIssues(rows) {
  const issues = [];
  const duplicates = [];
  /** @type {Map<string, number>} */
  const firstByKey = new Map();
  for (const row of [...rows].sort((a, b) => a.number - b.number)) {
    if (!isActionsBot(row.author)) continue;
    const issue = parseIssue(row);
    if (issue.state === null) continue;
    const first = firstByKey.get(keyOf(issue.state));
    if (first !== undefined) {
      duplicates.push({ number: issue.number, of: first });
      continue;
    }
    firstByKey.set(keyOf(issue.state), issue.number);
    issues.push(issue);
  }
  return { issues, duplicates };
}

/** The open quarantine issues, or `null` when they cannot be read. */
function readOpenIssues() {
  const out = gh([
    'issue',
    'list',
    '--label',
    LABEL,
    '--state',
    'open',
    '--limit',
    '200',
    '--json',
    'number,title,body,author',
  ]);
  if (out === null) return null;
  try {
    const rows = JSON.parse(out);
    return Array.isArray(rows) ? trustedIssues(rows) : null;
  } catch {
    return null;
  }
}

function argValue(/** @type {string[]} */ argv, /** @type {string} */ name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

/**
 * A line of vitest's output that reports an error outside any test: the
 * `Unhandled Errors` section or the `Errors  N error(s)` summary line. The
 * JSON report does not carry these, so the output is the only evidence.
 */
export const UNHANDLED_LINE = /Unhandled (Errors?|Rejection)|^\s*Errors\s+\d+\s+errors?\b/;

/** Strip ANSI colour codes, so a coloured line matches too. */
const plain = (/** @type {string} */ line) => line.replace(/\x1b\[[0-9;]*m/g, '');

/**
 * Run vitest once; tee its output to `log` when given.
 *
 * @param {readonly string[]} command - Executable and leading args (`pnpm exec vitest run`).
 * @param {readonly string[]} args
 * @param {string} reportPath
 * @param {string | undefined} log
 * @returns {Promise<{ code: number, unhandled: boolean }>} exit code (signals map to 1) and
 *   whether the output reported an error outside any test
 */
function runVitest(command, args, reportPath, log) {
  const full = [
    ...command.slice(1),
    ...args,
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${reportPath}`,
  ];
  return new Promise((resolve) => {
    const child = spawn(command[0], full, { stdio: ['ignore', 'pipe', 'pipe'] });
    const sink = log ? createWriteStream(log) : null;
    let unhandled = false;
    /** @type {Record<'out' | 'err', string>} */
    const partial = { out: '', err: '' };
    const scan = (/** @type {'out' | 'err'} */ which, /** @type {string} */ text) => {
      const lines = (partial[which] + text).split('\n');
      partial[which] = lines.pop() ?? '';
      if (!unhandled && lines.some((l) => UNHANDLED_LINE.test(plain(l)))) unhandled = true;
    };
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      sink?.write(chunk);
      scan('out', String(chunk));
    });
    child.stderr.on('data', (chunk) => {
      process.stdout.write(chunk);
      sink?.write(chunk);
      scan('err', String(chunk));
    });
    child.on('close', (code) => {
      for (const rest of Object.values(partial)) {
        if (!unhandled && UNHANDLED_LINE.test(plain(rest))) unhandled = true;
      }
      const done = () => resolve({ code: code ?? 1, unhandled });
      // Wait for the log to flush: the caller may exit right after.
      if (sink) sink.end(done);
      else done();
    });
    child.on('error', () => resolve({ code: 127, unhandled }));
  });
}

/** `pnpm exec vitest run`, or the JSON array in FLAKY_VITEST_COMMAND (tests). */
function vitestCommand() {
  const override = process.env.FLAKY_VITEST_COMMAND;
  if (override) {
    const parsed = JSON.parse(override);
    if (Array.isArray(parsed) && parsed.every((p) => typeof p === 'string') && parsed.length > 0)
      return parsed;
  }
  return ['pnpm', 'exec', 'vitest', 'run'];
}

function summary(/** @type {string} */ text) {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`, { flag: 'a' });
    } catch {
      // best effort
    }
  }
}

const list = (/** @type {TestRef[]} */ refs) =>
  refs.map((r) => `- \`${r.file}\` > ${r.test}`).join('\n');

/** The `run` subcommand. */
async function runCommand(/** @type {string[]} */ argv) {
  const sep = argv.indexOf('--');
  const own = sep === -1 ? argv : argv.slice(0, sep);
  const vitestArgs = sep === -1 ? [] : argv.slice(sep + 1);
  const log = argValue(own, '--log');
  const reportOut = argValue(own, '--report');
  const repoRoot = process.cwd();
  const work = mkdtempSync(path.join(tmpdir(), 'flaky-quarantine-'));
  const command = vitestCommand();

  const firstReport = path.join(work, 'first.json');
  const firstRun = await runVitest(command, vitestArgs, firstReport, log);

  const open = readOpenIssues();
  const quarantine = (open?.issues ?? []).flatMap((i) => (i.state ? [i.state] : []));
  if (open === null)
    console.warn(
      '::warning::The flaky quarantine could not be read; no failure is quarantined in this run.',
    );
  if (open !== null && quarantine.length > MAX_QUARANTINE) {
    const text = `### Flaky quarantine over budget\n\n${quarantine.length} tests are quarantined (most ${MAX_QUARANTINE}). Fix flaky tests and close their \`${LABEL}\` issues.\n\n${list(quarantine)}`;
    // Enforced on main (push, nightly), where the quarantine grows; a pull
    // request only warns, so one bad day on main does not block every PR.
    if (BUDGET_EVENTS.has(process.env.GITHUB_EVENT_NAME ?? '')) {
      summary(text);
      return 1;
    }
    summary(`${text}\n\n(Warning only on a ${process.env.GITHUB_EVENT_NAME || 'local'} run.)`);
  }
  if (firstRun.unhandled) {
    // An error outside any test is unattributable even when some failures are
    // attributable: a re-run of the failing files would hide it.
    summary(
      "### Unit tests reported an error outside any test\n\nvitest's output has an `Unhandled Errors` section or an `Errors` summary line. It cannot be attributed to a test, so it is not retried.",
    );
    return firstRun.code === 0 ? 1 : firstRun.code;
  }
  if (firstRun.code === 0) return 0;

  const first = existsSync(firstReport)
    ? parseVitestReport(readFileSync(firstReport, 'utf8'), repoRoot)
    : null;
  if (first === null || first.failures.length === 0) {
    summary(
      `### Unit tests failed without an attributable test\n\nvitest exited ${firstRun.code} ${first === null ? 'without a readable JSON report' : 'with no failing test in its report'} (a crash, a heap or signal kill, or an unhandled error). Not retried.`,
    );
    return firstRun.code;
  }

  const files = [...new Set(first.failures.map((f) => f.file))];
  if (files.length > MAX_RERUN_FILES) {
    summary(
      `### ${files.length} files have failing tests\n\nMore than ${MAX_RERUN_FILES}: a broad failure, not a flake. Not retried.\n\n${list(first.failures)}`,
    );
    return 1;
  }
  console.log(
    `\nRe-running ${files.length} file(s) with failing tests once (T13145):\n${files.join('\n')}\n`,
  );
  const rerunReport = path.join(work, 'rerun.json');
  const rerunRun = await runVitest(
    command,
    [...withoutShard(vitestArgs), ...files],
    rerunReport,
    undefined,
  );
  if (rerunRun.unhandled) {
    summary(
      '### The re-run reported an error outside any test\n\nNot attributable to a test, so it blocks.',
    );
    return 1;
  }
  const rerun = existsSync(rerunReport)
    ? parseVitestReport(readFileSync(rerunReport, 'utf8'), repoRoot)
    : null;
  const outcome = classify(first.failures, quarantine, rerun?.failures ?? null);
  const messages = new Map([...first.messages, ...(rerun?.messages ?? [])]);

  /** @type {Observation[]} */
  const observations = [
    ...outcome.flaky.map((f) => ({
      kind: /** @type {const} */ ('flaky'),
      ...f,
      message: messages.get(keyOf(f)) ?? '',
    })),
    ...outcome.quarantined.map((f) => ({
      kind: /** @type {const} */ ('quarantined'),
      ...f,
      message: messages.get(keyOf(f)) ?? '',
    })),
  ];
  if (reportOut && observations.length > 0)
    writeFileSync(reportOut, `${JSON.stringify({ observations }, null, 2)}\n`);
  if (outcome.flaky.length > 0)
    summary(
      `### Flaky tests (failed, then passed on a re-run; not blocking)\n\n${list(outcome.flaky)}`,
    );
  if (outcome.quarantined.length > 0)
    summary(
      `### Quarantined tests that failed their re-run too (not blocking; the quarantine is not renewed)\n\n${list(outcome.quarantined)}`,
    );
  if (outcome.blocking.length > 0) {
    summary(`### Failing tests (failed on the re-run too)\n\n${list(outcome.blocking)}`);
    return 1;
  }
  return 0;
}

/** The `file` subcommand: never fails the job. */
function fileCommand(/** @type {string[]} */ argv) {
  const dir = argValue(argv, '--reports');
  const runUrl = argValue(argv, '--run-url') ?? 'unknown run';
  const sha = (argValue(argv, '--sha') ?? '').slice(0, 12);
  const expire = argv.includes('--expire');
  /** @type {Observation[]} */
  const observations = [];
  if (dir && existsSync(dir)) {
    const walk = (/** @type {string} */ d) => {
      for (const name of readdirSync(d)) {
        const p = path.join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith('.json')) {
          try {
            const parsed = JSON.parse(readFileSync(p, 'utf8'));
            if (Array.isArray(parsed.observations)) observations.push(...parsed.observations);
          } catch {
            console.warn(`::warning::Unreadable flaky report ${p}`);
          }
        }
      }
    };
    walk(dir);
  }
  const open = readOpenIssues();
  if (open === null) {
    console.warn('::warning::The flaky quarantine could not be read; nothing filed.');
    return 0;
  }
  const now = new Date();
  const plan = planFiling(observations, open.issues, now.toISOString(), `${sha} (${runUrl})`);
  if (plan.create.length > 0) {
    gh([
      'label',
      'create',
      LABEL,
      '--color',
      'FBCA04',
      '--description',
      'Quarantined flaky test (T13145)',
      '--force',
    ]);
  }
  for (const c of plan.create)
    gh(['issue', 'create', '--title', c.title, '--body', c.body, '--label', LABEL]);
  for (const u of plan.update) gh(['issue', 'edit', String(u.number), '--body', u.body]);
  // Two main runs that saw the same new flake each filed it: keep the oldest.
  for (const d of open.duplicates) {
    gh(['issue', 'close', String(d.number), '--comment', `Duplicate of #${d.of} (T13145).`]);
  }
  let closed = 0;
  if (expire) {
    // Only a confirmed flake keeps a test in quarantine; failing twice does not.
    const observed = new Set(observations.filter((o) => o.kind === 'flaky').map(keyOf));
    for (const issue of planExpiry(open.issues, observed, now)) {
      if (
        gh([
          'issue',
          'close',
          String(issue.number),
          '--comment',
          `No confirmed flake in ${EXPIRE_AFTER_DAYS} days: this test leaves quarantine and blocks again when it fails (T13145).`,
        ]) !== null
      )
        closed++;
    }
  }
  console.log(
    `Flaky quarantine: ${plan.create.length} filed, ${plan.update.length} updated, ${closed} expired.`,
  );
  return 0;
}

async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  if (sub === 'run') return runCommand(rest);
  if (sub === 'file') return fileCommand(rest);
  console.error(
    'usage: ci-flaky-quarantine.mjs run --log <f> --report <f> -- <vitest args> | file --reports <dir> --run-url <u> --sha <s> [--expire]',
  );
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
