#!/usr/bin/env node
/**
 * Lint rule: merge-bar aggregate gate (T11955 · DHQ-072 · Epic T11679).
 *
 * Why this matters
 * ----------------
 * GitHub branch protection requires a fixed list of named status checks (the
 * "merge bar"). Each GitHub Actions job in a workflow surfaces as its OWN
 * top-level status check. A multi-job workflow therefore needs EITHER every
 * one of its jobs individually listed in branch protection (brittle — drifts
 * the moment a job is added) OR a single aggregate "all-green" gate job that
 * `needs:` every sibling and fails if any sibling failed.
 *
 * The merge-bar GAP this gate closes: `arch-boundary-check.yml` shipped 12
 * independent lint jobs (incl. the `LLM Chokepoint Guard` / no-hardcoded-models
 * rule) with NO aggregate. Only `CI`, `Lockfile Check`, and `Contracts Dep
 * Lint` were required checks, so a failing arch-boundary lint could land on
 * `main` green-looking — exactly what happened in #1037 (fixed #1044). The
 * structural fix is a per-workflow aggregate gate; this lint makes the gate
 * mandatory and keeps its `needs:` list complete forever.
 *
 * What this script enforces
 * -------------------------
 * For each PR-gating workflow declared in {@link GATED_WORKFLOWS} that has
 * MORE THAN ONE job, exactly one job MUST be an aggregate gate that:
 *   1. uses `if: always()` (so it runs even when an upstream job fails — GitHub
 *      otherwise skips it and branch protection treats a skipped required
 *      check as never-reported);
 *   2. `needs:` EVERY other job in the workflow (no sibling omitted);
 *   3. inspects `needs.*.result` and fails on `failure`/`cancelled`.
 *
 * Single-job workflows (e.g. lockfile-check.yml) are exempt — the lone job is
 * already its own required status check.
 *
 * Modes
 * -----
 * (default / --check)  Fail (exit 1) on ANY violation. This is a structural
 *                      invariant, not a drift baseline — there is no tolerance
 *                      window. `--check` is accepted as an explicit alias.
 * --strict             Identical to default (kept for CLI symmetry with the
 *                      other arch lints).
 *
 * Exit codes: 0 = all gated workflows have a complete aggregate gate;
 *             1 = one or more violations; 2 = tool error (missing/invalid file).
 *
 * @task T11955
 * @epic T11679 (DHQ burn-down)
 * @see docs/release/branch-protection-setup.md § "Required Status Checks"
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * REPO_ROOT resolves to `process.cwd()`. The script is invoked from the
 * repository root by CI/pnpm, and tests run it with `cwd` set to a synthetic
 * tmpdir. Pinning to cwd keeps it trivially testable.
 */
const REPO_ROOT = process.cwd();

const args = process.argv.slice(2);
// `--check` and `--strict` are accepted as no-op aliases for CLI symmetry with
// the sibling arch lints; this gate has no baseline tolerance to toggle.
void args;

/**
 * PR-gating workflows whose merge-bar coverage this lint enforces. A workflow
 * qualifies when it triggers on `pull_request` to `main`. We pin the list
 * explicitly (rather than globbing) so a newly-added gating workflow is a
 * deliberate edit here — surfacing the merge-bar decision in review.
 */
const GATED_WORKFLOWS = [
  {
    file: '.github/workflows/ci.yml',
    aggregateJob: 'ci',
  },
  {
    file: '.github/workflows/arch-boundary-check.yml',
    aggregateJob: 'arch-boundary-check',
  },
];

/**
 * Parse a workflow YAML file into a plain object, or throw a descriptive
 * error if it cannot be read or parsed.
 *
 * @param {string} absPath
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function readWorkflow(absPath, label) {
  if (!existsSync(absPath)) {
    throw new Error(`${label}: file not found at ${absPath}`);
  }
  const raw = readFileSync(absPath, 'utf-8');
  try {
    return parseYaml(raw) ?? {};
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${label}: failed to parse YAML — ${msg}`);
  }
}

/**
 * Normalize a job's `needs:` field to a string array. GitHub accepts either a
 * scalar string or a sequence.
 *
 * @param {unknown} needs
 * @returns {string[]}
 */
function normalizeNeeds(needs) {
  if (typeof needs === 'string') return [needs];
  if (Array.isArray(needs)) return needs.filter((n) => typeof n === 'string');
  return [];
}

/**
 * Does this job body gate on the upstream results — i.e. does any `run:` step
 * reference `needs.*.result` (the canonical aggregate pattern)?
 *
 * @param {Record<string, unknown>} job
 * @returns {boolean}
 */
function gatesOnNeedsResult(job) {
  const steps = Array.isArray(job.steps) ? job.steps : [];
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    const s = /** @type {Record<string, unknown>} */ (step);
    const haystacks = [s.run, s.env ? JSON.stringify(s.env) : ''];
    for (const h of haystacks) {
      if (typeof h === 'string' && h.includes('needs.*.result')) return true;
    }
  }
  return false;
}

/**
 * Is the job configured to always run (so an upstream failure does not skip
 * the gate)? Accepts `always()` anywhere in the `if:` expression.
 *
 * @param {Record<string, unknown>} job
 * @returns {boolean}
 */
function runsAlways(job) {
  const cond = job.if;
  return typeof cond === 'string' && cond.includes('always()');
}

/**
 * Validate one gated workflow, returning a list of human-readable violations
 * (empty array = compliant).
 *
 * @param {(typeof GATED_WORKFLOWS)[number]} entry
 * @returns {string[]}
 */
function validateWorkflow(entry) {
  const violations = [];
  const doc = readWorkflow(join(REPO_ROOT, entry.file), entry.file);
  const jobs =
    doc.jobs && typeof doc.jobs === 'object'
      ? /** @type {Record<string, Record<string, unknown>>} */ (doc.jobs)
      : {};
  const jobIds = Object.keys(jobs);

  // Single-job workflows are their own required check — no aggregate needed.
  if (jobIds.length <= 1) return violations;

  const aggId = entry.aggregateJob;
  if (!jobIds.includes(aggId)) {
    violations.push(
      `aggregate job '${aggId}' is missing — a multi-job PR-gating workflow MUST declare an all-green aggregate gate`,
    );
    return violations;
  }

  const aggJob = jobs[aggId];
  const siblings = jobIds.filter((j) => j !== aggId);
  const declaredNeeds = normalizeNeeds(aggJob.needs);

  const missing = siblings.filter((s) => !declaredNeeds.includes(s));
  for (const m of missing) {
    violations.push(
      `aggregate job '${aggId}' does not 'needs:' sibling job '${m}' — every job must gate the merge bar`,
    );
  }

  const extra = declaredNeeds.filter((n) => !siblings.includes(n));
  for (const e of extra) {
    violations.push(
      `aggregate job '${aggId}' lists 'needs: ${e}' which is not a job in this workflow (stale reference)`,
    );
  }

  if (!runsAlways(aggJob)) {
    violations.push(
      `aggregate job '${aggId}' must use 'if: always()' so it still runs (and fails the merge bar) when an upstream job fails`,
    );
  }

  if (!gatesOnNeedsResult(aggJob)) {
    violations.push(
      `aggregate job '${aggId}' must inspect 'needs.*.result' and exit non-zero on failure/cancelled`,
    );
  }

  return violations;
}

/**
 * Entry point. Returns the process exit code.
 *
 * @returns {number}
 */
function main() {
  /** @type {Array<{ file: string, violations: string[] }>} */
  const results = [];
  try {
    for (const entry of GATED_WORKFLOWS) {
      results.push({ file: entry.file, violations: validateWorkflow(entry) });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`ERROR: ${msg}\n`);
    return 2;
  }

  const total = results.reduce((sum, r) => sum + r.violations.length, 0);
  if (total === 0) {
    process.stdout.write(
      `PASS — every PR-gating multi-job workflow has a complete merge-bar aggregate gate (${GATED_WORKFLOWS.length} checked)\n`,
    );
    return 0;
  }

  process.stderr.write(`FAIL — ${total} merge-bar aggregate violation(s):\n`);
  for (const r of results) {
    if (r.violations.length === 0) continue;
    process.stderr.write(`\n  ${r.file}\n`);
    for (const v of r.violations) {
      process.stderr.write(`    - ${v}\n`);
    }
  }
  process.stderr.write(
    '\nFix: ensure the aggregate job `needs:` every sibling, uses `if: always()`,\n' +
      'and checks `needs.*.result`. See docs/release/branch-protection-setup.md.\n',
  );
  return 1;
}

process.exit(main());
