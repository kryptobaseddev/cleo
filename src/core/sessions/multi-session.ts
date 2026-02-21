/**
 * Check if multi-session mode is enabled.
 *
 * @task T4782
 * @epic T4654
 */

import { getAccessor } from '../../store/data-accessor.js';

interface TodoMeta {
  _meta?: {
    multiSessionEnabled?: boolean;
    [key: string]: unknown;
  };
}

/**
 * Check if multi-session mode is enabled.
 * Reads todo.json _meta via accessor.
 */
export async function isMultiSession(projectRoot: string): Promise<boolean> {
  try {
    const accessor = await getAccessor(projectRoot);
    const data = await accessor.loadTodoFile();
    return (data as unknown as TodoMeta)?._meta?.multiSessionEnabled === true;
  } catch {
    return false;
  }
}
