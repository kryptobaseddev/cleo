/**
 * Sticky Engine Operations — EngineResult wrapper layer.
 *
 * Contains all sticky domain EngineResult wrappers migrated from
 * `packages/cleo/src/dispatch/engines/sticky-engine.ts` (ENG-MIG-10 / T1577).
 *
 * Each exported function wraps a core sticky primitive with EngineResult
 * (ADR-057 D1 uniform `(projectRoot, params)` signature where applicable).
 *
 * Importable from `@cleocode/core/internal` so the CLI dispatch layer can
 * call them without any intermediate engine file.
 *
 * @module sticky/engine-ops
 * @task T1577 — ENG-MIG-10
 * @epic T1566
 */

import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { paginate } from '../pagination.js';
import { archiveSticky } from './archive.js';
import {
  convertStickyToMemory,
  convertStickyToSessionNote,
  convertStickyToTask,
  convertStickyToTaskNote,
} from './convert.js';
import { addSticky } from './create.js';
import { listStickies } from './list.js';
import { purgeSticky } from './purge.js';
import { getSticky } from './show.js';
import type { CreateStickyParams, ListStickiesParams, StickyNote } from './types.js';

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
    return engineSuccess(sticky);
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
    return engineSuccess({ stickies, total: stickies.length });
  } catch (error) {
    return engineError('E_INTERNAL', String(error));
  }
}

/**
 * List sticky notes with optional filtering and pagination.
 *
 * Handles the dual-query pattern (filtered + unfiltered total) and applies
 * pagination, returning page metadata in the EngineResult so dispatch
 * handlers remain ≤5 LOC (ADR-058).
 *
 * @param projectRoot - Project root path
 * @param filters - Filter parameters (status, color, priority, tags)
 * @param limit - Pagination limit
 * @param offset - Pagination offset
 * @returns EngineResult with paginated stickies, total, filtered, and page metadata
 * @task T1492 ADR-058 thin-handler
 */
export async function stickyListFiltered(
  projectRoot: string,
  filters: Omit<ListStickiesParams, 'limit'>,
  limit?: number,
  offset?: number,
): Promise<EngineResult<{ stickies: StickyNote[]; total: number; filtered: number }>> {
  try {
    const filteredStickies = await listStickies(filters, projectRoot);
    const hasFilter =
      filters.status !== undefined ||
      filters.color !== undefined ||
      filters.priority !== undefined ||
      (filters.tags !== undefined && filters.tags.length > 0);
    const total = hasFilter
      ? (await listStickies({}, projectRoot)).length
      : filteredStickies.length;
    const page = paginate(filteredStickies, limit, offset);
    return engineSuccess(
      { stickies: page.items, total, filtered: filteredStickies.length },
      page.page,
    );
  } catch (error) {
    return engineError('E_INTERNAL', String(error));
  }
}

/**
 * Get a single sticky note by ID.
 *
 * @param projectRoot - Project root path
 * @param id - Sticky note ID
 * @returns EngineResult with sticky note or error
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
    return engineSuccess(sticky);
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
    return engineSuccess({ taskId: result.taskId! });
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
    return engineSuccess({ memoryId: result.memoryId! });
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
    return engineSuccess(sticky);
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
    return engineSuccess({ taskId: result.taskId! });
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
    return engineSuccess({ sessionId: result.sessionId! });
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
    return engineSuccess(sticky);
  } catch (error) {
    return engineError('E_INTERNAL', String(error));
  }
}
