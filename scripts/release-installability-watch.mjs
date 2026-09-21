#!/usr/bin/env node
/**
 * release-installability-watch.mjs — answer "is this version installable NOW?" (gh#1474, gh#1478).
 *
 * ## Why a watcher and not a longer budget
 *
 * `@cleocode/cleo` has taken 4m55s, 55m11s and 2h55m09s to become installable
 * across three consecutive releases. Two of those exceed any workable job cap,
 * so NO poll budget fits inside a GitHub Actions job — raising
 * `POSTDEPLOY_TIMEOUT_MS` cannot solve this, it can only burn a runner for
 * hours and then still time out.
 *
 * So the release run answers the bounded question ("did this run prove
 * installability inside its budget?") and this watcher answers the live one.
 * It is cheap by construction: with no open tracking issues it exits in about
 * ten seconds, which is the common case on every tick of every day.
 *
 * ## Why it edits the issue body rather than commenting
 *
 * A watch that ran for 2h55m at a 10-minute cadence would post ~18 comments;
 * an 18-hour one would post ~100. Notification volume is how a real signal
 * gets muted. The body carries current state; comments are reserved for the
 * two transitions worth waking someone for — converged (and closing), and
 * stuck past 24h.
 *
 * ## Escalating interval
 *
 * Fresh issues are checked every tick; after an hour every ~30 minutes; after
 * six, hourly. A release that converges in 5 minutes is reported promptly
 * without a day-old issue being polled 144 times.
 *
 * @task T12251
 * @epic T12119
 */

import { execFileSync } from 'node:child_process';
import { appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPackage, readPublishedPackages } from './execute-payload.mjs';

const LABEL = 'release-installability';
const STUCK_LABEL = 'release-installability-stuck';
const STUCK_AFTER_MS = 24 * 60 * 60 * 1000;
const ISSUE_LIMIT = 1000;
const SCHEDULE_GRACE_MS = 10 * 60 * 1000;

/**
 * Decide whether an issue is due for a check this tick.
 *
 * @param {number} ageMs - How long the issue has been open.
 * @param {number} sinceLastCheckMs - Time since the last recorded check.
 * @returns {boolean}
 */
export function shouldCheckNow(ageMs, sinceLastCheckMs) {
  if (ageMs < 60 * 60 * 1000) return true; // first hour: every tick
  if (ageMs < 6 * 60 * 60 * 1000) return sinceLastCheckMs >= 30 * 60 * 1000;
  return sinceLastCheckMs >= 60 * 60 * 1000;
}

/**
 * Compare two CalVer-ish version strings numerically, segment by segment.
 *
 * Used only to detect that the dist-tag has moved PAST the version under watch,
 * which means a later release superseded this one and the issue should close
 * rather than poll forever.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} negative when a < b.
 */
export function compareVersions(a, b) {
  const seg = (v) =>
    v
      .split('-')[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [seg(a), seg(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  // A prerelease sorts before its own release.
  const pre = (v) => (v.includes('-') ? 0 : 1);
  return pre(a) - pre(b);
}

function gh(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Extract the machine-readable state block embedded in the issue body.
 *
 * @param {string} body
 * @returns {object | null} Parsed state, or null for malformed/non-object JSON.
 */
export function parseState(body) {
  const m = body.match(/<!--\s*release-installability-state\s*([\s\S]*?)-->/);
  if (!m) return null;
  try {
    const state = JSON.parse(m[1]);
    return state && typeof state === 'object' && !Array.isArray(state) ? state : null;
  } catch {
    return null;
  }
}

/** Replace the embedded state block, leaving the prose untouched. */
function withState(body, state) {
  const block = `<!-- release-installability-state\n${JSON.stringify(state, null, 2)}\n-->`;
  return /<!--\s*release-installability-state[\s\S]*?-->/.test(body)
    ? body.replace(/<!--\s*release-installability-state[\s\S]*?-->/, block)
    : `${body}\n\n${block}`;
}

/**
 * Run exactly one verification pass over a package set. No polling, no sleep —
 * the cron tick IS the poll interval.
 *
 * @param {string[]} packages
 * @param {string} version
 * @param {string} distTag
 * @returns {Promise<Array<{pkg: string, ok: boolean, reason?: string, rung?: string}>>}
 */
export async function checkAllOnce(packages, version, distTag) {
  return await Promise.all(
    packages.map(async (pkg) => {
      const r = await checkPackage(pkg, version, fetch, distTag);
      return { pkg, ok: r.state === 'ok', reason: r.detail, rung: r.rung };
    }),
  );
}

/** Describe freshness without equating a failed attempt with a successful observation. */
function freshness(lastObservedAt, now, ageMs) {
  const maxAgeMs =
    (ageMs < 60 * 60 * 1000 ? 10 : ageMs < 6 * 60 * 60 * 1000 ? 30 : 60) * 60 * 1000 +
    SCHEDULE_GRACE_MS;
  if (!lastObservedAt)
    return {
      status: 'missing',
      ageMs: null,
      maxAgeMs,
      evaluatedAt: new Date(now).toISOString(),
      staleAfterAt: null,
    };
  const elapsed = now - Date.parse(lastObservedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0)
    return {
      status: 'invalid',
      ageMs: null,
      maxAgeMs,
      evaluatedAt: new Date(now).toISOString(),
      staleAfterAt: null,
    };
  return {
    status: elapsed > maxAgeMs ? 'stale' : 'current',
    ageMs: elapsed,
    maxAgeMs,
    evaluatedAt: new Date(now).toISOString(),
    staleAfterAt: new Date(Date.parse(lastObservedAt) + maxAgeMs).toISOString(),
  };
}

/** Retain operation and exit diagnostics without copying credentials or issue bodies from process errors. */
function diagnostic(operation, error) {
  return {
    operation,
    code: 'E_WATCH_OPERATION_FAILED',
    message: `${operation} failed`,
    errorName: typeof error?.name === 'string' ? error.name : 'Error',
    exitCode: Number.isSafeInteger(error?.status) ? error.status : null,
  };
}

/** Freeze owned report data so later issue updates cannot revise this observation. */
function freezeReport(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') freezeReport(child);
  }
  return Object.freeze(value);
}

/**
 * Observe one bounded sweep through the existing GitHub scheduler's I/O boundary.
 *
 * @param {object} [options] - Isolated environment, clock and I/O adapters for deterministic tests.
 * @returns {Promise<object>} Immutable observation, including failed reads and writes.
 * @remarks
 * A successful observation means the requested registry checks returned evidence,
 * not that publication or installed package contents were verified. Prior legacy
 * timestamps retain their unverified provenance. No scheduling engine is created.
 * @example
 * const report = await observeInstallability({ env: { DRY_RUN: 'true' } });
 */
export async function observeInstallability(options = {}) {
  const env = options.env ?? process.env;
  const clock = options.now ?? Date.now;
  const github = options.github ?? gh;
  const checkPackages = options.checkPackages ?? checkAllOnce;
  const readPackages = options.readPackages ?? readPublishedPackages;
  const startedMs = clock();
  const attemptedAt = new Date(startedMs).toISOString();
  const dryRun = env.DRY_RUN === 'true' || env.DRY_RUN === '1';
  const trigger = env.GITHUB_EVENT_NAME || 'unknown';
  const run = {
    id: env.GITHUB_RUN_ID || null,
    attempt: env.GITHUB_RUN_ATTEMPT || null,
    revision: env.GITHUB_SHA || null,
    url:
      env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        : null,
  };
  const report = {
    schemaVersion: 1,
    attemptedAt,
    completedAt: null,
    trigger,
    run,
    dryRun,
    inventory: { matched: null, limit: ISSUE_LIMIT, coverage: 'failed' },
    history: {
      coverage: 'partial',
      source: 'machine state on open tracking issues',
      excluded: 'Closed trackers and previous workflow artifacts are not read by this sweep',
    },
    observations: [],
    diagnostics: [],
    exitCode: 0,
    evidence: {
      publicationAcceptance: 'unverified',
      installedContent: 'unverified',
      registryChecks: 'per-version metadata, resolved tarball HEAD, requested dist-tag',
    },
  };
  const finish = () => {
    report.completedAt = new Date(clock()).toISOString();
    return freezeReport(report);
  };
  let issues;
  try {
    const raw = await github([
      'issue',
      'list',
      '--label',
      LABEL,
      '--state',
      'open',
      '--limit',
      String(ISSUE_LIMIT),
      '--json',
      'number,title,body,createdAt,labels',
    ]);
    issues = JSON.parse(raw);
    if (
      !Array.isArray(issues) ||
      issues.some(
        (i) =>
          !Number.isSafeInteger(i?.number) ||
          typeof i.title !== 'string' ||
          typeof i.body !== 'string' ||
          !Number.isFinite(Date.parse(i.createdAt)) ||
          !Array.isArray(i.labels),
      )
    ) {
      throw new Error('Invalid issue inventory');
    }
  } catch (error) {
    report.diagnostics.push(diagnostic('issue-list', error));
    report.exitCode = 1;
    return finish();
  }
  report.inventory = {
    matched: issues.length,
    limit: ISSUE_LIMIT,
    coverage: issues.length >= ISSUE_LIMIT ? 'partial' : 'current',
  };
  if (report.inventory.coverage === 'partial') {
    report.diagnostics.push({
      operation: 'issue-list',
      code: 'E_WATCH_INVENTORY_LIMIT',
      message: 'Issue limit reached; population may be incomplete',
    });
    report.exitCode = 1;
  }
  const forcedVersion = env.WATCH_VERSION || '';
  if (forcedVersion) {
    // Exact state identity prevents v1.2 from selecting v1.20 by title substring.
    issues = issues.filter((issue) => parseState(issue.body)?.version === forcedVersion);
    if (issues.length === 0)
      issues = [
        { number: null, title: '', body: '', createdAt: attemptedAt, labels: [], direct: true },
      ];
  }
  for (const issue of issues) {
    const state = issue.direct
      ? { version: forcedVersion, distTag: env.WATCH_DIST_TAG || 'latest' }
      : parseState(issue.body);
    const previous = state?.lastObservation ?? null;
    const ageMs = Math.max(0, startedMs - Date.parse(issue.createdAt));
    const lastSuccess = state?.lastSuccessfulObservationAt ?? null;
    const item = {
      issueId: issue.number,
      version: state?.version ?? null,
      distTag: state?.distTag ?? 'latest',
      attemptedAt: null,
      observedAt: null,
      lastAttemptedAt: state?.lastAttemptedAt ?? null,
      lastSuccessfulObservationAt: lastSuccess,
      legacyLastCheckedAt: state?.lastCheckedAt ?? null,
      trigger,
      run: { ...run },
      outcome: 'failed',
      coverage: 'failed',
      results: [],
      diagnostics: [],
      freshness: freshness(lastSuccess, startedMs, ageMs),
      previousObservation: previous,
      persistence: dryRun
        ? 'not-requested-dry-run'
        : issue.direct
          ? 'not-applicable'
          : 'not-attempted',
      actions: [],
    };
    report.observations.push(item);
    if (
      !state ||
      typeof state.version !== 'string' ||
      !state.version ||
      typeof item.distTag !== 'string' ||
      !item.distTag ||
      !Number.isFinite(ageMs)
    ) {
      item.diagnostics.push({
        operation: 'issue-state',
        code: 'E_WATCH_STATE_INVALID',
        message: 'Missing or invalid machine-readable release identity',
      });
      report.exitCode = 1;
      continue;
    }
    // Legacy lastCheckedAt can throttle checks, but cannot claim new provenance.
    const lastCheck = lastSuccess ?? state.lastCheckedAt;
    const elapsed = lastCheck ? startedMs - Date.parse(lastCheck) : Infinity;
    if (
      !forcedVersion &&
      Number.isFinite(elapsed) &&
      elapsed >= 0 &&
      !shouldCheckNow(ageMs, elapsed)
    ) {
      item.outcome = 'not-due';
      item.coverage = lastSuccess ? 'current' : 'partial';
      continue;
    }
    item.attemptedAt = attemptedAt;
    item.lastAttemptedAt = attemptedAt;
    try {
      const fromTag = Array.isArray(state.packages) && state.packages.length > 0;
      const packages = fromTag ? [...state.packages] : await readPackages();
      if (
        !Array.isArray(packages) ||
        packages.length === 0 ||
        packages.some((pkg) => typeof pkg !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(pkg)) ||
        new Set(packages).size !== packages.length
      )
        throw new Error('Invalid package inventory');
      const results = await checkPackages(packages, state.version, item.distTag);
      if (
        !Array.isArray(results) ||
        results.length !== packages.length ||
        packages.some(
          (pkg) => results.filter((r) => r?.pkg === pkg && typeof r.ok === 'boolean').length !== 1,
        )
      ) {
        throw new Error('Incomplete package observation');
      }
      item.results = results.map((r) => ({
        pkg: r.pkg,
        ok: r.ok,
        reason: r.reason ?? null,
        rung: r.rung ?? null,
      }));
      item.observedAt = new Date(clock()).toISOString();
      item.lastSuccessfulObservationAt = item.observedAt;
      item.freshness = freshness(item.observedAt, clock(), ageMs);
      item.coverage = fromTag || issue.direct ? 'current' : 'partial';
      if (!fromTag && !issue.direct)
        item.diagnostics.push({
          operation: 'package-inventory',
          code: 'E_WATCH_LEGACY_PACKAGE_SCOPE',
          message: 'Current publish list used; historical tag package scope is unverified',
        });
      const bad = item.results.filter((r) => !r.ok);
      item.outcome = bad.length === 0 ? 'installable' : 'pending';
      const tagNow = bad.find((r) => r.rung === 'dist-tag');
      const successor = /resolves to "([^"]+)"/.exec(tagNow?.reason ?? '')?.[1];
      if (successor && successor !== '(absent)' && compareVersions(successor, state.version) > 0)
        item.outcome = 'superseded';
      if (issue.direct && bad.length > 0) report.exitCode = 1;
    } catch (error) {
      item.diagnostics.push(diagnostic('registry-observation', error));
      report.exitCode = 1;
    }
    if (dryRun || issue.direct) continue;
    try {
      // Persist terminal evidence before comments or closure. Retain prior success
      // on failed attempts; omit previousObservation to avoid recursive history.
      const { previousObservation: _previous, ...persisted } = item;
      const rows = item.results.map(
        (result) =>
          `| @cleocode/${result.pkg} | ${result.ok ? 'yes' : 'no'} | ${result.rung ?? 'unknown'} | ${(result.reason ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ')} |`,
      );
      const table = [
        '| package | installable | stalled at | reason |',
        '|---|:--:|---|---|',
        ...rows,
      ].join('\n');
      const visibleBody = rows.length
        ? issue.body.replace(/\n\| package \|[\s\S]*?(?=\n\n<!--|$)/, `\n${table}`)
        : issue.body;
      const body = withState(visibleBody, {
        ...state,
        lastAttemptedAt: attemptedAt,
        lastSuccessfulObservationAt: item.lastSuccessfulObservationAt,
        lastCheckedAt: item.observedAt ?? state.lastCheckedAt ?? null,
        lastObservation: { ...persisted, persistence: 'recorded-in-issue' },
        lastSuccessfulObservation: item.observedAt
          ? { ...persisted, persistence: 'recorded-in-issue' }
          : (state.lastSuccessfulObservation ?? null),
      });
      await github(['issue', 'edit', String(issue.number), '--body', body]);
      item.actions.push('state-recorded');
      item.persistence = 'succeeded';
      if (item.coverage === 'current' && ['installable', 'superseded'].includes(item.outcome)) {
        const message =
          item.outcome === 'installable'
            ? `Registry observation ${item.observedAt}: all ${item.results.length} packages resolve metadata, tarball HEAD and dist-tags.${item.distTag}. Installed contents remain unverified. The original release run conclusion is unchanged.`
            : `Registry observation ${item.observedAt}: dist-tags.${item.distTag} points to a later version. Supersession is not proof of this version's installability.`;
        await github(['issue', 'comment', String(issue.number), '--body', message]);
        item.actions.push('comment-recorded');
        await github([
          'issue',
          'close',
          String(issue.number),
          '--reason',
          item.outcome === 'installable' ? 'completed' : 'not planned',
        ]);
        item.actions.push('closed');
      } else if (item.outcome === 'pending' && ageMs > STUCK_AFTER_MS) {
        report.exitCode = 1;
        if (!issue.labels.some((label) => label.name === STUCK_LABEL)) {
          await github(['issue', 'edit', String(issue.number), '--add-label', STUCK_LABEL]);
          item.actions.push('stuck-labeled');
          await github([
            'issue',
            'comment',
            String(issue.number),
            '--body',
            `Registry checks remain pending after 24 hours; last observation ${item.observedAt}. This does not identify a cause or require retagging, republishing or a version bump.`,
          ]);
          item.actions.push('stuck-comment-recorded');
        }
      }
    } catch (error) {
      item.persistence = 'failed';
      item.diagnostics.push(diagnostic('issue-write', error));
      report.exitCode = 1;
    }
  }
  return finish();
}

/**
 * Run one observation and expose it to logs and optional workflow-owned artifacts.
 * @returns {Promise<number>} Nonzero for incomplete reads, verification errors or failed writes.
 * @remarks The workflow remains responsible for scheduling and durable artifact retention.
 * @example const exitCode = await main();
 */
export async function main() {
  let report = await observeInstallability();
  const failedOutput = (operation, error) => {
    report = freezeReport({
      ...report,
      exitCode: 1,
      diagnostics: [...report.diagnostics, diagnostic(operation, error)],
    });
  };
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `\n## Release installability observation\n\nTrigger: ${report.trigger}; run: ${report.run.id ?? 'unknown'}; attempt: ${report.attemptedAt}.\n\nInventory: ${report.inventory.coverage}; ${report.inventory.matched ?? 'unknown'} trackers. Installed contents: unverified.\n\n` +
          report.observations
            .map(
              (item) =>
                `- ${item.version ?? 'unknown'}: ${item.outcome}; coverage ${item.coverage}; freshness ${item.freshness.status}; last successful observation ${item.lastSuccessfulObservationAt ?? 'none'}; persistence ${item.persistence}\n`,
            )
            .join('') +
          `\nDiagnostics: ${report.diagnostics.length + report.observations.reduce((n, item) => n + item.diagnostics.length, 0)}.\n`,
      );
    } catch (error) {
      failedOutput('step-summary-write', error);
    }
  }
  if (process.env.WATCH_OBSERVATION_PATH) {
    try {
      await writeFile(process.env.WATCH_OBSERVATION_PATH, `${JSON.stringify(report, null, 2)}\n`);
    } catch (error) {
      failedOutput('observation-artifact-write', error);
    }
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report.exitCode;
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) process.exit(await main());
