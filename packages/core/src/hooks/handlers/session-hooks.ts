/**
 * Session Hook Handlers - Phase 2D of T5237
 *
 * Handlers that capture session lifecycle events.
 * Auto-registers on module load.
 *
 * T138: Triggers memory bridge refresh on session start and end.
 * T139: Regenerates bridge with session scope on start.
 * T144: Extracts transcript observations on session end.
 * T5158: The session-end SQLite snapshot used to live here. T12508 moved it
 *        to `sessions/session-end-snapshot.ts`, called by `endSession` after
 *        the session is persisted (hook handlers run concurrently, before
 *        the session row is written).
 * T527: Removed duplicate session observeBrain writes — session data already
 *       lives in the sessions table; writing it again to brain_observations
 *       was pure noise.
 * T549 Wave 3-E: Fire-and-forget sleep-time consolidation on session end.
 *       Priority 5.
 * T554: Fire-and-forget LLM reflector on session end. Runs at priority 4
 *       (after consolidation at priority 5) to synthesize final session knowledge.
 * T732: Write `transcript_pending_extraction` tombstone on session end (priority 3).
 *       Runs after reflector so it is the last scheduled operation. Records the
 *       session JSONL path so `cleo transcript scan --pending` can list queued work.
 * T1263: Append session journal entry at priority 2 (last in pipeline).
 *        Absorbs T1262 session-end hook: calls scanBrainNoise and embeds
 *        doctorSummary in each session_end journal entry.
 *        MUST use `await` (not setImmediate) — process exits after this hook.
 */

import { hooks } from '../registry.js';
import type { SessionEndPayload, SessionStartPayload } from '../types.js';
import { maybeRefreshMemoryBridge } from './memory-bridge-refresh.js';

/**
 * Handle SessionStart - refresh memory bridge on session start.
 *
 * T138: Refresh memory bridge on session start.
 * T139: Regenerate bridge with session scope context.
 * T527: Removed duplicate observeBrain write — session data is already
 *       persisted in the sessions table.
 */
export async function handleSessionStart(
  projectRoot: string,
  _payload: SessionStartPayload,
): Promise<void> {
  // T138/T139: Refresh memory bridge after session starts (best-effort)
  await maybeRefreshMemoryBridge(projectRoot);
}

/**
 * Handle SessionEnd - run post-session tasks and refresh memory bridge.
 *
 * T138: Refresh memory bridge after session ends.
 * T144: Extract transcript observations via cross-provider adapter.
 * T527: Removed duplicate observeBrain write — session data is already
 *       persisted in the sessions table.
 */
export async function handleSessionEnd(
  projectRoot: string,
  payload: SessionEndPayload,
): Promise<void> {
  // Auto-grade session and feed insights to brain.db (best-effort).
  // Skip during vitest runs: gradeSession calls queryAudit which opens
  // .cleo/tasks.db at the process CWD (not the test temp dir), triggering
  // the T9001 isolation guard and polluting test output with WARN logs.
  if (!process.env['VITEST']) {
    try {
      const { gradeSession } = await import('../../sessions/session-grade.js');
      await gradeSession(payload.sessionId, projectRoot);
    } catch {
      // Grading must never block session end
    }
  }

  // T144: Cross-provider transcript extraction (best-effort)
  try {
    const { loadConfig } = await import('../../config.js');
    const config = await loadConfig(projectRoot);
    if (config.brain?.autoCapture) {
      const { AdapterManager } = await import('../../adapters/index.js');
      const manager = AdapterManager.getInstance(projectRoot);
      const activeAdapter = manager.getActive();
      const hookProvider = activeAdapter?.hooks;
      if (hookProvider && typeof hookProvider.getTranscript === 'function') {
        const transcript = await hookProvider.getTranscript(payload.sessionId, projectRoot);
        if (transcript) {
          const { extractFromTranscript } = await import('../../memory/auto-extract.js');
          await extractFromTranscript(projectRoot, payload.sessionId, transcript);
        }
      }
    }
  } catch {
    // Graceful no-op: transcript extraction must never block session end
  }

  // T138: Refresh memory bridge after session ends (best-effort)
  await maybeRefreshMemoryBridge(projectRoot);
}

/**
 * Handle SessionEnd — fire-and-forget sleep-time memory consolidation.
 *
 * T549 Wave 3-E: Runs the full consolidation pipeline (dedup, quality recompute,
 * tier promotion, contradiction detection, soft eviction, graph strengthening,
 * summary generation) in the background.
 *
 * Uses setImmediate to yield control so the session end flow completes before
 * consolidation begins. Consolidation errors are caught and logged to console.warn
 * — they MUST NOT block session end or throw to callers.
 *
 * Registered at priority 5. Priorities order the handler list only; dispatch
 * runs all SessionEnd handlers concurrently (see the NOTE at registration).
 */
export async function handleSessionEndConsolidation(
  projectRoot: string,
  _payload: SessionEndPayload,
): Promise<void> {
  // Schedule consolidation to run after the current event loop turn.
  // This ensures the session end response reaches the caller before
  // consolidation begins, matching the "sleep-time compute" pattern.
  setImmediate(async () => {
    try {
      const { runConsolidation } = await import('../../memory/brain-lifecycle.js');
      await runConsolidation(projectRoot);
    } catch (err) {
      console.warn('[consolidation] Session-end consolidation failed:', err);
    }
  });
}

/**
 * Handle SessionEnd — fire-and-forget LLM Observer compression.
 *
 * T740: GAP-6 fix — Observer was only triggered on task completion when
 * observation count >= threshold (default 10). Sessions with < 10 observations
 * never got compression. This hook runs Observer unconditionally at session end
 * with a threshold override of 1, ensuring even short sessions get compressed.
 *
 * Priority 4.5 (between consolidation at 5 and reflector at 4) so Observer
 * compresses the raw observations before Reflector synthesizes patterns/learnings
 * from them. This matches the intended pipeline order.
 *
 * Uses setImmediate to yield control before the LLM call. Errors are caught
 * and logged — they MUST NOT block session end or throw to callers.
 */
export async function handleSessionEndObserver(
  projectRoot: string,
  payload: SessionEndPayload,
): Promise<void> {
  setImmediate(async () => {
    try {
      const { runObserver } = await import('../../memory/observer-reflector.js');
      // thresholdOverride: 1 ensures Observer always fires at session end
      // regardless of observation count (bypassing the default threshold of 10).
      await runObserver(projectRoot, payload.sessionId, { thresholdOverride: 1 });
    } catch (err) {
      console.warn('[observer] Session-end observer failed:', err);
    }
  });
}

/**
 * Handle SessionEnd — fire-and-forget LLM reflector synthesis.
 *
 * T554: Runs the Reflector after the consolidation pass (priority 5) to
 * synthesize session observations into durable patterns and learnings.
 *
 * Uses setImmediate to yield control before the LLM call. Errors are caught
 * and logged — they MUST NOT block session end or throw to callers.
 *
 * Priority 4 ensures this runs after consolidation (priority 5).
 */
export async function handleSessionEndReflector(
  projectRoot: string,
  payload: SessionEndPayload,
): Promise<void> {
  setImmediate(async () => {
    try {
      const { runReflector } = await import('../../memory/observer-reflector.js');
      await runReflector(projectRoot, payload.sessionId);
    } catch (err) {
      console.warn('[reflector] Session-end reflector failed:', err);
    }
  });
}

/**
 * Handle SessionEnd — write a `transcript_pending_extraction` record to brain_observations.
 *
 * T732: Records the session JSONL path so the warm-tier extractor and
 * `cleo transcript scan --pending` can locate queued sessions.
 *
 * The record is idempotent: re-running session end for the same session_id
 * updates the timestamp but does not create a duplicate (content-hash dedup
 * in observeBrain handles this automatically).
 *
 * Priority 3 — runs after reflector (priority 4) so it is the last step in
 * the session-end pipeline.
 *
 * Uses setImmediate to yield so the session-end response reaches the CLI
 * before the brain write occurs.
 */
export async function handleSessionEndTranscriptSchedule(
  projectRoot: string,
  payload: SessionEndPayload,
): Promise<void> {
  setImmediate(async () => {
    try {
      const { findSessionTranscriptPath } = await import('../../memory/transcript-scanner.js');
      const filePath = await findSessionTranscriptPath(payload.sessionId);

      // If we can't locate the JSONL path, skip — extractor will handle it in migration
      if (!filePath) return;

      const { observeBrain } = await import('../../memory/brain-retrieval.js');
      await observeBrain(projectRoot, {
        title: `transcript_pending_extraction:${payload.sessionId}`,
        text: `Session ${payload.sessionId} transcript queued for warm-tier extraction. File: ${filePath}`,
        type: 'discovery',
        sourceType: 'agent',
        sourceSessionId: payload.sessionId,
      });
    } catch (err) {
      // Best-effort — never block session end
      console.warn('[transcript-schedule] Failed to queue transcript:', err);
    }
  });
}

/**
 * Handle SessionEnd — append a session journal entry to `.cleo/session-journals/`.
 *
 * T1263 PSYCHE E6: Writes a `session_end` JSONL entry capturing session metadata
 * and the compact result of `scanBrainNoise` (T1262 absorption).
 *
 * **MUST use synchronous `await`** — this hook runs at priority 2, immediately
 * before process.exit. Using `setImmediate` here would silently drop the write.
 *
 * Runs at priority 2 — the last synchronous hook in the session-end pipeline,
 * alongside consolidation, observer, reflector and transcript scheduling
 * (dispatch runs SessionEnd handlers concurrently, so none is guaranteed to
 * have finished first).
 */
export async function handleSessionEndJournal(
  projectRoot: string,
  payload: SessionEndPayload,
): Promise<void> {
  try {
    const { SESSION_JOURNAL_SCHEMA_VERSION } = await import(
      '@cleocode/contracts/session-journal.js'
    );
    const { appendSessionJournalEntry } = await import('../../sessions/session-journal.js');

    // Run brain-noise scan (T1262 absorption) — best-effort
    let doctorSummary:
      | {
          isClean: boolean;
          findingsCount: number;
          patterns: string[];
          totalScanned: number;
        }
      | undefined;
    try {
      const { scanBrainNoise } = await import('../../memory/brain-doctor.js');
      const scanResult = await scanBrainNoise(projectRoot);
      doctorSummary = {
        isClean: scanResult.isClean,
        findingsCount: scanResult.findings.length,
        patterns: scanResult.findings.map((f) => f.pattern),
        totalScanned: scanResult.totalScanned,
      };
    } catch {
      // scanBrainNoise failures must never block journal write
    }

    // Detect agent identifier from environment
    const agentIdentifier =
      process.env.CLEO_AGENT_ID ?? process.env.CLAUDE_CODE_AGENT_ID ?? undefined;

    await appendSessionJournalEntry(projectRoot, {
      schemaVersion: SESSION_JOURNAL_SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      sessionId: payload.sessionId,
      eventType: 'session_end',
      agentIdentifier,
      providerId: payload.providerId,
      duration: payload.duration,
      tasksCompleted: payload.tasksCompleted,
      ...(doctorSummary !== undefined ? { doctorSummary } : {}),
    });
  } catch {
    // Journal write must never block session end — silently swallow
  }
}

// Register handlers on module load
hooks.register({
  id: 'brain-session-start',
  event: 'SessionStart',
  handler: handleSessionStart,
  priority: 100,
});

hooks.register({
  id: 'brain-session-end',
  event: 'SessionEnd',
  handler: handleSessionEnd,
  priority: 100,
});

// NOTE (T12508): `hooks.dispatch` runs every handler for an event
// CONCURRENTLY (`Promise.allSettled`). `priority` orders the handler list,
// not execution — a handler can never rely on another having finished. The
// session-end SQLite snapshot is therefore NOT a hook: `endSession` calls
// `snapshotAfterSessionEnd` itself, after the session is persisted.
hooks.register({
  id: 'consolidation-session-end',
  event: 'SessionEnd',
  handler: handleSessionEndConsolidation,
  priority: 5,
});

// T740: Priority 4.5 runs AFTER consolidation (priority 5) and BEFORE
// reflector (priority 4). Observer compresses raw observations so Reflector
// sees the compressed form, matching the intended pipeline order.
// Threshold override = 1: Observer fires unconditionally (even < 10 obs).
hooks.register({
  id: 'observer-session-end',
  event: 'SessionEnd',
  handler: handleSessionEndObserver,
  priority: 4.5,
});

// Priority 4 runs AFTER observer (priority 4.5) — reflector synthesizes
// the final session knowledge using observations that observer may have
// already compressed.
hooks.register({
  id: 'reflector-session-end',
  event: 'SessionEnd',
  handler: handleSessionEndReflector,
  priority: 4,
});

// Priority 3 — T732: queue transcript for warm-tier extraction. Runs last so
// the tombstone captures the completed session state (handlers run concurrently;
// see the NOTE above).
hooks.register({
  id: 'transcript-schedule-session-end',
  event: 'SessionEnd',
  handler: handleSessionEndTranscriptSchedule,
  priority: 3,
});

// Priority 2 — T1263: append session journal entry LAST in the pipeline.
// MUST use await (not setImmediate) — process exits after this hook fires.
// Absorbs T1262 session-end doctor integration: embeds scanBrainNoise result.
hooks.register({
  id: 'journal-session-end',
  event: 'SessionEnd',
  handler: handleSessionEndJournal,
  priority: 2,
});
