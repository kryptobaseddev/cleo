/**
 * Sticky Engine — Thin wrapper layer for sticky note operations.
 *
 * Delegates all business logic to src/core/sticky/.
 * Each function catches errors from core and wraps them into EngineResult.
 *
 * @task T5280
 * @epic T5267
 */

import {
  addSticky,
  listStickies,
  getSticky,
  convertStickyToTask,
  convertStickyToMemory,
  convertStickyToTaskNote,
  convertStickyToSessionNote,
  archiveSticky,
  purgeSticky,
} from '../../core/sticky/index.js';
import type {
  CreateStickyParams,
  ListStickiesParams,
  StickyNote,
} from '../../core/sticky/types.js';
import { engineError, type EngineResult } from './_error.js';

// Re-export EngineResult for consumers
export type { EngineResult };

/**
 * Create a new sticky note.
 *
 * @param projectRoot - Project root path
 * @param params - Creation parameters
 * @returns EngineResult with created sticky note
 */
export async function stickyAdd(
  projectRoot: string,
  params: CreateStickyParams,
): Promise<EngineResult<StickyNote>> {
  try {
    const sticky = await addSticky(params, projectRoot);
    return { success: true, data: sticky };
  } catch (error) {
    return engineError('E_INTERNAL', String(error));
  }
}

/**
 * List sticky notes with optional filtering.
 *
 * @param projectRoot - Project root path
 * @param params - Filter parameters
 * @returns EngineResult with array of sticky notes
 */
export async function stickyList(
  projectRoot: string,
  params: ListStickiesParams = {},
): Promise<EngineResult<{ stickies: StickyNote[]; total: number }>> {
  try {
    const stickies = await listStickies(params, projectRoot);
    return { success: true, data: { stickies, total: stickies.length } };
  } catch (error) {
    return engineError('E_INTERNAL', String(error));
  }
}

/**
 * Get a single sticky note by ID.
 *
 * @param projectRoot - Project root path
 * @param id - Sticky note ID
 * @returns EngineResult with sticky note or null
 */
export async function stickyShow(
  projectRoot: string,
  id: string,
): Promise<EngineResult<StickyNote | null>> {
  try {
    const sticky = await getSticky(id, projectRoot);
    if (!sticky) {
      return engineError('E_NOT_FOUND', `Sticky note ${id} not found`);
    }
    return { success: true, data: sticky };
  } catch (error) {
    return engineError('E_INTERNAL', String(error));
  }
}

/**
 * Convert a sticky note to a task.
 *
 * @param projectRoot - Project root path
 * @param stickyId - Sticky note ID
 * @param title - Optional task title
 * @returns EngineResult with new task ID
 */
export async function stickyConvertToTask(
  projectRoot: string,
  stickyId: string,
  title?: string,
): Promise<EngineResult<{ taskId: string }>> {
  try {
    const result = await convertStickyToTask(stickyId, title, projectRoot);
    if (!result.success) {
      return engineError(result.error!.code, result.error!.message);
    }
    return { success: true, data: { taskId: result.taskId! } };
  } catch (error) {
    return engineError('E_INTERNAL', String(error));
  }
}

/**
 * Convert a sticky note to a memory observation.
 *
 * @param projectRoot - Project root path
 * @param stickyId - Sticky note ID
 * @param memoryType - Optional memory type
 * @returns EngineResult with new memory entry ID
 */
export async function stickyConvertToMemory(
  projectRoot: string,
  stickyId: string,
  memoryType?: string,
): Promise<EngineResult<{ memoryId: string }>> {
  try {
    const result = await convertStickyToMemory(stickyId, memoryType, projectRoot);
    if (!result.success) {
      return engineError(result.error!.code, result.error!.message);
    }
    return { success: true, data: { memoryId: result.memoryId! } };
  } catch (error) {
    return engineError('E_INTERNAL', String(error));
  }
}

/**
 * Archive a sticky note.
 *
 * @param projectRoot - Project root path
 * @param id - Sticky note ID
 * @returns EngineResult with archived sticky note
 */
export async function stickyArchive(
  projectRoot: string,
  id: string,
): Promise<EngineResult<StickyNote>> {
  try {
    const sticky = await archiveSticky(id, projectRoot);
    if (!sticky) {
      return engineError('E_NOT_FOUND', `Sticky note ${id} not found`);
    }
    return { success: true, data: sticky };
  } catch (error) {
    return engineError('E_INTERNAL', String(error));
  }
}

/**
 * Convert a sticky note to a task note.
 *
 * @param projectRoot - Project root path
 * @param stickyId - Sticky note ID
 * @param taskId - Target task ID
 * @returns EngineResult with updated task ID
 */
export async function stickyConvertToTaskNote(
  projectRoot: string,
  stickyId: string,
  taskId: string,
): Promise<EngineResult<{ taskId: string }>> {
  try {
    const result = await convertStickyToTaskNote(stickyId, taskId, projectRoot);
    if (!result.success) {
      return engineError(result.error!.code, result.error!.message);
    }
    return { success: true, data: { taskId: result.taskId! } };
  } catch (error) {
    return engineError('E_INTERNAL', String(error));
  }
}

/**
 * Convert a sticky note to a session note.
 *
 * @param projectRoot - Project root path
 * @param stickyId - Sticky note ID
 * @param sessionId - Optional target session ID
 * @returns EngineResult with session ID
 */
export async function stickyConvertToSessionNote(
  projectRoot: string,
  stickyId: string,
  sessionId?: string,
): Promise<EngineResult<{ sessionId: string }>> {
  try {
    const result = await convertStickyToSessionNote(stickyId, sessionId, projectRoot);
    if (!result.success) {
      return engineError(result.error!.code, result.error!.message);
    }
    return { success: true, data: { sessionId: result.sessionId! } };
  } catch (error) {
    return engineError('E_INTERNAL', String(error));
  }
}

/**
 * Purge (permanently delete) a sticky note.
 *
 * @param projectRoot - Project root path
 * @param id - Sticky note ID
 * @returns EngineResult with purged sticky note
 */
export async function stickyPurge(
  projectRoot: string,
  id: string,
): Promise<EngineResult<StickyNote>> {
  try {
    const sticky = await purgeSticky(id, projectRoot);
    if (!sticky) {
      return engineError('E_NOT_FOUND', `Sticky note ${id} not found`);
    }
    return { success: true, data: sticky };
  } catch (error) {
    return engineError('E_INTERNAL', String(error));
  }
}
