/**
 * Grill-Gate Predicate — E3-GRILL-GATE (T11495)
 *
 * Decides whether a task unit is ready to proceed autonomously (`proceed`)
 * or needs human/orchestrator clarification before work starts (`grill`).
 *
 * The predicate is pure: it operates on pre-loaded task data + optional
 * supporting signals and never opens a DB or calls the network directly.
 * Callers (e.g. `cleo go`) supply the unit + signals; the predicate
 * focuses solely on classification logic.
 *
 * ## Grill triggers (AC2)
 * 1. Missing acceptance criteria — task has no `acceptance` entries.
 * 2. Owner-decision required — task carries an `owner-decision` label OR
 *    `blockedBy` contains "owner" / "decision" text.
 * 3. IVTR max-retries exhausted — any phase in `ivtrLoopBackCount` has
 *    reached {@link MAX_LOOP_BACKS_PER_PHASE} (requires HITL escalation).
 * 4. Release/publish gate active — task `pipelineStage` is `'release'` and
 *    no HITL approval token is present (reuses existing `orchestrate approve`
 *    / `reject` / `pending` surface — no new HITL introduced).
 * 5. Scope ambiguity — epic-type task with no children AND no attached spec
 *    or research artifact (blob list) — cannot be safely autonomously worked.
 *
 * ## Auto-proceed condition (AC2)
 * - Implementation-or-later epic (`pipelineStage` ∈ `implementation-stages`)
 *   that has a non-empty ready frontier (at least one child task satisfies
 *   all dependencies), or any concrete task/subtask that clears all GRILL
 *   triggers.
 *
 * @module orchestration/classify-readiness
 * @task T11495  E3-GRILL-GATE classifyReadiness predicate
 * @epic T11492  SG-AUTOPILOT
 * @see {@link classifyReadiness}
 */

import type { Task } from '@cleocode/contracts';
import type { IvtrState } from '../lifecycle/ivtr-loop.js';
import { MAX_LOOP_BACKS_PER_PHASE } from '../lifecycle/ivtr-loop.js';

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * Verdict returned by {@link classifyReadiness}.
 *
 * - `'proceed'` — the task is ready for autonomous execution.
 * - `'grill'`   — the task needs clarification or escalation before work
 *                 can safely begin. Callers surface this as
 *                 `AskUserQuestion` (agent mode) or a pending-row
 *                 (--headless mode).
 */
export type ReadinessVerdict = 'proceed' | 'grill';

/**
 * Grill trigger codes.  One or more codes appear in
 * {@link ReadinessResult.triggers} when `verdict === 'grill'`.
 */
export type GrillTrigger =
  /** Task has no acceptance criteria — work scope is undefined. */
  | 'MISSING_AC'
  /** Task carries an `owner-decision` label or its `blockedBy` field mentions owner/decision. */
  | 'OWNER_DECISION_REQUIRED'
  /** IVTR loop has exhausted loop-back retries for at least one phase. */
  | 'IVTR_MAX_RETRIES'
  /** Task is in `release` pipeline stage and no HITL approval has been granted. */
  | 'RELEASE_GATE'
  /** Epic with no children and no spec/research artifact — ambiguous scope. */
  | 'AMBIGUOUS_SCOPE';

/**
 * Result returned by {@link classifyReadiness}.
 */
export interface ReadinessResult {
  /** Whether the task should proceed or be grilled. */
  verdict: ReadinessVerdict;
  /**
   * Human-readable summary of the verdict.
   *
   * For `proceed`: a brief confirmation.
   * For `grill`: a concise description of what needs clarification.
   */
  reason: string;
  /**
   * Active grill triggers (empty when `verdict === 'proceed'`).
   *
   * Multiple triggers may fire simultaneously; callers should surface all of
   * them in the question/pending-row so they can be resolved in one pass.
   */
  triggers: GrillTrigger[];
}

/**
 * Optional signals that require async resolution by the caller.
 *
 * Pass a populated `ReadinessSignals` to {@link classifyReadiness} so the
 * predicate can incorporate live state without opening any I/O itself.
 * Every field is optional; omitting a field disables the corresponding check.
 */
export interface ReadinessSignals {
  /**
   * Child tasks of the unit under evaluation.
   *
   * Used to determine whether an epic has a non-empty ready frontier
   * (at least one non-terminal child with all deps satisfied) and
   * to suppress {@link GrillTrigger.AMBIGUOUS_SCOPE} when children exist.
   */
  children?: Task[];

  /**
   * IVTR state for the task as returned by `getIvtrState()`.
   *
   * When present, the predicate checks whether any phase's `loopBackCount`
   * has reached {@link MAX_LOOP_BACKS_PER_PHASE}.  When absent the
   * IVTR-max-retries check is skipped.
   */
  ivtrState?: IvtrState | null;

  /**
   * Names of blob attachments associated with the task (from `blobList()`).
   *
   * Used to detect whether an undecomposed epic has a spec or research
   * artifact that justifies autonomous execution.  When absent the check
   * falls back to the children-count alone.
   */
  blobNames?: string[];

  /**
   * Whether a HITL approval token has already been granted for the task.
   *
   * When `true` the {@link GrillTrigger.RELEASE_GATE} trigger is suppressed
   * even if the task is in the `release` pipeline stage (the gate was already
   * cleared via `cleo orchestrate approve`).
   *
   * Defaults to `false` when omitted.
   */
  hitlApproved?: boolean;
}

// ─── Internal constants ───────────────────────────────────────────────────────

/**
 * Label (case-insensitive) that marks a task as requiring an owner decision
 * before work begins.
 *
 * Applied by convention via `cleo update --label owner-decision`.
 */
const OWNER_DECISION_LABEL = 'owner-decision';

/**
 * Keywords checked in `task.blockedBy` (free-text) to detect implicit
 * owner-decision blocks.  Checked case-insensitively.
 */
const OWNER_DECISION_BLOCKED_BY_KEYWORDS = ['owner', 'decision'] as const;

/**
 * Pipeline stages that represent active release/publish gates.
 *
 * A task at one of these stages requires explicit HITL approval (via
 * `cleo orchestrate approve`) before autonomous execution.  Reuses the
 * existing `pending` / `approve` / `reject` surface — no new HITL path.
 */
const RELEASE_PIPELINE_STAGES = new Set(['release', 'publish'] as const);

/**
 * Blob attachment name patterns (lowercased) that signal a spec or research
 * artifact is present for an undecomposed epic.
 *
 * Any blob whose name contains one of these substrings is treated as a
 * sufficient spec artifact to suppress {@link GrillTrigger.AMBIGUOUS_SCOPE}.
 */
const SPEC_ARTIFACT_NAME_PATTERNS = ['spec', 'research', 'adr', 'rfc', 'design', 'plan'] as const;

/**
 * Pipeline stages at or beyond the implementation phase.
 *
 * An epic in one of these stages with a non-empty ready frontier is treated
 * as safely proceeding — it has been planned and decomposed.
 */
const IMPLEMENTATION_STAGES = new Set([
  'implementation',
  'validation',
  'audit',
  'test',
  'release',
  'publish',
  'contribution',
] as const);

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Return `true` when the task is missing any meaningful acceptance criteria.
 *
 * A task is considered to have criteria when its `acceptance` array contains
 * at least one entry — either a non-empty string or a structured
 * {@link AcceptanceGate} object.
 *
 * @param task - Task record to inspect.
 */
function hasMissingAc(task: Task): boolean {
  const ac = task.acceptance;
  if (!ac || ac.length === 0) return true;
  // Ensure every entry is non-empty (filter out blank-string artifacts).
  const meaningful = ac.filter((item) =>
    typeof item === 'string' ? item.trim().length > 0 : true,
  );
  return meaningful.length === 0;
}

/**
 * Return `true` when the task requires an owner decision before work can start.
 *
 * Two signals are checked:
 *  1. `task.labels` contains `'owner-decision'` (exact, case-insensitive).
 *  2. `task.blockedBy` free-text mentions "owner" OR "decision"
 *     (case-insensitive substring match).
 *
 * @param task - Task record to inspect.
 */
function requiresOwnerDecision(task: Task): boolean {
  const labels = (task.labels ?? []).map((l) => l.toLowerCase());
  if (labels.includes(OWNER_DECISION_LABEL)) return true;

  const blockedBy = (task.blockedBy ?? '').toLowerCase();
  if (blockedBy.length > 0) {
    for (const kw of OWNER_DECISION_BLOCKED_BY_KEYWORDS) {
      if (blockedBy.includes(kw)) return true;
    }
  }

  return false;
}

/**
 * Return `true` when the IVTR loop has exhausted retries for any phase.
 *
 * Checks every phase's `loopBackCount` against {@link MAX_LOOP_BACKS_PER_PHASE}.
 * A count equal to or greater than the limit means the next `loopBackIvtr`
 * call would throw `E_IVTR_MAX_RETRIES` — the task must escalate to HITL.
 *
 * @param ivtrState - Resolved IVTR state or `null`/`undefined` when absent.
 */
function hasIvtrMaxRetries(ivtrState: IvtrState | null | undefined): boolean {
  if (!ivtrState) return false;
  const counts = ivtrState.loopBackCount;
  if (!counts) return false;
  return Object.values(counts).some((count) => count >= MAX_LOOP_BACKS_PER_PHASE);
}

/**
 * Return `true` when the task is at an active release/publish gate without
 * prior HITL approval.
 *
 * @param task        - Task record to inspect.
 * @param hitlApproved - Whether approval was already granted.
 */
function hasReleaseGate(task: Task, hitlApproved: boolean): boolean {
  const stage = task.pipelineStage ?? null;
  if (!stage) return false;
  return RELEASE_PIPELINE_STAGES.has(stage as 'release' | 'publish') && !hitlApproved;
}

/**
 * Return `true` when an epic's scope is ambiguous (cannot proceed autonomously).
 *
 * Ambiguity is signalled by:
 *  - The task is an `epic` type.
 *  - It has no direct children (`children` is empty or absent).
 *  - It has no attached spec/research artifact blobs.
 *
 * When the epic IS at `implementation` stage or beyond we do NOT mark it
 * ambiguous — the implementation stage implies decomposition already happened.
 *
 * @param task      - Task record to inspect.
 * @param children  - Direct child tasks (may be empty).
 * @param blobNames - Names of attached blobs (may be empty).
 */
function hasAmbiguousScope(
  task: Task,
  children: Task[] | undefined,
  blobNames: string[] | undefined,
): boolean {
  if (task.type !== 'epic') return false;

  // If the epic is in an implementation-or-later stage it was already
  // decomposed — no ambiguity.
  const stage = task.pipelineStage ?? '';
  if (IMPLEMENTATION_STAGES.has(stage as Parameters<typeof IMPLEMENTATION_STAGES.has>[0])) {
    return false;
  }

  // Children exist → not ambiguous.
  if (children && children.length > 0) return false;

  // A spec/research artifact is sufficient to proceed.
  const lowerBlobs = (blobNames ?? []).map((n) => n.toLowerCase());
  const hasSpecArtifact = SPEC_ARTIFACT_NAME_PATTERNS.some((pattern) =>
    lowerBlobs.some((name) => name.includes(pattern)),
  );
  if (hasSpecArtifact) return false;

  return true;
}

/**
 * Return `true` when an epic has a non-empty ready frontier.
 *
 * A task in the frontier is one that:
 *  - has a non-terminal status (`pending` or `active`)
 *  - has all its `depends` entries satisfied (status `done` or `archived`)
 *
 * @param children - Direct child tasks of the epic.
 */
function hasReadyFrontier(children: Task[]): boolean {
  const terminalStatuses = new Set(['done', 'cancelled', 'archived']);
  const satisfiedStatuses = new Set(['done', 'archived']);

  const childMap = new Map(children.map((c) => [c.id, c]));

  return children.some((child) => {
    if (terminalStatuses.has(child.status)) return false;
    const deps = child.depends ?? [];
    return deps.every((depId) => {
      const dep = childMap.get(depId);
      return dep !== undefined && satisfiedStatuses.has(dep.status);
    });
  });
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Classify whether a task unit is ready to proceed autonomously or needs
 * grilling (clarification / escalation) before work starts.
 *
 * **Pure function**: does not open any DB, file, or network connection.
 * All live state (children, IVTR, blobs) is pre-fetched by the caller and
 * passed via {@link ReadinessSignals}.
 *
 * ## Grill triggers (checked in order)
 * 1. {@link GrillTrigger.MISSING_AC}              — `task.acceptance` is empty or absent.
 * 2. {@link GrillTrigger.OWNER_DECISION_REQUIRED} — `owner-decision` label or blockedBy text.
 * 3. {@link GrillTrigger.IVTR_MAX_RETRIES}        — IVTR loop-back count ≥ MAX per any phase.
 * 4. {@link GrillTrigger.RELEASE_GATE}            — `pipelineStage` ∈ {release, publish} without approval.
 * 5. {@link GrillTrigger.AMBIGUOUS_SCOPE}         — epic with no children and no spec artifact.
 *
 * ## Auto-proceed
 * - All triggers clear.
 * - OR: implementation-or-later epic with a non-empty ready frontier
 *   (only possible when MISSING_AC is absent — an epic without ACs still grills).
 *
 * @param task    - Full task record to classify.
 * @param signals - Optional pre-fetched supporting state. When omitted, checks
 *                  that require live state are skipped gracefully.
 * @returns {@link ReadinessResult} with `verdict`, `reason`, and `triggers`.
 *
 * @example Basic usage (no async signals):
 * ```typescript
 * const result = classifyReadiness(task);
 * if (result.verdict === 'grill') {
 *   console.warn(`Grill: ${result.reason}`);
 * }
 * ```
 *
 * @example With pre-fetched signals:
 * ```typescript
 * const children = await accessor.getChildren(task.id);
 * const ivtrState = await getIvtrState(task.id);
 * const blobNames = (await blobList(task.id)).map(b => b.name);
 *
 * const result = classifyReadiness(task, { children, ivtrState, blobNames });
 * ```
 *
 * @task T11495 E3-GRILL-GATE
 * @epic T11492 SG-AUTOPILOT
 */
export function classifyReadiness(task: Task, signals: ReadinessSignals = {}): ReadinessResult {
  const { children, ivtrState, blobNames, hitlApproved = false } = signals;
  const triggers: GrillTrigger[] = [];

  // ── 1. Missing acceptance criteria ──────────────────────────────────────
  if (hasMissingAc(task)) {
    triggers.push('MISSING_AC');
  }

  // ── 2. Owner-decision required ───────────────────────────────────────────
  if (requiresOwnerDecision(task)) {
    triggers.push('OWNER_DECISION_REQUIRED');
  }

  // ── 3. IVTR max-retries exhausted ───────────────────────────────────────
  if (hasIvtrMaxRetries(ivtrState)) {
    triggers.push('IVTR_MAX_RETRIES');
  }

  // ── 4. Release / publish gate ────────────────────────────────────────────
  if (hasReleaseGate(task, hitlApproved)) {
    triggers.push('RELEASE_GATE');
  }

  // ── 5. Ambiguous scope ───────────────────────────────────────────────────
  if (hasAmbiguousScope(task, children, blobNames)) {
    triggers.push('AMBIGUOUS_SCOPE');
  }

  // ── Short-circuit: any trigger fires → grill ────────────────────────────
  if (triggers.length > 0) {
    const reason = buildGrillReason(task, triggers, children);
    return { verdict: 'grill', reason, triggers };
  }

  // ── Auto-proceed check for impl+ epics ─────────────────────────────────
  //   Epics in implementation-or-later stage with a non-empty ready frontier
  //   are explicitly marked as auto-proceed (AC2).
  const stage = task.pipelineStage ?? '';
  if (
    task.type === 'epic' &&
    IMPLEMENTATION_STAGES.has(stage as Parameters<typeof IMPLEMENTATION_STAGES.has>[0]) &&
    children &&
    children.length > 0 &&
    hasReadyFrontier(children)
  ) {
    return {
      verdict: 'proceed',
      reason: `Epic ${task.id} is in '${stage}' stage with a non-empty ready frontier — proceed autonomously.`,
      triggers: [],
    };
  }

  return {
    verdict: 'proceed',
    reason: `Task ${task.id} cleared all readiness checks — proceed autonomously.`,
    triggers: [],
  };
}

// ─── Internal: reason builder ─────────────────────────────────────────────────

/**
 * Build a human-readable reason string for a `grill` verdict.
 *
 * Lists every active trigger so the caller can surface all issues in a single
 * `AskUserQuestion` / pending-row without a follow-up round-trip.
 *
 * @internal
 */
function buildGrillReason(
  task: Task,
  triggers: GrillTrigger[],
  children: Task[] | undefined,
): string {
  const parts: string[] = [`Task ${task.id} (${task.title}) requires grilling:`];

  for (const trigger of triggers) {
    switch (trigger) {
      case 'MISSING_AC':
        parts.push(
          '  • MISSING_AC — task has no acceptance criteria; define them before starting work.',
        );
        break;

      case 'OWNER_DECISION_REQUIRED': {
        const hasLabel = (task.labels ?? [])
          .map((l) => l.toLowerCase())
          .includes(OWNER_DECISION_LABEL);
        if (hasLabel) {
          parts.push(
            `  • OWNER_DECISION_REQUIRED — label '${OWNER_DECISION_LABEL}' indicates an open owner decision.`,
          );
        } else {
          parts.push(
            `  • OWNER_DECISION_REQUIRED — blockedBy '${task.blockedBy}' indicates an owner/decision dependency.`,
          );
        }
        break;
      }

      case 'IVTR_MAX_RETRIES':
        parts.push(
          '  • IVTR_MAX_RETRIES — IVTR loop-back retries exhausted; HITL escalation required.',
        );
        break;

      case 'RELEASE_GATE':
        parts.push(
          `  • RELEASE_GATE — task is in '${task.pipelineStage}' stage; use 'cleo orchestrate approve' to unblock.`,
        );
        break;

      case 'AMBIGUOUS_SCOPE': {
        const childCount = children?.length ?? 0;
        parts.push(
          `  • AMBIGUOUS_SCOPE — epic has ${childCount} children and no spec artifact; decompose or attach a spec before work begins.`,
        );
        break;
      }
    }
  }

  return parts.join('\n');
}
