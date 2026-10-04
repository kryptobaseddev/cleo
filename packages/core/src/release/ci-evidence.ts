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
 * One substitution (T12742): when a required check's merge-commit push run
 * was only CANCELLED or SKIPPED (a concurrency group superseded it) and no
 * run on the merge commit failed, the first decisive green `push` run on a
 * later default-branch commit stands in — only when the PR head's own
 * `pull_request` run was green and nothing in between touched the PR's files
 * or a CI definition. See {@link findGreenDescendant}.
 *
 * @task T12634
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvidenceAtom, EvidenceValidationContext } from '@cleocode/contracts';
import { isGitWorkTree } from '../git/work-tree.js';
import type { ViewComponentPr } from '../tasks/component-pr.js';
import {
  checkPrTaskLinkage,
  type EvidenceRoots,
  isDocumentArtifact,
  linkedPrChange,
} from '../tasks/evidence.js';
import { ghQueryTimeoutMs, isGhCliAvailable } from './github-pr.js';
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
  /**
   * Later default-branch commit (T12742) whose `push` runs stand in for a
   * required check whose merge-commit verdict is only `cancelled`/`skipped` —
   * never for a failed, pending or missing one. The caller proves ancestry and
   * file integrity ({@link findGreenDescendant}).
   */
  descendantSha?: string;
}

/** One first-parent commit of the default branch after a merge commit (T12742). */
export interface MainCommit {
  /** Commit SHA. */
  sha: string;
  /** Number of parents; 2+ is a merge commit. */
  parents: number;
}

/** Most later default-branch commits examined for a green stand-in run (T12742). */
export const CI_DESCENDANT_MAX_CANDIDATES = 10;

/** Latest committer time after the merge commit a stand-in may have (T12742): 7 days. */
export const CI_DESCENDANT_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/** Merge-commit verdicts a later green main run may stand in for (T12742). */
const SUPERSEDED_VERDICTS: ReadonlySet<string> = new Set(['cancelled', 'skipped']);

/** Conclusions that never indicate a real failure on the merge commit (T12742). */
const HARMLESS_CONCLUSIONS: ReadonlySet<string> = new Set([
  'success',
  'cancelled',
  'skipped',
  'neutral',
]);

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
  /**
   * Whether a commit has landed on origin's default branch; defaults to
   * `origin/HEAD` (else origin/main, origin/master) and `merge-base --is-ancestor`.
   */
  onDefaultBranch?: (sha: string, cwd: string) => { ref: string | null; landed: boolean };
  /**
   * Component PR the task is linked through (`ci:<component>@<integration>`,
   * T12671): the integration PR's CI is judged; the component supplies the link.
   */
  componentPrNumber?: number;
  /** Component PR reader; defaults to `gh pr view`. */
  viewComponentPr?: ViewComponentPr;
  /** Persist nothing: no PR-result or branch-protection cache writes (the `--plan` preview). */
  readOnly?: boolean;
  /**
   * First-parent commits of `ref` after `mergeSha`, oldest first, already
   * bounded to {@link CI_DESCENDANT_MAX_CANDIDATES} within
   * {@link CI_DESCENDANT_MAX_AGE_SECONDS}; null when git cannot tell (T12742).
   * Defaults to `git log --first-parent`.
   */
  listDescendants?: (mergeSha: string, ref: string, cwd: string) => string[] | null;
  /**
   * First-parent commits in `from..to` whose diff against their first parent
   * touches any of `paths`; null when git cannot tell (T12742). Any hit —
   * merge or not — refuses the stand-in. Defaults to
   * `git log --first-parent -- <paths>`.
   */
  touchingCommits?: (
    from: string,
    to: string,
    paths: readonly string[],
    cwd: string,
  ) => MainCommit[] | null;
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
export function readCiChecks(projectRoot: string): CiChecksConfig {
  const raw = (readProjectContextFile(projectRoot) as { evidence?: { ciChecks?: unknown } } | null)
    ?.evidence?.ciChecks;
  if (typeof raw !== 'object' || raw === null) return {};
  const list = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() !== '')
      ? (v as string[]).map((x) => x.trim())
      : undefined;
  const { tests, qa, jobs } = raw as { tests?: unknown; qa?: unknown; jobs?: unknown };
  const jobLists =
    typeof jobs === 'object' && jobs !== null
      ? (jobs as { tests?: unknown; qa?: unknown })
      : undefined;
  const jobTests = list(jobLists?.tests);
  const jobQa = list(jobLists?.qa);
  return {
    ...(list(tests) ? { tests: list(tests) } : {}),
    ...(list(qa) ? { qa: list(qa) } : {}),
    ...(jobTests || jobQa
      ? { jobs: { ...(jobTests ? { tests: jobTests } : {}), ...(jobQa ? { qa: jobQa } : {}) } }
      : {}),
  };
}

/** `evidence.ciChecks` as read from project context (T12634). */
export interface CiChecksConfig {
  /** Required checks attesting testsPassed. */
  tests?: string[];
  /** Required checks attesting qaPassed. */
  qa?: string[];
  /**
   * Job-name globs (`*` wildcard) that must each match at least one job run by
   * the pinned workflows of that gate's checks, all `success`, before a `code`
   * task's gate is attested — an aggregate that counts skipped jobs as a pass
   * is not enough.
   */
  jobs?: { tests?: string[]; qa?: string[] };
}

/**
 * Top-level directories whose files are code for the `ci:` skip decision even
 * when they are Markdown or text: a `.md` under `packages/**` can be a runtime
 * template (CLEO-INJECTION.md is injected into every agent), and the CI `code`
 * path filter plus the scripts, crates and workflow filters cover these roots.
 */
const CI_CODE_ROOTS: readonly string[] = ['packages/', 'crates/', 'scripts/', '.github/'];

/**
 * Stricter than `pr:`'s {@link isDocumentArtifact}: a documentation artifact
 * that lives outside every code root. Only a diff made entirely of these may
 * leave its test and typecheck jobs honestly skipped.
 *
 * @param path - Repo-relative changed path.
 * @returns True when the path cannot affect code, tests or CI.
 * @task T12634
 */
export function isCiDocumentPath(path: string): boolean {
  return isDocumentArtifact(path) && !CI_CODE_ROOTS.some((root) => path.startsWith(root));
}

/** `*`-glob to an anchored regular expression. */
function globToRegExp(glob: string): RegExp {
  return new RegExp(
    `^${glob
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  );
}

/**
 * Judge job globs on one SHA: every glob must match at least one job (check
 * run) from the allowed workflows/app, and the latest run of each matched
 * (job, event) must be `success` — a `skipped` job is refused by name.
 *
 * @param globs - Job-name globs for the gate.
 * @param checks - Every check reported for the commit.
 * @param sha - Commit being judged.
 * @param scope - The app and workflow files the jobs must come from.
 * @param onlyEvent - Restrict to runs of this event (the PR-head substitution).
 * @returns The judged job names, or one reason per unmet glob.
 * @task T12634
 */
export function evaluateJobs(
  globs: readonly string[],
  checks: readonly CommitCheck[],
  sha: string,
  scope: { app?: string | number; workflows: readonly string[] },
  onlyEvent?: string,
): { ok: true; jobs: string[] } | { ok: false; reasons: string[] } {
  const inScope = checks.filter(
    (c) =>
      c.source === 'check-run' &&
      c.headSha === sha &&
      (onlyEvent === undefined || c.event === onlyEvent) &&
      c.workflowPath !== undefined &&
      scope.workflows.includes(c.workflowPath) &&
      (scope.app === undefined ||
        (typeof scope.app === 'number' ? c.appId === scope.app : c.appSlug === scope.app)),
  );
  const reasons: string[] = [];
  const jobs: string[] = [];
  for (const glob of globs) {
    const re = globToRegExp(glob);
    const matched = inScope.filter((c) => re.test(c.name));
    if (matched.length === 0) {
      reasons.push(
        `job ${glob}: not found in ${scope.workflows.join(', ')} on ${sha.slice(0, 12)}`,
      );
      continue;
    }
    const latest = new Map<string, CommitCheck>();
    for (const c of matched) {
      const key = `${c.name}\u0000${c.event ?? ''}`;
      const prev = latest.get(key);
      if (!prev || c.id > prev.id) latest.set(key, c);
    }
    const bad = [...latest.values()].find(
      (c) => c.status !== 'completed' || c.conclusion !== 'success',
    );
    if (bad) {
      reasons.push(
        `job ${bad.name}: ${bad.status !== 'completed' ? `pending (${bad.status})` : bad.conclusion} on ${sha.slice(0, 12)}`,
      );
      continue;
    }
    jobs.push(...new Set([...latest.values()].map((c) => c.name)));
  }
  return reasons.length > 0 ? { ok: false, reasons } : { ok: true, jobs };
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
  const { treeEquivalentSha, descendantSha, pins = {} } = opts;
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
    // T12742: only a superseded (cancelled/skipped) merge-commit verdict may
    // be stood in for, and only by a later main commit's own push runs.
    if (
      descendantSha !== undefined &&
      descendantSha !== mergeCommitSha &&
      SUPERSEDED_VERDICTS.has(onMerge.verdict)
    ) {
      const onDescendant = judgeOnSha(pinned, descendantSha, 'push');
      if (onDescendant.ok) {
        matched.push(judged(name, onDescendant.run, descendantSha));
        continue;
      }
    }
    const impostor = named.find((c) => !pinMatches(c, pins[name]));
    const elsewhere = pinned.find(
      (c) =>
        c.headSha !== mergeCommitSha &&
        c.headSha !== treeEquivalentSha &&
        c.headSha !== descendantSha,
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

/** Scope of the runs that count for the required checks: their pins' apps and workflow files. */
interface PinnedScope {
  required: readonly string[];
  pins: Record<string, RequiredCheckPinSpec>;
  workflows: ReadonlySet<string>;
  apps: ReadonlySet<string | number>;
}

function pinnedScope(
  required: readonly string[],
  pins: Record<string, RequiredCheckPinSpec>,
): PinnedScope {
  const specs = required.flatMap((n) => (pins[n] ? [pins[n]!] : []));
  return {
    required,
    pins,
    workflows: new Set(specs.flatMap((p) => (p.workflow ? [p.workflow] : []))),
    apps: new Set(specs.flatMap((p) => (p.app !== undefined ? [p.app] : []))),
  };
}

/** Whether a run belongs to a required check or to a job of a pinned workflow. */
function inPinnedScope(check: CommitCheck, scope: PinnedScope): boolean {
  if (scope.required.includes(check.name) && pinMatches(check, scope.pins[check.name])) return true;
  if (check.workflowPath === undefined || !scope.workflows.has(check.workflowPath)) return false;
  if (scope.apps.size === 0) return true;
  return (
    (check.appSlug !== undefined && scope.apps.has(check.appSlug)) ||
    (check.appId !== undefined && scope.apps.has(check.appId))
  );
}

/** The first completed in-scope run on `sha` whose conclusion is a real failure. */
function firstRealFailure(
  checks: readonly CommitCheck[],
  sha: string,
  scope: PinnedScope,
): CommitCheck | undefined {
  return checks.find(
    (c) =>
      c.headSha === sha &&
      c.status === 'completed' &&
      !HARMLESS_CONCLUSIONS.has(c.conclusion ?? '') &&
      inPinnedScope(c, scope),
  );
}

/** Result of {@link supersededOnMerge}. */
export type SupersededOnMergeResult = { ok: true; names: string[] } | { ok: false; reason: string };

/**
 * Whether every required check left unproven on the merge commit was only
 * SUPERSEDED there (T12742): its latest merge-commit verdict is `cancelled`
 * or `skipped`, and no run of a required check or of a job in a pinned
 * workflow on the merge commit — any attempt — concluded with a failure. A
 * failed, timed-out, pending or missing check is never superseded. Pure.
 *
 * @param required - Required check names.
 * @param checks - Every check fetched for the merge commit (and PR head).
 * @param mergeCommitSha - The merge commit.
 * @param opts - Tree-equivalent PR head and pins, as for {@link evaluateMergeCommitChecks}.
 * @returns The superseded names, or why a later main run may not stand in.
 * @task T12742
 */
export function supersededOnMerge(
  required: readonly string[],
  checks: readonly CommitCheck[],
  mergeCommitSha: string,
  opts: EvaluateMergeCommitChecksOptions = {},
): SupersededOnMergeResult {
  const { treeEquivalentSha, pins = {} } = opts;
  const scope = pinnedScope(required, pins);
  const failed = firstRealFailure(checks, mergeCommitSha, scope);
  if (failed) {
    return {
      ok: false,
      reason: `${failed.name}: ${failed.conclusion} on merge commit ${mergeCommitSha.slice(0, 12)} — a real failure is never stood in for by a later run`,
    };
  }
  const names: string[] = [];
  for (const name of required) {
    const pinned = checks.filter((c) => c.name === name && pinMatches(c, pins[name]));
    const onMerge = judgeOnSha(pinned, mergeCommitSha);
    if (onMerge.ok) continue;
    if (
      treeEquivalentSha !== undefined &&
      treeEquivalentSha !== mergeCommitSha &&
      judgeOnSha(pinned, treeEquivalentSha, 'pull_request').ok
    ) {
      continue;
    }
    if (!SUPERSEDED_VERDICTS.has(onMerge.verdict)) {
      return {
        ok: false,
        reason: `${name}: ${onMerge.verdict === 'missing' ? 'not found' : onMerge.verdict} on merge commit ${mergeCommitSha.slice(0, 12)} — only a cancelled or skipped run is stood in for by a later run`,
      };
    }
    names.push(name);
  }
  return names.length > 0
    ? { ok: true, names }
    : { ok: false, reason: 'no required check was superseded on the merge commit' };
}

/** Inputs of {@link findGreenDescendant}. */
export interface FindGreenDescendantInput {
  /** Required check names. */
  required: readonly string[];
  /** Checks already fetched for the merge commit (and a tree-equivalent PR head). */
  checks: readonly CommitCheck[];
  /** The merge commit. */
  mergeCommitSha: string;
  /** Tree-equivalent PR head, when one was proven. */
  treeEquivalentSha?: string;
  /** Required-name → app/workflow pin. */
  pins: Record<string, RequiredCheckPinSpec>;
  /** The PR's changed paths; no commit in the descendant range may touch them. */
  changedPaths: readonly string[];
  /**
   * The PR's final head (`headRefOid`). Its latest `pull_request` runs must be
   * green for every superseded check: a later main run never vouches for a
   * PR that was not itself green.
   */
  prHeadSha?: string;
  /**
   * The PR edited a pinned workflow, so its own `pull_request` runs prove
   * nothing (they ran the PR's edited workflow) and are not consulted: only
   * default-branch `push` runs attest it (T13174).
   */
  mainOnly?: boolean;
  /** Default-branch ref (`origin/main`). */
  ref: string;
  /** Repository work tree. */
  cwd: string;
  /** Checks for one SHA. */
  fetchChecks: NonNullable<ResolveCiEvidenceOptions['fetchChecks']>;
  /** Later first-parent commits of `ref`, oldest first, bounded. */
  listDescendants: NonNullable<ResolveCiEvidenceOptions['listDescendants']>;
  /** First-parent commits in a range touching paths. */
  touchingCommits: NonNullable<ResolveCiEvidenceOptions['touchingCommits']>;
  /** Ancestry test. */
  isAncestor: NonNullable<ResolveCiEvidenceOptions['isAncestor']>;
}

/** Result of {@link findGreenDescendant}. */
export type FindGreenDescendantResult =
  | {
      ok: true;
      /** The stand-in commit. */
      sha: string;
      /** Checks fetched for the stand-in and for the PR head. */
      checks: CommitCheck[];
      /** `<merge>..<sha>`, proven to leave the PR's files and CI definitions untouched. */
      range: string;
      /**
       * The PR head whose `pull_request` runs were green for every superseded
       * check; absent in `mainOnly` mode, where PR runs are not consulted.
       */
      prHeadSha?: string;
    }
  | { ok: false; reason: string };

/**
 * CI-definition paths no commit in a descendant range may touch (T12742): the
 * pinned workflow file of every required check, local composite actions, and
 * the whole workflows directory when a required check has no pinned workflow
 * file (its runs could then come from any of them).
 */
function ciDefinitionPaths(
  required: readonly string[],
  pins: Record<string, RequiredCheckPinSpec>,
): string[] {
  const paths = new Set<string>();
  for (const name of required) paths.add(pins[name]?.workflow ?? '.github/workflows');
  paths.add('.github/actions');
  return [...paths];
}

/**
 * Find a later default-branch commit whose green `push` CI stands in for a
 * merge-commit run that a concurrency group cancelled (T12742).
 *
 * The stand-in's CI tested the DESCENDANT's tree, not the merge tree. It is
 * accepted only when that difference cannot matter to the PR:
 *  - the merge commit must be superseded, not failed ({@link supersededOnMerge});
 *  - the PR's own final head (`prHeadSha`) must have a green latest
 *    `pull_request` run for every superseded check — a later fix on main
 *    never rescues a broken PR;
 *  - candidates are the first {@link CI_DESCENDANT_MAX_CANDIDATES} first-parent
 *    commits of `ref` within {@link CI_DESCENDANT_MAX_AGE_SECONDS} of the
 *    merge, each a proven descendant (`git merge-base --is-ancestor`);
 *  - NO commit in `merge..candidate` — merge commits included — may touch the
 *    PR's changed paths or a CI definition ({@link ciDefinitionPaths}): a
 *    later merge could otherwise fix the PR's code or weaken the workflow
 *    that judged it (drop steps or filters, add `continue-on-error`);
 *  - the FIRST candidate with a decisive verdict decides: every superseded
 *    check green on its own `push` runs accepts it, a failure on it (or any
 *    failed job of a pinned workflow) refuses, and a PENDING run refuses with
 *    "wait for <sha>" — a later green run is never shopped for past one that
 *    is red or may still go red. Only cancelled, skipped and missing
 *    (never-started) runs move on to the next candidate.
 *
 * @param input - Merge-commit checks, pins, changed paths, PR head and injected I/O.
 * @returns The stand-in SHA, its checks and proven range, or the refusal reason.
 * @task T12742
 */
export async function findGreenDescendant(
  input: FindGreenDescendantInput,
): Promise<FindGreenDescendantResult> {
  const { required, mergeCommitSha: merge, pins, cwd } = input;
  const superseded = supersededOnMerge(required, input.checks, merge, {
    ...(input.treeEquivalentSha ? { treeEquivalentSha: input.treeEquivalentSha } : {}),
    pins,
  });
  if (!superseded.ok) return superseded;
  if (input.changedPaths.length === 0) {
    return { ok: false, reason: 'the PR has no known changed paths to follow onto a later commit' };
  }
  const head = input.mainOnly ? undefined : input.prHeadSha;
  let headChecks: CommitCheck[] = [];
  if (!input.mainOnly) {
    if (!head || !/^[0-9a-f]{40}$/.test(head)) {
      return {
        ok: false,
        reason: "the PR's final head is unknown, so its own pull_request CI cannot be shown green",
      };
    }
    const onHead = await input.fetchChecks(head, cwd);
    if (!onHead.ok) return { ok: false, reason: onHead.reason };
    headChecks = onHead.checks;
  }
  for (const name of head ? superseded.names : []) {
    const pinned = headChecks.filter((c) => c.name === name && pinMatches(c, pins[name]));
    const verdict = judgeOnSha(pinned, head as string, 'pull_request');
    if (!verdict.ok) {
      return {
        ok: false,
        reason: `${name}: ${verdict.verdict === 'missing' ? 'no pull_request run' : verdict.verdict} on PR head ${(head as string).slice(0, 12)} — a later main run never stands in for a PR whose own CI was not green`,
      };
    }
  }
  const candidates = input.listDescendants(merge, input.ref, cwd);
  if (candidates === null) {
    return { ok: false, reason: `cannot list commits on ${input.ref} after ${merge.slice(0, 12)}` };
  }
  const scope = pinnedScope(required, pins);
  const ciPaths = ciDefinitionPaths(required, pins);
  const guarded: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["the PR's files", input.changedPaths],
    [`a CI definition (${ciPaths.join(', ')})`, ciPaths],
  ];
  for (const sha of candidates.slice(0, CI_DESCENDANT_MAX_CANDIDATES)) {
    if (sha === merge || !input.isAncestor(merge, sha, cwd)) continue;
    const range = `${merge.slice(0, 12)}..${sha.slice(0, 12)}`;
    for (const [what, paths] of guarded) {
      const touching = input.touchingCommits(merge, sha, paths, cwd);
      if (touching === null) return { ok: false, reason: `cannot read history ${range}` };
      const first = touching[0];
      if (first) {
        return {
          ok: false,
          reason: `${what} changed on ${input.ref} by ${first.parents > 1 ? 'merge' : 'commit'} ${first.sha.slice(0, 12)} in ${range}, so a later run no longer tests what the PR merged`,
        };
      }
    }
    const fetched = await input.fetchChecks(sha, cwd);
    if (!fetched.ok) return { ok: false, reason: fetched.reason };
    const failedJob = firstRealFailure(fetched.checks, sha, scope);
    if (failedJob) {
      return {
        ok: false,
        reason: `${failedJob.name}: ${failedJob.conclusion} on later ${input.ref} commit ${sha.slice(0, 12)}`,
      };
    }
    let decided = true;
    for (const name of superseded.names) {
      const pinned = fetched.checks.filter((c) => c.name === name && pinMatches(c, pins[name]));
      const verdict = judgeOnSha(pinned, sha, 'push');
      if (verdict.ok) continue;
      if (verdict.verdict.startsWith('pending')) {
        return {
          ok: false,
          reason: `${name}: ${verdict.verdict} on later ${input.ref} commit ${sha.slice(0, 12)} — wait for ${sha.slice(0, 12)} to finish, then verify again`,
        };
      }
      if (verdict.verdict === 'missing' || SUPERSEDED_VERDICTS.has(verdict.verdict)) {
        decided = false;
        break;
      }
      return {
        ok: false,
        reason: `${name}: ${verdict.verdict} on later ${input.ref} commit ${sha.slice(0, 12)}`,
      };
    }
    if (decided) {
      return {
        ok: true,
        sha,
        checks: [...fetched.checks, ...headChecks],
        range: `${merge}..${sha}`,
        ...(head ? { prHeadSha: head } : {}),
      };
    }
  }
  return {
    ok: false,
    reason: `no later ${input.ref} commit (first ${CI_DESCENDANT_MAX_CANDIDATES} within 7 days) has a completed push run of ${superseded.names.join(', ')}`,
  };
}

/**
 * Default {@link ResolveCiEvidenceOptions.listDescendants} (T12742): the
 * first-parent commits of `ref` that descend from `mergeSha`, oldest first,
 * bounded to {@link CI_DESCENDANT_MAX_CANDIDATES} committed within
 * {@link CI_DESCENDANT_MAX_AGE_SECONDS} of the merge commit.
 *
 * @param mergeSha - The merge commit.
 * @param ref - Default-branch ref (`origin/main`).
 * @param cwd - Repository work tree.
 * @returns Candidate SHAs, or null when git cannot read them.
 * @task T12742
 */
export function listMainDescendants(mergeSha: string, ref: string, cwd: string): string[] | null {
  const mergedAt = Number(gitRead(cwd, ['log', '-1', '--format=%ct', mergeSha]));
  if (!Number.isFinite(mergedAt) || mergedAt <= 0) return null;
  const out = gitRead(cwd, [
    'log',
    '--first-parent',
    '--ancestry-path',
    '--reverse',
    '--format=%H %ct',
    `${mergeSha}..${ref}`,
  ]);
  if (out === null) return null;
  return out
    .split('\n')
    .map((line) => line.trim().split(' '))
    .filter(
      ([sha, ct]) =>
        sha !== undefined &&
        /^[0-9a-f]{40}$/.test(sha) &&
        Number(ct) <= mergedAt + CI_DESCENDANT_MAX_AGE_SECONDS,
    )
    .map(([sha]) => sha!)
    .slice(0, CI_DESCENDANT_MAX_CANDIDATES);
}

/**
 * Default {@link ResolveCiEvidenceOptions.touchingCommits} (T12742): the
 * first-parent commits in `from..to` that changed any of `paths`. With
 * `--first-parent`, git judges each commit's path-limited change against its
 * first parent only, so a merge that brought another PR's edit is listed as
 * a merge, and a direct (non-merge) commit as a non-merge.
 *
 * @param from - Exclusive start (the merge commit).
 * @param to - Inclusive end (the candidate).
 * @param paths - The PR's changed paths.
 * @param cwd - Repository work tree.
 * @returns The touching commits with their parent counts, or null on a git error.
 * @task T12742
 */
export function listPathTouchingMainCommits(
  from: string,
  to: string,
  paths: readonly string[],
  cwd: string,
): MainCommit[] | null {
  const out = gitRead(cwd, [
    'log',
    '--first-parent',
    '--format=%H %P',
    `${from}..${to}`,
    '--',
    ...paths,
  ]);
  if (out === null) return null;
  return out
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [sha, ...parents] = line.trim().split(/\s+/);
      return { sha: sha!, parents: parents.length };
    });
}

/** Default {@link ResolveCiEvidenceOptions.treeOf}: `git rev-parse <sha>^{tree}`. */
function defaultTreeOf(sha: string, cwd: string): string | null {
  return gitRead(cwd, ['rev-parse', '--verify', '--quiet', `${sha}^{tree}`]);
}

function defaultIsAncestor(ancestor: string, descendant: string, cwd: string): boolean {
  return gitRead(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]) !== null;
}

function defaultOnDefaultBranch(sha: string, cwd: string): { ref: string | null; landed: boolean } {
  // The forge is authoritative; a local origin/HEAD can be stale or unset.
  const fromGh = ghDefaultBranch(cwd);
  const symbolic = fromGh
    ? null
    : gitRead(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  let ref = fromGh
    ? `origin/${fromGh}`
    : symbolic
      ? symbolic.replace(/^refs\/remotes\//, '')
      : null;
  if (ref === null) {
    for (const candidate of ['origin/main', 'origin/master']) {
      if (
        gitRead(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/${candidate}`]) !== null
      ) {
        ref = candidate;
        break;
      }
    }
  }
  if (ref === null) return { ref: null, landed: false };
  return { ref, landed: defaultIsAncestor(sha, ref, cwd) };
}

/**
 * Default branch name from `gh repo view --json defaultBranchRef`.
 *
 * @param cwd - Repository `gh` runs in.
 * @returns The branch name, or null when `gh` is unavailable, failed, or
 *   answered something that is not a branch name.
 * @task T12959
 */
export function ghDefaultBranch(cwd: string): string | null {
  if (!isGhCliAvailable()) return null;
  try {
    const name = execFileSync(
      'gh',
      ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'],
      { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: ghQueryTimeoutMs() },
    ).trim();
    return /^[A-Za-z0-9._/-]+$/.test(name) ? name : null;
  } catch {
    return null;
  }
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
        timeout: ghQueryTimeoutMs(),
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
 * Re-check, at `cleo complete`, a `ci:` atom that leaned on a later main
 * commit (T12742). A completed conclusion is NOT immutable: a GitHub re-run
 * adds a newer attempt that can go red. Every check judged on the
 * descendant is re-fetched and its latest `push` attempt (same app and
 * workflow) must still be `success`; each such check's latest
 * `pull_request` attempt on the recorded PR head must be too. Atoms without
 * `descendantSha` pass untouched.
 *
 * @param atom - The recorded `ci:` atom.
 * @param cwd - Repository work tree for `gh`.
 * @param fetchChecks - Checks for one SHA; defaults to the GitHub REST API.
 * @returns Ok, or why the stand-in no longer holds.
 * @task T12742
 */
export async function recheckCiDescendantAtom(
  atom: Extract<EvidenceAtom, { kind: 'ci' }>,
  cwd: string,
  fetchChecks: NonNullable<ResolveCiEvidenceOptions['fetchChecks']> = defaultFetchChecks,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const descendant = atom.descendantSha;
  if (!descendant) return { ok: true };
  const head = atom.descendantPrHeadSha;
  if (!head && !atom.mainOnly) {
    return {
      ok: false,
      reason: `ci:${atom.prNumber} leans on ${descendant.slice(0, 12)} but records no PR head; verify again`,
    };
  }
  const stoodIn = atom.checks.filter((c) => c.sha === descendant);
  const sameSource = (run: CommitCheck, c: (typeof stoodIn)[number]): boolean =>
    run.name === c.name &&
    (c.app === undefined || run.appSlug === c.app || String(run.appId) === c.app) &&
    (c.workflow === undefined || run.workflowPath === c.workflow);
  // T13174: a main-only atom never consulted the PR's own runs.
  const targets: ReadonlyArray<readonly [string, 'push' | 'pull_request']> = head
    ? [
        [descendant, 'push'],
        [head, 'pull_request'],
      ]
    : [[descendant, 'push']];
  for (const [sha, event] of targets) {
    const fetched = await fetchChecks(sha, cwd);
    if (!fetched.ok) {
      return {
        ok: false,
        reason: `cannot re-check ci:${atom.prNumber} on ${sha.slice(0, 12)}: ${fetched.reason}`,
      };
    }
    for (const c of stoodIn) {
      const verdict = judgeOnSha(
        fetched.checks.filter((run) => sameSource(run, c)),
        sha,
        event,
      );
      if (!verdict.ok) {
        return {
          ok: false,
          reason: `${c.name}: now ${verdict.verdict} (${event}) on ${sha.slice(0, 12)} — ci:${atom.prNumber} no longer holds; verify again`,
        };
      }
    }
  }
  return { ok: true };
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
      key: g === 'testsPassed' ? ('tests' as const) : ('qa' as const),
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
  const readOnly = opts.readOnly === true;
  const pr = await (
    opts.resolvePr ?? ((n, r) => resolvePrEvidenceAtom(n, r, { projectContext, readOnly }))
  )(prNumber, roots);
  if (!pr.ok) return { ok: false, reason: pr.reason, codeName: pr.codeName };
  // T12634: the same task linkage `pr:` enforces — never any merged PR for any
  // task. T12671: through the component PR when the atom names one.
  const linked = await linkedPrChange(
    prNumber,
    pr,
    roots,
    opts.componentPrNumber,
    opts.viewComponentPr,
  );
  if (!linked.ok) {
    return {
      ok: false,
      reason: linked.reason,
      codeName:
        linked.codeName === 'E_EVIDENCE_CONTENT_MISMATCH'
          ? 'E_EVIDENCE_CONTENT_MISMATCH'
          : 'E_EVIDENCE_INSUFFICIENT',
    };
  }
  const unlinked = checkPrTaskLinkage(linked.prNumber, linked.pr, context);
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

  // The work must have LANDED on the default branch: a PR merged into an
  // integration branch counts once that branch reached the default branch
  // (its merge commit is then an ancestor), and never before.
  const onDefault = (opts.onDefaultBranch ?? defaultOnDefaultBranch)(
    pr.mergeCommitSha,
    roots.executionRoot,
  );
  if (onDefault.ref === null) {
    return {
      ok: false,
      codeName: 'E_EVIDENCE_INSUFFICIENT',
      reason: `Cannot determine origin's default branch in ${roots.executionRoot}, so ci:${prNumber} cannot show the work landed (git remote set-head origin --auto).`,
    };
  }
  if (!onDefault.landed) {
    return {
      ok: false,
      codeName: 'E_EVIDENCE_INSUFFICIENT',
      reason: `PR #${prNumber}'s merge commit ${pr.mergeCommitSha.slice(0, 12)} is not on ${onDefault.ref}: the work has not landed on the default branch (git fetch origin, or wait until its integration branch merges).`,
    };
  }

  const required = await resolveRequiredWorkflowsDetailed(roots, { projectContext, readOnly });
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
  // Round 2 (MEDIUM): a check that attests a gate must be pinned to the app
  // that posts it — an unpinned name would match a run from any app.
  const mapped = [...new Set(gateLists.flatMap((g) => g.list ?? []))];
  const unpinned = mapped.filter((name) => pins[name]?.app === undefined);
  if (unpinned.length > 0) {
    return {
      ok: false,
      codeName: 'E_EVIDENCE_INSUFFICIENT',
      reason:
        `ci:${prNumber} cannot trust unpinned check(s) ${unpinned.join(', ')}: declare each in ` +
        'release.prRequiredWorkflows as { "name": "<check>", "app": "<app slug or id>", ' +
        '"workflow": ".github/workflows/<file>.yml" } (or pin it in branch protection).',
    };
  }
  // Round 2: a pull_request run executes the PR's OWN edited workflow, so a PR
  // that touches a pinned workflow file cannot vouch for itself. T13174: it is
  // attested by default-branch `push` runs only — the merge commit's, or a
  // later main commit's under the T12742 rule — which run the workflow as it
  // stands on main after review. Its PR runs are never consulted.
  const pinnedWorkflows = [
    ...new Set(mapped.flatMap((name) => (pins[name]?.workflow ? [pins[name]!.workflow!] : []))),
  ];
  const editedWorkflows = pinnedWorkflows.filter((w) => pr.changedPaths.includes(w));
  const mainOnly = editedWorkflows.length > 0;

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
    !mainOnly &&
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

  let judgedChecks = evaluateMergeCommitChecks(required.workflows, checks, pr.mergeCommitSha, {
    ...(treeEqualHead ? { treeEquivalentSha: treeEqualHead } : {}),
    pins,
  });
  // T12742: a merge-commit push run cancelled by a concurrency group (merges
  // landing back to back) may be stood in for by the first decisive green push
  // run on a later default-branch commit — only when the PR head's own
  // pull_request CI was green and nothing in between touched the PR's files
  // or a CI definition. That run proves the DESCENDANT's tree, not the merge's.
  let descendant: { sha: string; range: string; prHeadSha?: string } | undefined;
  let descendantReason: string | undefined;
  if (!judgedChecks.ok && onDefault.ref !== null) {
    const found = await findGreenDescendant({
      required: required.workflows,
      checks,
      mergeCommitSha: pr.mergeCommitSha,
      ...(treeEqualHead ? { treeEquivalentSha: treeEqualHead } : {}),
      pins,
      changedPaths: pr.changedPaths,
      ...(pr.headRefOid ? { prHeadSha: pr.headRefOid } : {}),
      ...(mainOnly ? { mainOnly: true } : {}),
      ref: onDefault.ref,
      cwd,
      fetchChecks,
      listDescendants: opts.listDescendants ?? listMainDescendants,
      touchingCommits: opts.touchingCommits ?? listPathTouchingMainCommits,
      isAncestor: opts.isAncestor ?? defaultIsAncestor,
    });
    if (found.ok) {
      const withDescendant = [...checks, ...found.checks];
      const rejudged = evaluateMergeCommitChecks(
        required.workflows,
        withDescendant,
        pr.mergeCommitSha,
        {
          ...(treeEqualHead ? { treeEquivalentSha: treeEqualHead } : {}),
          pins,
          descendantSha: found.sha,
        },
      );
      if (rejudged.ok) {
        checks = withDescendant;
        judgedChecks = rejudged;
        descendant = {
          sha: found.sha,
          range: found.range,
          ...(found.prHeadSha ? { prHeadSha: found.prHeadSha } : {}),
        };
      } else {
        descendantReason = `later commit ${found.sha.slice(0, 12)} was green, but re-judging with it still fails: ${rejudged.reasons.join('; ')}`;
      }
    } else {
      descendantReason = found.reason;
    }
  }
  if (!judgedChecks.ok) {
    const waiting = judgedChecks.reasons.some((r) => /pending|not found|missing/.test(r));
    return {
      ok: false,
      codeName: 'E_EVIDENCE_TESTS_FAILED',
      reason:
        `Required CI on PR #${prNumber}'s merge commit ${pr.mergeCommitSha.slice(0, 12)} is not green ` +
        `(source: ${describeRequiredWorkflowsSource(required.source)}):\n  - ${judgedChecks.reasons.join('\n  - ')}` +
        (descendantReason ? `\n  No later main run stands in: ${descendantReason}` : '') +
        (mainOnly
          ? `\n  PR #${prNumber} edits the pinned workflow ${editedWorkflows.join(', ')}, so only main's push CI attests it (T13174)` +
            (waiting
              ? `: wait for the push run on ${pr.mergeCommitSha.slice(0, 12)} (or a later main commit) to finish, then verify again. No local run is needed.`
              : '.')
          : ''),
    };
  }
  // Round 2 (skipped tests): the aggregate counts skipped jobs as a pass. For a
  // CODE task every configured job glob must have actually run and succeeded
  // in the pinned workflows; a docs/research task keeps the honest skip.
  // A PR whose whole diff is documentation had nothing for the test and
  // typecheck jobs to run on — the same judgement `pr:` makes when it refuses a
  // docs-only PR as a code task's implementation — so its skip is honest too.
  // Round 3: the DIFF alone decides — a task label is agent-editable
  // (`cleo update --labels docs`) and must never excuse skipped jobs.
  const docsOnlyDiff = pr.changedPaths.length > 0 && pr.changedPaths.every(isCiDocumentPath);
  const isCode = !docsOnlyDiff;
  const jobsByGate: Record<string, string[]> = {};
  if (isCode) {
    for (const g of gateLists) {
      const globs = readCiChecks(roots.storeRoot).jobs?.[g.key];
      if (!globs || globs.length === 0) {
        return {
          ok: false,
          codeName: 'E_EVIDENCE_INSUFFICIENT',
          reason:
            `ci:${prNumber} cannot attest ${g.gate} for code task ${context.task.id}: set ` +
            `evidence.ciChecks.jobs.${g.key} to the job names that must run (e.g. "Unit Tests*").`,
        };
      }
      const scopeWorkflows = (g.list ?? []).flatMap((n) =>
        pins[n]?.workflow ? [pins[n]!.workflow!] : [],
      );
      const app = (g.list ?? []).map((n) => pins[n]?.app).find((a) => a !== undefined);
      if (scopeWorkflows.length === 0) {
        return {
          ok: false,
          codeName: 'E_EVIDENCE_INSUFFICIENT',
          reason: `ci:${prNumber}: no workflow file is pinned for ${g.gate}'s checks, so its jobs cannot be scoped; add "workflow" to their release.prRequiredWorkflows entries.`,
        };
      }
      const scope = { ...(app !== undefined ? { app } : {}), workflows: scopeWorkflows };
      let judgedJobs = evaluateJobs(globs, checks, pr.mergeCommitSha, scope);
      if (!judgedJobs.ok && treeEqualHead && !mainOnly) {
        const onHead = evaluateJobs(globs, checks, treeEqualHead, scope, 'pull_request');
        if (onHead.ok) judgedJobs = onHead;
      }
      if (!judgedJobs.ok && descendant) {
        // T12742: the stand-in's jobs, and the PR head's own pull_request jobs.
        const onDescendant = evaluateJobs(globs, checks, descendant.sha, scope, 'push');
        if (!descendant.prHeadSha) {
          // T13174: main-only — the PR's own jobs are not consulted.
          if (onDescendant.ok) judgedJobs = onDescendant;
        } else {
          const onPrHead = evaluateJobs(globs, checks, descendant.prHeadSha, scope, 'pull_request');
          if (onDescendant.ok && onPrHead.ok) judgedJobs = onDescendant;
          else if (!onPrHead.ok) judgedJobs = onPrHead;
        }
      }
      if (!judgedJobs.ok) {
        return {
          ok: false,
          codeName: 'E_EVIDENCE_TESTS_FAILED',
          reason:
            `${g.gate} for code task ${context.task.id} needs its jobs to have run on PR #${prNumber}:\n  - ` +
            judgedJobs.reasons.join('\n  - '),
        };
      }
      jobsByGate[g.gate] = judgedJobs.jobs;
    }
  }
  const gateChecks: { testsPassed?: string[]; qaPassed?: string[] } = {};
  for (const g of gateLists)
    gateChecks[g.gate] = [...(g.list ?? []), ...(jobsByGate[g.gate] ?? [])];
  return {
    ok: true,
    atom: {
      kind: 'ci',
      prNumber,
      mergeCommitSha: pr.mergeCommitSha,
      checks: judgedChecks.checks,
      ...(mergeTree !== null ? { testedTree: mergeTree } : {}),
      ...(descendant
        ? {
            descendantSha: descendant.sha,
            descendantRange: descendant.range,
            ...(descendant.prHeadSha ? { descendantPrHeadSha: descendant.prHeadSha } : {}),
          }
        : {}),
      ...(mainOnly ? { mainOnly: true } : {}),
      requiredSource: required.source.tier,
      taskId: context.task.id,
      gateChecks,
      ...(opts.componentPrNumber !== undefined
        ? { componentPrNumber: opts.componentPrNumber }
        : {}),
    },
  };
}
