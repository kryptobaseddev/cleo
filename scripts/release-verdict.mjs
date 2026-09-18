#!/usr/bin/env node
/**
 * release-verdict.mjs — decide and publish what a release run CLAIMS (gh#1474, gh#1416).
 *
 * ## Why this exists
 *
 * v2026.9.6 and v2026.9.7 both concluded `success` over a package that did not
 * exist on npm. The pipeline had already measured that correctly and written it
 * down — `postdeploy-2026.9.6.json` records
 * `{"name":"@cleocode/cleo","verified":false,"reason":"metadata 404"}` and
 * `"failed": 1` — and the verdict was discarded by one line of YAML
 * (`continue-on-error: true`). A night of investigation later reconstructed a
 * fact that had been sitting in a CI artifact the whole time.
 *
 * ## The split this script implements
 *
 * A GitHub Actions run conclusion is stamped once and never revised, while
 * `@cleocode/cleo` has taken anywhere from 4m55s to 2h55m to become
 * installable. So the run cannot be the durable answer to "is this version
 * installable?". Two questions, two homes:
 *
 *   - THE RUN CONCLUSION answers "did THIS RUN prove installability inside its
 *     budget?" — bounded, and permanently true either way.
 *   - THE TRACKING ISSUE answers "is this version installable NOW?" — mutable,
 *     updated by release-installability-watch.yml until it converges.
 *
 * That is what dissolves the tension the old `continue-on-error` comment was
 * reaching for. Its worry — "a transient npm propagation delay must never roll
 * back a good publish" — was legitimate; its remedy was not. Nothing here CAN
 * roll anything back: by the time this runs, the tag, the GitHub Release and
 * all 18 publishes are irreversible, and this workflow triggers on tag push so
 * a red gates no merge and blocks no required check.
 *
 * ## Three outcomes
 *
 *   installable — every package cleared metadata, tarball and dist-tag. Green.
 *   pending     — published and accepted, not yet resolvable at the deadline.
 *                 RED, with a tracking issue. Explicitly NOT a claim that the
 *                 release is broken.
 *   defect      — a package is missing or serves the wrong version. RED.
 *   infra       — the verdict could not be read. RED. Fails closed: a broken
 *                 verifier must never render as `installable`.
 *
 * @task T12243
 * @epic T12119
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const VERSION = process.env['VERSION'] ?? '';
const DIST_TAG = process.env['DIST_TAG'] ?? 'latest';
const RELEASE_RESULT = process.env['RELEASE_RESULT'] ?? 'unknown';
const VERDICT_IN = process.env['VERDICT'] ?? '';
const RUN_URL = process.env['RUN_URL'] ?? '';
const POSTDEPLOY_DIR = process.env['POSTDEPLOY_DIR'] ?? '/tmp/postdeploy-artifacts';
const TIMELINE_DIR = process.env['PUBLISH_TIMELINE_DIR'] ?? '/tmp/publish-timeline';
const DRY_RUN = process.env['DRY_RUN'] === '1';
const ISSUE_LABEL = 'release-installability';

/** Append a line to the GitHub step summary, when running under Actions. */
function summary(text) {
  const f = process.env['GITHUB_STEP_SUMMARY'];
  if (f) appendFileSync(f, `${text}\n`, 'utf8');
  else process.stdout.write(`${text}\n`);
}

/**
 * Read the post-deploy summary artifact.
 *
 * Returns `null` on any failure — missing directory, missing file, unparseable
 * JSON. Every one of those is an `infra` verdict, never a pass.
 *
 * @returns {null | Record<string, any>}
 */
function readSummary() {
  try {
    if (!existsSync(POSTDEPLOY_DIR)) return null;
    const direct = path.join(POSTDEPLOY_DIR, `deploy-summary-${VERSION}.json`);
    const file = existsSync(direct)
      ? direct
      : readdirSync(POSTDEPLOY_DIR)
          .filter((f) => f.startsWith('deploy-summary-') && f.endsWith('.json'))
          .map((f) => path.join(POSTDEPLOY_DIR, f))[0];
    if (!file) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Read the publish timeline TSV emitted by release.yml's `publish_pkg` (gh#1479).
 *
 * @returns {Map<string, {outcome: string, callTs: string, doneTs: string}>}
 */
function readTimeline() {
  /** @type {Map<string, {outcome: string, callTs: string, doneTs: string}>} */
  const out = new Map();
  try {
    if (!existsSync(TIMELINE_DIR)) return out;
    const file = readdirSync(TIMELINE_DIR)
      .filter((f) => f.endsWith('.tsv'))
      .map((f) => path.join(TIMELINE_DIR, f))[0];
    if (!file) return out;
    for (const line of readFileSync(file, 'utf8').split('\n').slice(1)) {
      const [pkg, outcome, callTs, doneTs] = line.split('\t');
      if (pkg) out.set(pkg, { outcome, callTs, doneTs });
    }
  } catch {
    /* timeline is diagnostic, never load-bearing for the verdict */
  }
  return out;
}

/** Render the per-package table shared by the summary and the issue body. */
function renderTable(sum, timeline) {
  const rows = (sum?.packages ?? []).map((p) => {
    const short = p.name.replace('@cleocode/', '');
    const t = timeline.get(short);
    const secs = `${Math.round((p.convergedAfterMs ?? 0) / 1000)}s`;
    return `| \`${p.name}\` | ${p.verified ? '✅' : '❌'} | ${p.rung ?? '—'} | ${secs} | ${t?.callTs ?? '—'} | ${p.reason ?? ''} |`;
  });
  return [
    '| package | installable | reached rung | at | publish call (UTC) | reason |',
    '|---|:--:|---|---:|---|---|',
    ...rows,
  ].join('\n');
}

function gh(args, allowFail = false) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8' }).trim();
  } catch (err) {
    if (allowFail) return '';
    throw err;
  }
}

/** Open or update the installability tracking issue, returning its URL. */
function upsertTrackingIssue(sum, timeline) {
  const title = `v${VERSION} published but not verified installable`;
  const machine = JSON.stringify(
    {
      version: VERSION,
      distTag: DIST_TAG,
      runUrl: RUN_URL,
      // The TAG-TIME package list. The watcher runs on `schedule`, which only
      // ever executes the default branch, so main's publish_pkg SSoT may have
      // drifted since this tag. Verify what was actually published here.
      packages: (sum?.packages ?? []).map((p) => p.name.replace('@cleocode/', '')),
      lastCheckedAt: sum?.timestamp ?? null,
    },
    null,
    2,
  );

  const body = [
    `**\`v${VERSION}\` was PUBLISHED.** npm accepted every package (exit 0). ` +
      `${sum?.stats?.verified ?? '?'} of ${sum?.stats?.total ?? '?'} were verified installable ` +
      `within the ${Math.round((sum?.budgetMs ?? 0) / 1000)}s budget.`,
    '',
    '**This issue is not a claim that the release is broken.** It tracks whether ' +
      'the registry has finished making it resolvable. It is updated automatically ' +
      'and closes itself once every package installs.',
    '',
    '**Do not** roll back, re-tag, re-publish, or bump the version.',
    '',
    `Release run: ${RUN_URL}`,
    '',
    renderTable(sum, timeline),
    '',
    '<!-- release-installability-state',
    machine,
    '-->',
  ].join('\n');

  const existing = gh(
    [
      'issue',
      'list',
      '--label',
      ISSUE_LABEL,
      '--state',
      'open',
      '--search',
      VERSION,
      '--json',
      'number,title',
      '--jq',
      `.[] | select(.title | contains("v${VERSION}")) | .number`,
    ],
    true,
  );

  if (DRY_RUN) {
    process.stdout.write(`[dry-run] would upsert issue: ${title}\n${body}\n`);
    return '(dry-run)';
  }

  if (existing) {
    gh(['issue', 'edit', existing, '--body', body], true);
    return gh(['issue', 'view', existing, '--json', 'url', '--jq', '.url'], true);
  }
  return gh(['issue', 'create', '--title', title, '--body', body, '--label', ISSUE_LABEL], true);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const sum = readSummary();
const timeline = readTimeline();

// Classify. The release job failing outranks everything: nothing downstream is
// meaningful if the publish itself did not complete.
let klass;
if (RELEASE_RESULT !== 'success') klass = 'defect';
else if (!sum || !sum.verdict) klass = 'infra';
else if (sum.verdict === 'installable') klass = 'installable';
else if (sum.verdict === 'defect') klass = 'defect';
else if (sum.verdict === 'pending') klass = 'pending';
else klass = 'infra';

// VERDICT_IN is the job-output path; the artifact is authoritative. They should
// agree — say so loudly if they do not rather than silently picking one.
if (sum?.verdict && VERDICT_IN && sum.verdict !== VERDICT_IN) {
  console.warn(
    `::warning::verdict disagreement — job output "${VERDICT_IN}" vs artifact "${sum.verdict}". Using the artifact.`,
  );
}

const table = renderTable(sum, timeline);

if (klass === 'installable') {
  summary(`## ✅ v${VERSION} is installable`);
  summary('');
  summary(
    `All ${sum.stats.total} packages cleared metadata, tarball and \`dist-tags.${DIST_TAG}\`. ` +
      `Slowest converged at +${Math.round((sum.stats.slowestConvergenceMs ?? 0) / 1000)}s.`,
  );
  summary('');
  summary(table);
  console.log(
    `::notice title=RELEASE INSTALLABLE::v${VERSION}: ${sum.stats.verified}/${sum.stats.total} packages installable.`,
  );
  process.exit(0);
}

if (klass === 'pending') {
  const pending = (sum.pendingPackages ?? []).join(', ');
  const url = upsertTrackingIssue(sum, timeline);

  summary(`## ⏳ v${VERSION} published — NOT YET VERIFIED INSTALLABLE`);
  summary('');
  summary(
    `npm accepted every package. ${sum.stats.verified}/${sum.stats.total} were installable ` +
      `within ${Math.round((sum.budgetMs ?? 0) / 1000)}s. Still pending: \`${pending}\`.`,
  );
  summary('');
  summary(
    `**This red means this run did not PROVE installability — not that the release is broken.**`,
  );
  summary(`Live status: ${url}`);
  summary('');
  summary(table);

  console.log(
    `::error title=RELEASE NOT VERIFIED INSTALLABLE::v${VERSION} was PUBLISHED — npm accepted ` +
      `every package (exit 0) — but ${sum.stats.failed} of ${sum.stats.total} were not installable ` +
      `after ${Math.round((sum.budgetMs ?? 0) / 1000)}s: ${pending}. THIS RED MEANS THIS RUN DID NOT ` +
      `PROVE INSTALLABILITY. It is not a claim that the release is broken. Do NOT roll back, re-tag, ` +
      `re-publish or bump the version. Live status, updated until it converges: ${url}`,
  );

  // Kick the watcher now rather than waiting up to 10 minutes for cron.
  if (!DRY_RUN) {
    gh(
      [
        'workflow',
        'run',
        'release-installability-watch.yml',
        '-f',
        `version=${VERSION}`,
        '-f',
        `dist_tag=${DIST_TAG}`,
      ],
      true,
    );
  }
  process.exit(1);
}

if (klass === 'defect') {
  const why =
    RELEASE_RESULT !== 'success'
      ? `the Build & Publish job concluded "${RELEASE_RESULT}"`
      : `a package is missing or serves the wrong version`;
  summary(`## ❌ v${VERSION} — PUBLISH DEFECT`);
  summary('');
  summary(`Not a propagation delay: ${why}. Retrying unchanged will fail identically.`);
  summary('');
  summary(table);
  console.log(
    `::error title=PUBLISH DEFECT::v${VERSION}: ${why}. This is NOT a propagation delay and will ` +
      `not resolve on its own. Investigate before re-running.`,
  );
  process.exit(1);
}

// infra — fail closed.
summary(`## ⚠️ v${VERSION} — VERDICT UNAVAILABLE`);
summary('');
summary(
  'The post-deploy summary artifact was missing or unreadable, so this run cannot say whether ' +
    'the release is installable. Treated as a failure by design: a verifier that cannot report ' +
    'must never render as a pass.',
);
console.log(
  `::error title=RELEASE VERDICT UNAVAILABLE::v${VERSION}: post-deploy summary missing or ` +
    `unparseable at ${POSTDEPLOY_DIR}. Failing closed — this is not evidence the release is good.`,
);
process.exit(1);
