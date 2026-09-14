#!/usr/bin/env node

/**
 * lint-postdeploy-budget.mjs — bind the post-deploy poll budget to the job cap.
 *
 * Why this exists (gh#1409)
 * -------------------------
 * `release.yml`'s post-deploy job polls npm until every package's TARBALL is
 * fetchable, bounded by `POSTDEPLOY_TIMEOUT_MS`. The job itself is bounded by
 * `timeout-minutes`. If the budget ever meets or exceeds the cap, the runner
 * kills the job mid-poll and the step never reaches its own failure branch:
 * no `NOT INSTALLABLE` line, no package named, no artifacts uploaded. A red
 * with no diagnosis is strictly WORSE than the red the budget exists to
 * produce, because the correct red tells you a retry will not help.
 *
 * That requirement was stated in a comment for months. A comment is not an
 * enforcement — the same shape as the three arch gates documented and wired
 * nowhere (gh#1394) and `lint-changesets.mjs` calling itself a CI gate while
 * no workflow invokes it (gh#1412). This script is the assertion.
 *
 * It checks two things the workflow cannot check about itself:
 *   1. `timeout-minutes` on the post-deploy job equals `POSTDEPLOY_JOB_CAP_MINUTES`
 *      (the run step asserts against the env var; only this binds that var to
 *      the literal the runner actually obeys).
 *   2. `POSTDEPLOY_TIMEOUT_MS` is strictly less than the cap, with headroom.
 *
 * Exit codes: 0 pass · 1 violation · 2 could not parse (fails CLOSED — an
 * unreadable workflow is not evidence the relationship holds).
 *
 * @task gh#1409
 */

import { readFileSync } from 'node:fs';

const WORKFLOW = '.github/workflows/release.yml';
/** Minimum seconds the cap must exceed the budget by, so a slow runner start cannot invert them. */
const MIN_HEADROOM_MS = 300_000;

/**
 * Extract the post-deploy job's cap and budget from the workflow source.
 *
 * Deliberately regex over raw source rather than a YAML parse: this must run
 * in CI with no dependencies, and the values are plain scalars.
 *
 * @param {string} src - Raw `release.yml` contents.
 * @returns {{capMinutes: number, capEnvMinutes: number, budgetMs: number}}
 */
function extract(src) {
  const postDeploy = src.indexOf('Post-Deploy Execution Payload');
  if (postDeploy === -1) throw new Error(`could not locate the post-deploy job in ${WORKFLOW}`);
  const tail = src.slice(postDeploy);

  const cap = tail.match(/^\s*timeout-minutes:\s*(\d+)/m);
  const capEnv = tail.match(/^\s*POSTDEPLOY_JOB_CAP_MINUTES:\s*'(\d+)'/m);
  const budget = tail.match(/^\s*POSTDEPLOY_TIMEOUT_MS:\s*'(\d+)'/m);

  if (!cap) throw new Error('could not read timeout-minutes for the post-deploy job');
  if (!capEnv) throw new Error('could not read POSTDEPLOY_JOB_CAP_MINUTES');
  if (!budget) throw new Error('could not read POSTDEPLOY_TIMEOUT_MS');

  return {
    capMinutes: Number(cap[1]),
    capEnvMinutes: Number(capEnv[1]),
    budgetMs: Number(budget[1]),
  };
}

let parsed;
try {
  parsed = extract(readFileSync(WORKFLOW, 'utf8'));
} catch (err) {
  console.error(`lint-postdeploy-budget: FAIL (parse) — ${err.message}`);
  console.error('Failing closed: an unreadable workflow is not evidence the budget fits the cap.');
  process.exit(2);
}

const { capMinutes, capEnvMinutes, budgetMs } = parsed;
const capMs = capMinutes * 60_000;
const problems = [];

if (capMinutes !== capEnvMinutes) {
  problems.push(
    `timeout-minutes (${capMinutes}) != POSTDEPLOY_JOB_CAP_MINUTES (${capEnvMinutes}).\n` +
      '    The run step asserts against the env var, but the runner obeys timeout-minutes.\n' +
      '    While they disagree, that assertion is checking a number nothing enforces.',
  );
}

if (budgetMs >= capMs) {
  problems.push(
    `POSTDEPLOY_TIMEOUT_MS (${budgetMs}ms) >= job cap (${capMinutes}min = ${capMs}ms).\n` +
      '    The runner would kill the job mid-poll; no package named, no artifacts written.',
  );
} else if (capMs - budgetMs < MIN_HEADROOM_MS) {
  problems.push(
    `only ${capMs - budgetMs}ms of headroom between budget and cap (need >= ${MIN_HEADROOM_MS}ms).\n` +
      '    Checkout, setup and npm install all run before the poll starts.',
  );
}

if (problems.length > 0) {
  console.error(`lint-postdeploy-budget: FAIL — ${problems.length} violation(s) in ${WORKFLOW}\n`);
  for (const p of problems) console.error(`  • ${p}\n`);
  process.exit(1);
}

console.log(
  `lint-postdeploy-budget: OK — budget ${budgetMs}ms < cap ${capMs}ms ` +
    `(${capMinutes}min), headroom ${capMs - budgetMs}ms, env mirrors literal.`,
);
