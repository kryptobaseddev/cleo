/**
 * Session snapshot serialization and restoration.
 *
 * Provides `serializeSession()` and `restoreSession()` for full session
 * state capture and hydration. Designed for CleoOS agent session persistence:
 * when an agent dies, CleoOS serializes the session snapshot, and when a new
 * agent connects, it restores the snapshot to resume seamlessly.
 *
 * The snapshot captures everything needed to resume work:
 * - Full session object (scope, taskWork, notes, stats)
 * - Handoff data (completed tasks, decisions, next suggested)
 * - Brain context (recent observations linked to this session)
 * - Active task state (current focus, blockers)
 *
 * @module sessions/snapshot
 */

import type { Session } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import type { DataAccessor } from '../store/data-accessor.js';
import { getAccessor } from '../store/data-accessor.js';
import { getDecisionLog } from './decisions.js';
import { computeHandoff, type HandoffData } from './handoff.js';

// ============================================================================
// Snapshot types
// ============================================================================

/** Version of the snapshot schema. Increment on breaking changes. */
export const SNAPSHOT_VERSION = 1;

/** A decision recorded during the session. */
export interface SnapshotDecision {
  /** Decision text. */
  decision: string;
  /** Rationale for the decision. */
  rationale: string;
  /** Task ID context. */
  taskId: string;
  /** When the decision was recorded. */
  recordedAt: string;
}

/** Brain observation linked to this session. */
export interface SnapshotObservation {
  /** Observation ID. */
  id: string;
  /** Observation text. */
  text: string;
  /** Observation type (discovery, change, feature, etc.). */
  type: string;
  /** When the observation was created. */
  createdAt: string;
}

/** Active task context at snapshot time. */
export interface SnapshotTaskContext {
  /** Task ID currently in focus. */
  taskId: string;
  /** Task title. */
  title: string;
  /** Task status. */
  status: string;
  /** Task priority. */
  priority: string;
  /** Task description (truncated to save space). */
  description: string;
  /** Acceptance criteria if any. */
  acceptance?: string;
}

/**
 * Complete session snapshot — everything needed to resume.
 *
 * This is the serialization format. It is JSON-safe and can be stored
 * in a file, database column, or transmitted over the network.
 */
export interface SessionSnapshot {
  /** Schema version for forward compatibility. */
  version: number;
  /** When the snapshot was created. */
  capturedAt: string;
  /** The full session object. */
  session: Session;
  /** Computed handoff data. */
  handoff: HandoffData;
  /** Decisions recorded in this session. */
  decisions: SnapshotDecision[];
  /** Recent brain observations linked to this session. */
  observations: SnapshotObservation[];
  /** Current task context (if a task is focused). */
  activeTask: SnapshotTaskContext | null;
  /** Session duration in minutes at snapshot time. */
  durationMinutes: number;
}

/** Options for serializing a session. */
export interface SerializeOptions {
  /** Session ID to serialize. If omitted, uses the active session. */
  sessionId?: string;
  /** Maximum number of brain observations to include. Default: 10. */
  maxObservations?: number;
  /** Maximum description length for active task. Default: 500. */
  maxDescriptionLength?: number;
}

/** Options for restoring a session. */
export interface RestoreOptions {
  /** Agent identifier for the new agent taking over. */
  agent?: string;
  /** Whether to resume the session (set status to active). Default: true. */
  activate?: boolean;
}

// ============================================================================
// Serialize
// ============================================================================

/**
 * Serialize a session into a complete snapshot.
 *
 * Captures the full session state including handoff data, decisions,
 * brain observations, and active task context. The result is a
 * JSON-serializable object that can be stored and later restored.
 *
 * @param projectRoot - Project root directory
 * @param options - Serialization options
 * @returns Complete session snapshot
 */
export async function serializeSession(
  projectRoot: string,
  options: SerializeOptions = {},
  accessor?: DataAccessor,
): Promise<SessionSnapshot> {
  const acc = accessor ?? (await getAccessor(projectRoot));
  const maxObs = options.maxObservations ?? 10;
  const maxDescLen = options.maxDescriptionLength ?? 500;

  // Find the session
  const sessions = await acc.loadSessions();
  let session: Session | undefined;

  if (options.sessionId) {
    session = sessions.find((s) => s.id === options.sessionId);
  } else {
    // Find the active session
    session = sessions
      .filter((s) => s.status === 'active')
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0];
  }

  if (!session) {
    throw new CleoError(
      ExitCode.SESSION_NOT_FOUND,
      options.sessionId
        ? `Session '${options.sessionId}' not found`
        : 'No active session to serialize',
      { fix: "Use 'cleo session list' to see available sessions" },
    );
  }

  // Compute handoff data
  const handoff = await computeHandoff(projectRoot, { sessionId: session.id });

  // Get decisions
  const decisionLog = await getDecisionLog(projectRoot, { sessionId: session.id });
  const decisions: SnapshotDecision[] = decisionLog.map((d) => ({
    decision: d.decision,
    rationale: d.rationale,
    taskId: d.taskId,
    recordedAt: d.timestamp ?? new Date().toISOString(),
  }));

  // Get brain observations linked to this session (best-effort)
  let observations: SnapshotObservation[] = [];
  try {
    const { searchBrainCompact } = await import('../memory/brain-retrieval.js');
    const results = await searchBrainCompact(projectRoot, {
      query: session.id,
      limit: maxObs,
      tables: ['observations'],
    });
    if (Array.isArray(results)) {
      observations = results.map(
        (r: { id: string; text?: string; type?: string; createdAt?: string }) => ({
          id: r.id,
          text: r.text ?? '',
          type: r.type ?? 'discovery',
          createdAt: r.createdAt ?? '',
        }),
      );
    }
  } catch {
    // Brain search is best-effort — snapshot works without it
  }

  // Get active task context
  let activeTask: SnapshotTaskContext | null = null;
  if (session.taskWork?.taskId) {
    try {
      const { tasks } = await acc.queryTasks({});
      const task = tasks.find((t) => t.id === session.taskWork?.taskId);
      if (task) {
        const desc = task.description ?? '';
        activeTask = {
          taskId: task.id,
          title: task.title,
          status: task.status,
          priority: task.priority ?? 'medium',
          description: desc.length > maxDescLen ? desc.slice(0, maxDescLen) + '...' : desc,
          acceptance: Array.isArray(task.acceptance) ? task.acceptance.join('\n') : (task.acceptance ?? undefined),
        };
      }
    } catch {
      // Task lookup is best-effort
    }
  }

  // Compute duration
  const startTime = new Date(session.startedAt).getTime();
  const now = Date.now();
  const durationMinutes = Math.round((now - startTime) / 60_000);

  return {
    version: SNAPSHOT_VERSION,
    capturedAt: new Date().toISOString(),
    session,
    handoff,
    decisions,
    observations,
    activeTask,
    durationMinutes,
  };
}

// ============================================================================
// Restore
// ============================================================================

/**
 * Restore a session from a snapshot.
 *
 * Hydrates a session from a previously serialized snapshot. The session
 * is re-inserted into the sessions store and optionally activated.
 * Brain observations from the snapshot are NOT re-inserted (they already
 * exist in brain.db) — only the session state is restored.
 *
 * @param projectRoot - Project root directory
 * @param snapshot - The snapshot to restore from
 * @param options - Restoration options
 * @returns The restored session
 */
export async function restoreSession(
  projectRoot: string,
  snapshot: SessionSnapshot,
  options: RestoreOptions = {},
  accessor?: DataAccessor,
): Promise<Session> {
  // Validate snapshot version
  if (snapshot.version > SNAPSHOT_VERSION) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Snapshot version ${snapshot.version} is newer than supported version ${SNAPSHOT_VERSION}`,
      { fix: 'Upgrade @cleocode/core to a newer version that supports this snapshot format' },
    );
  }

  const acc = accessor ?? (await getAccessor(projectRoot));
  const activate = options.activate ?? true;

  // Check for active session conflict
  if (activate) {
    const sessions = await acc.loadSessions();
    const scope = snapshot.session.scope;
    const activeConflict = sessions.find(
      (s) =>
        s.status === 'active' &&
        s.scope.type === scope.type &&
        s.scope.epicId === scope.epicId &&
        s.id !== snapshot.session.id,
    );
    if (activeConflict) {
      throw new CleoError(
        ExitCode.SCOPE_CONFLICT,
        `Active session '${activeConflict.id}' already exists for scope ${scope.type}${scope.epicId ? ':' + scope.epicId : ''}`,
        {
          fix: `End the active session first with 'cleo session end' or restore without activating`,
          alternatives: [
            { action: 'End conflicting session', command: 'cleo session end' },
            { action: 'Restore without activating', command: 'Restore with activate: false' },
          ],
        },
      );
    }
  }

  // Reconstruct the session
  const restoredSession: Session = {
    ...snapshot.session,
    status: activate ? 'active' : snapshot.session.status,
    notes: [
      ...(snapshot.session.notes ?? []),
      `Restored from snapshot at ${new Date().toISOString()} (captured ${snapshot.capturedAt}, duration ${snapshot.durationMinutes}m)`,
    ],
    resumeCount: (snapshot.session.resumeCount ?? 0) + 1,
  };

  // Update agent if a new one is taking over
  if (options.agent) {
    restoredSession.agent = options.agent;
    restoredSession.notes = [
      ...(restoredSession.notes ?? []),
      `Agent handoff: ${snapshot.session.agent ?? 'unknown'} → ${options.agent}`,
    ];
  }

  // Store the handoff data for context
  restoredSession.handoffJson = JSON.stringify(snapshot.handoff);

  // Persist
  await acc.upsertSingleSession(restoredSession);

  // Dispatch hook (best-effort)
  try {
    const { hooks } = await import('../hooks/registry.js');
    await hooks.dispatch('onSessionStart', projectRoot, {
      timestamp: new Date().toISOString(),
      sessionId: restoredSession.id,
      name: restoredSession.name,
      scope: restoredSession.scope,
      agent: restoredSession.agent,
      restored: true,
      snapshotCapturedAt: snapshot.capturedAt,
    });
  } catch {
    // Hooks are best-effort
  }

  return restoredSession;
}
