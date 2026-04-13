/**
 * Session Hook Handlers - Phase 2D of T5237
 *
 * Handlers that capture session lifecycle events.
 * Auto-registers on module load.
 *
 * T138: Triggers memory bridge refresh on session start and end.
 * T139: Regenerates bridge with session scope on start.
 * T144: Extracts transcript observations on session end.
 * T5158: Auto-snapshots SQLite databases (tasks.db + brain.db) via
 *        VACUUM INTO on SessionEnd to preserve a recovery point now that
 *        the databases are no longer tracked in project git (ADR-013).
 * T527: Removed duplicate session observeBrain writes — session data already
 *       lives in the sessions table; writing it again to brain_observations
 *       was pure noise.
 * T549 Wave 3-E: Fire-and-forget sleep-time consolidation on session end.
 *       Runs after backup (priority 5) so brain.db snapshot is captured first.
 * T554: Fire-and-forget LLM reflector on session end. Runs at priority 4
 *       (after consolidation at priority 5) to synthesize final session knowledge.
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
  // Auto-grade session and feed insights to brain.db (best-effort)
  try {
    const { gradeSession } = await import('../../sessions/session-grade.js');
    await gradeSession(payload.sessionId, projectRoot);
  } catch {
    // Grading must never block session end
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
 * Handle SessionEnd - snapshot SQLite databases to `.cleo/backups/sqlite/`.
 *
 * ADR-013 / T5158: `.cleo/tasks.db` and `.cleo/brain.db` are NOT tracked in
 * project git, so we need an out-of-band recovery mechanism. This handler
 * calls `vacuumIntoBackupAll` with `force: true` at every session end to
 * guarantee a fresh point-in-time snapshot of both databases.
 *
 * Rotation (MAX_SNAPSHOTS = 10 per database) is handled inside
 * `sqlite-backup.ts`. Failures here are non-fatal: a backup error must
 * never block session end.
 *
 * The `vacuumIntoBackupAll` import is deferred to call time so tests that
 * auto-load session-hooks (e.g. via `handlers/index.ts`) do not have to
 * mock every transitive dependency of `sqlite-backup.ts` at hoisted
 * `vi.mock` time.
 */
export async function handleSessionEndBackup(
  projectRoot: string,
  _payload: SessionEndPayload,
): Promise<void> {
  try {
    const { vacuumIntoBackupAll } = await import('../../store/sqlite-backup.js');
    await vacuumIntoBackupAll({ cwd: projectRoot, force: true });
  } catch {
    // Backup failures are best-effort — never block session end on them.
  }
}

/**
 * Handle SessionEnd — fire-and-forget sleep-time memory consolidation.
 *
 * T549 Wave 3-E: Runs the full consolidation pipeline (dedup, quality recompute,
 * tier promotion, contradiction detection, soft eviction, graph strengthening,
 * summary generation) in the background after the session backup has completed.
 *
 * Uses setImmediate to yield control so the session end flow completes before
 * consolidation begins. Consolidation errors are caught and logged to console.warn
 * — they MUST NOT block session end or throw to callers.
 *
 * Priority 5 ensures this runs last (after backup at priority 10).
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

// Lower priority (10) runs AFTER the brain/memory-bridge handlers so the
// snapshot captures the most up-to-date brain.db state including the
// SessionEnd observation just written by handleSessionEnd above.
hooks.register({
  id: 'backup-session-end',
  event: 'SessionEnd',
  handler: handleSessionEndBackup,
  priority: 10,
});

// Priority 5 runs AFTER backup (priority 10) — consolidation is purely
// additive and should not delay the backup point-in-time snapshot.
hooks.register({
  id: 'consolidation-session-end',
  event: 'SessionEnd',
  handler: handleSessionEndConsolidation,
  priority: 5,
});

// Priority 4 runs AFTER consolidation (priority 5) — reflector synthesizes
// the final session knowledge using observations that consolidation may have
// updated (tier promotions, dedup).
hooks.register({
  id: 'reflector-session-end',
  event: 'SessionEnd',
  handler: handleSessionEndReflector,
  priority: 4,
});
