/**
 * Sticky Note Conversion
 *
 * Converts sticky notes to tasks or memory entries.
 *
 * @task T5280
 * @epic T5267
 */

import { getBrainAccessor } from '../../store/brain-accessor.js';
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
    return { success: false, error: { code: 'E_NOT_FOUND', message: `Sticky note ${stickyId} not found` } };
  }

  if (sticky.status !== 'active') {
    return { success: false, error: { code: 'E_INVALID_STATE', message: `Cannot convert sticky note with status: ${sticky.status}` } };
  }

  // Import tasks module dynamically to avoid circular dependency
  const { addTask } = await import('../tasks/add.js');

  const title = taskTitle || sticky.content.slice(0, 50);
  const description = sticky.content;

  try {
    const result = await addTask({
      title,
      description,
      labels: sticky.tagsJson ? JSON.parse(sticky.tagsJson) : undefined,
    }, projectRoot);

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
    return { success: false, error: { code: 'E_NOT_FOUND', message: `Sticky note ${stickyId} not found` } };
  }

  if (sticky.status !== 'active') {
    return { success: false, error: { code: 'E_INVALID_STATE', message: `Cannot convert sticky note with status: ${sticky.status}` } };
  }

  // Import memory module dynamically to avoid circular dependency
  const { observeBrain } = await import('../memory/brain-retrieval.js');

  try {
    const result = await observeBrain(
      projectRoot,
      {
        text: sticky.content,
        title: sticky.content.slice(0, 50),
        type: (memoryType as 'discovery' | 'change' | 'feature' | 'bugfix' | 'decision' | 'refactor') ?? 'discovery',
      },
    );

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
