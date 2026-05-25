/**
 * Task type definitions matching todo.schema.json (v2.10.0).
 *
 * Consolidates types from src/types/task.ts and packages/contracts/src/task-types.ts.
 *
 * ## Type Safety Design
 *
 * - {@link Task} represents a fully-materialized task as stored in the database.
 *   Fields that CLEO's anti-hallucination rules require at runtime are marked as
 *   required (non-optional) so the type system enforces what the business rules demand.
 *
 * - {@link TaskCreate} represents the input for creating a new task. Only fields the
 *   caller MUST supply are required; everything else has sensible defaults applied
 *   by the `addTask` function.
 *
 * - {@link CompletedTask} and {@link CancelledTask} are discriminated union types
 *   that narrow `Task` for status-specific contexts where additional fields become
 *   required (e.g., `completedAt` is required when `status = 'done'`).
 *
 * @epic T4454
 * @task T4456
 */

import type { AcceptanceGate } from './acceptance-gate.js';
import type { TaskStatus } from './status-registry.js';

export type { TaskStatus };

/**
 * A single acceptance criterion — either a free-text string (legacy) or a
 * structured {@link AcceptanceGate} (machine-verifiable).
 *
 * Mixed arrays of these are stored as JSON in the `acceptance_json` column.
 *
 * @epic T760
 * @task T780
 * @task T800
 */
export type AcceptanceItem = string | AcceptanceGate;

/** Task priority levels. */
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';

/**
 * Task type in hierarchy.
 *
 * Per ADR-083 §2.5, `'saga'` is a first-class tier discriminator above
 * Epic — a Saga groups N Epics across multiple releases. Hierarchy is now
 * Saga (depth 0) → Epic (1) → Task (2) → Subtask (3), with `maxDepth=3`
 * preserved under each Saga member.
 *
 * @adr ADR-083 §2.5
 * @saga T10326
 * @task T10328
 */
export type TaskType = 'saga' | 'epic' | 'task' | 'subtask';

/**
 * Task kind axis — orthogonal to {@link TaskType}, describes the intent of work.
 * Defaults to `'work'` for backward compatibility.
 *
 * Note: DB column is named `role` (rename deferred per T9067 — CHECK constraint).
 * All TypeScript consumers use `kind`; the SQL-layer alias is handled in tasks-schema.ts.
 *
 * @task T944
 * @task T9072
 */
export type TaskKind = 'work' | 'research' | 'experiment' | 'bug' | 'spike' | 'release';

/**
 * Task scope axis — granularity of work. Orthogonal to {@link TaskType} and
 * {@link TaskKind}. Defaults to `'feature'`.
 *
 * Legacy type → scope mapping on backfill:
 * - `type='epic'`    → `scope='project'`
 * - `type='task'`    → `scope='feature'`
 * - `type='subtask'` → `scope='unit'`
 *
 * @task T944
 */
export type TaskScope = 'project' | 'feature' | 'unit';

/**
 * Severity axis. Orthogonal to {@link TaskKind}; valid severities may be set
 * on work/research/experiment/bug/spike/release tasks alike. The DB CHECK
 * constraint only validates membership in P0-P3.
 *
 * OWNER-WRITE-ONLY: severity is intended to be set through owner-authenticated
 * paths only. This prevents a prompt-injection exploit where a compromised
 * Tier 3 agent could downgrade a P0 bug to P3 to force-ship.
 *
 * @task T944
 * @task T10089
 */
export type TaskSeverity = 'P0' | 'P1' | 'P2' | 'P3';

/** Task size (scope, NOT time). */
export type TaskSize = 'small' | 'medium' | 'large';

/** Epic lifecycle states. */
export type EpicLifecycle = 'backlog' | 'planning' | 'active' | 'review' | 'released' | 'archived';

/** Task origin (provenance). T1899: added production/test-fixture/imported/migrated. */
export type TaskOrigin =
  | 'production'
  | 'test-fixture'
  | 'imported'
  | 'migrated'
  | 'internal'
  | 'bug-report'
  | 'feature-request'
  | 'security'
  | 'technical-debt'
  | 'dependency'
  | 'regression';

/** Canonical origin values for the T1899 CHECK constraint. */
export const TASK_ORIGIN_CANONICAL = [
  'production',
  'test-fixture',
  'imported',
  'migrated',
] as const satisfies readonly TaskOrigin[];

/** Whether an origin value is a test-fixture (should be excluded from live briefing). */
export function isTestFixtureOrigin(origin: string | null | undefined): boolean {
  return origin === 'test-fixture';
}

/** Verification agent types. */
export type VerificationAgent =
  | 'planner'
  | 'coder'
  | 'testing'
  | 'qa'
  | 'cleanup'
  | 'security'
  | 'docs';

/** Verification gate names. */
export type VerificationGate =
  | 'implemented'
  | 'testsPassed'
  | 'qaPassed'
  | 'cleanupDone'
  | 'securityPassed'
  | 'documented'
  /**
   * IVTR Breaking-Change Gate — blocks completion when task touches symbols
   * with CRITICAL nexus impact risk. Opt-in via `CLEO_NEXUS_IMPACT_GATE=1`.
   *
   * @task T1073
   * @epic T1042
   */
  | 'nexusImpact';

/** Verification failure log entry. */
export interface VerificationFailure {
  /** Verification round number when the failure occurred. */
  round: number;
  /** Agent that performed the verification and reported the failure. */
  agent: string;
  /** Human-readable description of why verification failed. */
  reason: string;
  /** ISO 8601 timestamp of when the failure was recorded. */
  timestamp: string;
}

/**
 * A single piece of evidence backing a verification gate.
 *
 * Evidence is validated at `cleo verify` write time (commits reachable, files
 * exist with matching sha256, tests pass, tools exit 0) and re-validated at
 * `cleo complete` time to catch post-verify tampering.
 *
 * @task T832
 * @adr ADR-051
 */
export type EvidenceAtom =
  | { kind: 'commit'; sha: string; shortSha: string }
  | { kind: 'files'; files: Array<{ path: string; sha256: string }> }
  | {
      kind: 'test-run';
      path: string;
      sha256: string;
      passCount: number;
      failCount: number;
      skipCount: number;
    }
  | { kind: 'tool'; tool: string; exitCode: number; stdoutTail: string }
  | { kind: 'url'; url: string }
  | { kind: 'note'; note: string }
  | { kind: 'override'; reason: string }
  | {
      /**
       * LOC-drop atom — proves that a migrated engine file shed at least a
       * configurable percentage of lines.  Required for `implemented` gate
       * when the task carries the `engine-migration` label.
       *
       * Format: `loc-drop:<from>:<to>`  (both values are line counts ≥ 0)
       *
       * @task T1604
       */
      kind: 'loc-drop';
      /** Line count before migration (wc -l of original file). */
      fromLines: number;
      /** Line count after migration (wc -l of migrated file). */
      toLines: number;
      /** Actual percentage reduction, rounded to two decimal places. */
      reductionPct: number;
    }
  | {
      /**
       * Callsite-coverage atom — proves that an exported symbol has ≥1
       * production callsite outside its own source file, test files, and
       * dist directories.  Required for the `implemented` gate whenever the
       * task carries the `callsite-coverage` label.  Catches the T1601
       * pattern where a function is shipped but never wired into production.
       *
       * Format: `callsite-coverage:<symbolName>:<relativeSourcePath>`
       *
       * - `symbolName` — The exported identifier (function, class, constant)
       *   to search for.
       * - `relativeSourcePath` — Source path relative to project root
       *   (excluded from the grep search so the definition itself is not
       *   counted as a callsite).
       *
       * @task T1605
       */
      kind: 'callsite-coverage';
      /** Exported identifier that must appear in a production callsite. */
      symbolName: string;
      /**
       * Source file path relative to project root (definition file, excluded
       * from callsite search).
       */
      relativeSourcePath: string;
      /** Number of production callsite hits found by ripgrep. */
      hitCount: number;
    }
  | {
      /**
       * Decision atom — proves a decision-only task by referencing the
       * brain_decisions row that IS the canonical artifact.
       *
       * Eliminates the need for `CLEO_OWNER_OVERRIDE` on decision-only
       * completion paths (owner directive 2026-05-05 "overrides are a crutch").
       *
       * Used alongside `files:` pointing to a research note to satisfy the
       * `implemented` gate for tasks where the deliverable is a recorded
       * decision rather than a code change.
       *
       * Format: `decision:<D-id>` (e.g. `decision:D-arch-001`)
       *
       * Validation: CLEO checks the `brain_decisions` row exists with
       * `confirmation_state` in (`accepted`, `proposed`).
       *
       * @task T1875
       * @epic T1824
       */
      kind: 'decision';
      /**
       * The canonical decision ID from `brain_decisions.id`
       * (e.g. `"D-arch-001"`, `"AGT-abc123"`).
       */
      decisionId: string;
    }
  | {
      /**
       * Pull-request atom — proves that a referenced GitHub PR shipped to
       * the project's primary branch with CI green.
       *
       * Closes the release-verb dogfood gap (T9764): tasks that ship via the
       * standard PR + admin-merge flow lacked a zero-friction way to record
       * `testsPassed` / `qaPassed` evidence after the fact. Re-running
       * `tool:test` against the entire monorepo is overkill for one-line
       * tasks, and `note:` is rejected for hard gates on critical
       * verifications.
       *
       * A `pr:<number>` atom satisfies BOTH `testsPassed` and `qaPassed`
       * simultaneously when:
       *   1. `state === 'MERGED'` (PR was actually shipped to main)
       *   2. `mergedAt` is non-null (defends against API races)
       *   3. The status-check rollup contains ≥1 SUCCESS check and zero
       *      FAILURE checks in the required workflows
       *      (`CI`, `Lockfile Check`, `Contracts Dep Lint`)
       *
       * Format: `pr:<positive integer>` (e.g. `pr:357`)
       *
       * Validation: CLEO calls `gh pr view <num> --json
       * statusCheckRollup,mergeable,state,mergedAt,headRefOid` and parses
       * the rollup. Results are cached under
       * `.cleo/cache/evidence/pr-<num>.json` keyed on `(prNumber, mergedAt)`
       * so re-verifies skip the network round trip.
       *
       * @task T9764
       * @epic T9762
       * @saga T9758
       */
      kind: 'pr';
      /** PR number (positive integer). */
      prNumber: number;
      /** Merge commit SHA (full 40-char hex) — captured at validate time. */
      mergeCommitSha: string;
      /** ISO 8601 timestamp when the PR was merged. */
      mergedAt: string;
      /** Number of `SUCCESS` checks across all required workflows. */
      successCount: number;
      /** Total number of checks evaluated in the rollup. */
      totalChecks: number;
    }
  | {
      /**
       * Satisfies atom — cross-task acceptance-criterion binding per
       * ADR-079-r2.
       *
       * Carries the parsed form (one of `targetAcId` UUID or
       * `targetAcAlias` `AC<digits>` will be populated; optional
       * `versionPin` captures the target AC's `updated_at` at mint time)
       * plus the validator-canonical `resolvedAcUuid` populated by the
       * T10507 5-check pipeline (target exists, not terminal, AC exists,
       * same-saga scope). T10506 only ships the parser — the validated
       * form is reserved here so consumers of `EvidenceAtom` (sentinel
       * tables, gate-checkers, audit logs) can pattern-match on
       * `kind === 'satisfies'` from day one.
       *
       * Format: `satisfies:<task-id>#<ac-id>[@<version-pin>]`
       *   - `satisfies:T1234#a1b2c3d4-5e6f-4890-abcd-ef1234567890` (UUID)
       *   - `satisfies:T1234#AC2`                                  (alias)
       *   - `satisfies:T1234#AC2@20260524223045`                   (pin)
       *
       * @task T10506
       * @adr ADR-079-r2
       */
      kind: 'satisfies';
      /** Target task ID — `T<1-7 digits>` per ADR-079-r2 §2.1. */
      targetTaskId: string;
      /** Lowercase UUIDv4 — populated for canonical form; undefined for alias form. */
      targetAcId?: string;
      /** `AC<1-4 digits>` alias — populated for alias form; undefined for UUID form. */
      targetAcAlias?: string;
      /** Optional `@<YYYYMMDDhhmmss>` pin captured at mint time. */
      versionPin?: string;
      /**
       * Canonical UUID resolved by the T10507 validator from `targetAcId`
       * (already canonical) or by looking up `(targetTaskId, alias-ordinal)`.
       * Reserved here for forward compatibility; undefined under T10506.
       */
      resolvedAcUuid?: string;
    };

/**
 * Evidence backing a single verification gate.
 *
 * @task T832
 * @adr ADR-051
 */
export interface GateEvidence {
  /** One or more evidence atoms supporting this gate. */
  atoms: EvidenceAtom[];
  /** ISO 8601 timestamp of when evidence was captured. */
  capturedAt: string;
  /** Agent identifier that captured the evidence. */
  capturedBy: string;
  /**
   * True when CLEO_OWNER_OVERRIDE was used to bypass evidence validation.
   * Override evidence MUST NOT be re-validated at complete time.
   * @defaultValue undefined (false)
   */
  override?: boolean;
  /** Reason given for an override (`CLEO_OWNER_OVERRIDE_REASON` env). */
  overrideReason?: string;
}

/** Task verification state. */
export interface TaskVerification {
  /** Whether all required verification gates have passed. */
  passed: boolean;
  /** Current verification round number (starts at 1). */
  round: number;
  /** Gate pass/fail/pending status for each verification gate. */
  gates: Partial<Record<VerificationGate, boolean | null>>;
  /**
   * Evidence backing each gate.  Populated by `cleo verify --evidence …` and
   * re-validated at `cleo complete` time (T832 / ADR-051).
   * @defaultValue undefined
   */
  evidence?: Partial<Record<VerificationGate, GateEvidence>>;
  /** The last agent that performed a verification check, or `null`. */
  lastAgent: VerificationAgent | null;
  /** ISO 8601 timestamp of the most recent verification update, or `null`. */
  lastUpdated: string | null;
  /** Ordered log of all verification failures across rounds. */
  failureLog: VerificationFailure[];
  /**
   * ISO timestamp set when verification was first initialized on task creation (T061).
   * @defaultValue undefined
   */
  initializedAt?: string | null;
}

/** Task provenance tracking. */
export interface TaskProvenance {
  /** Agent or user that created this task, or `null` if unknown. */
  createdBy: string | null;
  /** Agent or user that last modified this task, or `null` if unknown. */
  modifiedBy: string | null;
  /** Session ID during which this task was created, or `null`. */
  sessionId: string | null;
}

/** A single task relation entry. */
export interface TaskRelation {
  /** ID of the related task. */
  taskId: string;
  /** Relation type (e.g. `"blocks"`, `"related-to"`, `"duplicates"`). */
  type: string;
  /**
   * Optional reason explaining the relationship.
   * @defaultValue undefined
   */
  reason?: string;
}

/**
 * A single CLEO task as stored in the database.
 *
 * Fields marked as required are enforced by CLEO's anti-hallucination validation
 * at runtime. Making them required here ensures the type system catches violations
 * at compile time rather than deferring to runtime checks.
 */
export interface Task {
  /** Unique task identifier. Must match pattern `T\d{3,}` (e.g., T001, T5800). */
  id: string;

  /** Human-readable task title. Required, max 120 characters. */
  title: string;

  /**
   * Task description. **Required** — CLEO's anti-hallucination rules reject tasks
   * without a description, and require it to differ from the title.
   */
  description: string;

  /** Current task status. Must be a valid {@link TaskStatus} enum value. */
  status: TaskStatus;

  /** Task priority level. Defaults to `'medium'` on creation. */
  priority: TaskPriority;

  /** Task type in hierarchy. Inferred from parent context if not specified. @defaultValue undefined */
  type?: TaskType;

  /**
   * Task kind axis — intent of work, orthogonal to {@link type}.
   * Defaults to `'work'` at the DB level. DB column is named `role` (T9067 deferral).
   * @defaultValue 'work'
   * @task T944
   * @task T9072
   */
  kind?: TaskKind;

  /**
   * Task scope axis — granularity of work, orthogonal to {@link type} and
   * {@link kind}. Defaults to `'feature'` at the DB level. @defaultValue 'feature'
   * @task T944
   */
  scope?: TaskScope;

  /**
   * Severity axis. Valid for any {@link kind}. OWNER-WRITE-ONLY.
   * @defaultValue undefined
   * @task T944
   */
  severity?: TaskSeverity | null;

  /** ID of the parent task. `null` for root-level tasks. @defaultValue undefined */
  parentId?: string | null;

  /** Sort position within sibling scope. @defaultValue undefined */
  position?: number | null;

  /** Optimistic concurrency version for position changes. @defaultValue undefined */
  positionVersion?: number;

  /** Relative scope sizing (small/medium/large). NOT a time estimate. @defaultValue undefined */
  size?: TaskSize | null;

  /** Phase slug this task belongs to. @defaultValue undefined */
  phase?: string;

  /** File paths associated with this task. @defaultValue undefined */
  files?: string[];

  /**
   * Mixed acceptance criteria — free-text strings (legacy) and/or structured
   * {@link AcceptanceGate} objects (machine-verifiable).
   *
   * @epic T760
   * @task T780
   * @defaultValue undefined
   */
  acceptance?: AcceptanceItem[];

  /** IDs of tasks this task depends on. @defaultValue undefined */
  depends?: string[];

  /** Related task entries (non-dependency relationships). @defaultValue undefined */
  relates?: TaskRelation[];

  /** Epic lifecycle state. Only meaningful when `type = 'epic'`. @defaultValue undefined */
  epicLifecycle?: EpicLifecycle | null;

  /** When true, epic will not auto-complete when all children are done. @defaultValue undefined */
  noAutoComplete?: boolean | null;

  /** Reason the task is blocked (free-form text). @defaultValue undefined */
  blockedBy?: string;

  /** Timestamped notes appended during task lifecycle. @defaultValue undefined */
  notes?: string[];

  /** Classification labels for filtering and grouping. @defaultValue undefined */
  labels?: string[];

  /** Task origin/provenance category. @defaultValue undefined */
  origin?: TaskOrigin | null;

  /** ISO 8601 timestamp of task creation. Must not be in the future. */
  createdAt: string;

  /** ISO 8601 timestamp of last update. Set automatically on mutation. @defaultValue undefined */
  updatedAt?: string | null;

  /**
   * ISO 8601 timestamp of task completion. Set when `status` transitions to `'done'`.
   * See {@link CompletedTask} for the status-narrowed type where this is required.
   *
   * @defaultValue undefined
   */
  completedAt?: string;

  /**
   * ISO 8601 timestamp of task cancellation. Set when `status` transitions to `'cancelled'`.
   * See {@link CancelledTask} for the status-narrowed type where this is required.
   *
   * @defaultValue undefined
   */
  cancelledAt?: string;

  /**
   * Reason for cancellation. Required when `status = 'cancelled'`.
   * See {@link CancelledTask} for the status-narrowed type where this is required.
   *
   * @defaultValue undefined
   */
  cancellationReason?: string;

  /** Verification pipeline state. @defaultValue undefined */
  verification?: TaskVerification | null;

  /** Provenance tracking (who created/modified, which session). @defaultValue undefined */
  provenance?: TaskProvenance | null;

  /**
   * RCASD-IVTR+C pipeline stage this task is associated with.
   *
   * Valid values: research, consensus, architecture_decision, specification,
   * decomposition, implementation, validation, testing, release, contribution.
   *
   * Auto-assigned on creation; only moves forward through stages.
   * @task T060
   * @defaultValue undefined
   */
  pipelineStage?: string | null;

  /** Agent ID that has claimed/is assigned to this task. Null when unclaimed. @defaultValue undefined */
  assignee?: string | null;

  /**
   * Abort reason when a worker was stopped due to runaway detection (T1658).
   *
   * Set by the sentient monitor when a worker exceeds its size-based budget
   * (`small` ≥ 30 min, `medium` ≥ 2 h, `large` ≥ 4 h). The field is
   * informational — callers may surface it in `cleo sentient monitor` output.
   *
   * @task T1658
   * @defaultValue undefined
   */
  abortReason?: string | null;
}

// ---------------------------------------------------------------------------
// Input types for task creation
// ---------------------------------------------------------------------------

/**
 * Input type for creating a new task via `addTask()`.
 *
 * Only the fields the caller MUST provide are required. All other fields
 * have sensible defaults applied by the creation logic:
 * - `status` defaults to `'pending'`
 * - `priority` defaults to `'medium'`
 * - `type` is inferred from parent context
 * - `size` defaults to `'medium'`
 */
export interface TaskCreate {
  /** Human-readable task title. Required, max 120 characters. */
  title: string;

  /**
   * Task description. **Required** — CLEO's anti-hallucination rules reject tasks
   * without a description, and require it to differ from the title.
   */
  description: string;

  /** Initial status. Defaults to `'pending'`. @defaultValue 'pending' */
  status?: TaskStatus;

  /** Priority level. Defaults to `'medium'`. @defaultValue 'medium' */
  priority?: TaskPriority;

  /** Task type. Inferred from parent context if not specified. @defaultValue undefined */
  type?: TaskType;

  /**
   * Task kind — intent of work. Defaults to `'work'` at the DB level.
   * DB column is named `role` (T9067 deferral).
   * @defaultValue 'work'
   * @task T944
   * @task T9072
   */
  kind?: TaskKind;

  /**
   * Task scope — granularity of work. Defaults to `'feature'` at the DB level.
   * @defaultValue 'feature'
   * @task T944
   */
  scope?: TaskScope;

  /**
   * Severity axis (OWNER-WRITE-ONLY). Valid for any `kind`.
   * @defaultValue undefined
   * @task T944
   */
  severity?: TaskSeverity | null;

  /** Parent task ID for hierarchy placement. @defaultValue undefined */
  parentId?: string | null;

  /** Relative scope sizing. Defaults to `'medium'`. @defaultValue 'medium' */
  size?: TaskSize;

  /** Phase slug to assign. Inherited from project.currentPhase if not specified. @defaultValue undefined */
  phase?: string;

  /** Classification labels. @defaultValue undefined */
  labels?: string[];

  /** File paths associated with this task. @defaultValue undefined */
  files?: string[];

  /** Acceptance criteria (string or AcceptanceGate objects). @defaultValue undefined */
  acceptance?: AcceptanceItem[];

  /** IDs of tasks this task depends on. @defaultValue undefined */
  depends?: string[];

  /** Initial note to attach. @defaultValue undefined */
  notes?: string;

  /** Sort position. Auto-calculated if not specified. @defaultValue undefined */
  position?: number;
}

// ---------------------------------------------------------------------------
// Status-narrowed types (discriminated unions)
// ---------------------------------------------------------------------------

/**
 * A task with `status = 'done'`. Narrows {@link Task} to require `completedAt`.
 *
 * Use this type when you need to guarantee a completed task has its completion
 * timestamp — for example, in cycle-time calculations or archive operations.
 */
export type CompletedTask = Task & {
  /** Discriminant: status is always `'done'` for a completed task. */
  status: 'done';
  /** ISO 8601 timestamp of completion. Required for done tasks. */
  completedAt: string;
};

/**
 * A task with `status = 'cancelled'`. Narrows {@link Task} to require
 * `cancelledAt` and `cancellationReason`.
 *
 * Use this type when processing cancelled tasks where the cancellation
 * metadata is guaranteed to be present.
 */
export type CancelledTask = Task & {
  /** Discriminant: status is always `'cancelled'` for a cancelled task. */
  status: 'cancelled';
  /** ISO 8601 timestamp of cancellation. Required for cancelled tasks. */
  cancelledAt: string;
  /** Reason for cancellation. Required for cancelled tasks (min 5 chars). */
  cancellationReason: string;
};

/**
 * Shape of a signed severity attestation line appended to the audit log.
 *
 * The attestation is produced whenever a task's `--severity` flag is
 * explicitly set.  It is signed with the project's CLEO Ed25519 identity and
 * appended to `.cleo/audit/severity-attestation.jsonl` as a single JSON line
 * (stable / sorted-key serialisation so verifiers can reconstruct the signed
 * payload).
 *
 * Renamed from the earlier `BugSeverityAttestation` (which was scoped only to
 * `cleo bug`).  The new name reflects that severity attestation is a
 * system-wide primitive usable by any task type (bug, feature, spike, etc.)
 * that carries a `--severity` flag.
 *
 * @task T9071
 * @adr ADR-054 (draft)
 */
export interface SeverityAttestation {
  /** ISO 8601 timestamp of the attestation. */
  timestamp: string;
  /** Task title at attestation time. */
  title: string;
  /** Severity level asserted by the signer (P0–P3). */
  severity: string;
  /** Optional epic the task is filed under. @defaultValue undefined */
  epic?: string;
  /** Optional pre-assigned task ID (if known at attestation time). @defaultValue undefined */
  taskId?: string;
  /** Signer's Ed25519 public key (hex, 64 hex characters). */
  signerPub: string;
}

/** Phase status. */
export type PhaseStatus = 'pending' | 'active' | 'completed';

/** Phase definition. */
export interface Phase {
  /** Sort order of this phase in the project lifecycle. */
  order: number;
  /** Human-readable phase name. */
  name: string;
  /** Phase description. @defaultValue undefined */
  description?: string;
  /** Current phase lifecycle status. */
  status: PhaseStatus;
  /** ISO 8601 timestamp of when the phase started. @defaultValue undefined */
  startedAt?: string | null;
  /** ISO 8601 timestamp of when the phase completed. @defaultValue undefined */
  completedAt?: string | null;
}

/** Phase transition record. */
export interface PhaseTransition {
  /** Slug of the phase that transitioned. */
  phase: string;
  /** Type of transition that occurred. */
  transitionType: 'started' | 'completed' | 'rollback';
  /** ISO 8601 timestamp of the transition. */
  timestamp: string;
  /** Number of tasks in the phase at transition time. */
  taskCount: number;
  /** Previous phase slug for rollback transitions. @defaultValue undefined */
  fromPhase?: string | null;
  /** Optional reason for the transition. @defaultValue undefined */
  reason?: string;
}

/** Release status. */
export type ReleaseStatus = 'planned' | 'active' | 'released';

/** Release definition. */
export interface Release {
  /** Semantic version string (e.g. `"v2026.4.0"`). */
  version: string;
  /** Current release lifecycle status. */
  status: ReleaseStatus;
  /** Target release date in ISO 8601. @defaultValue undefined */
  targetDate?: string | null;
  /** Actual release date in ISO 8601. @defaultValue undefined */
  releasedAt?: string | null;
  /** Task IDs included in this release. */
  tasks: string[];
  /** Release notes text. @defaultValue undefined */
  notes?: string | null;
  /** Generated changelog content. @defaultValue undefined */
  changelog?: string | null;
}

/** Project metadata. */
export interface ProjectMeta {
  /** Project name from `.cleo/project-context.json`. */
  name: string;
  /** Slug of the currently active phase. @defaultValue undefined */
  currentPhase?: string | null;
  /** Phase definitions keyed by slug. */
  phases: Record<string, Phase>;
  /** Ordered history of phase transitions. @defaultValue undefined */
  phaseHistory?: PhaseTransition[];
  /** Release definitions for the project. @defaultValue undefined */
  releases?: Release[];
}

/** File metadata (_meta block). */
export interface FileMeta {
  /** Schema version of the task data file. */
  schemaVersion: string;
  /** Spec version for forward compatibility. @defaultValue undefined */
  specVersion?: string;
  /** Integrity checksum of the data file. */
  checksum: string;
  /** Configuration version used when the file was last written. */
  configVersion: string;
  /** ID of the last session that modified this file. @defaultValue undefined */
  lastSessionId?: string | null;
  /** ID of the currently active session. @defaultValue undefined */
  activeSession?: string | null;
  /** Number of active sessions at last write. @defaultValue undefined */
  activeSessionCount?: number;
  /** Path to the sessions storage file. @defaultValue undefined */
  sessionsFile?: string | null;
  /** Monotonically increasing file generation counter. @defaultValue undefined */
  generation?: number;
}

/** Session note in taskWork block. */
export interface SessionNote {
  /** Note text content. */
  note: string;
  /** ISO 8601 timestamp of when the note was recorded. */
  timestamp: string;
  /** Conversation ID for multi-turn context. @defaultValue undefined */
  conversationId?: string | null;
  /** Agent that recorded this note. @defaultValue undefined */
  agent?: string | null;
}

/** Task work state. */
export interface TaskWorkState {
  /** ID of the task currently being worked on. @defaultValue undefined */
  currentTask?: string | null;
  /** Slug of the current project phase. @defaultValue undefined */
  currentPhase?: string | null;
  /** ISO 8601 timestamp until which work is blocked. @defaultValue undefined */
  blockedUntil?: string | null;
  /** Most recent session note (legacy, use sessionNotes). @defaultValue undefined */
  sessionNote?: string | null;
  /** Ordered list of session notes. @defaultValue undefined */
  sessionNotes?: SessionNote[];
  /** Suggested next action for the agent. @defaultValue undefined */
  nextAction?: string | null;
  /** ID of the primary session managing this work state. @defaultValue undefined */
  primarySession?: string | null;
}
