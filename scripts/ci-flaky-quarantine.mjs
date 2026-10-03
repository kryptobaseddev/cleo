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

/** Days without a new observation after which a quarantined test leaves quarantine. */
export const EXPIRE_AFTER_DAYS = 14;

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
  return quarantine.some(
    (q) => q.file === failure.file && (q.test === failure.test || q.test === WHOLE_FILE),
  );
}

/**
 * Decide a shard's outcome from its first run and, when it happened, the
 * re-run of the failing files.
 *
 * @param {TestRef[]} first - Failing tests of the first run.
 * @param {readonly TestRef[]} quarantine - Quarantined tests.
 * @param {TestRef[] | null} rerun - Failing tests of the re-run; `null` when there was none
 *   or its report was unreadable (then every retried failure blocks).
 * @returns {{ blocking: TestRef[], flaky: TestRef[], quarantined: TestRef[], retry: TestRef[] }}
 */
export function classify(first, quarantine, rerun) {
  const quarantined = first.filter((f) => isQuarantined(f, quarantine));
  const retry = first.filter((f) => !isQuarantined(f, quarantine));
  if (rerun === null) return { blocking: retry, flaky: [], quarantined, retry };
  const stillFailing = new Set(rerun.map(keyOf));
  const blocking = retry.filter((f) => stillFailing.has(keyOf(f)));
  // A test that failed only in the re-run was not part of this shard's first
  // failure set; it failed, so it blocks unless quarantined.
  for (const f of rerun) {
    if (!retry.some((r) => keyOf(r) === keyOf(f)) && !isQuarantined(f, quarantine))
      blocking.push(f);
  }
  const flaky = retry.filter((f) => !stillFailing.has(keyOf(f)));
  return { blocking, flaky, quarantined, retry };
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
    `\`${state.test}\` in \`${state.file}\` failed in CI and then passed on a re-run, or failed while quarantined.`,
    '',
    `While this issue is open the test is **quarantined**: its failures do not block CI (scripts/ci-flaky-quarantine.mjs, T13145). It leaves quarantine when this issue is closed: automatically after ${EXPIRE_AFTER_DAYS} days with no new observation, or by hand once the flake is fixed. CI fails while more than ${MAX_QUARANTINE} tests are quarantined.`,
    '',
    `Observations: ${state.observations} (first ${state.firstSeenAt}, last ${state.lastSeenAt}).`,
    `Latest: ${note}`,
    '',
    `<!-- flaky-quarantine ${JSON.stringify(state)} -->`,
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
  for (const o of observations) byKey.set(keyOf(o), o);
  const create = [];
  const update = [];
  for (const [key, o] of byKey) {
    const issue = open.find((i) => i.state !== null && keyOf(i.state) === key);
    const line = `${o.kind} on ${note}${o.message ? `: ${o.message}` : ''}`;
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
    'number,title,body',
  ]);
  if (out === null) return null;
  try {
    const rows = JSON.parse(out);
    return Array.isArray(rows) ? rows.map(parseIssue) : null;
  } catch {
    return null;
  }
}

function argValue(/** @type {string[]} */ argv, /** @type {string} */ name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

/**
 * Run vitest once; tee its output to `log` when given.
 *
 * @param {readonly string[]} command - Executable and leading args (`pnpm exec vitest run`).
 * @param {readonly string[]} args
 * @param {string} reportPath
 * @param {string | undefined} log
 * @returns {Promise<number>} exit code (signals map to 1)
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
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        process.stdout.write(chunk);
        sink?.write(chunk);
      });
    }
    child.on('close', (code) => {
      // Wait for the log to flush: the caller may exit right after.
      if (sink) sink.end(() => resolve(code ?? 1));
      else resolve(code ?? 1);
    });
    child.on('error', () => resolve(127));
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
  const firstCode = await runVitest(command, vitestArgs, firstReport, log);

  const open = readOpenIssues();
  const quarantine = (open ?? []).flatMap((i) => (i.state ? [i.state] : []));
  if (open === null)
    console.warn(
      '::warning::The flaky quarantine could not be read; no failure is quarantined in this run.',
    );
  if (open !== null && quarantine.length > MAX_QUARANTINE) {
    summary(
      `### Flaky quarantine over budget\n\n${quarantine.length} tests are quarantined (most ${MAX_QUARANTINE}). Fix flaky tests and close their \`${LABEL}\` issues.\n\n${list(quarantine)}`,
    );
    return 1;
  }
  if (firstCode === 0) return 0;

  const first = existsSync(firstReport)
    ? parseVitestReport(readFileSync(firstReport, 'utf8'), repoRoot)
    : null;
  if (first === null || first.failures.length === 0) {
    summary(
      `### Unit tests failed without an attributable test\n\nvitest exited ${firstCode} ${first === null ? 'without a readable JSON report' : 'with no failing test in its report'} (a crash, a heap or signal kill, or an unhandled error). Not retried.`,
    );
    return firstCode === 0 ? 1 : firstCode;
  }

  let rerun = null;
  const pending = first.failures.filter((f) => !isQuarantined(f, quarantine));
  if (pending.length > 0) {
    const files = [...new Set(pending.map((f) => f.file))];
    console.log(
      `\nRe-running ${files.length} file(s) with failing tests once (T13145):\n${files.join('\n')}\n`,
    );
    const rerunReport = path.join(work, 'rerun.json');
    await runVitest(command, [...withoutShard(vitestArgs), ...files], rerunReport, undefined);
    rerun = existsSync(rerunReport)
      ? parseVitestReport(readFileSync(rerunReport, 'utf8'), repoRoot)
      : null;
  }
  const outcome = classify(
    first.failures,
    quarantine,
    rerun === null ? (pending.length > 0 ? null : []) : rerun.failures,
  );
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
    summary(`### Quarantined tests that failed (not blocking)\n\n${list(outcome.quarantined)}`);
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
  const plan = planFiling(observations, open, now.toISOString(), `${sha} (${runUrl})`);
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
  let closed = 0;
  if (expire) {
    const observed = new Set(observations.map(keyOf));
    for (const issue of planExpiry(open, observed, now)) {
      if (
        gh([
          'issue',
          'close',
          String(issue.number),
          '--comment',
          `No new failure in ${EXPIRE_AFTER_DAYS} days: this test leaves quarantine (T13145).`,
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
