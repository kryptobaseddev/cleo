/**
 * Release Domain Operations (7 operations)
 *
 * All mutate operations
 *
 * Shared-surface taxonomy (T10483): this file also defines the contract that
 * keeps shipped CLEO release commands and generated workflow templates aligned.
 * The contract is intentionally data-only so downstream validators can assert
 * the release pipeline without importing @cleocode/core or @cleocode/cleo.
 */

/**
 * Common release types
 */
export type ReleaseType = 'major' | 'minor' | 'patch';

export interface ReleaseGate {
  name: string;
  description: string;
  passed: boolean;
  reason?: string;
}

// ── T10483: release shared-surface command/template contract ────────────────

/**
 * Release-surface taxonomy used by T10468/T10476 to distinguish shipped CLEO
 * consumer tooling, cleocode dogfood-only repository workflows, and contracts
 * that are shared by both surfaces.
 */
export type ReleaseSurfaceAudience =
  | 'shipped-consumer-tooling'
  | 'cleocode-dogfood-workflow'
  | 'shared-surface';

/** Stability expectation for a release surface. */
export type ReleaseSurfaceStability = 'public-contract' | 'internal-template';

/** CLI or dispatch entry point participating in the release shared surface. */
export interface ReleaseCommandSurfaceContract {
  /** Human-facing command form, e.g. `cleo release plan`. */
  command: string;
  /** Dispatch gateway used by the shipped CLI command. */
  gateway: 'query' | 'mutate' | 'pipeline';
  /** Dispatch domain and operation, e.g. `release.plan`. */
  operation: string;
  /** Surface audience classification for release-product taxonomy. */
  audience: ReleaseSurfaceAudience;
  /** Compatibility/stability promise. */
  stability: ReleaseSurfaceStability;
  /** True when the command may write local deterministic state. */
  writesLocalState: boolean;
  /** True when the command may call GitHub/npm/network services. */
  mayCallNetwork: boolean;
  /** True when an LLM call may block success. MUST remain false for release surfaces. */
  llmBlockingPath: false;
  /** True when identical inputs and repo state yield the same release artifact. */
  deterministic: boolean;
  /** True when this surface must be covered by a changeset before release. */
  changesetRequired: boolean;
}

/** Generated workflow template participating in the release shared surface. */
export interface ReleaseTemplateSurfaceContract {
  /** Template path in the source tree. */
  template: string;
  /** Rendered workflow filename installed into consumer repositories. */
  renderedWorkflow: string;
  /** Owning/recovering command that operators use for this workflow. */
  owningCommand: string;
  /** Surface audience classification for release-product taxonomy. */
  audience: ReleaseSurfaceAudience;
  /** Compatibility/stability promise. */
  stability: ReleaseSurfaceStability;
  /** True when template execution may call GitHub/npm/network services. */
  mayCallNetwork: boolean;
  /** True when an LLM call may block success. MUST remain false for release surfaces. */
  llmBlockingPath: false;
  /** True when the template consumes a precomputed deterministic plan. */
  consumesReleasePlan: boolean;
  /** True when template drift must be snapshot/render tested. */
  renderSnapshotRequired: boolean;
}

/**
 * Shipped release commands that form the public/operator contract.  The first
 * verb, `plan`, is deliberately deterministic and network-free: release
 * planning must be a changesets-first local computation, not an LLM-first or
 * GitHub-first blocking path.
 */
export const RELEASE_SHARED_COMMAND_SURFACES = [
  {
    command: 'cleo release plan',
    gateway: 'mutate',
    operation: 'release.plan',
    audience: 'shared-surface',
    stability: 'public-contract',
    writesLocalState: true,
    mayCallNetwork: false,
    llmBlockingPath: false,
    deterministic: true,
    changesetRequired: true,
  },
  {
    command: 'cleo release open',
    gateway: 'mutate',
    operation: 'release.open',
    audience: 'shared-surface',
    stability: 'public-contract',
    writesLocalState: true,
    mayCallNetwork: true,
    llmBlockingPath: false,
    deterministic: false,
    changesetRequired: true,
  },
  {
    command: 'cleo release reconcile',
    gateway: 'mutate',
    operation: 'release.reconcile',
    audience: 'shared-surface',
    stability: 'public-contract',
    writesLocalState: true,
    mayCallNetwork: true,
    llmBlockingPath: false,
    deterministic: true,
    changesetRequired: true,
  },
  {
    command: 'cleo release rollback',
    gateway: 'pipeline',
    operation: 'pipeline.release.rollback',
    audience: 'shipped-consumer-tooling',
    stability: 'public-contract',
    writesLocalState: true,
    mayCallNetwork: false,
    llmBlockingPath: false,
    deterministic: true,
    changesetRequired: true,
  },
] as const satisfies readonly ReleaseCommandSurfaceContract[];

/** Workflow templates that must stay in parity with the release command surface. */
export const RELEASE_SHARED_TEMPLATE_SURFACES = [
  {
    template: 'packages/core/templates/workflows/release-prepare.yml.tmpl',
    renderedWorkflow: 'release-prepare.yml',
    owningCommand: 'cleo release open',
    audience: 'shared-surface',
    stability: 'public-contract',
    mayCallNetwork: true,
    llmBlockingPath: false,
    consumesReleasePlan: true,
    renderSnapshotRequired: true,
  },
  {
    template: 'packages/core/templates/workflows/release-publish.yml.tmpl',
    renderedWorkflow: 'release-publish.yml',
    owningCommand: 'cleo release reconcile',
    audience: 'shared-surface',
    stability: 'public-contract',
    mayCallNetwork: true,
    llmBlockingPath: false,
    consumesReleasePlan: true,
    renderSnapshotRequired: true,
  },
  {
    template: 'packages/core/templates/workflows/release-rollback.yml.tmpl',
    renderedWorkflow: 'release-rollback.yml',
    owningCommand: 'cleo release rollback',
    audience: 'cleocode-dogfood-workflow',
    stability: 'internal-template',
    mayCallNetwork: true,
    llmBlockingPath: false,
    consumesReleasePlan: false,
    renderSnapshotRequired: true,
  },
  {
    template: 'packages/core/templates/workflows/release-fanout.yml.tmpl',
    renderedWorkflow: 'release-fanout.yml',
    owningCommand: 'cleo release plan',
    audience: 'cleocode-dogfood-workflow',
    stability: 'internal-template',
    mayCallNetwork: true,
    llmBlockingPath: false,
    consumesReleasePlan: true,
    renderSnapshotRequired: true,
  },
] as const satisfies readonly ReleaseTemplateSurfaceContract[];

/** All commands/templates that share the release-product contract. */
export const RELEASE_SHARED_SURFACE_CONTRACT = {
  commands: RELEASE_SHARED_COMMAND_SURFACES,
  templates: RELEASE_SHARED_TEMPLATE_SURFACES,
  invariants: {
    deterministicPlanningCommand: 'cleo release plan',
    llmBlockingPathAllowed: false,
    changesetRequiredForPublicCommands: true,
  },
} as const;

/**
 * Mutate Operations
 */

// release.prepare
/**
 * Parameters for `release.prepare`.
 *
 * @remarks
 * Re-synced to match `prepareRelease(version, tasks?, notes?)` in
 * `packages/core/src/release/release-manifest.ts`. The legacy `type` field
 * was never accepted by the engine — the release manifest persists the
 * version as-is after normalization. Task filtering happens via the
 * optional `tasks` array (defaults to all tasks with `status=done`).
 *
 * @task T963 — contract↔impl drift reconciliation (T910 audit)
 */
export interface ReleasePrepareParams {
  /** Version string (e.g. `YYYY.M.patch` or `X.Y.Z`). @task T963 */
  version: string;
  /**
   * Specific task IDs to bundle into the release. When omitted, all
   * completed tasks with `completedAt` are included.
   * @task T963
   */
  tasks?: string[];
  /** Free-form release notes persisted onto the manifest entry. @task T963 */
  notes?: string;
}
/** Result of `release.prepare`. @task T963 */
export interface ReleasePrepareResult {
  /** Normalized version string. @task T963 */
  version: string;
  /** Manifest status — always `'prepared'` on success. @task T963 */
  status: string;
  /** Task IDs committed to the manifest. @task T963 */
  tasks: string[];
  /** Count of tasks in the release. @task T963 */
  taskCount: number;
}

// release.commit
/** Parameters for `release.commit`. @task T963 */
export interface ReleaseCommitParams {
  /** Version tag being committed. @task T963 */
  version: string;
  /** Files associated with the commit. @task T963 */
  files?: string[];
}
/** Result of `release.commit`. @task T963 */
export interface ReleaseCommitResult {
  /** Version. @task T963 */
  version: string;
  /** Git commit hash. @task T963 */
  commitHash: string;
  /** Commit message. @task T963 */
  message: string;
  /** Files actually committed. @task T963 */
  filesCommitted: string[];
}

// release.tag
/** Parameters for `release.tag`. @task T963 */
export interface ReleaseTagParams {
  /** Version being tagged. @task T963 */
  version: string;
  /** Tag message (annotated tag). @task T963 */
  message?: string;
}
/** Result of `release.tag`. @task T963 */
export interface ReleaseTagResult {
  /** Version. @task T963 */
  version: string;
  /** Tag name created. @task T963 */
  tagName: string;
  /** ISO 8601 creation timestamp. @task T963 */
  created: string;
}

// release.push
/** Parameters for `release.push`. @task T963 */
export interface ReleasePushParams {
  /** Version being pushed. @task T963 */
  version: string;
  /** Git remote name. Defaults to `origin`. @task T963 */
  remote?: string;
}
/** Result of `release.push`. @task T963 */
export interface ReleasePushResult {
  /** Version. @task T963 */
  version: string;
  /** Remote that received the push. @task T963 */
  remote: string;
  /** ISO 8601 push timestamp. @task T963 */
  pushed: string;
  /** Tags that were pushed alongside. @task T963 */
  tagsPushed: string[];
}

// release.gates.run
/** Parameters for `release.gates.run`. @task T963 */
export interface ReleaseGatesRunParams {
  /** Specific gate names to run. Omit to run all. @task T963 */
  gates?: string[];
}
/** Result of `release.gates.run`. @task T963 */
export interface ReleaseGatesRunResult {
  /** Total gates evaluated. @task T963 */
  total: number;
  /** Gates that passed. @task T963 */
  passed: number;
  /** Gates that failed. @task T963 */
  failed: number;
  /** Full per-gate report. @task T963 */
  gates: ReleaseGate[];
  /** True when every gate passed. @task T963 */
  canRelease: boolean;
}

// release.rollback
/** Parameters for `release.rollback`. @task T963 */
export interface ReleaseRollbackParams {
  /** Version to roll back. @task T963 */
  version: string;
  /** Human-readable reason for the rollback. @task T963 */
  reason: string;
}
/** Result of `release.rollback`. @task T963 */
export interface ReleaseRollbackResult {
  /** Version that was rolled back. @task T963 */
  version: string;
  /** ISO 8601 rollback timestamp. @task T963 */
  rolledBack: string;
  /** Version that is now current. @task T963 */
  restoredVersion: string;
  /** Rollback reason. @task T963 */
  reason: string;
}

// ── RELEASE-03: IVTR gate check ──────────────────────────────────────────────

/**
 * Parameters for `release.gate` — checks all IVTR loops in a release epic
 * have reached the `released` phase before allowing `release.ship`.
 *
 * @task T820 RELEASE-03
 * @task T1416
 */
export interface ReleaseGateCheckParams {
  /** Epic ID whose child tasks should be inspected. */
  epicId: string;
  /**
   * Bypass the IVTR gate — requires explicit owner confirmation.
   * When true, the gate check is skipped and a loud warning is emitted.
   */
  force?: boolean;
}

/** A single task's IVTR phase status as reported by `release.gate`. */
export interface IvtrTaskStatus {
  /** Task ID. */
  taskId: string;
  /**
   * Current IVTR phase, or `null` when no IVTR loop has been started for
   * this task (task is "unchecked").
   */
  currentPhase: 'implement' | 'validate' | 'test' | 'released' | null;
  /** Whether the task blocks release (`true` = blocking). */
  blocking: boolean;
}

/**
 * Result of `release.gate`.
 *
 * @task T820 RELEASE-03
 * @task T1416
 */
export interface ReleaseGateCheckResult {
  /** Epic ID that was inspected. */
  epicId: string;
  /** Whether the gate passed — all tasks are released or unchecked. */
  passed: boolean;
  /** Whether the gate was bypassed via `--force`. */
  forcedBypass: boolean;
  /** Task IDs whose IVTR state is not `released` (blocking). */
  blocked: string[];
  /**
   * Task IDs with no IVTR state (non-blocking; docs / chore tasks often
   * have no IVTR loop).
   */
  unchecked: string[];
  /** Full per-task status breakdown. */
  tasks: IvtrTaskStatus[];
  /**
   * Human-readable summary suitable for CLI output and operator review.
   * Present on both pass and fail.
   */
  summary: string;
}

// ── RELEASE-07: IVTR → release auto-suggest ──────────────────────────────────

/**
 * Result emitted by `release.ivtr-suggest` — the hint produced when an IVTR
 * loop transitions to `released` and all tasks in the parent epic are now
 * in the `released` phase.
 *
 * @task T820 RELEASE-07
 * @task T1416
 */
export interface IvtrAutoSuggestResult {
  /** Task ID that just reached the `released` phase. */
  taskId: string;
  /** Parent epic ID, if the task belongs to one. */
  epicId: string | null;
  /** Whether every task in the epic has reached `released`. */
  epicFullyReleased: boolean;
  /**
   * Suggested next CLI command. Non-null only when `epicFullyReleased` is
   * true. Points the operator toward `cleo release ship`.
   */
  suggestedCommand: string | null;
  /** Human-readable message for operator guidance. */
  message: string;
}
