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
import type { EvidenceAtom, EvidenceValidationContext } from '@cleocode/contracts';
import { isGitWorkTree } from '../git/work-tree.js';
import { checkPrTaskLinkage, type EvidenceRoots } from '../tasks/evidence.js';
import { isGhCliAvailable } from './github-pr.js';
import {
  describeRequiredWorkflowsSource,
  type PrAtomResolution,
  type RequiredCheckPinSpec,
  readRequiredCheckPins,
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
  /** GitHub id; a higher id is a later attempt within the same event. */
  id: number;
  /** Posting GitHub App slug (`github-actions`, …), when known. */
  appSlug?: string;
  /** Posting GitHub App id, when known. */
  appId?: number;
  /** Workflow file that produced the run, when known. */
  workflowPath?: string;
  /** Triggering event (`push`, `pull_request`, …), when known. */
  event?: string;
}

/** A judged check: which run, on which commit, attests a required name. */
export interface JudgedCheck {
  name: string;
  conclusion: string;
  sha: string;
  app?: string;
  workflow?: string;
  event?: string;
}

/** Result of {@link evaluateMergeCommitChecks}. */
export type MergeCommitCheckResult =
  | { ok: true; checks: JudgedCheck[] }
  | { ok: false; reasons: string[] };

/** Options for {@link evaluateMergeCommitChecks}. */
export interface EvaluateMergeCommitChecksOptions {
  /**
   * PR head whose `pull_request` runs tested exactly the merged tree (tree
   * equal AND the merge's first parent is an ancestor of it). Its runs stand
   * in for a merge-commit run that was cancelled or never started.
   */
  treeEquivalentSha?: string;
  /** Required-name → app/workflow pin; a run from anything else never counts. */
  pins?: Record<string, RequiredCheckPinSpec>;
}

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
        | 'E_EVIDENCE_GIT_ROOT'
        | 'E_EVIDENCE_CONTENT_MISMATCH';
    };

/** Injectable I/O for {@link resolveCiEvidenceAtom}. */
export interface ResolveCiEvidenceOptions {
  /** Task, gates and criteria the atom is validated for; required (like `pr:`). */
  context?: EvidenceValidationContext;
  /** PR provenance; defaults to {@link resolvePrEvidenceAtom}. */
  resolvePr?: (prNumber: number, roots: EvidenceRoots) => Promise<PrAtomResolution>;
  /** Checks reported for one commit SHA; defaults to the GitHub REST API via `gh`. */
  fetchChecks?: (
    sha: string,
    cwd: string,
  ) => Promise<{ ok: true; checks: CommitCheck[] } | { ok: false; reason: string }>;
  /** Parsed `.cleo/project-context.json`, for the required-check list and pins. */
  projectContext?: Record<string, unknown> | null;
  /** Tree SHA of a commit, or null when the object is not local; defaults to `git rev-parse`. */
  treeOf?: (sha: string, cwd: string) => string | null;
  /** Whether `ancestor` is an ancestor of `descendant`; defaults to `git merge-base --is-ancestor`. */
  isAncestor?: (ancestor: string, descendant: string, cwd: string) => boolean;
  /** First parent of a commit, or null; defaults to `git rev-parse <sha>^1`. */
  firstParentOf?: (sha: string, cwd: string) => string | null;
}

/** Parsed `.cleo/project-context.json` of the store root, or null. */
function readProjectContextFile(projectRoot: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(projectRoot, '.cleo', 'project-context.json'), 'utf-8'),
    );
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
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
  const evidence = (
    readProjectContextFile(projectRoot) as { evidence?: { ciSatisfies?: unknown } } | null
  )?.evidence;
  return evidence?.ciSatisfies === true;
}

/**
 * The checks that attest each gate (`evidence.ciChecks`, T12634).
 *
 * @param projectRoot - CLEO store root.
 * @returns `tests` → testsPassed, `qa` → qaPassed; a missing list is absent.
 * @task T12634
 */
export function readCiChecks(projectRoot: string): { tests?: string[]; qa?: string[] } {
  const raw = (readProjectContextFile(projectRoot) as { evidence?: { ciChecks?: unknown } } | null)
    ?.evidence?.ciChecks;
  if (typeof raw !== 'object' || raw === null) return {};
  const list = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() !== '')
      ? (v as string[]).map((x) => x.trim())
      : undefined;
  const { tests, qa } = raw as { tests?: unknown; qa?: unknown };
  return {
    ...(list(tests) ? { tests: list(tests) } : {}),
    ...(list(qa) ? { qa: list(qa) } : {}),
  };
}

function pinMatches(check: CommitCheck, pin: RequiredCheckPinSpec | undefined): boolean {
  if (!pin) return true;
  if (pin.app !== undefined) {
    const ok = typeof pin.app === 'number' ? check.appId === pin.app : check.appSlug === pin.app;
    if (!ok) return false;
  }
  if (pin.workflow !== undefined && check.workflowPath !== pin.workflow) return false;
  return true;
}

function describeApp(check: CommitCheck): string {
  return check.appSlug ?? (check.appId !== undefined ? `app ${check.appId}` : 'an unknown app');
}

/**
 * Judge required checks on one merge commit. Pure.
 *
 * For each required name, runs are grouped by source (job / workflow) and
 * triggering event, and within a group only the LATEST attempt counts; every
 * group on the merge commit must be `completed`/`success`. A pinned name only
 * considers runs from its pinned app/workflow. When `treeEquivalentSha` is
 * given, that commit's `pull_request` runs (and only those) stand in for a
 * merge-commit verdict that failed or is missing.
 *
 * @param required - Required check names.
 * @param checks - Every check reported for the commits involved.
 * @param mergeCommitSha - The merge commit being judged.
 * @param opts - Tree-equivalent PR head and pins.
 * @returns The judged checks, or one reason per unmet name.
 * @task T12634
 */
export function evaluateMergeCommitChecks(
  required: readonly string[],
  checks: readonly CommitCheck[],
  mergeCommitSha: string,
  opts: EvaluateMergeCommitChecksOptions = {},
): MergeCommitCheckResult {
  if (required.length === 0) {
    return {
      ok: false,
      reasons: ['No required checks are configured, so merge-commit CI proves nothing.'],
    };
  }
  const { treeEquivalentSha, pins = {} } = opts;
  const reasons: string[] = [];
  const matched: JudgedCheck[] = [];
  for (const name of required) {
    const named = checks.filter((c) => c.name === name);
    const pinned = named.filter((c) => pinMatches(c, pins[name]));
    const onMerge = judgeOnSha(pinned, mergeCommitSha);
    if (onMerge.ok) {
      matched.push(judged(name, onMerge.run, mergeCommitSha));
      continue;
    }
    if (treeEquivalentSha !== undefined && treeEquivalentSha !== mergeCommitSha) {
      const onHead = judgeOnSha(pinned, treeEquivalentSha, 'pull_request');
      if (onHead.ok) {
        matched.push(judged(name, onHead.run, treeEquivalentSha));
        continue;
      }
    }
    const impostor = named.find((c) => !pinMatches(c, pins[name]));
    const elsewhere = pinned.find(
      (c) => c.headSha !== mergeCommitSha && c.headSha !== treeEquivalentSha,
    );
    reasons.push(
      onMerge.verdict === 'missing' && impostor && pinned.length === 0
        ? `${name}: posted by ${describeApp(impostor)}${impostor.workflowPath ? ` (${impostor.workflowPath})` : ''}, not the pinned ${describePin(pins[name])}`
        : onMerge.verdict === 'missing' && elsewhere
          ? `${name}: ran on ${elsewhere.headSha.slice(0, 12)}, not the merge commit ${mergeCommitSha.slice(0, 12)}`
          : onMerge.verdict === 'missing'
            ? `${name}: not found on merge commit ${mergeCommitSha.slice(0, 12)}`
            : `${name}: ${onMerge.verdict} on merge commit ${mergeCommitSha.slice(0, 12)}`,
    );
  }
  return reasons.length > 0 ? { ok: false, reasons } : { ok: true, checks: matched };
}

function describePin(pin: RequiredCheckPinSpec | undefined): string {
  if (!pin) return 'source';
  return [
    pin.app !== undefined ? `app ${pin.app}` : '',
    pin.workflow ? `workflow ${pin.workflow}` : '',
  ]
    .filter(Boolean)
    .join(' / ');
}

function judged(name: string, run: CommitCheck, sha: string): JudgedCheck {
  return {
    name,
    conclusion: 'success',
    sha,
    ...(run.appSlug !== undefined
      ? { app: run.appSlug }
      : run.appId !== undefined
        ? { app: String(run.appId) }
        : {}),
    ...(run.workflowPath ? { workflow: run.workflowPath } : {}),
    ...(run.event ? { event: run.event } : {}),
  };
}

/**
 * Judge one required name on one SHA. Runs are grouped by (source, event) and
 * the latest attempt of each group must have completed with `success`. With
 * `onlyEvent`, only runs of that event are considered.
 */
function judgeOnSha(
  named: readonly CommitCheck[],
  sha: string,
  onlyEvent?: string,
): { ok: true; run: CommitCheck } | { ok: false; verdict: string } {
  const onSha = named.filter(
    (c) => c.headSha === sha && (onlyEvent === undefined || c.event === onlyEvent),
  );
  if (onSha.length === 0) return { ok: false, verdict: 'missing' };
  const groups = new Map<string, CommitCheck>();
  for (const c of onSha) {
    const key = `${c.source}\u0000${c.event ?? ''}`;
    const prev = groups.get(key);
    if (!prev || c.id > prev.id) groups.set(key, c);
  }
  const latest = [...groups.values()];
  const bad = latest.find((c) => c.status !== 'completed' || c.conclusion !== 'success');
  if (bad) {
    return {
      ok: false,
      verdict:
        bad.status !== 'completed' ? `pending (${bad.status})` : (bad.conclusion ?? 'unknown'),
    };
  }
  return { ok: true, run: latest.find((c) => c.source === 'workflow-run') ?? latest[0]! };
}

/** Default {@link ResolveCiEvidenceOptions.treeOf}: `git rev-parse <sha>^{tree}`. */
function defaultTreeOf(sha: string, cwd: string): string | null {
  return gitRead(cwd, ['rev-parse', '--verify', '--quiet', `${sha}^{tree}`]);
}

function defaultIsAncestor(ancestor: string, descendant: string, cwd: string): boolean {
  return gitRead(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]) !== null;
}

function defaultFirstParentOf(sha: string, cwd: string): string | null {
  return gitRead(cwd, ['rev-parse', '--verify', '--quiet', `${sha}^1`]);
}

function gitRead(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
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

/**
 * Default {@link ResolveCiEvidenceOptions.fetchChecks}: check runs + workflow
 * runs for a SHA. Workflow runs carry their event and workflow file; a check
 * run inherits both from the workflow run of its check suite.
 */
async function defaultFetchChecks(
  sha: string,
  cwd: string,
): Promise<{ ok: true; checks: CommitCheck[] } | { ok: false; reason: string }> {
  if (!isGitWorkTree(cwd) || !isGhCliAvailable()) {
    return { ok: false, reason: `gh cannot query checks from ${cwd} (no work tree or gh CLI).` };
  }
  const wf = ghApi(`repos/{owner}/{repo}/actions/runs?head_sha=${sha}&per_page=100`, cwd) as {
    workflow_runs?: Array<Record<string, unknown>>;
  } | null;
  if (wf === null) return { ok: false, reason: `gh api workflow runs for ${sha} failed` };
  const checks: CommitCheck[] = [];
  const bySuite = new Map<number, { event?: string; path?: string }>();
  for (const r of wf.workflow_runs ?? []) {
    const event = typeof r.event === 'string' ? r.event : undefined;
    const path = typeof r.path === 'string' ? r.path.replace(/@.*$/, '') : undefined;
    if (typeof r.check_suite_id === 'number') bySuite.set(r.check_suite_id, { event, path });
    checks.push({
      name: String(r.name ?? ''),
      source: 'workflow-run',
      status: String(r.status ?? ''),
      conclusion: typeof r.conclusion === 'string' ? r.conclusion : null,
      headSha: String(r.head_sha ?? ''),
      id: Number(r.id ?? 0),
      appSlug: 'github-actions',
      ...(path ? { workflowPath: path } : {}),
      ...(event ? { event } : {}),
    });
  }
  for (let page = 1; page <= 10; page++) {
    const body = ghApi(
      `repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100&page=${page}`,
      cwd,
    ) as { check_runs?: Array<Record<string, unknown>> } | null;
    if (body === null) return { ok: false, reason: `gh api check-runs for ${sha} failed` };
    const runs = body.check_runs ?? [];
    for (const r of runs) {
      const app = r.app as { id?: unknown; slug?: unknown } | null | undefined;
      const suite = (r.check_suite as { id?: unknown } | null | undefined)?.id;
      const origin = typeof suite === 'number' ? bySuite.get(suite) : undefined;
      checks.push({
        name: String(r.name ?? ''),
        source: 'check-run',
        status: String(r.status ?? ''),
        conclusion: typeof r.conclusion === 'string' ? r.conclusion : null,
        headSha: String(r.head_sha ?? ''),
        id: Number(r.id ?? 0),
        ...(typeof app?.slug === 'string' ? { appSlug: app.slug } : {}),
        ...(typeof app?.id === 'number' ? { appId: app.id } : {}),
        ...(origin?.path ? { workflowPath: origin.path } : {}),
        ...(origin?.event ? { event: origin.event } : {}),
      });
    }
    if (runs.length < 100) break;
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
  const context = opts.context;
  if (!context) {
    return {
      ok: false,
      codeName: 'E_EVIDENCE_INSUFFICIENT',
      reason: 'CI evidence requires current task, gate and acceptance-criterion context.',
    };
  }
  // T12634: which checks attest which gate is declared, never inferred.
  const ciChecks = readCiChecks(roots.storeRoot);
  const gateLists = context.gates
    .filter((g): g is 'testsPassed' | 'qaPassed' => g === 'testsPassed' || g === 'qaPassed')
    .map((g) => ({
      gate: g,
      key: g === 'testsPassed' ? 'tests' : 'qa',
      list: ciChecks[g === 'testsPassed' ? 'tests' : 'qa'],
    }));
  if (gateLists.length === 0) {
    return {
      ok: false,
      codeName: 'E_EVIDENCE_INVALID',
      reason: `ci:${prNumber} attests only testsPassed and qaPassed, not ${context.gates.join(', ')}.`,
    };
  }
  const unconfigured = gateLists.filter((g) => !g.list || g.list.length === 0);
  if (unconfigured.length > 0) {
    return {
      ok: false,
      codeName: 'E_EVIDENCE_INSUFFICIENT',
      reason:
        `ci:${prNumber} cannot attest ${unconfigured.map((g) => g.gate).join(', ')}: set ` +
        unconfigured.map((g) => `evidence.ciChecks.${g.key}`).join(' and ') +
        ' in .cleo/project-context.json to the required checks that prove it.',
    };
  }

  const projectContext = opts.projectContext ?? null;
  const pr = await (opts.resolvePr ?? ((n, r) => resolvePrEvidenceAtom(n, r, { projectContext })))(
    prNumber,
    roots,
  );
  if (!pr.ok) return { ok: false, reason: pr.reason, codeName: pr.codeName };
  // T12634: the same task linkage `pr:` enforces — never any merged PR for any task.
  const unlinked = checkPrTaskLinkage(prNumber, pr, context);
  if (unlinked) {
    return {
      ok: false,
      reason: unlinked.reason,
      codeName:
        unlinked.codeName === 'E_EVIDENCE_CONTENT_MISMATCH'
          ? 'E_EVIDENCE_CONTENT_MISMATCH'
          : 'E_EVIDENCE_INSUFFICIENT',
    };
  }

  const required = await resolveRequiredWorkflowsDetailed(roots, { projectContext });
  if (required.source.tier === 'unknown') {
    return {
      ok: false,
      codeName: 'E_EVIDENCE_INSUFFICIENT',
      reason: `Cannot determine the required checks (${required.source.reason}); ci:${prNumber} cannot be judged.`,
    };
  }
  const outside = gateLists.flatMap((g) =>
    (g.list ?? []).filter((n) => !required.workflows.includes(n)).map((n) => `${g.key}:${n}`),
  );
  if (outside.length > 0) {
    return {
      ok: false,
      codeName: 'E_EVIDENCE_INSUFFICIENT',
      reason: `evidence.ciChecks names checks that are not required (${outside.join(', ')}); required: ${required.workflows.join(', ')}.`,
    };
  }
  // Pins: branch protection's app ids when that tier supplied the list,
  // otherwise object entries of release.prRequiredWorkflows.
  const pins = required.pins ?? readRequiredCheckPins(projectContext);

  const fetchChecks = opts.fetchChecks ?? defaultFetchChecks;
  const fetched = await fetchChecks(pr.mergeCommitSha, roots.executionRoot);
  if (!fetched.ok) return { ok: false, reason: fetched.reason, codeName: 'E_EVIDENCE_TOOL_FAILED' };

  // T12634 (review): a pull_request run on head H tested merge(H, base-at-run).
  // Tree equality alone is unsound — base can gain X, CI tests H+X, then base
  // reverts X and the merge still equals H's tree. Requiring the merge's
  // first parent to be an ANCESTOR of H closes it: base only advances, so
  // every base-at-run was already in H and the tested merge IS H. GitHub
  // deletes refs/pull/<n>/merge after merge, so H stands in for it.
  const cwd = roots.executionRoot;
  const treeOf = opts.treeOf ?? defaultTreeOf;
  const mergeTree = treeOf(pr.mergeCommitSha, cwd);
  const head = pr.headRefOid;
  const headTree = head ? treeOf(head, cwd) : null;
  const parent = (opts.firstParentOf ?? defaultFirstParentOf)(pr.mergeCommitSha, cwd);
  const treeEqualHead =
    head &&
    mergeTree !== null &&
    headTree !== null &&
    headTree === mergeTree &&
    parent !== null &&
    (opts.isAncestor ?? defaultIsAncestor)(parent, head, cwd)
      ? head
      : undefined;
  let checks = fetched.checks;
  if (treeEqualHead && treeEqualHead !== pr.mergeCommitSha) {
    const onHead = await fetchChecks(treeEqualHead, cwd);
    if (onHead.ok) checks = [...checks, ...onHead.checks];
  }

  const judgedChecks = evaluateMergeCommitChecks(required.workflows, checks, pr.mergeCommitSha, {
    ...(treeEqualHead ? { treeEquivalentSha: treeEqualHead } : {}),
    pins,
  });
  if (!judgedChecks.ok) {
    return {
      ok: false,
      codeName: 'E_EVIDENCE_TESTS_FAILED',
      reason:
        `Required CI on PR #${prNumber}'s merge commit ${pr.mergeCommitSha.slice(0, 12)} is not green ` +
        `(source: ${describeRequiredWorkflowsSource(required.source)}):\n  - ${judgedChecks.reasons.join('\n  - ')}`,
    };
  }
  const gateChecks: { testsPassed?: string[]; qaPassed?: string[] } = {};
  for (const g of gateLists) gateChecks[g.gate] = [...(g.list ?? [])];
  return {
    ok: true,
    atom: {
      kind: 'ci',
      prNumber,
      mergeCommitSha: pr.mergeCommitSha,
      checks: judgedChecks.checks,
      ...(mergeTree !== null ? { testedTree: mergeTree } : {}),
      requiredSource: required.source.tier,
      taskId: context.task.id,
      gateChecks,
    },
  };
}
