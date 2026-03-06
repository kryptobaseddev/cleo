/**
 * Sticky Note Purge
 *
 * Permanently deletes sticky notes (hard delete).
 *
 * @task T5363
 */

import { getBrainAccessor } from '../../store/brain-accessor.js';
import type { StickyNote } from './types.js';
import type { BrainStickyNoteRow } from '../../store/brain-schema.js';

/**
 * Convert database row to StickyNote interface.
 */
function rowToStickyNote(row: BrainStickyNoteRow): StickyNote {
  return {
    id: row.id,
    content: row.content,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? undefined,
    tags: row.tagsJson ? JSON.parse(row.tagsJson) : [],
    status: row.status as StickyNote['status'],
    convertedTo: row.convertedToJson ? JSON.parse(row.convertedToJson) : undefined,
    color: row.color as StickyNote['color'] ?? undefined,
    priority: row.priority as StickyNote['priority'] ?? undefined,
    sourceType: row.sourceType ?? 'sticky-note',
  };
}

/**
 * Purge (permanently delete) a sticky note.
 *
 * @param id - Sticky note ID
 * @param projectRoot - Project root path
 * @returns The deleted sticky note or null if not found
 */
export async function purgeSticky(
  id: string,
  projectRoot: string,
): Promise<StickyNote | null> {
  const accessor = await getBrainAccessor(projectRoot);

  // First get the sticky to return it
  const sticky = await accessor.getStickyNote(id);
  if (!sticky) {
    return null;
  }

  const stickyNote = rowToStickyNote(sticky);

  // Permanently delete from database
  await accessor.deleteStickyNote(id);

  return stickyNote;
}
