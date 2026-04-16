/**
 * IVTR Orchestration Loop — State Machine
 *
 * Implements the Implement → Validate → Test → Release phase state machine
 * for per-task multi-agent enforcement. State is persisted as JSON in the
 * `ivtr_state` column on the `tasks` table.
 *
 * State machine transitions:
 *
 *   (none) ──startIvtr──► implement
 *   implement ──advanceIvtr──► validate
 *   validate  ──advanceIvtr──► test
 *   test      ──advanceIvtr──► released
 *
 *   implement | validate | test ──loopBackIvtr──► implement | validate | test
 *
 *   released ──releaseIvtr──► marks task status=done
 *
 * Evidence refs are sha256 hashes of attachment blobs stored under
 * .cleo/attachments (see ADR T796 attachment store).
 *
 * @epic T810
 * @task T811
 */

import { eq } from 'drizzle-orm';
import { getLogger } from '../logger.js';
import { getDb } from '../store/sqlite.js';
import * as schema from '../store/tasks-schema.js';

const log = getLogger('lifecycle:ivtr');

// =============================================================================
// CANONICAL TYPES
// =============================================================================

/** The four canonical IVTR phases. */
export type IvtrPhase = 'implement' | 'validate' | 'test' | 'released';

/**
 * A single phase entry in the IVTR phase history.
 * Loop-back entries have `passed: false` and a non-null `reason`.
 */
export interface IvtrPhaseEntry {
  /** Phase name. */
  phase: IvtrPhase;
  /** Agent identity string (from session/agent registry), or null if unknown. */
  agentIdentity: string | null;
  /** ISO timestamp when this phase was started. */
  startedAt: string;
  /** ISO timestamp when this phase was completed, or null if still active. */
  completedAt: string | null;
  /** Whether this phase passed. null = in-progress. */
  passed: boolean | null;
  /** sha256 hashes of attachments produced as evidence for this phase. */
  evidenceRefs: string[];
  /** Populated on loop-back entries to explain the failure. */
  reason?: string;
}

/** Complete IVTR state for a task. */
export interface IvtrState {
  /** Task ID (e.g. 'T811'). */
  taskId: string;
  /** Current active phase. */
  currentPhase: IvtrPhase;
  /** Full ordered history of all phase entries (including loop-backs). */
  phaseHistory: IvtrPhaseEntry[];
  /** ISO timestamp when the IVTR loop was first started. */
  startedAt: string;
}

// =============================================================================
// PHASE ORDER
// =============================================================================

const PHASE_ORDER: IvtrPhase[] = ['implement', 'validate', 'test', 'released'];

/**
 * Return the next phase after `current`, or null if already at `released`.
 */
function nextPhase(current: IvtrPhase): IvtrPhase | null {
  const idx = PHASE_ORDER.indexOf(current);
  if (idx === -1 || idx >= PHASE_ORDER.length - 1) return null;
  return PHASE_ORDER[idx + 1] ?? null;
}

// =============================================================================
// PERSISTENCE HELPERS
// =============================================================================

/**
 * Read the raw `ivtr_state` JSON from the tasks table for a given taskId.
 * Returns null if the column is empty or the task does not exist.
 */
async function readIvtrStateRaw(taskId: string, cwd?: string): Promise<IvtrState | null> {
  const db = await getDb(cwd);
  const rows = await db
    .select({ ivtrState: schema.tasks.ivtrState })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .all();

  if (rows.length === 0 || rows[0]?.ivtrState == null) return null;

  try {
    return JSON.parse(rows[0].ivtrState) as IvtrState;
  } catch {
    log.warn({ taskId }, 'Failed to parse ivtr_state JSON; treating as null');
    return null;
  }
}

/**
 * Write the IvtrState back to tasks.ivtr_state as JSON.
 * Throws if the task does not exist.
 *
 * Uses a pre-check SELECT rather than `.returning()` on UPDATE because the
 * node:sqlite Drizzle driver does not guarantee rows are returned from
 * `.returning().all()` on an UPDATE, which caused E_NOT_FOUND false positives.
 */
async function writeIvtrState(state: IvtrState, cwd?: string): Promise<void> {
  const db = await getDb(cwd);

  // Pre-check: verify the task row exists before attempting the UPDATE.
  const exists = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, state.taskId))
    .get();

  if (!exists) {
    throw new Error(`Task ${state.taskId} not found — cannot write IVTR state`);
  }

  const json = JSON.stringify(state);
  await db
    .update(schema.tasks)
    .set({ ivtrState: json, updatedAt: new Date().toISOString() })
    .where(eq(schema.tasks.id, state.taskId))
    .run();
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Start the IVTR loop for a task.
 *
 * Creates a fresh IvtrState with `currentPhase = 'implement'` and persists
 * it to the task row. Idempotent: calling again on a task that already has
 * IVTR state returns the existing state without mutation.
 *
 * @param taskId - Task ID to start the IVTR loop for.
 * @param options - Optional cwd and agent identity.
 * @returns The current (possibly new) IvtrState.
 */
export async function startIvtr(
  taskId: string,
  options?: { cwd?: string; agentIdentity?: string },
): Promise<IvtrState> {
  const existing = await readIvtrStateRaw(taskId, options?.cwd);
  if (existing) {
    log.info({ taskId }, 'IVTR already started; returning existing state');
    return existing;
  }

  const now = new Date().toISOString();
  const entry: IvtrPhaseEntry = {
    phase: 'implement',
    agentIdentity: options?.agentIdentity ?? null,
    startedAt: now,
    completedAt: null,
    passed: null,
    evidenceRefs: [],
  };

  const state: IvtrState = {
    taskId,
    currentPhase: 'implement',
    phaseHistory: [entry],
    startedAt: now,
  };

  await writeIvtrState(state, options?.cwd);
  log.info({ taskId }, 'IVTR loop started at implement phase');
  return state;
}

/**
 * Advance the IVTR loop from the current phase to the next.
 *
 * Closes the current in-progress phase entry (marks it `passed: true`,
 * records evidence), opens a new entry for the next phase.
 *
 * Throws if:
 * - No IVTR state exists (call startIvtr first).
 * - Already at `released` (use releaseIvtr to finalise).
 *
 * @param taskId   - Task to advance.
 * @param evidence - sha256 hashes of evidence attachments from this phase.
 * @param options  - Optional cwd and agent identity for the next phase entry.
 * @returns Updated IvtrState.
 */
export async function advanceIvtr(
  taskId: string,
  evidence: string[],
  options?: { cwd?: string; agentIdentity?: string },
): Promise<IvtrState> {
  const state = await readIvtrStateRaw(taskId, options?.cwd);
  if (!state) {
    throw new Error(`No IVTR state for task ${taskId}. Call startIvtr first.`);
  }
  if (state.currentPhase === 'released') {
    throw new Error(`Task ${taskId} is already released. Use releaseIvtr to finalise.`);
  }

  const now = new Date().toISOString();

  // Close the current active phase entry.
  const activeEntry = state.phaseHistory.findLast((e) => e.completedAt === null);
  if (activeEntry) {
    activeEntry.completedAt = now;
    activeEntry.passed = true;
    activeEntry.evidenceRefs = [...activeEntry.evidenceRefs, ...evidence];
  }

  const next = nextPhase(state.currentPhase);
  if (!next) {
    throw new Error(`Cannot advance beyond released phase for task ${taskId}`);
  }

  state.currentPhase = next;

  if (next !== 'released') {
    const nextEntry: IvtrPhaseEntry = {
      phase: next,
      agentIdentity: options?.agentIdentity ?? null,
      startedAt: now,
      completedAt: null,
      passed: null,
      evidenceRefs: [],
    };
    state.phaseHistory.push(nextEntry);
  }

  await writeIvtrState(state, options?.cwd);
  log.info(
    { taskId, from: state.currentPhase === next ? 'unknown' : next, to: next },
    'IVTR advanced',
  );
  return state;
}

/**
 * Loop back to an earlier phase due to failure.
 *
 * Closes the current active phase entry as failed, appends a failure note
 * to the history, then opens a new entry for the target phase.
 *
 * @param taskId  - Task to loop back.
 * @param toPhase - Phase to rewind to. Must be 'implement', 'validate', or 'test'.
 * @param reason  - Human-readable explanation of the failure.
 * @param evidence - sha256 hashes of failure evidence attachments.
 * @param options  - Optional cwd and agent identity.
 * @returns Updated IvtrState.
 */
export async function loopBackIvtr(
  taskId: string,
  toPhase: IvtrPhase,
  reason: string,
  evidence: string[],
  options?: { cwd?: string; agentIdentity?: string },
): Promise<IvtrState> {
  if (toPhase === 'released') {
    throw new Error(`Cannot loop back to 'released'. Use releaseIvtr to finalise.`);
  }

  const state = await readIvtrStateRaw(taskId, options?.cwd);
  if (!state) {
    throw new Error(`No IVTR state for task ${taskId}. Call startIvtr first.`);
  }
  if (state.currentPhase === 'released') {
    throw new Error(`Task ${taskId} is already released. Cannot loop back.`);
  }

  const now = new Date().toISOString();

  // Close the current active phase entry as failed.
  const activeEntry = state.phaseHistory.findLast((e) => e.completedAt === null);
  if (activeEntry) {
    activeEntry.completedAt = now;
    activeEntry.passed = false;
    activeEntry.evidenceRefs = [...activeEntry.evidenceRefs, ...evidence];
    activeEntry.reason = reason;
  }

  // Open a new entry for the target phase.
  const loopEntry: IvtrPhaseEntry = {
    phase: toPhase,
    agentIdentity: options?.agentIdentity ?? null,
    startedAt: now,
    completedAt: null,
    passed: null,
    evidenceRefs: [],
    reason: `Loop-back from ${state.currentPhase}: ${reason}`,
  };

  state.currentPhase = toPhase;
  state.phaseHistory.push(loopEntry);

  await writeIvtrState(state, options?.cwd);
  log.info({ taskId, toPhase, reason }, 'IVTR loop-back recorded');
  return state;
}

/**
 * Attempt to release a task after all three phases have passed.
 *
 * Validates that implement, validate, and test all have at least one passing
 * phase entry. If validation passes, marks the task status = 'done' and
 * sets `currentPhase = 'released'`.
 *
 * @param taskId  - Task to release.
 * @param options - Optional cwd.
 * @returns `{ released: true }` on success, or `{ released: false, failures }` listing missing phases.
 */
export async function releaseIvtr(
  taskId: string,
  options?: { cwd?: string },
): Promise<{ released: boolean; failures?: string[] }> {
  const state = await readIvtrStateRaw(taskId, options?.cwd);
  if (!state) {
    return { released: false, failures: [`No IVTR state for task ${taskId}`] };
  }
  if (state.currentPhase === 'released') {
    return { released: true };
  }

  const failures: string[] = [];
  const required: Array<Exclude<IvtrPhase, 'released'>> = ['implement', 'validate', 'test'];

  for (const phase of required) {
    const passed = state.phaseHistory.some((e) => e.phase === phase && e.passed === true);
    if (!passed) {
      failures.push(`Phase '${phase}' has no passing entry`);
    }
  }

  if (failures.length > 0) {
    return { released: false, failures };
  }

  // Close the active test entry if still open.
  const now = new Date().toISOString();
  const activeEntry = state.phaseHistory.findLast((e) => e.completedAt === null);
  if (activeEntry) {
    activeEntry.completedAt = now;
    activeEntry.passed = true;
  }

  state.currentPhase = 'released';
  await writeIvtrState(state, options?.cwd);

  // Mark the task done.
  const db = await getDb(options?.cwd);
  await db
    .update(schema.tasks)
    .set({ status: 'done', completedAt: now, updatedAt: now })
    .where(eq(schema.tasks.id, taskId))
    .all();

  log.info({ taskId }, 'IVTR released — task marked done');
  return { released: true };
}

/**
 * Retrieve the current IVTR state for a task, or null if the loop has not
 * been started.
 *
 * @param taskId  - Task ID to inspect.
 * @param options - Optional cwd.
 * @returns IvtrState or null.
 */
export async function getIvtrState(
  taskId: string,
  options?: { cwd?: string },
): Promise<IvtrState | null> {
  return readIvtrStateRaw(taskId, options?.cwd);
}

// =============================================================================
// PROMPT RESOLUTION HELPERS (phase-specific agent instructions)
// =============================================================================

/**
 * Build a resolved prompt string for the current phase's assigned agent.
 *
 * Includes the task spec section placeholder, prior-phase evidence refs,
 * and phase-specific instructions.
 *
 * @param taskId    - Task ID (used to label the prompt).
 * @param state     - Current IvtrState.
 * @param taskTitle - Short task title (from cleo show).
 * @param taskDesc  - Full task description / spec.
 * @returns Prompt string for the phase's assigned agent.
 */
export function resolvePhasePrompt(
  taskId: string,
  state: IvtrState,
  taskTitle: string,
  taskDesc: string,
): string {
  const priorEvidence = state.phaseHistory
    .filter((e) => e.passed === true)
    .flatMap((e) => e.evidenceRefs);

  const evidenceSection =
    priorEvidence.length > 0
      ? `## Prior Phase Evidence (sha256 attachment refs)\n${priorEvidence.map((r) => `- ${r}`).join('\n')}`
      : '## Prior Phase Evidence\n(none — first phase)';

  const phaseInstructions: Record<IvtrPhase, string> = {
    implement: `## Phase: Implement
You are the Implementation agent for task ${taskId}.

Your responsibilities:
1. Read the task spec below in full.
2. Write, modify, or extend code to satisfy the acceptance criteria.
3. Run quality gates: \`pnpm biome check --write .\` then \`pnpm run build\`.
4. Produce a git diff or file list as evidence.
5. Report your sha256 attachment refs as evidence when you call \`cleo orchestrate ivtr ${taskId} --next\`.`,

    validate: `## Phase: Validate
You are the Validation agent for task ${taskId}.

Your responsibilities:
1. Read the task spec and the prior-phase evidence refs listed above.
2. Retrieve each evidence attachment via \`cleo docs show <sha256>\`.
3. Verify spec↔code alignment: every acceptance criterion must be traceable to a code change.
4. Produce an EvidenceRecord: \`{ passed: boolean, details: string, gaps: string[] }\`.
5. If passed, call \`cleo orchestrate ivtr ${taskId} --next\` with your EvidenceRecord sha256.
6. If failed, call \`cleo orchestrate ivtr ${taskId} --loop-back --phase implement --reason "<details>"\`.`,

    test: `## Phase: Test
You are the Testing agent for task ${taskId}.

Your responsibilities:
1. Read the task spec and prior-phase evidence refs listed above.
2. Run \`pnpm run test\` and capture stdout.
3. Verify: zero new test failures; relevant tests cover the changed code paths.
4. Attach the test output as a text attachment.
5. If all tests pass, call \`cleo orchestrate ivtr ${taskId} --next\` with your attachment sha256.
6. If tests fail, call \`cleo orchestrate ivtr ${taskId} --loop-back --phase implement --reason "<failure summary>"\`.`,

    released: `## Phase: Released
Task ${taskId} has been released. No further agent action required.`,
  };

  return `# IVTR Agent Prompt — ${taskId}: ${taskTitle}
Phase: **${state.currentPhase.toUpperCase()}**

## Task Specification
${taskDesc}

${evidenceSection}

${phaseInstructions[state.currentPhase]}
`;
}
