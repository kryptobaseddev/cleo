/**
 * Sticky Note Conversion
 *
 * Converts sticky notes to tasks or memory entries.
 *
 * @task T5280
 * @epic T5267
 */

import type { Session } from '@cleocode/contracts';
import { getBrainAccessor } from '../store/memory-accessor.js';
import type { BrainAttentionRow } from '../store/memory-schema.js';
import type { ConvertedTarget } from './types.js';

/**
 * Convert a sticky note to a task.
 *
 * @param stickyId - Sticky note ID
 * @param taskTitle - Optional task title (defaults to sticky content)
 * @param projectRoot - Project root path
 * @returns Result with new task ID
 */
export async function convertStickyToTask(
  stickyId: string,
  taskTitle: string | undefined,
  projectRoot: string,
): Promise<{ success: boolean; taskId?: string; error?: { code: string; message: string } }> {
  const accessor = await getBrainAccessor(projectRoot);

  // Get the sticky note
  const sticky = await accessor.getStickyNote(stickyId);
  if (!sticky) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: `Sticky note ${stickyId} not found` },
    };
  }

  if (sticky.status !== 'active') {
    return {
      success: false,
      error: {
        code: 'E_INVALID_STATE',
        message: `Cannot convert sticky note with status: ${sticky.status}`,
      },
    };
  }

  // Import tasks module dynamically to avoid circular dependency
  const { addTask } = await import('../tasks/add.js');

  const title = taskTitle || sticky.content.slice(0, 50);
  const description = sticky.content;

  try {
    const result = await addTask(
      {
        title,
        description,
        labels: sticky.tagsJson ? JSON.parse(sticky.tagsJson) : undefined,
      },
      projectRoot,
    );

    // Update sticky note status
    const convertedTo: ConvertedTarget = { type: 'task', id: result.task.id };
    await accessor.updateStickyNote(stickyId, {
      status: 'converted',
      convertedToJson: JSON.stringify(convertedTo),
    });

    return { success: true, taskId: result.task.id };
  } catch (error) {
    return { success: false, error: { code: 'E_CONVERT_FAILED', message: String(error) } };
  }
}

/**
 * Convert a sticky note to a memory observation.
 *
 * @param stickyId - Sticky note ID
 * @param memoryType - Optional memory type
 * @param projectRoot - Project root path
 * @returns Result with new memory entry ID
 */
export async function convertStickyToMemory(
  stickyId: string,
  memoryType: string | undefined,
  projectRoot: string,
): Promise<{ success: boolean; memoryId?: string; error?: { code: string; message: string } }> {
  const accessor = await getBrainAccessor(projectRoot);

  // Get the sticky note
  const sticky = await accessor.getStickyNote(stickyId);
  if (!sticky) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: `Sticky note ${stickyId} not found` },
    };
  }

  if (sticky.status !== 'active') {
    return {
      success: false,
      error: {
        code: 'E_INVALID_STATE',
        message: `Cannot convert sticky note with status: ${sticky.status}`,
      },
    };
  }

  // Import memory module dynamically to avoid circular dependency
  const { observeBrain } = await import('../memory/brain-retrieval.js');

  try {
    const result = await observeBrain(projectRoot, {
      text: sticky.content,
      title: sticky.content.slice(0, 50),
      type:
        (memoryType as 'discovery' | 'change' | 'feature' | 'bugfix' | 'decision' | 'refactor') ??
        'discovery',
    });

    // Update sticky note status
    const convertedTo: ConvertedTarget = { type: 'memory', id: result.id };
    await accessor.updateStickyNote(stickyId, {
      status: 'converted',
      convertedToJson: JSON.stringify(convertedTo),
    });

    return { success: true, memoryId: result.id };
  } catch (error) {
    return { success: false, error: { code: 'E_CONVERT_FAILED', message: String(error) } };
  }
}

/**
 * Convert a sticky note to a task note.
 *
 * @param stickyId - Sticky note ID
 * @param taskId - Target task ID
 * @param projectRoot - Project root path
 * @returns Result with updated task ID
 */
export async function convertStickyToTaskNote(
  stickyId: string,
  taskId: string,
  projectRoot: string,
): Promise<{ success: boolean; taskId?: string; error?: { code: string; message: string } }> {
  const accessor = await getBrainAccessor(projectRoot);

  // Get the sticky note
  const sticky = await accessor.getStickyNote(stickyId);
  if (!sticky) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: `Sticky note ${stickyId} not found` },
    };
  }

  if (sticky.status !== 'active') {
    return {
      success: false,
      error: {
        code: 'E_INVALID_STATE',
        message: `Cannot convert sticky note with status: ${sticky.status}`,
      },
    };
  }

  // Import task module dynamically
  const { updateTask } = await import('../tasks/update.js');

  try {
    const result = await updateTask(
      {
        taskId,
        notes: sticky.content,
      },
      projectRoot,
    );

    if (!result.task) {
      return {
        success: false,
        error: { code: 'E_CONVERT_FAILED', message: `Failed to update task ${taskId}` },
      };
    }

    // Update sticky note status
    const convertedTo: ConvertedTarget = { type: 'task_note', id: taskId };
    await accessor.updateStickyNote(stickyId, {
      status: 'converted',
      convertedToJson: JSON.stringify(convertedTo),
    });

    return { success: true, taskId };
  } catch (error) {
    return { success: false, error: { code: 'E_CONVERT_FAILED', message: String(error) } };
  }
}

/**
 * Convert a sticky note to a session note.
 *
 * @param stickyId - Sticky note ID
 * @param sessionId - Optional target session ID (defaults to current active session)
 * @param projectRoot - Project root path
 * @returns Result with session ID
 */
export async function convertStickyToSessionNote(
  stickyId: string,
  sessionId: string | undefined,
  projectRoot: string,
): Promise<{ success: boolean; sessionId?: string; error?: { code: string; message: string } }> {
  const accessor = await getBrainAccessor(projectRoot);

  // Get the sticky note
  const sticky = await accessor.getStickyNote(stickyId);
  if (!sticky) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: `Sticky note ${stickyId} not found` },
    };
  }

  if (sticky.status !== 'active') {
    return {
      success: false,
      error: {
        code: 'E_INVALID_STATE',
        message: `Cannot convert sticky note with status: ${sticky.status}`,
      },
    };
  }

  const { readSessions, saveSessions, sessionStatus } = await import('../sessions/index.js');

  try {
    // We update the session object's notes array directly
    const sessions = await readSessions(projectRoot);

    // Find target session
    let targetSessionId = sessionId;
    if (!targetSessionId) {
      const activeSession = await sessionStatus(projectRoot, {});
      if (activeSession) {
        targetSessionId = activeSession.id;
      }
    }

    if (!targetSessionId) {
      return {
        success: false,
        error: {
          code: 'E_NO_ACTIVE_SESSION',
          message: 'No active session found and no target session provided',
        },
      };
    }

    const session = sessions.find((s: Session) => s.id === targetSessionId);
    if (!session) {
      return {
        success: false,
        error: { code: 'E_NOT_FOUND', message: `Session ${targetSessionId} not found` },
      };
    }

    if (!session.notes) {
      session.notes = [];
    }

    const timestampedNote = `${new Date()
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, ' UTC')}: ${sticky.content}`;
    session.notes.push(timestampedNote);

    await saveSessions(sessions, projectRoot);

    // Update sticky note status
    const convertedTo: ConvertedTarget = { type: 'session_note', id: targetSessionId };
    await accessor.updateStickyNote(stickyId, {
      status: 'converted',
      convertedToJson: JSON.stringify(convertedTo),
    });

    return { success: true, sessionId: targetSessionId };
  } catch (error) {
    return { success: false, error: { code: 'E_CONVERT_FAILED', message: String(error) } };
  }
}

/**
 * Promote a Tier-2 attention entry to a durable BRAIN observation — the
 * dream-cycle's promotion conduit (E3 · Epic T11289 · Saga T11283).
 *
 * Stickies remain the conduit (council verdict): rather than build a parallel
 * promotion path, this reuses the exact `convertStickyToMemory` shape — write a
 * `brain_observations` row via `observeBrain`, then attach provenance — so the
 * single salient-→-durable path is shared. The caller
 * ({@link consolidateAttention}) is responsible for flipping the source row to
 * `status='consolidated'` after a successful promotion (idempotency lives with
 * the buffer-status transition, not here).
 *
 * ## Leakage preservation (Epic T11289 AC; T11383)
 *
 * The promoted observation carries the entry's scope as structured provenance:
 *
 * - `crossRef` records `attention:<id>` + `scope:<kind>:<id>` so the durable row
 *   is traceable back to the exact scope key it came from.
 * - `agent` records the writing agent's id so an agent-scoped jot's durable form
 *   is attributed to that agent, never surfaced under another agent's identity.
 * - `provenanceChain` records the source attention id.
 *
 * Because the scope key travels with the observation, agent A's promoted entry
 * can never be mis-attributed to agent B's scope — the structural read-time
 * guarantee of the buffer is carried forward into Tier-3.
 *
 * @param row - The attention entry to promote (already scored + verdict='promote').
 * @param projectRoot - Project root path (brain.db resolution).
 * @returns Result with the new durable observation id, or a structured error.
 * @task T11383
 * @epic T11289
 */
export async function promoteAttentionToMemory(
  row: BrainAttentionRow,
  projectRoot: string,
): Promise<{ success: boolean; memoryId?: string; error?: { code: string; message: string } }> {
  // Import memory module dynamically to avoid a circular dependency
  // (memory → sticky → memory).
  const { observeBrain } = await import('../memory/brain-retrieval.js');

  // Scope provenance carried into the durable row — the leakage boundary.
  const scopeRef = `scope:${row.scopeKind}:${row.scopeId}`;
  const attentionRef = `attention:${row.id}`;

  try {
    const result = await observeBrain(projectRoot, {
      text: row.content,
      title: row.content.slice(0, 50),
      type: 'discovery',
      sourceType: 'agent',
      origin: 'auto-extract',
      // Provenance: trace back to the exact scope key + source jot.
      crossRef: [attentionRef, scopeRef],
      provenanceChain: [row.id],
      // Attribute the durable row to the writing agent so an agent-scoped jot
      // never surfaces under a different agent's identity.
      ...(row.agentId ? { agent: row.agentId } : {}),
      ...(row.sessionId ? { sourceSessionId: row.sessionId } : {}),
    });

    return { success: true, memoryId: result.id };
  } catch (error) {
    return { success: false, error: { code: 'E_CONVERT_FAILED', message: String(error) } };
  }
}
