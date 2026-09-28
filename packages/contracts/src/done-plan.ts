/**
 * Contracts for the read-only `cleo done --plan` evidence planner.
 *
 * The planner derives, without executing a tool or writing a row, the
 * evidence `cleo done` would record for each required verification gate:
 * the implemented change set and where it came from, the tool runs and
 * whether each already has a fresh cached result, which acceptance criteria
 * map to evidence deterministically, and the blockers in the order an agent
 * must clear them.
 *
 * Spec: `verify-streamlined-design` §3.2 and §7 step 1-2.
 *
 * @task T12623
 * @task T12624
 */

import type { VerificationGate } from './task.js';

/**
 * Where a task's implemented change set was found, first match wins.
 *
 * - `pr` — a merged PR that cites the task; files read from its merge commit.
 * - `branch` — the unmerged task branch diffed against its merge-base with
 *   origin's default branch.
 * - `docs` — attached documents and linked decisions of a research, spike or
 *   documentation task.
 * - `none` — nothing references the task yet.
 */
export type ChangeSetSource = 'pr' | 'branch' | 'docs' | 'none';

/**
 * How the repository the change set was read from was chosen.
 *
 * - `declared` — `CLEO_EVIDENCE_GIT_ROOT`, `GIT_WORK_TREE` or
 *   `evidence.gitRoot`; outranks every inference.
 * - `invocation-worktree` — the caller's own worktree of this project.
 * - `task-worktree` — the task's registered worktree, used when invoked from
 *   the main checkout.
 * - `store` — the CLEO store root or its single child checkout.
 */
export type ChangeSetRootSource = 'declared' | 'invocation-worktree' | 'task-worktree' | 'store';

/** One concrete, runnable next step. */
export interface DoneNextStep {
  /** Shell command the agent runs next. */
  command: string;
  /** Why this step clears the blocker. */
  why: string;
}

/**
 * Blocker vocabulary, in the order the planner reports them.
 *
 * @see DONE_PLAN_BLOCKER_ORDER in core for the ranking.
 */
export type DonePlanBlockerCode =
  | 'git-root'
  | 'dirty-tree'
  | 'no-change-set'
  | 'pr-ambiguous'
  | 'pr-unverified'
  | 'pr-stacked'
  | 'pr-reverted'
  | 'merge-commit-missing'
  | 'decision-missing'
  | 'tool-unresolved'
  | 'tool-failed'
  | 'typed-gate-failed'
  | 'ac-mapping-needed'
  | 'manual-gate'
  | 'epic-rollup'
  | 'run-from-worktree'
  | 'checkout-required'
  | 'evidence-refused'
  | 'completion-refused';

/** A reason `cleo done` would stop, with exactly one next step. */
export interface DonePlanBlocker {
  /** Stable machine code. */
  code: DonePlanBlockerCode;
  /** Human-readable statement of what is missing. */
  message: string;
  /** The one next step that clears it. */
  next: DoneNextStep;
  /** Original evidence error code when the blocker wraps a validator refusal. */
  cause?: string;
}

/** A merged PR that cites the task. */
export interface ChangeSetPrCandidate {
  /** PR number. */
  prNumber: number;
  /** PR title. */
  title: string;
  /** Head branch the PR merged from. */
  headRefName: string;
}

/** A document attached to a research, spike or documentation task. */
export interface ChangeSetDoc {
  /** Attachment or blob identifier. */
  id: string;
  /** Stable slug, when the doc has one. */
  slug: string | null;
  /** Store-relative path of the bytes the `files:` atom will hash. */
  path: string;
}

/**
 * The implemented change set derived for one task.
 *
 * `implementedEvidence` is the atom string the existing ADR-051 validators
 * receive unchanged; there is no second validation path.
 */
export interface TaskChangeSet {
  /** Where the change set came from. */
  source: ChangeSetSource;
  /** Absolute path of the repository every git and gh call ran in. */
  executionRoot: string;
  /** Why {@link executionRoot} was chosen. */
  rootSource: ChangeSetRootSource;
  /** Merged PR number (`source === 'pr'`). */
  prNumber?: number;
  /**
   * Verified merge commit the files were read from (`source === 'pr'`). For a
   * stacked PR this is the BASE PR's merge into the default branch.
   */
  mergeCommitSha?: string;
  /**
   * Set when the task's PR merged into another branch (a stacked PR) and the
   * task is attributed to that branch's own PR once it reached the default
   * branch.
   */
  stackedOn?: { baseRef: string; basePrNumber?: number };
  /** Branch tip commit (`source === 'branch'`). */
  commitSha?: string;
  /** Ref that was diffed (`HEAD` or `task/<id>`), for `source === 'branch'`. */
  headRef?: string;
  /** Origin default branch the merge-base was taken against. */
  baseRef?: string;
  /** Merge-base commit between {@link baseRef} and {@link headRef}. */
  mergeBase?: string;
  /** Repo-relative paths that still exist in the change set (the `files:` atom). */
  files: string[];
  /** Repo-relative paths the change set deleted; listed in the receipt, never in `files:`. */
  deletedFiles: string[];
  /** Attached docs (`source === 'docs'`). */
  docs: ChangeSetDoc[];
  /** Decision IDs linked to the task (`source === 'docs'`). */
  decisions: string[];
  /** Every merged PR that cited the task, before disambiguation. */
  candidates: ChangeSetPrCandidate[];
  /**
   * D11151: the task's OTHER own-branch PRs when it shipped across several,
   * oldest first. Each is recorded as its own `implemented` attempt before the
   * primary (latest) PR, which is what the stored gate evidence ends up citing.
   */
  additionalPrs?: Array<{
    prNumber: number;
    mergeCommitSha?: string;
    files: string[];
    deletedFiles: string[];
    implementedEvidence: string | null;
  }>;
  /** Planned `implemented` atoms (without `satisfies:`), or null when none derive. */
  implementedEvidence: string | null;
  /** Blockers found while deriving the change set. */
  blockers: DonePlanBlocker[];
  /** Non-blocking observations, e.g. PR discovery that could not reach `gh`. */
  warnings: string[];
  /**
   * The merged-PR lookup failed (e.g. `gh` unavailable), so a non-PR change set
   * does not prove the change is unmerged (T12656).
   */
  prDiscoveryFailed?: boolean;
}

/** Planned state of one verification gate. */
export interface DonePlanGate {
  /** Gate name. */
  gate: VerificationGate;
  /** Whether the project's verification policy requires it. */
  required: boolean;
  /** Whether the task already has the gate recorded as passed. */
  passed: boolean;
  /** Planned `--evidence` string (with `satisfies:`), or null when nothing is planned. */
  evidence: string | null;
}

/**
 * Cache state of a tool run the plan needs.
 *
 * - `fresh-pass` / `fresh-fail` — an ADR-061 cache entry exists for the
 *   current HEAD, dirty fingerprint and execution root.
 * - `miss` — `cleo done` would run the tool.
 * - `not-applicable` — the resolver says the tool does not apply here.
 * - `unresolved` — no command resolves for the tool.
 */
export type DonePlanToolCacheState =
  | 'fresh-pass'
  | 'fresh-fail'
  | 'miss'
  | 'not-applicable'
  | 'unresolved';

/** One tool run a gate needs. The planner never executes it. */
export interface DonePlanToolRun {
  /** Canonical tool name used in the `tool:` atom. */
  tool: string;
  /** Gate the result satisfies. */
  gate: VerificationGate;
  /** Resolved command line, or null when unresolved. */
  command: string | null;
  /** Resolver source (`project-context`, `language-default`, …). */
  source: string | null;
  /** Cache state for the current tree. */
  cache: DonePlanToolCacheState;
  /** Cached exit code, when an entry exists. */
  exitCode?: number;
  /** When the cached result was captured. */
  capturedAt?: string;
  /** Resolver refusal reason, when unresolved or not applicable. */
  reason?: string;
}

/** Stored result of a typed acceptance gate. The planner never runs it. */
export interface DonePlanTypedGate {
  /** Criterion alias (`AC<n>`). */
  alias: string;
  /** Typed gate kind. */
  kind: string;
  /** Requirement id, when the gate declares one. */
  req?: string;
  /** Latest stored result; `not-run` when none is stored. */
  status: 'pass' | 'fail' | 'not-run';
}

/**
 * Why an acceptance criterion is (or is not) linked automatically.
 *
 * - `typed-gate` — the criterion is a typed gate with a stored passing result.
 * - `files-in-diff` — every repo path the criterion names is in the change set.
 * - `agent` — the agent named it with `--satisfies`.
 * - `recorded` — already linked by gate evidence the task has recorded.
 * - `none` — no deterministic coverage; the agent must answer.
 */
export type DonePlanAcBasis = 'typed-gate' | 'files-in-diff' | 'agent' | 'recorded' | 'none';

/** Mapping of one acceptance criterion to gate evidence. */
export interface DonePlanAcMapping {
  /** Criterion alias (`AC<n>`). */
  alias: string;
  /** Canonical criterion UUID. */
  id: string;
  /** Criterion text. */
  text: string;
  /** Whether the criterion is linked, by any {@link DonePlanAcBasis} other than `none`. */
  mapped: boolean;
  /** Gates whose planned evidence carries `satisfies:` for this criterion. */
  gates: VerificationGate[];
  /** Why it is or is not linked. */
  basis: DonePlanAcBasis;
  /** Repo paths the criterion names (for `files-in-diff` and its misses). */
  files?: string[];
}

/**
 * Result of `deriveTaskEvidence` / `cleo done <id> --plan`.
 *
 * Read-only by construction: the planner records nothing and executes no tool
 * or typed gate. `commands` are the calls `cleo done` would issue, spelled as
 * the existing verbs so every one is runnable today.
 */
export interface DonePlan {
  /** Task the plan is for. */
  taskId: string;
  /** Directory the commands must run from (the change set's execution root). */
  runFrom: string;
  /** The derived change set. */
  changeSet: TaskChangeSet;
  /** Every evidence gate the plan covers, required or already passed. */
  gates: DonePlanGate[];
  /** Tool runs the required gates need. */
  toolRuns: DonePlanToolRun[];
  /** Typed acceptance gates and their stored results. */
  typedGates: DonePlanTypedGate[];
  /** Per-criterion mapping. */
  acMapping: DonePlanAcMapping[];
  /** Aliases of criteria that need `--satisfies` from the agent. */
  needsSatisfies: string[];
  /** Blockers, ordered: the first is the one to clear first. */
  blockers: DonePlanBlocker[];
  /**
   * D11151: `implemented` evidence (with its criterion links) for each of the
   * task's earlier own-branch PRs, recorded as separate attempts before the
   * primary gate write.
   */
  additionalImplemented?: string[];
  /** Runnable commands, in order, that record the gates and complete the task. */
  commands: string[];
  /** True when no blocker remains and `commands` would succeed as planned. */
  ready: boolean;
  /** The single next step: the first blocker's, or the first command. */
  next: DoneNextStep | null;
}

/** One tool `cleo done` ran (or reused from the ADR-061 cache) before recording. */
export interface DoneToolResult {
  /** Canonical tool name. */
  tool: string;
  /** Gate the result satisfies. */
  gate: VerificationGate;
  /** Exit code of the run. */
  exitCode: number | null;
  /** Whether the result came from the ADR-061 cache. */
  cacheHit: boolean;
  /** Wall-clock duration of the run (0 for a cache hit). */
  durationMs: number;
}

/**
 * Successful `cleo done` / `cleo verify --auto` write: every required gate the
 * task lacked, recorded in one transaction through the existing validators.
 * Completion (for `cleo done`) is reported by the caller alongside it.
 */
export interface DoneRecordResult {
  /** Task the gates were recorded for. */
  taskId: string;
  /** Gates this call recorded, in gate order. */
  recordedGates: VerificationGate[];
  /** Required gates that were already passed and left untouched. */
  alreadyPassed: VerificationGate[];
  /** Tool runs performed or reused before the write. */
  toolResults: DoneToolResult[];
  /** Typed acceptance gates executed before the write (0 when the task has none). */
  typedGateCount: number;
  /** Whether all required gates are now passed. */
  verificationPassed: boolean;
  /** The plan the write was derived from. */
  plan: DonePlan;
}

/** Details of an `E_DONE_BLOCKED` failure: one blocker, one next step. */
export interface DoneBlockedDetails {
  /** The blocker that stopped `cleo done`. */
  blocker: DonePlanBlockerCode;
  /** Original error code (e.g. `E_EVIDENCE_TOOL_FAILED`), when one exists. */
  cause?: string;
  /** The one next step. */
  next: DoneNextStep;
  /** Gates already recorded before a completion refusal (empty otherwise). */
  recordedGates: VerificationGate[];
  /** The plan, for tooling. */
  plan: DonePlan;
}
