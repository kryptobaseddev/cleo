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
 * @task T12243
 * @epic T12119
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPackage, readPublishedPackages } from './execute-payload.mjs';

const LABEL = 'release-installability';
const STUCK_LABEL = 'release-installability-stuck';
const STUCK_AFTER_MS = 24 * 60 * 60 * 1000;
const DRY_RUN = process.env['DRY_RUN'] === 'true' || process.env['DRY_RUN'] === '1';

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

function gh(args, allowFail = true) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8' }).trim();
  } catch (err) {
    if (allowFail) return '';
    throw err;
  }
}

/**
 * Extract the machine-readable state block embedded in the issue body.
 *
 * @param {string} body
 * @returns {null | Record<string, any>}
 */
export function parseState(body) {
  const m = body.match(/<!--\s*release-installability-state\s*([\s\S]*?)-->/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
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

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Sweep every open tracking issue (or just one, when dispatched with a version).
 *
 * @returns {Promise<number>} Process exit code.
 */
export async function main() {
  const forcedVersion = process.env['WATCH_VERSION'] || '';
  const forcedTag = process.env['WATCH_DIST_TAG'] || 'latest';

  const raw = gh([
    'issue',
    'list',
    '--label',
    LABEL,
    '--state',
    'open',
    '--json',
    'number,title,body,createdAt,labels',
  ]);
  /** @type {Array<{number: number, title: string, body: string, createdAt: string, labels: Array<{name: string}>}>} */
  let issues = raw ? JSON.parse(raw) : [];

  if (forcedVersion) {
    issues = issues.filter((i) => i.title.includes(`v${forcedVersion}`));
    if (issues.length === 0) {
      // Dispatched for a version with no tracker (e.g. release-verdict raced the
      // issue creation). Verify directly and report; do not invent an issue.
      const packages = await readPublishedPackages();
      const results = await checkAllOnce(packages, forcedVersion, forcedTag);
      const bad = results.filter((r) => !r.ok);
      console.log(
        `v${forcedVersion}: ${results.length - bad.length}/${results.length} installable` +
          (bad.length ? ` — pending: ${bad.map((b) => b.pkg).join(', ')}` : ''),
      );
      return bad.length === 0 ? 0 : 1;
    }
  }

  if (issues.length === 0) {
    console.log(`No open ${LABEL} issues — nothing to watch.`);
    return 0;
  }

  const now = Date.now();
  let anyStuck = false;

  for (const issue of issues) {
    const state = parseState(issue.body);
    if (!state?.version) {
      console.warn(`::warning::issue #${issue.number} has no parseable state block — skipping.`);
      continue;
    }

    const ageMs = now - new Date(issue.createdAt).getTime();
    const lastMs = state.lastCheckedAt ? now - new Date(state.lastCheckedAt).getTime() : Infinity;
    if (!forcedVersion && !shouldCheckNow(ageMs, lastMs)) {
      console.log(
        `#${issue.number} v${state.version}: not due yet (age ${Math.round(ageMs / 60000)}m).`,
      );
      continue;
    }

    // Prefer the TAG-TIME package list recorded on the issue. `schedule` only
    // ever runs the default branch, so main's publish_pkg SSoT may have drifted
    // since this tag was cut — verifying against today's list would check a set
    // that was never published.
    const packages =
      Array.isArray(state.packages) && state.packages.length > 0
        ? state.packages
        : await readPublishedPackages();

    const distTag = state.distTag ?? 'latest';
    const results = await checkAllOnce(packages, state.version, distTag);
    const bad = results.filter((r) => !r.ok);
    const checkedAt = new Date(now).toISOString();

    if (bad.length === 0) {
      console.log(
        `#${issue.number} v${state.version}: ALL ${results.length} INSTALLABLE — closing.`,
      );
      if (!DRY_RUN) {
        const comment = [
          `✅ **\`v${state.version}\` is now installable.** All ${results.length} packages resolve ` +
            `metadata, tarball and \`dist-tags.${distTag}\`.`,
          '',
          `Confirmed at ${checkedAt} (${Math.round(ageMs / 60000)} minutes after the release run).`,
          '',
          'Closing. The release run that opened this issue stays red on purpose: it records ' +
            'that *that run* did not prove installability inside its budget, which remains true.',
        ].join('\n');
        gh(['issue', 'comment', String(issue.number), '--body', comment]);
        gh(['issue', 'close', String(issue.number), '--reason', 'completed']);
      }
      continue;
    }

    // Has a later release taken the tag? Then this one is superseded and will
    // never converge on `latest`; polling forever would be noise.
    const tagNow = bad.find((b) => b.rung === 'dist-tag');
    if (tagNow) {
      const m = /resolves to "([^"]+)"/.exec(tagNow.reason ?? '');
      if (m && m[1] !== '(absent)' && compareVersions(m[1], state.version) > 0) {
        console.log(`#${issue.number} v${state.version}: superseded by ${m[1]} — closing.`);
        if (!DRY_RUN) {
          gh([
            'issue',
            'comment',
            String(issue.number),
            '--body',
            `Superseded: \`dist-tags.${distTag}\` now points at \`${m[1]}\`. ` +
              `\`v${state.version}\` will not take this tag. Closing.`,
          ]);
          gh(['issue', 'close', String(issue.number), '--reason', 'not planned']);
        }
        continue;
      }
    }

    const stuck = ageMs > STUCK_AFTER_MS;
    const alreadyStuck = issue.labels.some((l) => l.name === STUCK_LABEL);
    console.log(
      `#${issue.number} v${state.version}: ${results.length - bad.length}/${results.length} — ` +
        `pending ${bad.map((b) => `${b.pkg}(${b.rung})`).join(', ')}`,
    );

    if (!DRY_RUN) {
      const table = [
        '| package | installable | stalled at | reason |',
        '|---|:--:|---|---|',
        ...results.map(
          (r) =>
            `| \`@cleocode/${r.pkg}\` | ${r.ok ? '✅' : '❌'} | ${r.ok ? '—' : (r.rung ?? '—')} | ${r.ok ? '' : (r.reason ?? '')} |`,
        ),
      ].join('\n');

      const body = withState(
        issue.body.replace(/\n\| package \|[\s\S]*?(?=\n\n<!--|$)/, `\n${table}`),
        { ...state, lastCheckedAt: checkedAt },
      );
      // EDIT, never comment — see the docblock.
      gh(['issue', 'edit', String(issue.number), '--body', body]);

      if (stuck && !alreadyStuck) {
        anyStuck = true;
        gh(['issue', 'edit', String(issue.number), '--add-label', STUCK_LABEL]);
        gh([
          'issue',
          'comment',
          String(issue.number),
          '--body',
          [
            `⚠️ **Still not installable after 24 hours.** Pending: ${bad.map((b) => b.pkg).join(', ')}.`,
            '',
            'This is past anything npm propagation explains. Escalate to npm support ' +
              'with this issue and the release run linked above (gh#1478).',
            '',
            'This comment fires once. The body keeps updating.',
          ].join('\n'),
        ]);
      }
    }
  }

  if (anyStuck) {
    console.log('::error::One or more releases have been unresolvable for over 24 hours.');
    return 1;
  }
  return 0;
}

// Only run when invoked directly, so the helpers above can be imported by tests.
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  process.exit(await main());
}
