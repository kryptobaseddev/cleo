/**
 * IVTR `ivtr_state` record — read + cantbook-mirror surface.
 *
 * The Implement → Validate → Audit → Test → Release phase loop now runs on the
 * cantbook runtime (the survivor state machine after the T11764 collapse). The
 * hand-rolled phase-walk functions (`startIvtr`/`advanceIvtr`/`loopBackIvtr`/
 * `releaseIvtr`) plus the per-phase prompt/auto-gate helpers were deleted in
 * T11896 once `cleo go` (default) drives `executePlaybook(ivtr.cantbook)` and
 * the manual `cleo orchestrate ivtr` mutate ops were deprecated.
 *
 * This module now owns the RETAINED `ivtr_state` surface (one deprecation
 * cycle):
 *  - {@link IvtrState} / {@link IvtrPhase} / {@link IvtrPhaseEntry} — the JSON
 *    shape persisted in the `ivtr_state` column on `tasks`.
 *  - {@link getIvtrState} — the read path backing `cleo show --ivtr-history`
 *    and the strict `E_IVTR_INCOMPLETE` completion gate (`tasks/complete.ts`).
 *  - {@link seedIvtrForPlaybook} / {@link finalizeIvtrFromPlaybook} — the
 *    `cleo go` cantbook seam (T11805): seed the column at `implement` and
 *    mirror the run's terminal status back so the completion gate stays
 *    load-bearing.
 *  - {@link MAX_LOOP_BACKS_PER_PHASE} — read by `classify-readiness.ts`.
 *  - {@link validateSpawnRequest} — Lead authorship-bypass guard (ADR-070).
 *
 * Evidence refs are sha256 hashes of attachment blobs stored under
 * .cleo/attachments (see ADR T796 attachment store).
 *
 * @epic T810
 * @task T811
 * @task T813
 * @task T11805 — cantbook seam (seed + finalize mirror)
 * @task T11896 — phase-walk functions deleted; this is the read/mirror surface
 */

import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getLogger } from '../logger.js';
import { createAttachmentStore } from '../store/attachment-store.js';
import { getDb } from '../store/sqlite.js';
import * as schema from '../store/tasks-schema.js';

const log = getLogger('lifecycle:ivtr');

// =============================================================================
// CANONICAL TYPES
// =============================================================================

/** The four canonical IVTR phases. */
/** @task T9216 — added 'audit' phase between validate and test */
export type IvtrPhase = 'implement' | 'validate' | 'audit' | 'test' | 'released';

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
  /**
   * Schema version for forward-only migration.
   *
   * Version 2 adds the `audit` phase. Legacy rows (version absent or 1)
   * continue to work — `audit` counts default to 0 on read.
   *
   * @task T9216
   */
  schemaVersion?: number;
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
 * Build the canonical fresh {@link IvtrState} seeded at the `implement` phase.
 *
 * The historical manual walk (`startIvtr`) was deleted in T11896 when the IVTR
 * loop was collapsed onto the cantbook runtime; {@link seedIvtrForPlaybook}
 * (the `cleo go` seam, T11805) is now the sole producer of a fresh IvtrState
 * and delegates here so the seeded state is byte-identical to the retired walk.
 *
 * @param taskId - Task the IVTR loop is seeded for.
 * @param agentIdentity - Agent identity string for the first phase entry, or
 *   `null` when unknown.
 * @returns A fresh schema-v2 {@link IvtrState} at `currentPhase: 'implement'`.
 */
function buildInitialIvtrState(taskId: string, agentIdentity: string | null): IvtrState {
  const now = new Date().toISOString();
  const entry: IvtrPhaseEntry = {
    phase: 'implement',
    agentIdentity,
    startedAt: now,
    completedAt: null,
    passed: null,
    evidenceRefs: [],
  };

  return {
    taskId,
    schemaVersion: 2,
    currentPhase: 'implement',
    phaseHistory: [entry],
    startedAt: now,
    loopBackCount: { implement: 0, validate: 0, audit: 0, test: 0, released: 0 },
  };
}

/**
 * Seed the `tasks.ivtr_state` mirror for a task whose IVTR loop is now driven
 * by `executePlaybook(ivtr.cantbook)` rather than the hand-rolled phase walk
 * (T11805 · collapse-plan §3 item 4).
 *
 * The strict completion gate `E_IVTR_INCOMPLETE` (`tasks/complete.ts`) fires
 * **only when `ivtr_state !== null`**. The `cleo go` seam removed `startIvtr`
 * — the historical sole writer of that column — from the autopilot path; this
 * helper restores the writer so the gate stays load-bearing while the column
 * is retained for one deprecation cycle. It is intentionally **not**
 * `startIvtr`: AC4 of T11805 requires the go path to no longer call
 * `startIvtr`, but the seeded state must remain identical, so both share
 * {@link buildInitialIvtrState}.
 *
 * Idempotent: a task that already has IVTR state is left untouched and its
 * existing state is returned.
 *
 * @param taskId - Task to seed `ivtr_state` for.
 * @param options - Optional cwd and agent identity for the first phase entry.
 * @returns The current (possibly newly seeded) {@link IvtrState}.
 */
export async function seedIvtrForPlaybook(
  taskId: string,
  options?: { cwd?: string; agentIdentity?: string },
): Promise<IvtrState> {
  const existing = await readIvtrStateRaw(taskId, options?.cwd);
  if (existing) {
    log.info({ taskId }, 'IVTR state already present; seam seed is a no-op');
    return existing;
  }

  const state = buildInitialIvtrState(taskId, options?.agentIdentity ?? null);
  await writeIvtrState(state, options?.cwd);
  log.info({ taskId }, 'IVTR state mirror seeded for cantbook-driven run');
  return state;
}

/**
 * Terminal status reported by the cantbook runtime (`executePlaybook`) for an
 * IVTR run. Mirrors `PlaybookTerminalStatus` in `@cleocode/playbooks` but is
 * declared locally so `@cleocode/core` never imports the runtime package
 * (the dependency runs the other way — collapse-plan §3).
 */
export type IvtrPlaybookTerminalStatus =
  | 'completed'
  | 'failed'
  | 'pending_approval'
  | 'exceeded_iteration_cap';

/**
 * Outcome of {@link finalizeIvtrFromPlaybook}.
 */
export interface FinalizeIvtrResult {
  /** The IVTR state after the terminal mirror, or `null` if no state existed. */
  state: IvtrState | null;
  /**
   * sha256 of the content-addressed provenance blob written when the run
   * `completed` (reproduces the legacy walk's attachment-store evidence
   * write — collapse-plan §3 mapping row "evidence refs"). Absent when the run
   * did not complete or no state was present.
   */
  evidenceRef?: string;
}

/**
 * Mirror the terminal status of a cantbook-driven IVTR run back into
 * `tasks.ivtr_state` (T11805 · collapse-plan §3 item 4 + Risk #2).
 *
 * The `cleo go` seam seeds `ivtr_state` at the `implement` phase via
 * {@link seedIvtrForPlaybook} but the cantbook runtime (`executePlaybook`)
 * only writes `playbook_runs` — it never touches `ivtr_state`. Without this
 * mirror a fully-successful autonomous run leaves `ivtr_state.currentPhase`
 * frozen at `'implement'`, so the strict `E_IVTR_INCOMPLETE` completion gate
 * (`tasks/complete.ts`) permanently rejects `cleo complete`. This function
 * closes that gap by translating the runtime's terminal status into the
 * equivalent `ivtr_state` transition:
 *
 *  - **`completed`** → walk every required phase to a passing
 *    {@link IvtrPhaseEntry} and set `currentPhase = 'released'`, so the gate
 *    passes exactly as the legacy `advanceIvtr`→`releaseIvtr` walk did. A
 *    content-addressed provenance blob (runId + terminalStatus + a bounded
 *    `finalContext` snapshot) is written to the attachment store and its
 *    sha256 recorded on the released entry's `evidenceRefs`, reproducing the
 *    per-phase evidence write the old walk produced (collapse-plan §3
 *    "evidence refs (sha256 attachments)").
 *  - **`failed` / `exceeded_iteration_cap`** → mark the active phase entry
 *    `passed: false` with the runtime error as the `reason`, leaving
 *    `currentPhase` un-advanced so the gate correctly blocks completion.
 *  - **`pending_approval`** → no-op (the run is awaiting a HITL gate; a later
 *    resume turn finalizes it).
 *
 * Idempotent: a state already at `'released'` is returned untouched.
 *
 * @param taskId - Task whose `ivtr_state` mirror is being finalized.
 * @param terminalStatus - Terminal status from the cantbook run.
 * @param options - Optional cwd, agent identity, runId, error reason, and a
 *   bounded `finalContext` snapshot for the provenance blob.
 * @returns The finalized state + optional provenance evidence ref.
 *
 * @task T11805 — E-ORCH-STATE-MACHINE-COLLAPSE / T11764
 */
export async function finalizeIvtrFromPlaybook(
  taskId: string,
  terminalStatus: IvtrPlaybookTerminalStatus,
  options?: {
    cwd?: string;
    agentIdentity?: string;
    runId?: string;
    error?: string;
    finalContext?: Record<string, unknown>;
  },
): Promise<FinalizeIvtrResult> {
  const state = await readIvtrStateRaw(taskId, options?.cwd);
  if (!state) {
    log.warn(
      { taskId, terminalStatus },
      'finalizeIvtrFromPlaybook: no ivtr_state to mirror (seed step skipped?)',
    );
    return { state: null };
  }

  // Already released — nothing to do (idempotent re-finalization).
  if (state.currentPhase === 'released') {
    return { state };
  }

  const now = new Date().toISOString();
  const agentIdentity = options?.agentIdentity ?? null;

  if (terminalStatus === 'pending_approval') {
    // The run paused on a HITL gate; a later resume turn finalizes it.
    log.info(
      { taskId },
      'finalizeIvtrFromPlaybook: run pending approval — leaving ivtr_state as-is',
    );
    return { state };
  }

  if (terminalStatus === 'failed' || terminalStatus === 'exceeded_iteration_cap') {
    // Mark the active phase entry as failed so the gate blocks completion and
    // the failure is auditable; do NOT advance currentPhase.
    const reason = options?.error ?? `cantbook run ${terminalStatus}`;
    const activeEntry = state.phaseHistory.findLast((e) => e.completedAt === null);
    if (activeEntry) {
      activeEntry.completedAt = now;
      activeEntry.passed = false;
      activeEntry.reason = `Playbook ${terminalStatus}: ${reason}`;
    }
    await writeIvtrState(state, options?.cwd);
    log.info(
      { taskId, terminalStatus, currentPhase: state.currentPhase },
      'finalizeIvtrFromPlaybook: marked active phase failed (gate stays blocking)',
    );
    return { state };
  }

  // terminalStatus === 'completed' — write the provenance evidence blob first
  // so its sha256 can be recorded on the released phase history (reproduces the
  // legacy attachment-store write). Best-effort: a store failure must not block
  // the terminal mirror, since the gate-passability fix is the load-bearing
  // half — but we surface the failure in logs.
  let evidenceRef: string | undefined;
  try {
    evidenceRef = await writeIvtrPlaybookProvenance(
      taskId,
      terminalStatus,
      options?.runId,
      options?.finalContext,
      agentIdentity,
      options?.cwd,
    );
  } catch (err) {
    log.warn(
      { taskId, err: err instanceof Error ? err.message : String(err) },
      'finalizeIvtrFromPlaybook: provenance attachment write failed (non-fatal)',
    );
  }

  // Walk every required phase to a passing entry, then mark released. The
  // E_IVTR_INCOMPLETE gate (complete.ts) requires implement/validate/test to
  // each have a passing entry AND currentPhase === 'released'.
  const required: Array<Exclude<IvtrPhase, 'released'>> = [
    'implement',
    'validate',
    'audit',
    'test',
  ];

  // Close any in-progress entry as passed (the active implement seed).
  const activeEntry = state.phaseHistory.findLast((e) => e.completedAt === null);
  if (activeEntry) {
    activeEntry.completedAt = now;
    activeEntry.passed = true;
    if (evidenceRef) activeEntry.evidenceRefs = [...activeEntry.evidenceRefs, evidenceRef];
  }

  // Ensure every required phase has at least one passing entry. Append a
  // synthetic passing entry for any phase the seeded state lacks (the cantbook
  // seed only writes the implement entry).
  for (const phase of required) {
    const hasPassed = state.phaseHistory.some((e) => e.phase === phase && e.passed === true);
    if (!hasPassed) {
      const entry: IvtrPhaseEntry = {
        phase,
        agentIdentity,
        startedAt: now,
        completedAt: now,
        passed: true,
        evidenceRefs: evidenceRef ? [evidenceRef] : [],
        reason: `Cantbook run ${options?.runId ?? '(unknown run)'} completed — phase mirrored from playbook terminal status`,
      };
      state.phaseHistory.push(entry);
    }
  }

  state.currentPhase = 'released';
  await writeIvtrState(state, options?.cwd);
  log.info(
    { taskId, runId: options?.runId, evidenceRef },
    'finalizeIvtrFromPlaybook: ivtr_state mirrored to released (gate now passes)',
  );

  const result: FinalizeIvtrResult = { state };
  if (evidenceRef !== undefined) result.evidenceRef = evidenceRef;
  return result;
}

/**
 * Write a content-addressed provenance blob for a completed cantbook IVTR run
 * to the attachment store and return its sha256.
 *
 * This reproduces the attachment-store write the legacy `autoRunGatesAndRecord`
 * / `advanceIvtr` walk performed (collapse-plan §3 mapping row "evidence refs
 * (sha256 attachments)"), so downstream observers (`cleo show --ivtr-history`,
 * release observation reads) still find content-addressed evidence for
 * autonomously-driven tasks.
 *
 * The `finalContext` snapshot is bounded to its top-level keys' JSON to avoid
 * persisting an unbounded agent context.
 *
 * @internal
 */
async function writeIvtrPlaybookProvenance(
  taskId: string,
  terminalStatus: IvtrPlaybookTerminalStatus,
  runId: string | undefined,
  finalContext: Record<string, unknown> | undefined,
  agentIdentity: string | null,
  cwd?: string,
): Promise<string> {
  const provenance = {
    kind: 'ivtr-playbook-provenance' as const,
    taskId,
    runId: runId ?? null,
    terminalStatus,
    finalizedAt: new Date().toISOString(),
    // Snapshot only the bindings the cantbook nodes emitted (bounded). Internal
    // bookkeeping keys (prefixed `__`) are stripped to keep the blob auditable.
    bindings: finalContext
      ? Object.fromEntries(Object.entries(finalContext).filter(([k]) => !k.startsWith('__')))
      : {},
  };
  const outputJson = JSON.stringify(provenance, null, 2);
  const attachmentSha256 = createHash('sha256').update(outputJson).digest('hex');

  const store = createAttachmentStore();
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
    agentIdentity ?? 'ivtr-playbook-seam',
    cwd,
  );

  return attachmentSha256;
}

/**
 * Maximum number of loop-backs allowed per phase before HITL escalation.
 *
 * The hand-rolled loop-back walk (`loopBackIvtr`) that enforced this cap was
 * deleted in T11896 (the IVTR loop now runs on the cantbook runtime). The
 * constant is RETAINED because {@link classifyReadiness} still reads it to
 * detect tasks whose `ivtr_state.loopBackCount` has reached the monotonic
 * per-target cap (the audit's "Gap A" parity check) and must escalate to HITL.
 *
 * @see packages/core/src/orchestration/classify-readiness.ts
 */
export const MAX_LOOP_BACKS_PER_PHASE = 2;

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
// FISE-2: validateSpawnRequest — Lead authorship bypass prevention (T9231 / ADR-070)
// =============================================================================

/**
 * Result of {@link validateSpawnRequest}.
 * @task T9231
 */
export interface SpawnRequestValidationResult {
  allowed: boolean;
  /** Populated when `allowed=false`. */
  code?: string;
  message?: string;
}

/**
 * Validate whether a Lead agent is permitted to write the `implemented` gate
 * for a task.
 *
 * A Lead MUST have produced at least one downstream delegate_task spawn event
 * for the target task in the current session before claiming authorship of
 * the `implemented` gate. If no such event exists, the write is blocked with
 * `E_LEAD_AUTHORSHIP_BYPASS`.
 *
 * Provider-neutral: detection uses the CLEO audit log (SQLite-backed) and the
 * `CLEO_AGENT_ROLE` environment variable — no adapter-specific API required.
 *
 * Override: `CLEO_OWNER_OVERRIDE=1` is not effective here because T1118 L4b
 * already silently blocks overrides for `lead` role — owners must use
 * `CLEO_AGENT_ROLE` unset or set to a non-restricted role to override.
 *
 * @param taskId - Task being verified.
 * @param gate - Gate being written (only `implemented` triggers this check).
 * @param sessionId - Active session ID for audit log lookup.
 * @param cwd - Project root (defaults to `process.cwd()`).
 *
 * @task T9231
 * @adr ADR-070
 */
export async function validateSpawnRequest(
  taskId: string,
  gate: string,
  sessionId: string | null | undefined,
): Promise<SpawnRequestValidationResult> {
  const role = process.env['CLEO_AGENT_ROLE'];
  const isLeadOrHigher = role === 'lead';

  if (!isLeadOrHigher || gate !== 'implemented') {
    return { allowed: true };
  }

  if (!sessionId) {
    return { allowed: true };
  }

  try {
    const { queryAudit } = await import('../audit.js');
    const sessionEntries = await queryAudit({ sessionId, taskId });
    const hasDelegateEvent = sessionEntries.some(
      (e) =>
        e.operation === 'delegate_task' ||
        (e.domain === 'orchestrate' && e.operation === 'spawn' && e.result.success),
    );

    if (!hasDelegateEvent) {
      return {
        allowed: false,
        code: 'E_LEAD_AUTHORSHIP_BYPASS',
        message:
          `Lead agent attempted to write implemented gate for ${taskId} without a ` +
          `sub-agent delegation event. Leads MUST fan out implementation to Workers ` +
          `via delegate_task before claiming the implemented gate. (T9231 / ADR-070)`,
      };
    }
  } catch {
    // Audit query failure is non-fatal — allow the write (graceful degradation)
    return { allowed: true };
  }

  return { allowed: true };
}
