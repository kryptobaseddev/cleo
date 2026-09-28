/**
 * `ci:<pr>` evidence — required CI green on a merged PR's MERGE COMMIT.
 *
 * Owner decision D11149: when every required check completed with `success`
 * on the commit a PR actually merged as, that satisfies `testsPassed` and
 * `qaPassed` for the task the PR closes. It replaces the post-merge local
 * full-suite rerun, which was the single largest override driver. Opt-in via
 * `evidence.ciSatisfies: true` in `.cleo/project-context.json`.
 *
 * Verified the way `pr:` provenance is:
 *
 *  - the PR itself goes through {@link resolvePrEvidenceAtom} (merged, a real
 *    merge-commit identity), so a `ci:` atom can never outrun `pr:`;
 *  - the required-check list comes from the SAME resolver `pr:` uses
 *    (env → `release.prRequiredWorkflows` → branch protection), and an
 *    undetermined list refuses rather than accepting vacuously;
 *  - each required name is judged on the merge commit's own check runs and
 *    workflow runs (GitHub REST, by SHA). A run whose `head_sha` is anything
 *    else — the PR head included — never counts, and a required check found
 *    only there is named as such.
 *
 * Pending, failed, cancelled, skipped and missing required checks are each
 * refused with the check's name and state.
 *
 * @task T12634
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvidenceAtom } from '@cleocode/contracts';
import { isGitWorkTree } from '../git/work-tree.js';
import type { EvidenceRoots } from '../tasks/evidence.js';
import { isGhCliAvailable } from './github-pr.js';
import {
  describeRequiredWorkflowsSource,
  type PrAtomResolution,
  resolvePrEvidenceAtom,
  resolveRequiredWorkflowsDetailed,
} from './pr-evidence.js';

/** One check on a commit: a job (check run) or a whole workflow run. */
export interface CommitCheck {
  /** Check-run (job) name or workflow name. */
  name: string;
  /** Which GitHub object reported it. */
  source: 'check-run' | 'workflow-run';
  /** `queued` / `in_progress` / `completed` / … */
  status: string;
  /** `success` / `failure` / `skipped` / … — null until completed. */
  conclusion: string | null;
  /** The commit the check ran on. */
  headSha: string;
  /** GitHub id; a higher id is a later attempt of the same name. */
  id: number;
}

/** Result of {@link evaluateMergeCommitChecks}. */
export type MergeCommitCheckResult =
  | { ok: true; checks: Array<{ name: string; conclusion: string }> }
  | { ok: false; reasons: string[] };

/** A `ci:` atom resolution: the validated atom, or the refusal. */
export type CiAtomResolution =
  | { ok: true; atom: Extract<EvidenceAtom, { kind: 'ci' }> }
  | {
      ok: false;
      reason: string;
      codeName:
        | 'E_EVIDENCE_INSUFFICIENT'
        | 'E_EVIDENCE_TESTS_FAILED'
        | 'E_EVIDENCE_TOOL_FAILED'
        | 'E_EVIDENCE_INVALID'
        | 'E_EVIDENCE_GIT_ROOT';
    };

/** Injectable I/O for {@link resolveCiEvidenceAtom}. */
export interface ResolveCiEvidenceOptions {
  /** PR provenance; defaults to {@link resolvePrEvidenceAtom}. */
  resolvePr?: (prNumber: number, roots: EvidenceRoots) => Promise<PrAtomResolution>;
  /** Checks reported for one commit SHA; defaults to the GitHub REST API via `gh`. */
  fetchChecks?: (
    sha: string,
    cwd: string,
  ) => Promise<{ ok: true; checks: CommitCheck[] } | { ok: false; reason: string }>;
  /** Parsed `.cleo/project-context.json`, for the required-check list. */
  projectContext?: Record<string, unknown> | null;
}

/**
 * Whether the project opted in to merge-commit CI as test/QA evidence
 * (`evidence.ciSatisfies === true`; anything else, including a missing file,
 * is `false`).
 *
 * @param projectRoot - CLEO store root.
 * @returns True only for an explicit boolean `true`.
 * @task T12634
 */
export function readCiSatisfies(projectRoot: string): boolean {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(projectRoot, '.cleo', 'project-context.json'), 'utf-8'),
    );
    const evidence = (parsed as { evidence?: { ciSatisfies?: unknown } } | null)?.evidence;
    return evidence?.ciSatisfies === true;
  } catch {
    return false;
  }
}

/**
 * Judge required checks on one merge commit. Pure.
 *
 * A required name is met when every source reporting it (the workflow run
 * and/or the job of that name) has its LATEST attempt on the merge commit
 * `completed` with `success`. Runs on any other SHA are ignored, and a name
 * that only ran elsewhere is reported as such.
 *
 * @param required - Required check names.
 * @param checks - Every check reported for the commit (and possibly others).
 * @param mergeCommitSha - The merge commit being judged.
 * @returns The matched checks, or one reason per unmet name.
 * @task T12634
 */
export function evaluateMergeCommitChecks(
  required: readonly string[],
  checks: readonly CommitCheck[],
  mergeCommitSha: string,
): MergeCommitCheckResult {
  if (required.length === 0) {
    return {
      ok: false,
      reasons: ['No required checks are configured, so merge-commit CI proves nothing.'],
    };
  }
  const reasons: string[] = [];
  const matched: Array<{ name: string; conclusion: string }> = [];
  for (const name of required) {
    const named = checks.filter((c) => c.name === name);
    const onMerge = named.filter((c) => c.headSha === mergeCommitSha);
    if (onMerge.length === 0) {
      const elsewhere = named[0];
      reasons.push(
        elsewhere
          ? `${name}: ran on ${elsewhere.headSha.slice(0, 12)}, not the merge commit ${mergeCommitSha.slice(0, 12)}`
          : `${name}: not found on merge commit ${mergeCommitSha.slice(0, 12)}`,
      );
      continue;
    }
    const latest = (['workflow-run', 'check-run'] as const)
      .map(
        (source) => onMerge.filter((c) => c.source === source).toSorted((a, b) => b.id - a.id)[0],
      )
      .filter((c): c is CommitCheck => c !== undefined);
    const bad = latest.find((c) => c.status !== 'completed' || c.conclusion !== 'success');
    if (bad) {
      reasons.push(
        `${name}: ${bad.status !== 'completed' ? `pending (${bad.status})` : bad.conclusion} on merge commit ${mergeCommitSha.slice(0, 12)}`,
      );
      continue;
    }
    matched.push({ name, conclusion: 'success' });
  }
  return reasons.length > 0 ? { ok: false, reasons } : { ok: true, checks: matched };
}

/** Run one read-only `gh api` GET; `null` on failure. */
function ghApi(path: string, cwd: string): unknown {
  try {
    return JSON.parse(
      execFileSync('gh', ['api', path], {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 32 * 1024 * 1024,
      }),
    );
  } catch {
    return null;
  }
}

/** Default {@link ResolveCiEvidenceOptions.fetchChecks}: check runs + workflow runs for a SHA. */
async function defaultFetchChecks(
  sha: string,
  cwd: string,
): Promise<{ ok: true; checks: CommitCheck[] } | { ok: false; reason: string }> {
  if (!isGitWorkTree(cwd) || !isGhCliAvailable()) {
    return { ok: false, reason: `gh cannot query checks from ${cwd} (no work tree or gh CLI).` };
  }
  const checks: CommitCheck[] = [];
  for (let page = 1; page <= 10; page++) {
    const body = ghApi(
      `repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100&page=${page}`,
      cwd,
    ) as {
      check_runs?: Array<Record<string, unknown>>;
    } | null;
    if (body === null) return { ok: false, reason: `gh api check-runs for ${sha} failed` };
    const runs = body.check_runs ?? [];
    for (const r of runs) {
      checks.push({
        name: String(r.name ?? ''),
        source: 'check-run',
        status: String(r.status ?? ''),
        conclusion: typeof r.conclusion === 'string' ? r.conclusion : null,
        headSha: String(r.head_sha ?? ''),
        id: Number(r.id ?? 0),
      });
    }
    if (runs.length < 100) break;
  }
  const wf = ghApi(`repos/{owner}/{repo}/actions/runs?head_sha=${sha}&per_page=100`, cwd) as {
    workflow_runs?: Array<Record<string, unknown>>;
  } | null;
  if (wf === null) return { ok: false, reason: `gh api workflow runs for ${sha} failed` };
  for (const r of wf.workflow_runs ?? []) {
    checks.push({
      name: String(r.name ?? ''),
      source: 'workflow-run',
      status: String(r.status ?? ''),
      conclusion: typeof r.conclusion === 'string' ? r.conclusion : null,
      headSha: String(r.head_sha ?? ''),
      id: Number(r.id ?? 0),
    });
  }
  return { ok: true, checks };
}

/**
 * Validate a `ci:<pr>` atom end to end.
 *
 * @param prNumber - The merged PR.
 * @param roots - Store root (config, caches) and execution root (`gh` cwd).
 * @param opts - Injectable PR resolution and check fetching.
 * @returns The validated atom, or a refusal naming every unmet check.
 * @example
 * ```ts
 * const r = await resolveCiEvidenceAtom(357, { storeRoot, executionRoot });
 * ```
 * @task T12634
 */
export async function resolveCiEvidenceAtom(
  prNumber: number,
  roots: EvidenceRoots,
  opts: ResolveCiEvidenceOptions = {},
): Promise<CiAtomResolution> {
  if (!readCiSatisfies(roots.storeRoot)) {
    return {
      ok: false,
      codeName: 'E_EVIDENCE_INSUFFICIENT',
      reason:
        'ci:<pr> evidence is disabled for this project (evidence.ciSatisfies is not true). Set "evidence": { "ciSatisfies": true } in ' +
        ".cleo/project-context.json to accept required CI on a merged PR's merge commit for " +
        'testsPassed and qaPassed (D11149), or record tool:test / tool:lint results instead.',
    };
  }
  const projectContext = opts.projectContext ?? null;
  const pr = await (opts.resolvePr ?? ((n, r) => resolvePrEvidenceAtom(n, r, { projectContext })))(
    prNumber,
    roots,
  );
  if (!pr.ok) return { ok: false, reason: pr.reason, codeName: pr.codeName };

  const required = await resolveRequiredWorkflowsDetailed(roots, { projectContext });
  if (required.source.tier === 'unknown') {
    return {
      ok: false,
      codeName: 'E_EVIDENCE_INSUFFICIENT',
      reason: `Cannot determine the required checks (${required.source.reason}); ci:${prNumber} cannot be judged.`,
    };
  }
  const fetched = await (opts.fetchChecks ?? defaultFetchChecks)(
    pr.mergeCommitSha,
    roots.executionRoot,
  );
  if (!fetched.ok) return { ok: false, reason: fetched.reason, codeName: 'E_EVIDENCE_TOOL_FAILED' };

  const judged = evaluateMergeCommitChecks(required.workflows, fetched.checks, pr.mergeCommitSha);
  if (!judged.ok) {
    return {
      ok: false,
      codeName: 'E_EVIDENCE_TESTS_FAILED',
      reason:
        `Required CI on PR #${prNumber}'s merge commit ${pr.mergeCommitSha.slice(0, 12)} is not green ` +
        `(source: ${describeRequiredWorkflowsSource(required.source)}):\n  - ${judged.reasons.join('\n  - ')}`,
    };
  }
  return {
    ok: true,
    atom: {
      kind: 'ci',
      prNumber,
      mergeCommitSha: pr.mergeCommitSha,
      checks: judged.checks,
      requiredSource: required.source.tier,
    },
  };
}
