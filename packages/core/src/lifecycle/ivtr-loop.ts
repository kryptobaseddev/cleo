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
 * @task T813
 */

import { createHash } from 'node:crypto';
import type { AcceptanceGate, TestOutputRecord } from '@cleocode/contracts';
import { eq } from 'drizzle-orm';
import { getLogger } from '../logger.js';
import { getProjectRoot } from '../paths.js';
import { createAttachmentStore } from '../store/attachment-store.js';
import { getDb } from '../store/sqlite.js';
import * as schema from '../store/tasks-schema.js';
import { extractTypedGates, runGates } from '../tasks/gate-runner.js';

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
  /**
   * Running count of loop-backs per target phase.
   *
   * Incremented each time `loopBackIvtr` targets that phase.
   * After `MAX_LOOP_BACKS_PER_PHASE` loop-backs to the same phase, the next
   * attempt throws `E_IVTR_MAX_RETRIES` and requires HITL escalation.
   *
   * Missing on legacy states — treated as all-zeros on read.
   */
  loopBackCount: Record<IvtrPhase, number>;
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
    throw new Error(`Task ${state.taskId} not found --- cannot write IVTR state`);
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
    loopBackCount: { implement: 0, validate: 0, test: 0, released: 0 },
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
 * Maximum number of loop-backs allowed per phase before HITL escalation.
 *
 * After `MAX_LOOP_BACKS_PER_PHASE` loop-backs to the same phase, the next
 * attempt is rejected with `E_IVTR_MAX_RETRIES` so that a human can
 * intervene rather than the loop spinning indefinitely.
 */
export const MAX_LOOP_BACKS_PER_PHASE = 2;

/**
 * Error code emitted when a phase has exceeded its maximum loop-back count.
 *
 * Callers (domain handlers, orchestrators) should surface this to the operator
 * as a HITL escalation prompt — the task cannot self-heal and needs review.
 */
export const E_IVTR_MAX_RETRIES = 'E_IVTR_MAX_RETRIES';

/**
 * Loop back to an earlier phase due to failure.
 *
 * Closes the current active phase entry as failed, appends a failure note
 * to the history, then opens a new entry for the target phase.
 *
 * Increments the `loopBackCount` for the target phase. After
 * `MAX_LOOP_BACKS_PER_PHASE` loop-backs to the same phase, subsequent
 * calls throw an error with code `E_IVTR_MAX_RETRIES`.
 *
 * @param taskId  - Task to loop back.
 * @param toPhase - Phase to rewind to. Must be 'implement', 'validate', or 'test'.
 * @param reason  - Human-readable explanation of the failure.
 * @param evidence - sha256 hashes of failure evidence attachments.
 * @param options  - Optional cwd and agent identity.
 * @returns Updated IvtrState.
 * @throws Error with message starting with `E_IVTR_MAX_RETRIES` when the
 *         per-phase loop-back limit is exceeded.
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

  // Backward-compat: legacy states may not have loopBackCount.
  if (!state.loopBackCount) {
    state.loopBackCount = { implement: 0, validate: 0, test: 0, released: 0 };
  }

  // Check max BEFORE any mutation so the state stays clean on reject.
  const currentCount = state.loopBackCount[toPhase] ?? 0;
  if (currentCount >= MAX_LOOP_BACKS_PER_PHASE) {
    throw new Error(
      `${E_IVTR_MAX_RETRIES}: Task ${taskId} has reached the maximum of ${MAX_LOOP_BACKS_PER_PHASE} loop-backs to phase '${toPhase}'. ` +
        `HITL escalation required — review the loop-back history and resolve the root cause manually before retrying.`,
    );
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
  state.loopBackCount[toPhase] = currentCount + 1;

  await writeIvtrState(state, options?.cwd);
  log.info(
    { taskId, toPhase, reason, loopBackCount: state.loopBackCount[toPhase] },
    'IVTR loop-back recorded',
  );
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

  log.info({ taskId }, 'IVTR released --- task marked done');
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
 * A condensed summary of a single implement-phase evidence attachment.
 *
 * Callers who have access to the full `ImplDiffRecord` from
 * `@cleocode/contracts` SHOULD populate all optional fields. Callers that
 * only have access to the sha256 ref from `IvtrPhaseEntry.evidenceRefs` MAY
 * leave them undefined — the prompt will fall back to listing the sha256 alone.
 *
 * @see `ImplDiffRecord` in `@cleocode/contracts` for the full shape.
 */
export interface ImplEvidenceSummary {
  /** SHA-256 hex digest of the attachment blob (64 chars). */
  attachmentSha256: string;
  /** Evidence kind discriminant (e.g. `'impl-diff'`, `'lint-report'`). */
  kind: string;
  /** Relative paths of every file the diff touches. */
  filesChanged?: string[];
  /** Net lines added across all changed files. */
  linesAdded?: number;
  /** Net lines removed across all changed files. */
  linesRemoved?: number;
  /** Wall-clock duration of the implement action in milliseconds. */
  durationMs?: number;
}

/**
 * Build the validate-phase evidence bundle section (T812 §2).
 *
 * Renders a structured Markdown table when enriched summaries are provided,
 * or falls back to listing raw sha256 refs from the passed phase entries.
 *
 * @param implEntries    - Implement phase entries with `passed === true`.
 * @param evidenceBundle - Optional enriched summaries from the attachment store.
 */
function buildValidateEvidenceBundle(
  implEntries: IvtrPhaseEntry[],
  evidenceBundle: ImplEvidenceSummary[],
): string {
  if (evidenceBundle.length > 0) {
    const rows = evidenceBundle.map((e) => {
      const files =
        e.filesChanged && e.filesChanged.length > 0 ? e.filesChanged.join(', ') : '(unknown)';
      const added = e.linesAdded !== undefined ? `+${e.linesAdded}` : '?';
      const removed = e.linesRemoved !== undefined ? `-${e.linesRemoved}` : '?';
      const duration = e.durationMs !== undefined ? `${e.durationMs}ms` : '?';
      return `| \`${e.attachmentSha256.slice(0, 16)}...\` | ${e.kind} | ${files} | ${added}/${removed} | ${duration} |`;
    });

    return `## Implement-Phase Evidence Bundle

| sha256 (prefix) | kind | filesChanged | linesAdded/Removed | duration |
|---|---|---|---|---|
${rows.join('\n')}

> Retrieve full diff: \`cleo docs show <sha256>\``;
  }

  // Fallback: list raw refs from phase history.
  const allRefs = implEntries.flatMap((e) => e.evidenceRefs);
  if (allRefs.length === 0) {
    return '## Implement-Phase Evidence Bundle\n(none recorded — impl agent may not have produced attachments)';
  }

  return `## Implement-Phase Evidence Bundle (sha256 refs)
${allRefs.map((r) => `- \`${r}\``).join('\n')}

> Retrieve diff content: \`cleo docs show <sha256>\``;
}

/**
 * Build the validate-phase instruction block + REJECT criteria (T812 §§3–4).
 *
 * @param taskId         - Task ID for CLI command references.
 * @param state          - Current IvtrState (currentPhase === 'validate').
 * @param evidenceBundle - Pre-fetched implement evidence summaries (may be empty).
 */
function buildValidatePhaseInstruction(
  taskId: string,
  state: IvtrState,
  evidenceBundle: ImplEvidenceSummary[],
): string {
  const loopCount = state.loopBackCount?.validate ?? 0;
  const escalationNote =
    loopCount >= 2
      ? '\n> WARNING: This is loop-back attempt 3+. HITL escalation is required if this validate phase fails again.\n'
      : '';

  const implRefHint =
    evidenceBundle.length > 0
      ? evidenceBundle
          .map(
            (e) =>
              `- \`${e.attachmentSha256.slice(0, 16)}...\` (${e.kind}${e.filesChanged ? ', ' + e.filesChanged.length + ' file(s)' : ''})`,
          )
          .join('\n')
      : '(enumerate REQ-IDs from the task specification above and cross-reference the impl-diff sha256 refs in the evidence bundle)';

  return `## Phase: Validate
You are the Validate agent for task ${taskId}. Read the impl diff + evidence listed in the Implement-Phase Evidence Bundle above. Check spec↔code alignment per each acceptance criterion and REQ-ID.${escalationNote}

### Your responsibilities

1. Read the task spec and each evidence attachment in the Implement-Phase Evidence Bundle above.
2. Retrieve each diff blob: \`cleo docs show <sha256>\`
3. For every acceptance criterion and REQ-ID in the task spec, verify it is traceable to a concrete code change in the impl diff.
4. Produce a \`ValidateSpecCheckRecord\` (\`kind: 'validate-spec-check'\`) and write it to a JSON file:
   \`\`\`json
   {
     "kind": "validate-spec-check",
     "phase": "validate",
     "agentIdentity": "<your-agent-id>",
     "attachmentSha256": "<sha256-of-this-report>",
     "reqIdsChecked": ["<REQ-ID-1>", "<REQ-ID-2>"],
     "passed": true,
     "details": "<per-REQ-ID verdict, one sentence each>",
     "ranAt": "<ISO-8601-timestamp>",
     "durationMs": 0
   }
   \`\`\`
5. Attach the report: \`cleo docs add <file> --task ${taskId}\`
6. Pass the returned sha256 to \`--next\`:
   - **PASS**: \`cleo orchestrate ivtr ${taskId} --next --evidence <sha256>\`
   - **FAIL**: \`cleo orchestrate ivtr ${taskId} --loop-back --phase implement --reason "<details>"\`

### Impl-diff attachment refs to review

${implRefHint}

### REJECT criteria — trigger loop-back if ANY of the following are true

- **Spec-code mismatch**: an acceptance criterion or REQ-ID has no traceable code change in the impl diff.
- **Missing test**: an acceptance criterion that requires test coverage has no corresponding test added or updated in the diff.
- **Undocumented deviation**: the implementation deviates from the task spec without a documented reason (comment, ADR reference, or inline note in the diff).
- **Quality gate not run**: the impl-phase evidence does not include proof that \`pnpm biome check\` and \`pnpm run build\` both passed (lint-report or command-output attachment with exit code 0).`;
}

/**
 * Build a resolved prompt string for the current phase's assigned agent.
 *
 * When advancing to the `validate` phase the prompt is enriched with four
 * additional sections required by T812:
 *
 * 1. **Original task spec** — always included.
 * 2. **Implement-phase evidence bundle** — all `IvtrPhaseEntry` records where
 *    `phase === 'implement'` and `passed === true`, rendered with attachment
 *    metadata (sha256, kind, filesChanged, linesAdded/Removed, duration).
 *    Callers pass the optional `evidenceBundle` to supply pre-fetched metadata
 *    from the attachment store; the function falls back to raw sha256 refs if
 *    the bundle is empty.
 * 3. **Validate-agent instructions** — how to produce a `ValidateSpecCheckRecord`
 *    (`kind: 'validate-spec-check'`) and attach it via `cleo docs add`.
 * 4. **Explicit REJECT criteria** — conditions under which the validate agent
 *    MUST trigger a loop-back to implement.
 *
 * When the target phase is `implement` and prior failures exist, a loop-back
 * context section is injected with the triggering reason and history.
 *
 * For the `test` phase, the prompt instructs the agent to run
 * `cleo verify <id> --run` and produce a `TestOutputRecord`.
 *
 * @param taskId          - Task ID (used to label the prompt).
 * @param state           - Current IvtrState (after the transition to the target phase).
 * @param taskTitle       - Short task title (from cleo show).
 * @param taskDesc        - Full task description / spec including REQ-IDs.
 * @param acceptanceGates - Optional typed AcceptanceGate objects (used by the test phase).
 * @param evidenceBundle  - Optional pre-fetched implement-phase evidence summaries
 *                          (used by the validate phase; ignored for other phases).
 * @returns Prompt string for the phase's assigned agent.
 */
export function resolvePhasePrompt(
  taskId: string,
  state: IvtrState,
  taskTitle: string,
  taskDesc: string,
  acceptanceGates?: AcceptanceGate[],
  evidenceBundle: ImplEvidenceSummary[] = [],
): string {
  // ── Validate phase: structured 4-section prompt (T812) ───────────────────
  if (state.currentPhase === 'validate') {
    const implEntries = state.phaseHistory.filter(
      (e) => e.phase === 'implement' && e.passed === true,
    );
    const bundleSection = buildValidateEvidenceBundle(implEntries, evidenceBundle);
    const instructionSection = buildValidatePhaseInstruction(taskId, state, evidenceBundle);

    return `# IVTR Agent Prompt — ${taskId}: ${taskTitle}
Phase: **VALIDATE**

## Task Specification
${taskDesc}

${bundleSection}

${instructionSection}
`;
  }

  // ── Generic evidence refs section (implement / test / released) ───────────
  const priorEvidence = state.phaseHistory
    .filter((e) => e.passed === true)
    .flatMap((e) => e.evidenceRefs);

  const evidenceSection =
    priorEvidence.length > 0
      ? `## Prior Phase Evidence (sha256 attachment refs)\n${priorEvidence.map((r) => `- ${r}`).join('\n')}`
      : '## Prior Phase Evidence\n(none — first phase)';

  // Build loop-back context section when re-spawning Implement after a failure (T814).
  const failedEntries = state.phaseHistory.filter((e) => e.passed === false);
  let loopBackSection = '';
  if (state.currentPhase === 'implement' && failedEntries.length > 0) {
    const triggeringFailure = failedEntries[failedEntries.length - 1]!;
    const failureEvidenceLines =
      triggeringFailure.evidenceRefs.length > 0
        ? triggeringFailure.evidenceRefs.map((r) => `- ${r}`).join('\n')
        : '(no attachment refs --- check the reason text above for details)';
    const historyLines = failedEntries
      .map(
        (e, idx) =>
          `${idx + 1}. Phase: ${e.phase.toUpperCase()} | Reason: ${e.reason ?? '(none)'} | CompletedAt: ${e.completedAt ?? 'unknown'}`,
      )
      .join('\n');
    loopBackSection = `
## LOOP-BACK CONTEXT --- READ THIS CAREFULLY

**Previous attempt failed at phase: ${triggeringFailure.phase.toUpperCase()}**
**Failure reason**: ${triggeringFailure.reason ?? '(none)'}

### Failure Evidence (sha256 refs from the failing phase)
${failureEvidenceLines}

### Loop-back History (all prior failures for this task)
${historyLines}

**CRITICAL INSTRUCTION**: Previous attempt(s) failed. Read the failure evidence above.
Fix the ROOT CAUSE --- do NOT retry the same approach.
If the test phase failed, check what tests broke and WHY.
If the validate phase failed, check which acceptance criteria were not met and ensure they are addressed.
`;
  }

  // Build the typed gates section for the test phase prompt.
  const gatesSection =
    acceptanceGates && acceptanceGates.length > 0
      ? `\n## Typed AcceptanceGates (programmatic --- run via cleo verify --run)\n${acceptanceGates
          .map((g, i) => {
            const label =
              'command' in g
                ? (g as { command: string }).command
                : 'url' in g
                  ? (g as { url: string }).url
                  : g.kind;
            return `${i + 1}. [${g.kind}] ${g.req ?? '(no req)'} --- ${label}`;
          })
          .join('\n')}`
      : '';

  const phaseInstructions: Record<IvtrPhase, string> = {
    implement: `## Phase: Implement
You are the Implementation agent for task ${taskId}.

Your responsibilities:
1. Read the task spec below in full.
2. Write, modify, or extend code to satisfy the acceptance criteria.
3. Run quality gates: pnpm biome check --write . then pnpm run build.
4. Produce a git diff or file list as evidence.
5. Report your sha256 attachment refs as evidence when you call cleo orchestrate ivtr ${taskId} --next.`,

    validate: '', // handled above — this branch is unreachable when currentPhase === 'validate'

    test: `## Phase: Test
You are the Testing agent for task ${taskId}.

Your responsibilities:
1. Read the task spec and all prior-phase evidence refs listed above (impl + validate).
2. Run cleo verify ${taskId} --run to execute all programmatic AcceptanceGates.
3. Attach the full gate-run output via cleo docs add --labels test-output.
4. Compute or capture the sha256 of the attached output.
5. Pass the sha256 + gate-pass-count + gate-fail-count back in your --next call as:
   EvidenceRecord{kind:'test-output', command:'cleo verify ${taskId} --run', exitCode, testsPassed, testsFailed}
6. If all gates pass, call cleo orchestrate ivtr ${taskId} --next --evidence <sha256>.
7. If any gate fails, call cleo orchestrate ivtr ${taskId} --loop-back --phase implement --reason "<failure summary>".
${gatesSection}`,

    released: `## Phase: Released
Task ${taskId} has been released. No further agent action required.`,
  };

  return `# IVTR Agent Prompt --- ${taskId}: ${taskTitle}
Phase: **${state.currentPhase.toUpperCase()}**

## Task Specification
${taskDesc}

${evidenceSection}
${loopBackSection}
${phaseInstructions[state.currentPhase]}
`;
}
// =============================================================================
// AUTO-RUN GATES (T813)
// =============================================================================

/**
 * Result returned by autoRunGatesAndRecord.
 */
export interface AutoRunGatesResult {
  /** sha256 of the stored attachment containing the full gate-run output. */
  attachmentSha256: string;
  /** Number of gates that passed. */
  testsPassed: number;
  /** Number of gates that failed or errored. */
  testsFailed: number;
  /** The composite exit code: 0 if all gates passed, 1 otherwise. */
  exitCode: number;
  /** The synthesised EvidenceRecord (kind: 'test-output'). */
  evidenceRecord: TestOutputRecord;
}

/**
 * Execute all typed AcceptanceGates for a task atomically during an IVTR
 * --next transition with --auto-run-tests set.
 *
 * Steps performed in a single atomic operation:
 * 1. Accept the typed gates array (strings already filtered by caller).
 * 2. Run each gate via runGates().
 * 3. Serialise the results to JSON and store via AttachmentStore.
 * 4. Synthesise a TestOutputRecord carrying the sha256, pass/fail counts,
 *    and exit code.
 * 5. Append the sha256 to the active phaseHistory entry's evidenceRefs and
 *    persist the updated IvtrState.
 *
 * @param taskId          - Task ID being tested.
 * @param acceptanceItems - Mixed acceptance array from the task record (strings
 *                          are silently ignored; only typed gates are executed).
 * @param agentIdentity   - Optional agent identity string for provenance.
 * @param cwd             - Optional working directory.
 * @returns AutoRunGatesResult with the attachment sha256 and counts.
 */
export async function autoRunGatesAndRecord(
  taskId: string,
  acceptanceItems: (string | AcceptanceGate)[],
  agentIdentity?: string,
  cwd?: string,
): Promise<AutoRunGatesResult> {
  const projectRoot = getProjectRoot(cwd);
  const ranAt = new Date().toISOString();
  const startMs = Date.now();

  // 1. Filter to typed gates only (strings are silently skipped).
  const typedGateEntries = extractTypedGates(acceptanceItems);
  const gates = typedGateEntries.map((e) => e.gate);

  // 2. Execute gates.
  const results = await runGates(gates, { projectRoot, skipManual: true });

  const testsPassed = results.filter((r) => r.result === 'pass').length;
  const testsFailed = results.filter((r) => r.result === 'fail' || r.result === 'error').length;
  const exitCode = testsFailed > 0 ? 1 : 0;
  const durationMs = Date.now() - startMs;

  // 3. Serialise gate results as JSON and store as an attachment.
  const outputJson = JSON.stringify({ taskId, gates: results, testsPassed, testsFailed }, null, 2);
  const attachmentSha256 = createHash('sha256').update(outputJson).digest('hex');

  const store = createAttachmentStore();
  // BlobAttachment requires storageKey; the store writes the actual content-addressed
  // path itself. Omit<Attachment,'sha256'> on a discriminated union does not distribute
  // 'storageKey' as a shared known property, so we use an explicit cast here.
  type AttachmentInput = Parameters<typeof store.put>[1];
  await store.put(
    outputJson,
    {
      kind: 'blob',
      storageKey: '',
      mime: 'application/json',
      size: Buffer.byteLength(outputJson),
    } as AttachmentInput,
    'task',
    taskId,
    agentIdentity ?? 'ivtr-auto-run',
    cwd,
  );

  // 4. Build the TestOutputRecord.
  const evidenceRecord: TestOutputRecord = {
    kind: 'test-output',
    phase: 'test',
    agentIdentity: agentIdentity ?? 'ivtr-auto-run',
    attachmentSha256,
    command: `cleo verify ${taskId} --run`,
    exitCode,
    testsPassed,
    testsFailed,
    ranAt,
    durationMs,
  };

  // 5. Append sha256 to the active phase entry's evidenceRefs and persist.
  const state = await readIvtrStateRaw(taskId, cwd);
  if (state) {
    const activeEntry = state.phaseHistory.findLast((e) => e.completedAt === null);
    if (activeEntry) {
      activeEntry.evidenceRefs = [...activeEntry.evidenceRefs, attachmentSha256];
    }
    await writeIvtrState(state, cwd);
  }

  log.info(
    { taskId, testsPassed, testsFailed, exitCode, attachmentSha256 },
    'IVTR auto-run gates complete',
  );

  return { attachmentSha256, testsPassed, testsFailed, exitCode, evidenceRecord };
}
