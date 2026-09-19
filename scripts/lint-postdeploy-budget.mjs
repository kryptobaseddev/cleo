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
import { parse as parseYaml } from 'yaml';

const WORKFLOW = '.github/workflows/release.yml';
/** Minimum seconds the cap must exceed the budget by, so a slow runner start cannot invert them. */
const MIN_HEADROOM_MS = 300_000;

/**
 * Extract the post-deploy job's cap and budget from the workflow source.
 *
 * Select the step that invokes the payload, then read its owning job and
 * effective environment. Job IDs, display names, ordering and comments are
 * not identities. Unsupported/dynamic values fail closed, rather than being
 * partially parsed as a plausible number. CI installs the locked YAML parser.
 *
 * @param {string} src - Raw `release.yml` contents.
 * @returns Parsed job cap, effective step cap, mirrored environment cap, and poll budget.
 */
function extract(src) {
  const workflow = parseYaml(src);
  const payloads = [];
  for (const [jobId, job] of Object.entries(workflow?.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      // Recognize a literal command, not an echo, comment or display name.
      // This does not attempt to evaluate arbitrary shell or Actions code.
      if (
        typeof step?.run === 'string' &&
        /^\s*node\s+(?:\.\/)?scripts\/execute-payload\.mjs(?:\s|$)/m.test(step.run)
      ) {
        payloads.push({ jobId, job, step });
      }
    }
  }
  if (payloads.length !== 1) {
    throw new Error(`expected exactly one literal payload run step, found ${payloads.length}`);
  }
  const { jobId, job, step } = payloads[0];
  const env = { ...workflow.env, ...job.env, ...step.env };
  const capMinutes = positiveInteger(job['timeout-minutes'], `${jobId}.timeout-minutes`);
  const stepCap = step['timeout-minutes'];

  return {
    capMinutes,
    capEnvMinutes: positiveInteger(env.POSTDEPLOY_JOB_CAP_MINUTES, 'POSTDEPLOY_JOB_CAP_MINUTES'),
    budgetMs: positiveInteger(env.POSTDEPLOY_TIMEOUT_MS, 'POSTDEPLOY_TIMEOUT_MS'),
    effectiveCapMinutes:
      stepCap === undefined
        ? capMinutes
        : Math.min(capMinutes, positiveInteger(stepCap, `${jobId} payload step timeout-minutes`)),
  };
}

/** Require a complete positive integer literal, rejecting expressions and lossy coercion. */
function positiveInteger(value, label) {
  if (
    (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) <= 0 ||
    Number(value) > Number.MAX_SAFE_INTEGER / 60_000
  ) {
    throw new Error(`could not read ${label} as a positive safe integer literal`);
  }
  return Number(value);
}

let parsed;
try {
  parsed = extract(readFileSync(WORKFLOW, 'utf8'));
} catch (err) {
  console.error(`lint-postdeploy-budget: FAIL (parse) — ${err.message}`);
  console.error('Failing closed: an unreadable workflow is not evidence the budget fits the cap.');
  process.exit(2);
}

const { capMinutes, capEnvMinutes, budgetMs, effectiveCapMinutes } = parsed;
const capMs = effectiveCapMinutes * 60_000;
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
    `POSTDEPLOY_TIMEOUT_MS (${budgetMs}ms) >= effective cap (${effectiveCapMinutes}min = ${capMs}ms).\n` +
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
    `(${effectiveCapMinutes}min), headroom ${capMs - budgetMs}ms, env mirrors job literal.`,
);
