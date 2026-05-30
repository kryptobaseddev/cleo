/**
 * CLEO-native goal-system contracts (Layer 4 of SG-COGNITIVE-SUBSTRATE).
 *
 * A *goal* is a DB-persisted, per-agent, turn-budgeted intent that CLEO drives
 * to completion by judging progress after every agent turn. CLEO's goal loop is
 * designed to beat two prior-art systems:
 *
 * - **Claude-Code** — a `Stop` hook + a Haiku *transcript judge* (the model
 *   reads the conversation and guesses whether the task is done). It has no
 *   turn budget and no persistence: a fresh process forgets the goal.
 * - **Hermes** — a post-turn loop with a turn budget and parse-failure
 *   auto-pause, but it still judges *fuzzy* intent against transcript text.
 *
 * CLEO's differentiator is the **evidence-gate-aware judge**: when a goal is to
 * *complete a task* (`complete T123`), the judge does NOT read the transcript.
 * It resolves the target task's actual `status` and re-uses the shipped ADR-051
 * evidence infrastructure ({@link GateEvidenceRequirement} +
 * `validateEvidenceForGate`) — the goal is satisfied ONLY when the task is
 * `done` with its required gates backed by real, validated evidence atoms
 * (commit reachable, file sha256 match, test-run hash match). Transcript text
 * can never satisfy a task-completion goal. Fuzzy goals fall back to an
 * injectable LLM judge (see {@link GoalJudge}) so the model is consulted only
 * where no machine-checkable artifact exists.
 *
 * This module is the LEAF contract: it declares the persisted record shape
 * ({@link GoalRecord}), the lifecycle status union ({@link GoalStatus}), the
 * discriminated goal-kind union ({@link GoalKind}), and the judge verdict shape
 * ({@link GoalJudgeVerdict}) that every layer (store, judge, loop, continuation,
 * CLI) agrees on. It has ZERO runtime dependencies beyond sibling contracts.
 *
 * @packageDocumentation
 * @module @cleocode/contracts/goal
 *
 * @epic T11290 EP-CLEO-GOAL-SYSTEM
 * @task T11376
 * @saga T11283 SG-COGNITIVE-SUBSTRATE
 */

/**
 * Canonical task-id shape recognized by a {@link TaskCompletionGoal}.
 *
 * Mirrors the ADR-079-r2 `SATISFIES_TASK_ID_REGEX` / evidence-atom task-id
 * grammar (`T` + 1–7 digits). Exported so the store, judge, and CLI layers
 * validate target ids against ONE pattern rather than re-deriving it.
 *
 * @public
 */
export const GOAL_TARGET_TASK_ID_REGEX = /^T[0-9]{1,7}$/;

/**
 * Lifecycle status of a {@link GoalRecord}.
 *
 * Transitions are owned by the turn-budgeted loop (`advanceGoal`):
 * - `active`     — the goal is being pursued; the loop consumes turns.
 * - `paused`     — auto-paused after a judge/parse failure (Hermes pattern);
 *   carries a {@link GoalRecord.pausedReason}. No turns are consumed while
 *   paused; a human/agent must resume.
 * - `satisfied`  — the judge returned `ok: true` (evidence-backed for task
 *   goals, LLM-confirmed for fuzzy goals). Terminal.
 * - `abandoned`  — the turn budget was exhausted before satisfaction. Terminal.
 * - `impossible` — the judge proved the goal can never be satisfied
 *   (e.g. the target task was cancelled/deleted). Terminal; no further turns.
 *
 * @public
 */
export type GoalStatus = 'active' | 'paused' | 'satisfied' | 'abandoned' | 'impossible';

/**
 * The set of all {@link GoalStatus} values, in lifecycle order.
 *
 * Use for runtime validation (`GOAL_STATUSES.includes(x)`) and to drive
 * exhaustive switch checks without hand-maintaining a parallel array.
 *
 * @public
 */
export const GOAL_STATUSES: readonly GoalStatus[] = Object.freeze([
  'active',
  'paused',
  'satisfied',
  'abandoned',
  'impossible',
]);

/**
 * The terminal {@link GoalStatus} values a continuation builder must NOT nudge:
 * a satisfied/abandoned/impossible goal yields no next-turn message.
 *
 * `paused` is intentionally absent — a paused goal CAN be resumed, so the
 * continuation builder still emits a nudge for it (see `buildContinuation`).
 *
 * @public
 */
export const GOAL_TERMINAL_STATUSES: readonly GoalStatus[] = Object.freeze([
  'satisfied',
  'abandoned',
  'impossible',
]);

/**
 * Discriminant tag for the {@link GoalKind} union.
 *
 * @public
 */
export type GoalKindTag = 'task-completion' | 'fuzzy';

/**
 * A goal whose satisfaction is decided by the **evidence-gate-aware** judge.
 *
 * The judge resolves `targetTaskId`'s actual status and re-uses the ADR-051
 * evidence path — NEVER transcript text. This is CLEO's core differentiator
 * over Claude-Code and Hermes.
 *
 * @public
 */
export interface TaskCompletionGoal {
  /** Discriminant: judged via task status + evidence atoms (ADR-051). */
  readonly kind: 'task-completion';
  /**
   * The task to complete. MUST match {@link GOAL_TARGET_TASK_ID_REGEX}
   * (`T` + 1–7 digits). The judge loads this task and inspects its real
   * `status` and gate evidence.
   */
  readonly targetTaskId: string;
}

/**
 * A goal with no machine-checkable completion artifact — satisfaction is
 * decided by the injectable LLM judge ({@link GoalJudge}) as a fallback.
 *
 * The fuzzy path NEVER touches the evidence infrastructure; it exists only for
 * intents that cannot be reduced to a task + gates (e.g. "explore the auth
 * module and summarize the risks").
 *
 * @public
 */
export interface FuzzyGoal {
  /** Discriminant: judged by the fallback LLM judge (no evidence path). */
  readonly kind: 'fuzzy';
}

/**
 * Discriminated union distinguishing an evidence-judged task-completion goal
 * from an LLM-judged fuzzy goal. The `kind` tag routes the judge: see
 * {@link TaskCompletionGoal} (evidence) vs {@link FuzzyGoal} (LLM fallback).
 *
 * @public
 */
export type GoalKind = TaskCompletionGoal | FuzzyGoal;

/**
 * A DB-persisted, per-agent goal record (survives process restart).
 *
 * Persisted in `tasks.db` under the `tasks_goal` table (Pattern A — single file
 * per scope + domain-prefixed table). Keyed per agent by the resolved
 * `sessionId` + `agentId` from E0 (`resolveSessionIdFromEnv` /
 * `resolveAgentIdFromEnv`) so two concurrent agents never collide on one global
 * row — the session-bleed class this saga exists to kill.
 *
 * @public
 */
export interface GoalRecord {
  /**
   * Stable, content-independent goal id (the idempotency key / primary key in
   * the store). Generated by the store on create.
   */
  readonly id: string;
  /**
   * Resolved session id that owns this goal (from `resolveSessionIdFromEnv`).
   * `null` only for the global-scope / no-session case.
   */
  readonly sessionId: string | null;
  /**
   * Resolved agent handle that owns this goal (from `resolveAgentIdFromEnv`).
   * `null` when spawn did not inject an agent identity.
   */
  readonly agentId: string | null;
  /**
   * Parent goal id when this is a sub-goal, else `null`. Sub-goals let an agent
   * decompose a large intent without losing the turn budget of the parent.
   */
  readonly parentGoalId: string | null;
  /**
   * The kind discriminator + its payload (target task id for task goals).
   * Drives whether the judge takes the evidence path or the LLM-fallback path.
   */
  readonly goalKind: GoalKind;
  /** Human-readable statement of what the agent is trying to achieve. */
  readonly intent: string;
  /**
   * Outstanding, append-only acceptance criteria. The continuation builder
   * embeds these so the agent knows what remains. Append via
   * `appendCriteria` — never mutated in place.
   */
  readonly criteria: readonly string[];
  /** Current lifecycle status. */
  readonly status: GoalStatus;
  /**
   * Maximum number of turns the loop may consume before the goal is abandoned.
   * A hard cap that bounds runaway loops (the protection Claude-Code lacks).
   */
  readonly turnBudget: number;
  /** Turns consumed so far. Never exceeds {@link turnBudget}. */
  readonly turnsUsed: number;
  /**
   * Why the goal was auto-paused, when `status === 'paused'`. `null` otherwise.
   * Set on judge/parse failure so the resume path can surface the cause.
   */
  readonly pausedReason: string | null;
  /**
   * The most recent judge verdict, persisted so `cleo goal status` can show the
   * last reason without re-running the judge. `null` before the first judge.
   */
  readonly lastVerdict: GoalJudgeVerdict | null;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
  /** ISO-8601 last-update timestamp. */
  readonly updatedAt: string;
}

/**
 * The verdict returned by every judge path — evidence-gate-aware OR LLM
 * fallback — for a single goal evaluation.
 *
 * The shape is uniform across both paths (the loop never branches on which
 * judge produced it):
 * - `ok`         — the goal is satisfied right now.
 * - `reason`     — human-readable explanation (embedded into the continuation
 *   nudge so the agent knows WHY it must continue, or why it succeeded).
 * - `impossible` — the goal can NEVER be satisfied (e.g. target task cancelled);
 *   the loop transitions the goal to `impossible` and stops consuming turns.
 *   `impossible` implies `ok === false`.
 * - `evidence`   — optional list of evidence-atom strings (ADR-051) the
 *   evidence judge consulted, for audit/telemetry. Absent on the LLM path.
 *
 * @public
 */
export interface GoalJudgeVerdict {
  /** True when the goal is satisfied. Mutually exclusive with `impossible`. */
  readonly ok: boolean;
  /** Human-readable explanation of the verdict (for the continuation nudge). */
  readonly reason: string;
  /** True when the goal can never be satisfied (terminal `impossible`). */
  readonly impossible: boolean;
  /**
   * Evidence-atom strings the evidence judge inspected (ADR-051). Present only
   * on the task-completion path; omitted by the LLM fallback.
   */
  readonly evidence?: readonly string[];
}

/**
 * Injectable LLM-judge interface for {@link FuzzyGoal} evaluation.
 *
 * The goal judge depends on THIS interface, never on a concrete model client,
 * so vitest can pass a deterministic mock and stay fully offline/hermetic — CI
 * must never flake on a live model call. Production wires a real LLM-backed
 * implementation; tests wire a stub that returns a canned verdict.
 *
 * @public
 */
export interface GoalJudge {
  /**
   * Judge a fuzzy goal from its record alone (no transcript dependency in the
   * contract — an implementation MAY consult external context, but the
   * interface keeps the judge a pure function of the goal for testability).
   *
   * @param goal - The goal record under evaluation.
   * @returns The verdict (same shape as the evidence path).
   */
  judge(goal: GoalRecord): Promise<GoalJudgeVerdict>;
}

/**
 * A single next-turn continuation message produced by the cache-safe builder.
 *
 * Critically, the role is ALWAYS `'user'`: the goal loop nudges the agent by
 * appending a user-style message, NEVER by mutating the system prompt. A stable
 * system-prompt prefix is what makes prompt-caching effective; rewriting it on
 * every turn would bust the cache. See `buildContinuation` for the full
 * prompt-cache-safety contract.
 *
 * @public
 */
export interface GoalContinuation {
  /** Always `'user'` — the nudge is a user message, never a system mutation. */
  readonly role: 'user';
  /** The continuation text: goal intent + outstanding criteria + judge reason. */
  readonly content: string;
}

/**
 * Result of advancing a goal one turn through the turn-budgeted loop.
 *
 * @public
 */
export interface GoalAdvanceResult {
  /** The verdict the judge returned this turn. */
  readonly verdict: GoalJudgeVerdict;
  /** The status the goal transitions to after this turn. */
  readonly nextStatus: GoalStatus;
  /** Turns left after this one. Never negative. */
  readonly turnsRemaining: number;
}

/**
 * Type guard: is this a {@link TaskCompletionGoal} (evidence-judged)?
 *
 * @param kind - A {@link GoalKind} discriminated union value.
 * @returns `true` when the goal is judged via task status + evidence atoms.
 * @public
 */
export function isTaskCompletionGoal(kind: GoalKind): kind is TaskCompletionGoal {
  return kind.kind === 'task-completion';
}

/**
 * Type guard: is this a {@link FuzzyGoal} (LLM-judged fallback)?
 *
 * @param kind - A {@link GoalKind} discriminated union value.
 * @returns `true` when the goal is judged by the injectable LLM judge.
 * @public
 */
export function isFuzzyGoal(kind: GoalKind): kind is FuzzyGoal {
  return kind.kind === 'fuzzy';
}

/**
 * Test whether a string is a valid goal target task id (`T` + 1–7 digits).
 *
 * @param value - Candidate task id.
 * @returns `true` when `value` matches {@link GOAL_TARGET_TASK_ID_REGEX}.
 * @public
 */
export function isValidGoalTargetTaskId(value: string): boolean {
  return GOAL_TARGET_TASK_ID_REGEX.test(value);
}

/**
 * Test whether a {@link GoalStatus} is terminal (no further turns / nudges that
 * advance work). A terminal status yields NO continuation.
 *
 * @param status - A goal status.
 * @returns `true` for `satisfied` / `abandoned` / `impossible`.
 * @public
 */
export function isTerminalGoalStatus(status: GoalStatus): boolean {
  return GOAL_TERMINAL_STATUSES.includes(status);
}
