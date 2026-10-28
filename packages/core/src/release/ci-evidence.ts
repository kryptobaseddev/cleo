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
 * A second (T13453): a merge commit whose own run FAILED may also be stood in
 * for, but only when every failing job had already failed on its nearest
 * decided first-parent ancestor, i.e. the PR merged into a red main and
 * introduced no failure of its own. See {@link inheritedOnMerge}.
 *
 * A third (T13809): a merge commit whose run FAILED only on the flaky-quarantine
 * budget, with every test passing, failed no test of the PR's. See
 * {@link nonTestFailuresOn}. The stand-in search also looks past later runs red
 * for that reason alone, up to {@link CI_DESCENDANT_MAX_CANDIDATES} commits.
 *
 * A fourth (T14032, owner decision D11192), for a WORKSPACE-WIDE change only
 * (one a targeted test-run cannot speak for: a lockfile, a root config): when
 * the merge commit is not green and no T12742 descendant stands in, a green
 * push run of every required check on the default branch's CURRENT head (or
 * on a commit differing from it only in documentation) that descends from the
 * merge stands in, whatever the merge's own run concluded and whatever later
 * commits touched. See {@link findGreenCurrentHead}.
 *
 * @task T12634
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
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
  type FetchGhBranchProtection,
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
  /** Workflow attempt (1 = first run, above 1 = a re-run), when known (T14026). */
  runAttempt?: number;
  /** ISO 8601 time the run (or this attempt of it) started, when known (T14026). */
  startedAt?: string;
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
  /**
   * The merge commit's failures were not the PR's: all inherited from its
   * base (T13453), or only the flaky-quarantine budget with every test passing
   * (T13809). The descendant may stand in for a FAILED required check too.
   */
  inheritedFailures?: boolean;
  /**
   * The descendant is the default branch's current head standing in for a
   * workspace-wide change (T14032): it stands in for any merge-commit verdict.
   */
  currentHead?: boolean;
}

/** One failing merge-commit job and the base run it was inherited from (T13453). */
export interface InheritedFailure {
  /** Job or workflow name. */
  name: string;
  /** The failing run on the merge commit. */
  mergeRunId: number;
  /** The first-parent ancestor whose own run of the job had already failed. */
  baseSha: string;
  /** That ancestor's failing run. */
  baseRunId: number;
}

/** First-parent ancestors searched for a decided base verdict of a failing job (T13453). */
export const CI_INHERITED_MAX_ANCESTORS = 10;

/** One first-parent commit of the default branch after a merge commit (T12742). */
export interface MainCommit {
  /** Commit SHA. */
  sha: string;
  /** Number of parents; 2+ is a merge commit. */
  parents: number;
}

/** Most later default-branch commits examined for a green stand-in run (T12742). */
export const CI_DESCENDANT_MAX_CANDIDATES = 20;

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
        | 'E_EVIDENCE_CONTENT_MISMATCH'
        | 'E_EVIDENCE_CI_VACUOUS';
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
   * ISO 8601 commit time of the first first-parent commit of `ref` after
   * `mergeSha`, or null when there is none or git cannot tell (T14026).
   * Defaults to `git log --first-parent --ancestry-path`.
   */
  nextMainCommitAt?: (mergeSha: string, ref: string, cwd: string) => string | null;
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
  /**
   * Plain-text log of one Actions job (a check-run id), or null when it cannot
   * be read (T13809). Defaults to `gh api repos/{owner}/{repo}/actions/jobs/<id>/logs`.
   */
  fetchJobLog?: (jobId: number, cwd: string) => Promise<string | null>;
  /**
   * The current head of the default-branch ref (T14032); null when unknown.
   * Defaults to GitHub's branch head via `gh`, else `git rev-parse <ref>`.
   */
  defaultBranchHead?: (ref: string, cwd: string) => string | null;
  /**
   * Paths that differ between two commits, or null when git cannot tell
   * (T14032). Defaults to `git diff --name-only --no-renames`.
   */
  changedBetween?: (from: string, to: string, cwd: string) => string[] | null;
  /**
   * Why a change is workspace-wide (only a full run speaks for it), or null
   * when it is scoped (T14032). Defaults to the `test-run:` requirement rule
   * (`testRunRequirement` kind `full`).
   */
  workspaceWideReason?: (root: string, paths: readonly string[]) => Promise<string | null>;
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
 * The `evidence.ciSatisfies` remedy for a project that has GitHub workflows
 * but has not opted in (T13096), or null when it has, or has no workflows.
 *
 * Without the setting, `cleo complete` cannot stand a merged PR's CI in for
 * `testsPassed`/`qaPassed` (`ci:<pr>`), so a scoped run recorded before the
 * merge leaves only a full local suite. The remedy is a ready-to-paste
 * `evidence` block whose `ciChecks` are the default branch's required checks
 * ({@link resolveRequiredWorkflowsDetailed}, read-only: nothing is cached).
 *
 * @param root - The project checkout (its `.cleo/project-context.json` and `.github/workflows`).
 * @param opts - Branch-protection fetcher override (tests).
 * @returns The remedy text, or null.
 * @task T13096
 */
export async function ciSatisfiesRemedy(
  root: string,
  opts: { fetchGhBranchProtection?: FetchGhBranchProtection } = {},
): Promise<string | null> {
  if (readCiSatisfies(root)) return null;
  let workflows: string[];
  try {
    workflows = readdirSync(join(root, '.github', 'workflows')).filter((f) => /\.ya?ml$/.test(f));
  } catch {
    return null;
  }
  if (workflows.length === 0) return null;
  const required = await resolveRequiredWorkflowsDetailed(
    { storeRoot: root, executionRoot: root },
    {
      projectContext: readProjectContextFile(root),
      readOnly: true,
      ...(opts.fetchGhBranchProtection
        ? { fetchGhBranchProtection: opts.fetchGhBranchProtection }
        : {}),
    },
  );
  const checks = required.source.tier === 'unknown' ? [] : required.workflows;
  // ci:<pr> attests a gate only through its declared ciChecks list (T12634).
  const listed = checks.length > 0 ? checks : ['<required check>'];
  const block = { ciSatisfies: true, ciChecks: { tests: listed, qa: listed } };
  return (
    `This project has GitHub workflows (.github/workflows) but does not set evidence.ciSatisfies, ` +
    "so a merged PR's CI cannot stand in for testsPassed/qaPassed (ci:<pr>). Add to " +
    `.cleo/project-context.json: "evidence": ${JSON.stringify(block)}` +
    (checks.length > 0
      ? ` (required checks from ${describeRequiredWorkflowsSource(required.source)}; narrow ciChecks.tests/qa to the checks that run tests and QA).`
      : `, replacing <required check> with the required checks that run tests and QA (none were found: ${describeRequiredWorkflowsSource(required.source)}).`)
  );
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
  const { tests, qa, jobs, covering } = raw as {
    tests?: unknown;
    qa?: unknown;
    jobs?: unknown;
    covering?: unknown;
  };
  const jobLists =
    typeof jobs === 'object' && jobs !== null
      ? (jobs as { tests?: unknown; qa?: unknown })
      : undefined;
  const jobTests = list(jobLists?.tests);
  const jobQa = list(jobLists?.qa);
  const coverRules = (v: unknown): CoveringJobRule[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const rules = v.flatMap((r): CoveringJobRule[] => {
      if (typeof r !== 'object' || r === null) return [];
      const { paths, jobs: ruleJobs } = r as { paths?: unknown; jobs?: unknown };
      const p = list(paths);
      const j = list(ruleJobs);
      return p && j ? [{ paths: p, jobs: j }] : [];
    });
    // A malformed rule voids the whole list: a half-read mapping must not widen coverage.
    return rules.length === v.length && rules.length > 0 ? rules : undefined;
  };
  const coverLists =
    typeof covering === 'object' && covering !== null
      ? (covering as { tests?: unknown; qa?: unknown })
      : undefined;
  const coverTests = coverRules(coverLists?.tests);
  const coverQa = coverRules(coverLists?.qa);
  return {
    ...(list(tests) ? { tests: list(tests) } : {}),
    ...(list(qa) ? { qa: list(qa) } : {}),
    ...(jobTests || jobQa
      ? { jobs: { ...(jobTests ? { tests: jobTests } : {}), ...(jobQa ? { qa: jobQa } : {}) } }
      : {}),
    ...(coverTests || coverQa
      ? {
          covering: {
            ...(coverTests ? { tests: coverTests } : {}),
            ...(coverQa ? { qa: coverQa } : {}),
          },
        }
      : {}),
  };
}

/**
 * One `evidence.ciChecks.covering` rule (T13175): changed paths matching
 * `paths` are covered by the jobs matching `jobs`.
 */
export interface CoveringJobRule {
  /** Repo-relative path globs (`**` any depth, `*` within one segment). */
  paths: string[];
  /** Job-name globs (`*` wildcard) that must each have run and succeeded. */
  jobs: string[];
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
  /**
   * T13175: jobs that cover changed paths a change-detection filter keeps out
   * of the `jobs` globs (e.g. `scripts/**` → `Scripts Tests`). When every
   * required job of a gate was SKIPPED (by its `if:` filter; a failure upstream
   * already turns the required check red) and every changed path matches a
   * rule whose jobs ran and succeeded, those jobs attest the gate instead.
   */
  covering?: { tests?: CoveringJobRule[]; qa?: CoveringJobRule[] };
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
 * Path glob to an anchored regular expression (T13175): `**` followed by `/` is
 * any number of whole directories (including none), a trailing `/` followed by
 * `**` is everything below, `*` any run of characters within one segment, `?`
 * one character within a segment. Everything else is literal.
 *
 * @param glob - Repo-relative path glob.
 * @returns The anchored expression.
 */
export function pathGlobToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i++;
      }
    } else if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/**
 * Judge a gate's required jobs with the covering rules (T13175): accepted only
 * when each required glob either succeeded or had every latest run completed
 * `skipped` (never cancelled, failed, pending or missing), at least one was
 * skipped, every changed path matches a rule, and every job glob of each rule
 * used has run and succeeded on `sha`.
 *
 * @param globs - The gate's required job globs (`evidence.ciChecks.jobs`).
 * @param rules - The gate's covering rules.
 * @param changedPaths - The PR's changed paths.
 * @param checks - Every check reported for the commit.
 * @param sha - Commit being judged.
 * @param scope - The app and workflow files the jobs must come from.
 * @returns The covering job names, or why coverage does not apply.
 * @task T13175
 */
export function evaluateCoveringJobs(
  globs: readonly string[],
  rules: readonly CoveringJobRule[],
  changedPaths: readonly string[],
  checks: readonly CommitCheck[],
  sha: string,
  scope: { app?: string | number; workflows: readonly string[] },
): { ok: true; jobs: string[] } | { ok: false; reason: string } {
  const inScope = checks.filter(
    (c) =>
      c.source === 'check-run' &&
      c.headSha === sha &&
      c.workflowPath !== undefined &&
      scope.workflows.includes(c.workflowPath) &&
      (scope.app === undefined ||
        (typeof scope.app === 'number' ? c.appId === scope.app : c.appSlug === scope.app)),
  );
  // Each required glob either succeeded (kept) or was SKIPPED by its filter
  // on every run (covered below); anything else refuses.
  const ran: string[] = [];
  let skipped = false;
  for (const glob of globs) {
    const re = globToRegExp(glob);
    const latest = new Map<string, CommitCheck>();
    for (const c of inScope.filter((c) => re.test(c.name))) {
      const key = `${c.name}\u0000${c.event ?? ''}`;
      const prev = latest.get(key);
      if (!prev || c.id > prev.id) latest.set(key, c);
    }
    if (latest.size === 0) return { ok: false, reason: `job ${glob} is missing, not skipped` };
    const runs = [...latest.values()];
    if (runs.every((c) => c.status === 'completed' && c.conclusion === 'success')) {
      ran.push(...new Set(runs.map((c) => c.name)));
      continue;
    }
    const notSkipped = runs.find((c) => c.status !== 'completed' || c.conclusion !== 'skipped');
    if (notSkipped) {
      return {
        ok: false,
        reason: `job ${notSkipped.name} is ${notSkipped.status !== 'completed' ? notSkipped.status : notSkipped.conclusion}, not skipped by its filter`,
      };
    }
    skipped = true;
  }
  if (!skipped) return { ok: false, reason: 'no required job was skipped' };
  if (changedPaths.length === 0) return { ok: false, reason: 'the PR has no known changed paths' };
  const used = new Set<CoveringJobRule>();
  for (const path of changedPaths) {
    const rule = rules.find((r) => r.paths.some((g) => pathGlobToRegExp(g).test(path)));
    if (!rule)
      return { ok: false, reason: `${path} is covered by no evidence.ciChecks.covering rule` };
    used.add(rule);
  }
  const jobs = evaluateJobs([...new Set([...used].flatMap((r) => r.jobs))], checks, sha, scope);
  return jobs.ok
    ? { ok: true, jobs: [...new Set([...ran, ...jobs.jobs])] }
    : { ok: false, reason: jobs.reasons.join('; ') };
}

/**
 * An {@link evaluateJobs} reason saying the job never ran on that SHA — not
 * found, skipped by a change filter, or cancelled — rather than that it ran
 * and failed (T13846).
 */
const JOB_NOT_RUN = /^job .+: (not found in .+|skipped|cancelled) on [0-9a-f]{12}$/;

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

/**
 * Whether a run comes from a check's pinned app and workflow (T13017):
 * `unknown` when the response left out an identity field the pin names (a
 * check run whose workflow run was not listed yet), so the run is neither
 * counted nor reported as posted by another app.
 */
function pinMatch(
  check: CommitCheck,
  pin: RequiredCheckPinSpec | undefined,
): 'match' | 'mismatch' | 'unknown' {
  if (!pin) return 'match';
  let unknown = false;
  if (pin.app !== undefined) {
    const actual = typeof pin.app === 'number' ? check.appId : check.appSlug;
    if (actual === undefined) unknown = true;
    else if (actual !== pin.app) return 'mismatch';
  }
  if (pin.workflow !== undefined) {
    if (check.workflowPath === undefined) unknown = true;
    else if (check.workflowPath !== pin.workflow) return 'mismatch';
  }
  return unknown ? 'unknown' : 'match';
}

function pinMatches(check: CommitCheck, pin: RequiredCheckPinSpec | undefined): boolean {
  return pinMatch(check, pin) === 'match';
}

/**
 * Whether a fetch left a required check's run without the identity its pin
 * names (T13017), so the fetch is retried before anything is judged.
 *
 * @param checks - Checks fetched for one commit.
 * @param required - Required check names.
 * @param pins - Required-name to app/workflow pin.
 * @returns True when a required run's identity is incomplete.
 * @task T13017
 */
export function hasIncompleteIdentity(
  checks: readonly CommitCheck[],
  required: readonly string[],
  pins: Record<string, RequiredCheckPinSpec>,
): boolean {
  return checks.some((c) => required.includes(c.name) && pinMatch(c, pins[c.name]) === 'unknown');
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
      (SUPERSEDED_VERDICTS.has(onMerge.verdict) ||
        opts.currentHead === true ||
        (opts.inheritedFailures === true &&
          onMerge.verdict !== 'missing' &&
          !onMerge.verdict.startsWith('pending')))
    ) {
      const onDescendant = judgeOnSha(pinned, descendantSha, 'push');
      if (onDescendant.ok) {
        matched.push(judged(name, onDescendant.run, descendantSha));
        continue;
      }
    }
    const impostor = named.find((c) => pinMatch(c, pins[name]) === 'mismatch');
    const unidentified = named.some((c) => pinMatch(c, pins[name]) === 'unknown');
    const elsewhere = pinned.find(
      (c) =>
        c.headSha !== mergeCommitSha &&
        c.headSha !== treeEquivalentSha &&
        c.headSha !== descendantSha,
    );
    reasons.push(
      onMerge.verdict === 'missing' && unidentified && pinned.length === 0
        ? `${name}: pending (GitHub has not reported its run's app or workflow yet) on merge commit ${mergeCommitSha.slice(0, 12)}`
        : onMerge.verdict === 'missing' && impostor && pinned.length === 0
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

/** Latest completed run per (name, source, event) on `sha` within `scope`. */
function latestRuns(
  checks: readonly CommitCheck[],
  sha: string,
  scope: PinnedScope,
): CommitCheck[] {
  const latest = new Map<string, CommitCheck>();
  for (const c of checks) {
    if (c.headSha !== sha || !inPinnedScope(c, scope)) continue;
    const key = `${c.name}\u0000${c.source}\u0000${c.event ?? ''}`;
    const prev = latest.get(key);
    if (!prev || c.id > prev.id) latest.set(key, c);
  }
  return [...latest.values()];
}

/**
 * Why a merge-commit run did not test the merge as it was when it landed
 * (T14026): a re-run, or a start after a later default-branch commit landed.
 * Null when neither is known.
 */
function lateRun(run: CommitCheck, nextMainCommitAt: string | null): string | null {
  if ((run.runAttempt ?? 1) > 1) return `is re-run attempt ${run.runAttempt}`;
  if (run.startedAt && nextMainCommitAt && Date.parse(run.startedAt) > Date.parse(nextMainCommitAt))
    return `started at ${run.startedAt}, after a later default-branch commit landed (${nextMainCommitAt})`;
  return null;
}

/** Result of {@link inheritedOnMerge}. */
export type InheritedOnMergeResult =
  | { ok: true; names: string[]; inherited: InheritedFailure[] }
  | { ok: false; reason: string };

/**
 * Whether the merge commit's failures were all inherited from main (T13453).
 *
 * Every in-scope job whose latest run on the merge commit failed must have
 * failed on its nearest DECIDED first-parent ancestor too: the closest of up to
 * {@link CI_INHERITED_MAX_ANCESTORS} ancestors whose latest run of that job
 * completed as success or failure (cancelled, skipped and missing runs are
 * looked past). A job that passed there, or was never decided, is a failure
 * the PR may have introduced and refuses. A pending merge-commit run refuses.
 * Pure: the ancestors' checks are passed in, nearest first.
 *
 * The refusal blames the PR only when the failing run could have seen nothing
 * but the PR's change (T14026): a re-run, or a run that started after a later
 * default-branch commit landed, ran in a world that moved on since the merge
 * (rotated secrets, external services), so it still refuses but says the
 * failure may not be the PR's.
 *
 * @param required - Required check names.
 * @param checks - Checks fetched for the merge commit.
 * @param mergeCommitSha - The merge commit.
 * @param ancestors - First-parent ancestors of the merge, nearest first, with their checks.
 * @param pins - Required-name to app/workflow pin.
 * @param nextMainCommitAt - When the next default-branch commit after the merge landed, if known.
 * @param untested - Failing jobs with no failed test, a runner cancellation or a worker crash (T14049, T14074): never the PR's, so never blamed.
 * @returns The required names to stand in for and the inherited jobs, or why not.
 * @task T13453
 * @task T14026
 * @task T14049
 */
export function inheritedOnMerge(
  required: readonly string[],
  checks: readonly CommitCheck[],
  mergeCommitSha: string,
  ancestors: ReadonlyArray<{ sha: string; checks: readonly CommitCheck[] }>,
  pins: Record<string, RequiredCheckPinSpec>,
  nextMainCommitAt: string | null = null,
  untested: ReadonlySet<number> = new Set(),
): InheritedOnMergeResult {
  const scope = pinnedScope(required, pins);
  const onMerge = latestRuns(checks, mergeCommitSha, scope);
  const pending = onMerge.find((c) => c.status !== 'completed');
  if (pending) {
    return {
      ok: false,
      reason: `${pending.name}: pending on merge commit ${mergeCommitSha.slice(0, 12)}`,
    };
  }
  const failing = onMerge.filter(
    (c) => !HARMLESS_CONCLUSIONS.has(c.conclusion ?? '') && !untested.has(c.id),
  );
  if (failing.length === 0) return { ok: false, reason: 'no job failed on the merge commit' };
  const inherited: InheritedFailure[] = [];
  for (const job of failing) {
    let base: { sha: string; run: CommitCheck } | undefined;
    for (const a of ancestors.slice(0, CI_INHERITED_MAX_ANCESTORS)) {
      const run = latestRuns(a.checks, a.sha, scope).find(
        (c) =>
          c.name === job.name &&
          c.source === job.source &&
          (c.event ?? '') === (job.event ?? '') &&
          c.status === 'completed' &&
          (c.conclusion === 'success' || !HARMLESS_CONCLUSIONS.has(c.conclusion ?? '')),
      );
      if (run) {
        base = { sha: a.sha, run };
        break;
      }
    }
    if (!base) {
      return {
        ok: false,
        reason: `${job.name}: ${job.conclusion} on merge commit ${mergeCommitSha.slice(0, 12)}, and no earlier main commit decided it — the PR may have introduced it`,
      };
    }
    if (base.run.conclusion === 'success') {
      const at = `${job.name}: ${job.conclusion} on merge commit ${mergeCommitSha.slice(0, 12)} but success on its base ${base.sha.slice(0, 12)}`;
      const late = lateRun(job, nextMainCommitAt);
      return {
        ok: false,
        reason: late
          ? `${at}; the failing run ${late}, so it may have failed on something that changed after the merge (secrets, external services) rather than on the PR`
          : `${at} — the PR introduced this failure`,
      };
    }
    inherited.push({
      name: job.name,
      mergeRunId: job.id,
      baseSha: base.sha,
      baseRunId: base.run.id,
    });
  }
  const names = required.filter(
    (name) =>
      !judgeOnSha(
        checks.filter((c) => c.name === name && pinMatches(c, pins[name])),
        mergeCommitSha,
      ).ok,
  );
  return { ok: true, names, inherited };
}

/**
 * The heading `scripts/ci-flaky-quarantine.mjs` prints when it fails a main
 * run because the open quarantine exceeds its budget (T13145). It returns
 * right after the first test run, whatever that run's outcome.
 */
const QUARANTINE_BUDGET_HEADING = '### Flaky quarantine over budget';

/** Test-title form shared by vitest's ` > `-joined names and the quarantine list. */
const normTitle = (title: string): string =>
  title
    .replace(/\s*>\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The failed count in one vitest summary line (0 when it names none). */
const failedIn = (line: string): number => Number(/(\d+) failed/.exec(line)?.[1] ?? 0);

/**
 * The run's own vitest summary block in `text` (T13809): the LAST `Test Files`
 * line, preceded by a blank or test-result line and followed within four lines
 * by its `Tests`, `Start at` and `Duration` lines, with no test result or test
 * output after it. A killed run has no block of its own; a block a test echoed
 * (even a full one) is followed by more test output, or follows a child's
 * unprefixed output. Null when there is none.
 */
/** A vitest per-file result, a test's captured output, or a failure line. */
const TEST_RESULT_LINE = /^\S*\s+(?:[✓❯×✗↓]\s|stdout \||stderr \|)|\bFAIL\s{2,}/;

/** What vitest prints right before its summary: a blank (timestamp-only) or result line. */
const BEFORE_SUMMARY_LINE = /^(?:\d{4}-\d\d-\d\dT\S+Z)?\s*$|^\S*\s+[✓❯×✗↓]\s|\bFAIL\s{2,}/;

function runSummary(text: string): { failedFiles: number; failedTests: number } | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/\bTest Files\s{2,}\d/.test(lines[i] ?? '')) continue;
    // A child vitest's echoed block may follow its unprefixed output (inherited stdio).
    if (i > 0 && !BEFORE_SUMMARY_LINE.test(lines[i - 1] ?? '')) return null;
    const block = lines.slice(i + 1, i + 5);
    const tests = block.find((l) => /\bTests\s{2,}\d/.test(l));
    if (!tests || !block.some((l) => /\bStart at\s{2,}/.test(l))) return null;
    const duration = block.findIndex((l) => /\bDuration\s{2,}/.test(l));
    if (duration < 0) return null;
    // The run's own summary is its LAST vitest output: a test result or test
    // output after it means this block was echoed by a test, and the run itself
    // died before printing its own (an OOM-killed run prints no marker).
    if (lines.slice(i + 2 + duration).some((l) => TEST_RESULT_LINE.test(l))) return null;
    return { failedFiles: failedIn(lines[i] ?? ''), failedTests: failedIn(tests) };
  }
  return null;
}

/**
 * vitest's own report that a worker died or ran out of memory. A test's child
 * processes print `Killed` and signal names as ordinary output, so those are
 * not markers; a killed vitest leaves no summary block ({@link runSummary}).
 */
const RUN_DIED =
  /Worker exited unexpectedly|Worker terminated due to reaching memory limit|JavaScript heap out of memory/;

/**
 * Whether a unit-test job log shows a failure caused by the flaky-quarantine
 * budget alone (T13809). `scripts/ci-flaky-quarantine.mjs` fails a main run
 * whose quarantine is over budget right after the first test run, before it
 * applies its own rule that a quarantined test's failure never blocks. So
 * the log qualifies when the budget heading is present, no error escaped a
 * test, and every failing test of that run is one the quarantine lists (no
 * failure at all is the common case). Only the run's own summary block counts
 * ({@link runSummary}), never a summary a test echoed. Any doubt is `false`:
 * no summary block, a kill or crash marker, a failing test outside the
 * quarantine, a file that failed to load, or counts that do not add up
 * (per-file `(N tests | M failed)` lines included).
 *
 * With `unretriedTimeouts` (T14086, later runs only), a failing test whose
 * error is vitest's own "Test timed out in N ms" also qualifies: the budget
 * stopped the run before its rerun-once flake rule (T13145) could judge it,
 * so the timeout decided nothing. An assertion failure never qualifies.
 *
 * @param log - The job's plain-text log (ANSI colour codes allowed).
 * @param opts - `unretriedTimeouts`: accept unretried timeouts too.
 * @returns Whether the job failed only on the quarantine budget.
 * @task T13809
 * @task T14086
 */
export function isQuarantineBudgetOnlyLog(
  log: string,
  opts: { unretriedTimeouts?: boolean } = {},
): boolean {
  const text = log.replace(/\u001b\[[0-9;]*m/g, '');
  // The script's own verdict is the last heading, with its count line under it
  // (a test's fixture output may carry the heading too).
  const heading = text.lastIndexOf(QUARANTINE_BUDGET_HEADING);
  if (heading < 0) return false;
  if (
    !/^[^\n]*\n(?:[^\n]*\n)?[^\n]*\d+ tests are quarantined \(most \d+\)/.test(text.slice(heading))
  ) {
    return false;
  }
  const run = text.slice(0, heading);
  if (/Unhandled (Errors?|Rejection)|\bErrors\s{2,}\d/.test(run) || RUN_DIED.test(run))
    return false;
  // Only the run's own summary counts; a summary a test echoed never stands in.
  const summary = runSummary(run);
  if (summary === null) return false;
  const { failedFiles, failedTests } = summary;
  const testPath = String.raw`\S+\.(?:test|spec)\.[cm]?[jt]sx?`;
  // Every per-file `(N tests | M failed)` line must agree with the summary.
  const perFile = [
    ...run.matchAll(new RegExp(`❯\\s+(?:\\S+\\s+)?(${testPath})\\s+\\([^)]*?(\\d+) failed`, 'gm')),
  ].map((m) => ({ file: m[1] ?? '', failed: Number(m[2] ?? 0) }));
  if (perFile.reduce((a, f) => a + f.failed, 0) !== failedTests) return false;
  if (failedFiles === 0 && failedTests === 0) return true;
  const quarantined = [
    ...text.slice(heading).matchAll(new RegExp(`- \`(${testPath})\` > (.+)$`, 'gm')),
  ].map((m) => ({ file: m[1] ?? '', title: normTitle(m[2] ?? '') }));
  const failing = new Map<string, { file: string; title: string }>();
  const timedOut = new Set<string>();
  for (const m of run.matchAll(
    new RegExp(`\\bFAIL\\s{2,}(?:\\S+\\s+)?(${testPath}) > (.+)$`, 'gm'),
  )) {
    const entry = { file: m[1] ?? '', title: normTitle(m[2] ?? '') };
    const key = `${entry.file}\u0000${entry.title}`;
    failing.set(key, entry);
    // The failure's own error is the first line after its FAIL header.
    const next = run
      .slice((m.index ?? 0) + m[0].length)
      .split('\n')
      .map((l) => l.replace(/^\S*Z\s/, '').trim())
      .find((l) => l !== '');
    if (next && /^Error: Test timed out in \d+ms\b/.test(next)) timedOut.add(key);
  }
  if (failing.size !== failedTests) return false;
  if (new Set([...failing.values()].map((f) => f.file)).size !== failedFiles) return false;
  if (!perFile.every((p) => [...failing.values()].some((f) => f.file === p.file))) return false;
  return [...failing.entries()].every(
    ([key, f]) =>
      quarantined.some((q) => q.title === f.title && q.file.endsWith(f.file)) ||
      (opts.unretriedTimeouts === true && timedOut.has(key)),
  );
}

/** Result of {@link nonTestFailuresOn}. */
export type NonTestFailuresResult =
  | { ok: true; jobs: Array<{ name: string; mergeRunId: number }> }
  | { ok: false; reason: string };

/**
 * Whether every failure on a commit's CI is a non-test failure (T13809): each
 * failing job of a pinned workflow failed on the flaky-quarantine budget alone
 * ({@link isQuarantineBudgetOnlyLog}) with every test passing. The required
 * checks themselves (the aggregate job and its workflow run) only report the
 * jobs they need, so their failure follows; any cancelled or timed-out job, a
 * pending run, or an unreadable log refuses.
 *
 * @param checks - Checks fetched for `sha`.
 * @param sha - The commit judged.
 * @param required - Required check names.
 * @param pins - Required-name to app/workflow pin.
 * @param fetchJobLog - Plain-text log of one job.
 * @param cwd - Repository work tree for `gh`.
 * @param opts - `unretriedTimeouts` for a later run (T14086, {@link isQuarantineBudgetOnlyLog}).
 * @returns The quarantine-only jobs, or why the commit failed for real.
 * @task T13809
 */
export async function nonTestFailuresOn(
  checks: readonly CommitCheck[],
  sha: string,
  required: readonly string[],
  pins: Record<string, RequiredCheckPinSpec>,
  fetchJobLog: NonNullable<ResolveCiEvidenceOptions['fetchJobLog']>,
  cwd: string,
  opts: { unretriedTimeouts?: boolean } = {},
): Promise<NonTestFailuresResult> {
  const latest = latestRuns(checks, sha, pinnedScope(required, pins));
  const jobs: Array<{ name: string; mergeRunId: number }> = [];
  for (const c of latest) {
    if (c.status !== 'completed') {
      return { ok: false, reason: `${c.name}: pending on ${sha.slice(0, 12)}` };
    }
    if (c.conclusion === 'success' || c.conclusion === 'skipped') continue;
    // The required checks (the aggregate job and its workflow run) follow the jobs they need.
    if (c.source === 'workflow-run' || required.includes(c.name)) continue;
    const log = c.conclusion === 'failure' ? await fetchJobLog(c.id, cwd) : null;
    if (log === null || !isQuarantineBudgetOnlyLog(log, opts)) {
      return {
        ok: false,
        reason: `${c.name}: ${c.conclusion} on ${sha.slice(0, 12)}${log === null && c.conclusion === 'failure' ? ' (its log could not be read)' : ''} — not the flaky-quarantine budget alone`,
      };
    }
    jobs.push({ name: c.name, mergeRunId: c.id });
  }
  return jobs.length > 0
    ? { ok: true, jobs }
    : { ok: false, reason: `no job failed on ${sha.slice(0, 12)} for the quarantine budget` };
}

/**
 * The number of failing jobs of a pinned workflow on `sha` (the required
 * aggregate and workflow runs excluded) whose readable log `accepts`, or null
 * when a job is still running, a log cannot be read, or `accepts` refuses one.
 */
async function everyFailedJobLog(
  checks: readonly CommitCheck[],
  sha: string,
  required: readonly string[],
  pins: Record<string, RequiredCheckPinSpec>,
  fetchJobLog: NonNullable<ResolveCiEvidenceOptions['fetchJobLog']>,
  cwd: string,
  accepts: (log: string) => boolean,
): Promise<number | null> {
  let failed = 0;
  for (const c of latestRuns(checks, sha, pinnedScope(required, pins))) {
    if (c.source === 'workflow-run' || required.includes(c.name)) continue;
    if (c.status !== 'completed') return null;
    if (HARMLESS_CONCLUSIONS.has(c.conclusion ?? '')) continue;
    const log = await fetchJobLog(c.id, cwd);
    // An unreadable log proves nothing about the job: never skip past it.
    if (log === null || !accepts(log)) return null;
    failed++;
  }
  return failed;
}

/**
 * Whether a later commit's CI was cancelled rather than failed (T13809): its
 * pinned workflow run concluded `cancelled` (a concurrency group stopped it)
 * and every failing job's log is readable and names no failed test; a job a
 * cancel interrupted often reports `failure` with nothing failed in its log. Such a run decides nothing, as a
 * cancelled run never did (T12742).
 *
 * @param checks - Checks fetched for `sha`.
 * @param sha - The later commit.
 * @param required - Required check names.
 * @param pins - Required-name to app/workflow pin.
 * @param fetchJobLog - Plain-text log of one job.
 * @param cwd - Repository work tree for `gh`.
 * @returns Whether the run was cancelled with no test failing.
 * @task T13809
 */
export async function cancelledWithoutTestFailure(
  checks: readonly CommitCheck[],
  sha: string,
  required: readonly string[],
  pins: Record<string, RequiredCheckPinSpec>,
  fetchJobLog: NonNullable<ResolveCiEvidenceOptions['fetchJobLog']>,
  cwd: string,
): Promise<boolean> {
  const runs = latestRuns(checks, sha, pinnedScope(required, pins)).filter(
    (c) => c.source === 'workflow-run',
  );
  if (!runs.some((r) => r.conclusion === 'cancelled')) return false;
  if (runs.some((r) => r.conclusion !== 'cancelled' && r.conclusion !== 'success')) return false;
  return (
    (await everyFailedJobLog(checks, sha, required, pins, fetchJobLog, cwd, noTestFailedLog)) !==
    null
  );
}

/** Whether a job log names no failed test and no dead vitest run (T13809). */
function noTestFailedLog(log: string): boolean {
  const text = log.replace(/\u001b\[[0-9;]*m/g, '');
  return !/\bFAIL\s{2,}|\d+ failed/.test(text) && !RUN_DIED.test(text);
}

/** The errors GitHub prints when the runner, not the job, stopped a step (T14049). */
const RUNNER_CANCEL_ERROR =
  /##\[error\](?:The operation was canceled\.|The runner has received a shutdown signal\b.*)\s*$/;

/**
 * Whether a job log shows only a runner cancellation (T14049): every
 * `##[error]` line is GitHub's own "The operation was canceled." (or the
 * runner shutdown notice before it), and no test failed. GitHub then reports
 * the job, and the aggregate check that needs it, as `failure`, though
 * nothing the PR changed failed.
 *
 * @param log - The job's plain-text log (ANSI colour codes allowed).
 * @returns Whether the job failed only because its runner was cancelled.
 * @task T14049
 */
export function isRunnerCancelOnlyLog(log: string): boolean {
  const text = log.replace(/\u001b\[[0-9;]*m/g, '');
  const errors = text.split('\n').filter((line) => line.includes('##[error]'));
  return (
    errors.some((line) => /##\[error\]The operation was canceled\./.test(line)) &&
    errors.every((line) => RUNNER_CANCEL_ERROR.test(line)) &&
    noTestFailedLog(text)
  );
}

/** A vitest summary or failure line naming a failed test or file. */
const FAILED_TEST = /\bFAIL\s{2,}|\d+ failed/;

/**
 * Whether a job log shows only an unattributable vitest worker crash
 * (T14074): no test or file failed, every `Unhandled Error` vitest reports is
 * its own pool's "Worker forks emitted error" (a fork that exited
 * unexpectedly, e.g. a native addon abort), and the only `##[error]` is the
 * step's non-zero exit. Such a run never showed a test of the change failing.
 *
 * @param log - The job's plain-text log (ANSI colour codes allowed).
 * @returns Whether the job failed only on a worker crash.
 * @task T14074
 */
export function isWorkerCrashOnlyLog(log: string): boolean {
  const text = log.replace(/\u001b\[[0-9;]*m/g, '');
  const crashes = text.match(/Error: \[vitest-pool\]: Worker forks emitted error\./g)?.length ?? 0;
  const unhandled = text.match(/⎯+ Unhandled Error ⎯+/g)?.length ?? 0;
  const errors = text.split('\n').filter((line) => line.includes('##[error]'));
  return (
    crashes > 0 &&
    unhandled === crashes &&
    /Caused by: Error: Worker exited unexpectedly/.test(text) &&
    !FAILED_TEST.test(text) &&
    errors.every((line) => /##\[error\]Process completed with exit code \d+\.\s*$/.test(line))
  );
}

/** Why a failing job tested nothing of the change (T14049, T14074). */
export type UntestedFailureCause = 'runner-cancel' | 'worker-crash';

/**
 * Why a failing job's log shows no failed test, or `null` when it may have
 * failed on the change: a runner cancellation ({@link isRunnerCancelOnlyLog})
 * or a worker crash ({@link isWorkerCrashOnlyLog}).
 *
 * @param log - The job's plain-text log.
 * @returns The cause, or `null`.
 * @task T14074
 */
export function untestedFailureCause(log: string): UntestedFailureCause | null {
  if (isRunnerCancelOnlyLog(log)) return 'runner-cancel';
  if (isWorkerCrashOnlyLog(log)) return 'worker-crash';
  return null;
}

/** One failing job that tested nothing of the change, and why (T14074). */
export interface UntestedJobFailure {
  name: string;
  mergeRunId: number;
  cause: UntestedFailureCause;
}

/** A later default-branch run the stand-in search looked past, and why (T14086). */
export interface PassedOverRun {
  /** The later commit. */
  sha: string;
  /** Its failing jobs. */
  jobs: string[];
  /** Why they decided nothing. */
  reason: string;
}

/** Result of {@link untestedJobFailures}. */
export interface UntestedJobFailures {
  /** The failing jobs whose log shows no failed test, with the cause. */
  jobs: UntestedJobFailure[];
  /** Their run ids. */
  ids: ReadonlySet<number>;
  /** Every failing job of a pinned workflow is one (and at least one failed). */
  all: boolean;
}

/**
 * The failing jobs of a pinned workflow on `sha` (the required aggregate and
 * workflow runs excluded) that failed without a failed test: a runner
 * cancellation (T14049) or a worker crash (T14074), by
 * {@link untestedFailureCause}. A pending job or an unreadable log is never
 * one, so `all` is then false.
 *
 * @param checks - Checks fetched for `sha`.
 * @param sha - The commit judged.
 * @param required - Required check names.
 * @param pins - Required-name to app/workflow pin.
 * @param fetchJobLog - Plain-text log of one job.
 * @param cwd - Repository work tree for `gh`.
 * @returns Those jobs, and whether they are every failure.
 * @task T14049
 * @task T14074
 */
export async function untestedJobFailures(
  checks: readonly CommitCheck[],
  sha: string,
  required: readonly string[],
  pins: Record<string, RequiredCheckPinSpec>,
  fetchJobLog: NonNullable<ResolveCiEvidenceOptions['fetchJobLog']>,
  cwd: string,
): Promise<UntestedJobFailures> {
  const jobs: UntestedJobFailure[] = [];
  let all = true;
  for (const c of latestRuns(checks, sha, pinnedScope(required, pins))) {
    if (c.source === 'workflow-run' || required.includes(c.name)) continue;
    if (c.status !== 'completed') {
      all = false;
      continue;
    }
    if (HARMLESS_CONCLUSIONS.has(c.conclusion ?? '')) continue;
    const log = c.conclusion === 'failure' ? await fetchJobLog(c.id, cwd) : null;
    const cause = log === null ? null : untestedFailureCause(log);
    if (cause) jobs.push({ name: c.name, mergeRunId: c.id, cause });
    else all = false;
  }
  return { jobs, ids: new Set(jobs.map((j) => j.mergeRunId)), all: all && jobs.length > 0 };
}

/**
 * Whether a job log shows a failure in a setup step before any test ran
 * (T13809): its first `##[error]` sits in a remote action step
 * (`Run owner/action@ref`, e.g. `actions/download-artifact@v4` finding no
 * artifact), never in a `run:` script, and the log has no vitest output at
 * all. A gate script or test failure runs in a `run:` step and never matches.
 *
 * @param log - The job's plain-text log (ANSI colour codes allowed).
 * @returns Whether the job failed in an action step before any test ran.
 * @task T13809
 */
export function isSetupStepFailureLog(log: string): boolean {
  const lines = log.replace(/\u001b\[[0-9;]*m/g, '').split('\n');
  if (lines.some((l) => /\bRUN\s+v\d|\bTest Files\s{2,}\d|\bFAIL\s{2,}/.test(l))) return false;
  const error = lines.findIndex((l) => l.includes('##[error]'));
  if (error < 0) return false;
  for (let i = error - 1; i >= 0; i--) {
    const step = /##\[group\]Run (.*)$/.exec(lines[i] ?? '');
    if (step) return /^[\w.-]+\/[\w./-]+@\S+\s*$/.test(step[1] ?? '');
  }
  return false;
}

/**
 * Whether a later commit's CI failed before any test ran (T13809): every
 * failing job's log is readable and failed in a setup action step
 * ({@link isSetupStepFailureLog}), as when each unit-test shard finds no build
 * artifact. Such a run tested nothing, so it decides nothing.
 *
 * @param checks - Checks fetched for `sha`.
 * @param sha - The later commit.
 * @param required - Required check names.
 * @param pins - Required-name to app/workflow pin.
 * @param fetchJobLog - Plain-text log of one job.
 * @param cwd - Repository work tree for `gh`.
 * @returns Whether every failing job failed before running a test.
 * @task T13809
 */
export async function failedBeforeAnyTest(
  checks: readonly CommitCheck[],
  sha: string,
  required: readonly string[],
  pins: Record<string, RequiredCheckPinSpec>,
  fetchJobLog: NonNullable<ResolveCiEvidenceOptions['fetchJobLog']>,
  cwd: string,
): Promise<boolean> {
  const failed = await everyFailedJobLog(
    checks,
    sha,
    required,
    pins,
    fetchJobLog,
    cwd,
    isSetupStepFailureLog,
  );
  return failed !== null && failed > 0;
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
  /** First parent of a commit (T13453: the inherited-failure walk); absent = never inherit. */
  firstParentOf?: NonNullable<ResolveCiEvidenceOptions['firstParentOf']>;
  /** Log of one job (T13809: the quarantine-budget check); absent = never classify. */
  fetchJobLog?: NonNullable<ResolveCiEvidenceOptions['fetchJobLog']>;
  /** When the next default-branch commit after the merge landed (T14026); absent = unknown. */
  nextMainCommitAt?: NonNullable<ResolveCiEvidenceOptions['nextMainCommitAt']>;
  /**
   * Job globs a code task's gates need (T13846), with the workflows they must
   * come from. A candidate whose required checks are green but whose push run
   * never ran these jobs (a change filter skipped them, or the run was
   * cancelled before them) decides nothing and the walk moves on; a job that
   * failed there refuses, and a pending one waits.
   */
  jobs?: ReadonlyArray<{ globs: readonly string[]; scope: JobScope }>;
}

/** The app and workflow files a gate's jobs must come from. */
export interface JobScope {
  app?: string | number;
  workflows: readonly string[];
}

/**
 * The job globs and scope of each gate (T13846), as the job check below the
 * required-check judgement reads them; a gate with no globs or no pinned
 * workflow is left out here and refused there.
 */
function gateJobSpecs(
  gateLists: ReadonlyArray<{ key: 'tests' | 'qa'; list?: readonly string[] }>,
  storeRoot: string,
  pins: Record<string, RequiredCheckPinSpec>,
): Array<{ globs: readonly string[]; scope: JobScope }> {
  const jobs = readCiChecks(storeRoot).jobs;
  return gateLists.flatMap((g) => {
    const globs = jobs?.[g.key];
    const workflows = (g.list ?? []).flatMap((n) =>
      pins[n]?.workflow ? [pins[n]!.workflow!] : [],
    );
    const app = (g.list ?? []).map((n) => pins[n]?.app).find((a) => a !== undefined);
    if (!globs || globs.length === 0 || workflows.length === 0) return [];
    return [{ globs, scope: { ...(app !== undefined ? { app } : {}), workflows } }];
  });
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
      /** The merge commit's inherited failures, when it FAILED rather than being superseded (T13453). */
      inherited?: InheritedFailure[];
      /** The merge commit's jobs that failed on the flaky-quarantine budget alone (T13809). */
      nonTest?: Array<{ name: string; mergeRunId: number }>;
      /** The merge commit's failures tested nothing: runner cancellations or worker crashes (T14049, T14074). */
      untested?: UntestedJobFailure[];
      /** Later runs the search looked past, and why (T14086). */
      passedOver?: PassedOverRun[];
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
 *  - the merge commit must be superseded, not failed ({@link supersededOnMerge}),
 *    unless its failures were inherited from main ({@link inheritedOnMerge}) or
 *    were only the flaky-quarantine budget ({@link nonTestFailuresOn}, T13809);
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
 *    (never-started) runs, and a run red only for the flaky-quarantine budget
 *    (T13809), move on to the next candidate.
 *
 * @param input - Merge-commit checks, pins, changed paths, PR head and injected I/O.
 * @returns The stand-in SHA, its checks and proven range, or the refusal reason.
 * @task T12742
 */
export async function findGreenDescendant(
  input: FindGreenDescendantInput,
): Promise<FindGreenDescendantResult> {
  const { required, mergeCommitSha: merge, pins, cwd } = input;
  let superseded: { ok: true; names: string[] } | { ok: false; reason: string } = supersededOnMerge(
    required,
    input.checks,
    merge,
    {
      ...(input.treeEquivalentSha ? { treeEquivalentSha: input.treeEquivalentSha } : {}),
      pins,
    },
  );
  let inherited: InheritedFailure[] | undefined;
  let nonTest: Array<{ name: string; mergeRunId: number }> | undefined;
  let untested: UntestedJobFailure[] | undefined;
  let untestedIds: ReadonlySet<number> = new Set();
  const unproven = (): string[] =>
    required.filter(
      (name) =>
        !judgeOnSha(
          input.checks.filter((c) => c.name === name && pinMatches(c, pins[name])),
          merge,
        ).ok,
    );
  if (!superseded.ok && input.fetchJobLog) {
    // T14049, T14074: a job that failed with no failed test (a runner
    // cancellation, or a vitest worker crash) decided nothing, though GitHub
    // reports it and the aggregate as `failure`: it is superseded, as a
    // cancelled run is. A job with any failed test never is.
    const found = await untestedJobFailures(
      input.checks,
      merge,
      required,
      pins,
      input.fetchJobLog,
      cwd,
    );
    untestedIds = found.ids;
    if (found.all) {
      untested = found.jobs;
      superseded = { ok: true, names: unproven() };
    }
  }
  if (!superseded.ok && input.fetchJobLog) {
    // T13809: a merge-commit run red only because main's flaky quarantine was
    // over budget (every test passed) failed no test of the PR's.
    const result = await nonTestFailuresOn(
      input.checks,
      merge,
      required,
      pins,
      input.fetchJobLog,
      cwd,
    );
    if (result.ok) {
      nonTest = result.jobs;
      superseded = { ok: true, names: unproven() };
    }
  }
  if (!superseded.ok && input.firstParentOf) {
    // T13453: a real failure may still be main's, inherited by a PR that
    // merged into a red main. Walk the first-parent ancestors for each
    // failing job's nearest decided verdict.
    const ancestors: Array<{ sha: string; checks: CommitCheck[] }> = [];
    let at: string | null = merge;
    for (let n = 0; n < CI_INHERITED_MAX_ANCESTORS; n++) {
      at = at ? input.firstParentOf(at, cwd) : null;
      if (!at) break;
      const fetched = await input.fetchChecks(at, cwd);
      if (!fetched.ok) break;
      ancestors.push({ sha: at, checks: fetched.checks });
    }
    const result = inheritedOnMerge(
      required,
      input.checks,
      merge,
      ancestors,
      pins,
      input.nextMainCommitAt?.(merge, input.ref, cwd) ?? null,
      untestedIds,
    );
    if (result.ok) {
      superseded = { ok: true, names: result.names };
      inherited = result.inherited;
    } else {
      superseded = {
        ok: false,
        reason: `${superseded.reason}; not inherited from main: ${result.reason}`,
      };
    }
  }
  if (!superseded.ok) return superseded;
  const supersededNames = superseded.names;
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
  for (const name of head ? supersededNames : []) {
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
  const passedOver: PassedOverRun[] = [];
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
    if (failedJob && input.fetchJobLog) {
      // T13809: a later run red only for the quarantine budget, cancelled with
      // no test failing, or failed before any test ran decides nothing; look on.
      // Any other failure still refuses: a green run is never shopped for past a real one.
      // T14086: in such a run, a test that only timed out was never retried, so
      // it decided nothing either; an assertion failure still refuses.
      const quarantineOnly = await nonTestFailuresOn(
        fetched.checks,
        sha,
        required,
        pins,
        input.fetchJobLog,
        cwd,
        { unretriedTimeouts: true },
      );
      if (quarantineOnly.ok) {
        passedOver.push({
          sha,
          jobs: quarantineOnly.jobs.map((j) => j.name),
          reason: 'the flaky-quarantine budget stopped the run before its flake rerun',
        });
        continue;
      }
      if (
        await cancelledWithoutTestFailure(
          fetched.checks,
          sha,
          required,
          pins,
          input.fetchJobLog,
          cwd,
        )
      ) {
        continue;
      }
      if (await failedBeforeAnyTest(fetched.checks, sha, required, pins, input.fetchJobLog, cwd)) {
        continue;
      }
    }
    if (failedJob) {
      return {
        ok: false,
        reason: `${failedJob.name}: ${failedJob.conclusion} on later ${input.ref} commit ${sha.slice(0, 12)}`,
      };
    }
    const verdict = judgeStandIn(fetched.checks, sha, supersededNames, pins, input.jobs, input.ref);
    if (verdict === 'undecided') continue;
    if (!verdict.ok) return verdict;
    return {
      ok: true,
      sha,
      checks: [...fetched.checks, ...headChecks],
      range: `${merge}..${sha}`,
      ...(head ? { prHeadSha: head } : {}),
      ...(inherited ? { inherited } : {}),
      ...(nonTest ? { nonTest } : {}),
      ...(untested ? { untested } : {}),
      ...(passedOver.length > 0 ? { passedOver } : {}),
    };
  }
  return {
    ok: false,
    reason: `no later ${input.ref} commit (first ${CI_DESCENDANT_MAX_CANDIDATES} within 7 days) has a completed push run of ${supersededNames.join(', ')}`,
  };
}

/**
 * Judge one later default-branch commit's own `push` runs as a stand-in
 * (T12742, T14032): every named check green, and the gates' jobs run and
 * green (T13846). A pending run refuses with "wait"; a failed one refuses —
 * a green run is never shopped for past one that is red or may still go red.
 * Cancelled, skipped and missing (never-started) runs leave it undecided, so
 * the caller looks at the next candidate.
 */
function judgeStandIn(
  checks: readonly CommitCheck[],
  sha: string,
  names: readonly string[],
  pins: Record<string, RequiredCheckPinSpec>,
  jobs: FindGreenDescendantInput['jobs'],
  ref: string,
): { ok: true } | { ok: false; reason: string } | 'undecided' {
  for (const name of names) {
    const pinned = checks.filter((c) => c.name === name && pinMatches(c, pins[name]));
    const verdict = judgeOnSha(pinned, sha, 'push');
    if (verdict.ok) continue;
    if (verdict.verdict.startsWith('pending')) {
      return {
        ok: false,
        reason: `${name}: ${verdict.verdict} on later ${ref} commit ${sha.slice(0, 12)} — wait for ${sha.slice(0, 12)} to finish, then verify again`,
      };
    }
    if (verdict.verdict === 'missing' || SUPERSEDED_VERDICTS.has(verdict.verdict)) {
      return 'undecided';
    }
    return {
      ok: false,
      reason: `${name}: ${verdict.verdict} on later ${ref} commit ${sha.slice(0, 12)}`,
    };
  }
  // T13846: the gates' own jobs must have run on the stand-in too.
  let decided = true;
  for (const job of jobs ?? []) {
    const onSha = evaluateJobs(job.globs, checks, sha, job.scope, 'push');
    if (onSha.ok) continue;
    const pending = onSha.reasons.find((r) => r.includes(': pending ('));
    if (pending) {
      return {
        ok: false,
        reason: `${pending} — wait for ${sha.slice(0, 12)} to finish, then verify again`,
      };
    }
    const decisive = onSha.reasons.find((r) => !JOB_NOT_RUN.test(r));
    if (decisive) return { ok: false, reason: `${decisive} (later ${ref} commit)` };
    decided = false;
  }
  return decided ? { ok: true } : 'undecided';
}

/** Inputs of {@link findGreenCurrentHead}. */
export interface FindGreenCurrentHeadInput {
  /** Required check names; every one must be green on the stand-in's push runs. */
  required: readonly string[];
  /** The merge commit. */
  mergeCommitSha: string;
  /** Required-name → app/workflow pin. */
  pins: Record<string, RequiredCheckPinSpec>;
  /** Job globs the gates need, as for {@link findGreenDescendant} (T13846). */
  jobs?: FindGreenDescendantInput['jobs'];
  /** Default-branch ref (`origin/main`). */
  ref: string;
  /** Repository work tree. */
  cwd: string;
  /** Checks for one SHA. */
  fetchChecks: NonNullable<ResolveCiEvidenceOptions['fetchChecks']>;
  /** The default branch's current head. */
  defaultBranchHead: NonNullable<ResolveCiEvidenceOptions['defaultBranchHead']>;
  /** Paths that differ between two commits. */
  changedBetween: NonNullable<ResolveCiEvidenceOptions['changedBetween']>;
  /** First parent of a commit. */
  firstParentOf: NonNullable<ResolveCiEvidenceOptions['firstParentOf']>;
  /** Ancestry test. */
  isAncestor: NonNullable<ResolveCiEvidenceOptions['isAncestor']>;
}

/** Result of {@link findGreenCurrentHead}. */
export type FindGreenCurrentHeadResult =
  | {
      ok: true;
      /** The commit whose push CI stands in: HEAD, or one differing from it only in documentation. */
      sha: string;
      /** Checks fetched for it. */
      checks: CommitCheck[];
      /** `<merge>..<sha>`. */
      range: string;
      /** The default branch's head at verify time. */
      head: string;
    }
  | { ok: false; reason: string };

/**
 * Find the green required-CI push run on the default branch's CURRENT head
 * that stands in for a workspace-wide change's merge-commit CI (T14032, owner
 * decision D11192). A workspace-wide change (a lockfile, a root config, a CI
 * definition) only a full run speaks for; when its merge-commit run was red
 * for a reason that is not the change (a secrets job failing on a re-run) and
 * later commits touched its files, {@link findGreenDescendant} refuses, yet a
 * full green CI on today's HEAD tests the merged change as it is now — the
 * same reasoning as the targeted test-run stand-in (T13673), which also
 * allows later edits.
 *
 * Candidates are HEAD, then its first parents while they differ from HEAD only
 * in documentation ({@link isCiDocumentPath}, the T13784 rule: nothing a test
 * reads moved), up to {@link CI_DESCENDANT_MAX_CANDIDATES}. Each must descend
 * from the merge commit. The first decisive verdict decides, as in
 * {@link findGreenDescendant}: every required check green on its own `push`
 * runs (and the gates' jobs run, T13846) accepts; a failed or pending one
 * refuses; cancelled, skipped or missing runs move to the parent.
 *
 * @param input - Required checks, pins, merge commit and injected I/O.
 * @returns The stand-in commit, its checks and the head, or the refusal reason.
 * @task T14032
 */
export async function findGreenCurrentHead(
  input: FindGreenCurrentHeadInput,
): Promise<FindGreenCurrentHeadResult> {
  const { mergeCommitSha: merge, ref, cwd } = input;
  const head = input.defaultBranchHead(ref, cwd);
  if (!head) return { ok: false, reason: `cannot read the current head of ${ref}` };
  let sha: string | null = head;
  for (let n = 0; n < CI_DESCENDANT_MAX_CANDIDATES && sha; n++) {
    const at = sha === head ? `${ref} HEAD ${head.slice(0, 12)}` : `${sha.slice(0, 12)}`;
    if (sha === merge || !input.isAncestor(merge, sha, cwd)) {
      return {
        ok: false,
        reason:
          sha === head
            ? `${at} does not descend from merge commit ${merge.slice(0, 12)} here (git fetch origin, then verify again)`
            : `no push run between merge commit ${merge.slice(0, 12)} and ${ref} HEAD ${head.slice(0, 12)} decided the required checks`,
      };
    }
    if (sha !== head) {
      const moved = input.changedBetween(sha, head, cwd);
      if (moved === null) {
        return { ok: false, reason: `cannot diff ${sha.slice(0, 12)}..${head.slice(0, 12)}` };
      }
      const testInput = moved.find((p) => !isCiDocumentPath(p));
      if (testInput) {
        return {
          ok: false,
          reason: `${ref} HEAD ${head.slice(0, 12)} has no completed push run of the required checks, and ${sha.slice(0, 12)}..${head.slice(0, 12)} changes ${testInput}, so an earlier run does not test HEAD — wait for HEAD's push CI to finish, then verify again`,
        };
      }
    }
    const fetched = await input.fetchChecks(sha, cwd);
    if (!fetched.ok) return { ok: false, reason: fetched.reason };
    const verdict = judgeStandIn(fetched.checks, sha, input.required, input.pins, input.jobs, ref);
    if (verdict !== 'undecided') {
      if (!verdict.ok) return verdict;
      return { ok: true, sha, checks: fetched.checks, range: `${merge}..${sha}`, head };
    }
    sha = input.firstParentOf(sha, cwd);
  }
  return {
    ok: false,
    reason: `no commit within ${CI_DESCENDANT_MAX_CANDIDATES} first parents of ${ref} HEAD ${head.slice(0, 12)} has a completed push run of ${input.required.join(', ')}`,
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

/** Default {@link ResolveCiEvidenceOptions.nextMainCommitAt} (T14026). */
function defaultNextMainCommitAt(mergeSha: string, ref: string, cwd: string): string | null {
  const out = gitRead(cwd, [
    'log',
    '--first-parent',
    '--ancestry-path',
    '--reverse',
    '--format=%cI',
    `${mergeSha}..${ref}`,
  ]);
  return out?.split('\n')[0] || null;
}

/**
 * Default {@link ResolveCiEvidenceOptions.defaultBranchHead} (T14032): the
 * branch head GitHub reports, so a stale local ref never passes for the
 * current one; `git rev-parse <ref>` only when `gh` cannot answer.
 */
function defaultBranchHeadOf(ref: string, cwd: string): string | null {
  const branch = ref.replace(/^origin\//, '');
  if (isGitWorkTree(cwd) && isGhCliAvailable()) {
    const commit = ghApi(`repos/{owner}/{repo}/commits/${encodeURIComponent(branch)}`, cwd);
    if (
      typeof commit === 'object' &&
      commit !== null &&
      'sha' in commit &&
      typeof commit.sha === 'string' &&
      /^[0-9a-f]{40}$/.test(commit.sha)
    ) {
      return commit.sha;
    }
  }
  return gitRead(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
}

/** Default {@link ResolveCiEvidenceOptions.changedBetween} (T14032). */
function defaultChangedBetween(from: string, to: string, cwd: string): string[] | null {
  const out = gitRead(cwd, ['diff', '--name-only', '--no-renames', from, to]);
  return out === null ? null : out.split('\n').filter(Boolean);
}

/** Default {@link ResolveCiEvidenceOptions.workspaceWideReason}: the `test-run:` rule (T14032). */
async function defaultWorkspaceWideReason(
  root: string,
  paths: readonly string[],
): Promise<string | null> {
  const { testRunRequirement } = await import('../tasks/test-run-binding.js');
  const need = testRunRequirement(root, paths);
  return need.kind === 'full' ? need.reason : null;
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

/** Default {@link ResolveCiEvidenceOptions.fetchJobLog}: the job's plain-text log via `gh` (T13809). */
async function defaultFetchJobLog(jobId: number, cwd: string): Promise<string | null> {
  if (!isGitWorkTree(cwd) || !isGhCliAvailable()) return null;
  try {
    // Job logs carry ANSI colour; gh refuses to print them without the flag.
    const args = [
      'api',
      '--allow-escape-sequences',
      `repos/{owner}/{repo}/actions/jobs/${jobId}/logs`,
    ];
    return execFileSync('gh', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      timeout: ghQueryTimeoutMs(),
    });
  } catch {
    return null;
  }
}

/**
 * Fetch once more when a required check's run came back without the identity
 * its pin names (T13017): GitHub lists a job before its workflow run, and a
 * run judged from that response would read as another app's. A run still
 * incomplete after the retry is judged pending, never as a mismatch.
 *
 * @param fetchChecks - The underlying check fetch.
 * @param required - Required check names.
 * @param pins - Required-name to app/workflow pin.
 * @returns The same fetch, retried once on incomplete identity.
 * @task T13017
 */
export function refetchIncompleteIdentity(
  fetchChecks: NonNullable<ResolveCiEvidenceOptions['fetchChecks']>,
  required: readonly string[],
  pins: Record<string, RequiredCheckPinSpec>,
): NonNullable<ResolveCiEvidenceOptions['fetchChecks']> {
  return async (sha, cwd) => {
    const first = await fetchChecks(sha, cwd);
    if (!first.ok || !hasIncompleteIdentity(first.checks, required, pins)) return first;
    return fetchChecks(sha, cwd);
  };
}

/**
 * Drop runs a schedule started from every fetch (T13623). A nightly run that
 * happens to land on a merge commit tests main at that hour, not the merge:
 * only the merge commit's push run, a tree-equal PR head's pull_request run or
 * a later main commit's push run (T12742) decides the verdict.
 *
 * @param fetchChecks - The underlying check fetch.
 * @returns The same fetch, minus `schedule` runs and their check runs.
 * @task T13623
 */
export function withoutScheduledRuns(
  fetchChecks: NonNullable<ResolveCiEvidenceOptions['fetchChecks']>,
): NonNullable<ResolveCiEvidenceOptions['fetchChecks']> {
  return async (sha, cwd) => {
    const fetched = await fetchChecks(sha, cwd);
    return fetched.ok
      ? { ok: true, checks: fetched.checks.filter((c) => c.event !== 'schedule') }
      : fetched;
  };
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
  const bySuite = new Map<
    number,
    { event?: string; path?: string; attempt?: number; startedAt?: string }
  >();
  for (const r of wf.workflow_runs ?? []) {
    const event = typeof r.event === 'string' ? r.event : undefined;
    const path = typeof r.path === 'string' ? r.path.replace(/@.*$/, '') : undefined;
    const attempt = typeof r.run_attempt === 'number' ? r.run_attempt : undefined;
    const startedAt = typeof r.run_started_at === 'string' ? r.run_started_at : undefined;
    if (typeof r.check_suite_id === 'number')
      bySuite.set(r.check_suite_id, { event, path, attempt, startedAt });
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
      ...(attempt !== undefined ? { runAttempt: attempt } : {}),
      ...(startedAt ? { startedAt } : {}),
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
      const startedAt = typeof r.started_at === 'string' ? r.started_at : undefined;
      // A job started before its workflow's latest attempt belongs to an earlier one.
      const attempt =
        origin?.attempt !== undefined &&
        startedAt &&
        origin.startedAt &&
        Date.parse(startedAt) >= Date.parse(origin.startedAt)
          ? origin.attempt
          : undefined;
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
        ...(attempt !== undefined ? { runAttempt: attempt } : {}),
        ...(startedAt ? { startedAt } : {}),
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
  // T14032: a workspace-wide current-HEAD stand-in consulted main's push runs only.
  if (!head && !atom.mainOnly && !atom.workspaceWide) {
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
  // T13453: an inherited failure must still be a failure on the base it came
  // from; a base re-run that went green means the PR may have introduced it.
  for (const job of atom.inheritedFailures ?? []) {
    const fetched = await fetchChecks(job.baseSha, cwd);
    if (!fetched.ok) {
      return {
        ok: false,
        reason: `cannot re-check ci:${atom.prNumber} on base ${job.baseSha.slice(0, 12)}: ${fetched.reason}`,
      };
    }
    const latest = fetched.checks
      .filter((r) => r.name === job.name && r.headSha === job.baseSha && r.id >= job.baseRunId)
      .sort((x, y) => y.id - x.id)[0];
    if (latest?.conclusion === 'success') {
      return {
        ok: false,
        reason: `${job.name}: now success on base ${job.baseSha.slice(0, 12)}, so the merge commit's failure was not inherited — ci:${atom.prNumber} no longer holds; verify again`,
      };
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
  const unlinked = checkPrTaskLinkage(linked.prNumber, linked.pr, context, pr.mergedAt);
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
  // T13757: no required check means CI vouches for nothing, whatever
  // evidence.ciSatisfies says; never accept that as a test or QA result.
  if (required.workflows.length === 0) {
    return {
      ok: false,
      codeName: 'E_EVIDENCE_CI_VACUOUS',
      reason:
        `ci:${prNumber} would vouch for zero checks: the required-workflow set (${describeRequiredWorkflowsSource(required.source)}) is empty, ` +
        'so merged CI proves nothing about this change. Record a targeted result instead: test-run:<report> or ' +
        'tool:test-affected for testsPassed, qa-run:<receipt> or tool:lint;tool:typecheck for qaPassed ' +
        '(tool:config-schema for a change to CLEO config only), or declare the required checks in release.prRequiredWorkflows.',
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

  const fetchChecks = refetchIncompleteIdentity(
    withoutScheduledRuns(opts.fetchChecks ?? defaultFetchChecks),
    required.workflows,
    pins,
  );
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
  let descendant:
    | {
        sha: string;
        range: string;
        prHeadSha?: string;
        inherited?: InheritedFailure[];
        nonTest?: Array<{ name: string; mergeRunId: number }>;
        untested?: UntestedJobFailure[];
        passedOver?: PassedOverRun[];
      }
    | undefined;
  let descendantReason: string | undefined;
  // T13846: a code task's gates need their jobs to have run, so the stand-in
  // must be a later main run where they did — not merely the first one whose
  // required checks are green (a scripts-only merge skips the test jobs).
  const docsOnlyDiff = pr.changedPaths.length > 0 && pr.changedPaths.every(isCiDocumentPath);
  const jobSpecs = docsOnlyDiff ? [] : gateJobSpecs(gateLists, roots.storeRoot, pins);
  if (!judgedChecks.ok && onDefault.ref !== null) {
    const found = await findGreenDescendant({
      ...(jobSpecs.length > 0 ? { jobs: jobSpecs } : {}),
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
      firstParentOf: opts.firstParentOf ?? defaultFirstParentOf,
      fetchJobLog: opts.fetchJobLog ?? defaultFetchJobLog,
      nextMainCommitAt: opts.nextMainCommitAt ?? defaultNextMainCommitAt,
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
          ...(found.inherited || found.nonTest || found.untested
            ? { inheritedFailures: true }
            : {}),
        },
      );
      if (rejudged.ok) {
        checks = withDescendant;
        judgedChecks = rejudged;
        descendant = {
          sha: found.sha,
          range: found.range,
          ...(found.prHeadSha ? { prHeadSha: found.prHeadSha } : {}),
          ...(found.inherited ? { inherited: found.inherited } : {}),
          ...(found.nonTest ? { nonTest: found.nonTest } : {}),
          ...(found.untested ? { untested: found.untested } : {}),
          ...(found.passedOver ? { passedOver: found.passedOver } : {}),
        };
      } else {
        descendantReason = `later commit ${found.sha.slice(0, 12)} was green, but re-judging with it still fails: ${rejudged.reasons.join('; ')}`;
      }
    } else {
      descendantReason = found.reason;
    }
  }
  // T14032 (owner decision D11192): a workspace-wide change, which only a full
  // run speaks for, is stood in for by a green push run of every required
  // check on the default branch's current head, descending from the merge,
  // whatever the merge's own run concluded and whatever later commits touched:
  // that run tested the merged change as it is now (as the T13673 test-run
  // stand-in does). A scoped change keeps the T12742 rule alone.
  let workspaceWide: string | undefined;
  let currentHeadReason: string | undefined;
  if (!judgedChecks.ok && onDefault.ref !== null && !docsOnlyDiff) {
    const wide = await (opts.workspaceWideReason ?? defaultWorkspaceWideReason)(
      cwd,
      pr.changedPaths,
    );
    if (wide !== null) {
      const found = await findGreenCurrentHead({
        ...(jobSpecs.length > 0 ? { jobs: jobSpecs } : {}),
        required: required.workflows,
        mergeCommitSha: pr.mergeCommitSha,
        pins,
        ref: onDefault.ref,
        cwd,
        fetchChecks,
        defaultBranchHead: opts.defaultBranchHead ?? defaultBranchHeadOf,
        changedBetween: opts.changedBetween ?? defaultChangedBetween,
        firstParentOf: opts.firstParentOf ?? defaultFirstParentOf,
        isAncestor: opts.isAncestor ?? defaultIsAncestor,
      });
      const rejudged = found.ok
        ? evaluateMergeCommitChecks(
            required.workflows,
            [...checks, ...found.checks],
            pr.mergeCommitSha,
            {
              ...(treeEqualHead ? { treeEquivalentSha: treeEqualHead } : {}),
              pins,
              descendantSha: found.sha,
              currentHead: true,
            },
          )
        : null;
      if (found.ok && rejudged?.ok) {
        checks = [...checks, ...found.checks];
        judgedChecks = rejudged;
        descendant = { sha: found.sha, range: found.range };
        workspaceWide = wide;
      } else {
        const why = found.ok
          ? `${found.sha.slice(0, 12)} was green, but re-judging with it still fails: ${rejudged && !rejudged.ok ? rejudged.reasons.join('; ') : ''}`
          : found.reason;
        currentHeadReason = `the change is workspace-wide (${wide}), so a green push run of the required checks on the current ${onDefault.ref} HEAD would stand in (T14032), but ${why}`;
      }
    }
  }
  if (!judgedChecks.ok) {
    const waiting = judgedChecks.reasons.some((r) => /pending|not found|missing/.test(r));
    const merge12 = pr.mergeCommitSha.slice(0, 12);
    // T14042: the decisive reason and the next step lead; the detail follows,
    // so a truncated refusal still says what to do.
    const lead = mainOnly
      ? `PR #${prNumber} edits the pinned workflow ${editedWorkflows.join(', ')}, so only main's push CI attests it (T13174)` +
        (waiting
          ? `: wait for the push run on ${merge12} (or a later main commit) to finish, then verify again. No local run is needed.`
          : `, and it is not green: ${judgedChecks.reasons[0]}.`)
      : `Required CI on PR #${prNumber}'s merge commit ${merge12} is not green: ${judgedChecks.reasons[0]}` +
        (waiting ? '; wait for it to finish, then verify again.' : '.');
    return {
      ok: false,
      codeName: 'E_EVIDENCE_TESTS_FAILED',
      reason:
        `${lead}\n  Required checks (source: ${describeRequiredWorkflowsSource(required.source)}):\n  - ${judgedChecks.reasons.join('\n  - ')}` +
        (descendantReason ? `\n  No later main run stands in: ${descendantReason}` : '') +
        (currentHeadReason ? `\n  No current-HEAD run stands in: ${currentHeadReason}` : ''),
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
  const isCode = !docsOnlyDiff;
  const jobsByGate: Record<string, string[]> = {};
  const fetchJobLog = opts.fetchJobLog ?? defaultFetchJobLog;
  let mergeNonTest: NonTestFailuresResult | undefined;
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
      if (!judgedJobs.ok) {
        // T13809: a job red only on the quarantine budget ran every test and
        // they all passed; for this gate it ran and succeeded.
        mergeNonTest ??= descendant?.nonTest
          ? { ok: true, jobs: descendant.nonTest }
          : await nonTestFailuresOn(
              checks,
              pr.mergeCommitSha,
              required.workflows,
              pins,
              fetchJobLog,
              cwd,
            );
        if (mergeNonTest.ok) {
          const passed = new Set(mergeNonTest.jobs.map((j) => j.mergeRunId));
          const asRun = checks.map((c) => (passed.has(c.id) ? { ...c, conclusion: 'success' } : c));
          const onMerge = evaluateJobs(globs, asRun, pr.mergeCommitSha, scope);
          if (onMerge.ok) judgedJobs = onMerge;
        }
      }
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
      // T13175: required jobs skipped by their change filter, with every
      // changed path covered by a declared job that ran and succeeded.
      const rules = readCiChecks(roots.storeRoot).covering?.[g.key];
      let coverNote = '';
      if (!judgedJobs.ok && rules && rules.length > 0) {
        const covered = evaluateCoveringJobs(
          globs,
          rules,
          pr.changedPaths,
          checks,
          descendant?.sha ?? pr.mergeCommitSha,
          scope,
        );
        if (covered.ok) judgedJobs = covered;
        else coverNote = `\n  Covering jobs do not apply: ${covered.reason}`;
      }
      if (!judgedJobs.ok) {
        return {
          ok: false,
          codeName: 'E_EVIDENCE_TESTS_FAILED',
          reason:
            `${g.gate} for code task ${context.task.id} needs its jobs to have run on PR #${prNumber}:\n  - ` +
            judgedJobs.reasons.join('\n  - ') +
            coverNote,
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
            ...(descendant.inherited ? { inheritedFailures: descendant.inherited } : {}),
            ...(descendant.nonTest ? { nonTestFailures: descendant.nonTest } : {}),
            ...(descendant.untested ? { untestedFailures: descendant.untested } : {}),
            ...(descendant.passedOver ? { passedOverRuns: descendant.passedOver } : {}),
          }
        : {}),
      ...(workspaceWide ? { workspaceWide } : {}),
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
