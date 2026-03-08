/**
 * Sticky Note Archival
 *
 * Archives sticky notes (soft delete).
 *
 * @task T5280
 * @epic T5267
 */

import { getBrainAccessor } from '../../store/brain-accessor.js';
import type { BrainStickyNoteRow } from '../../store/brain-schema.js';
import type { StickyNote } from './types.js';

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
    color: (row.color as StickyNote['color']) ?? undefined,
    priority: (row.priority as StickyNote['priority']) ?? undefined,
    sourceType: row.sourceType ?? 'sticky-note',
  };
}

/**
 * Archive a sticky note.
 *
 * @param id - Sticky note ID
 * @param projectRoot - Project root path
 * @returns The archived sticky note or null if not found
 */
export async function archiveSticky(id: string, projectRoot: string): Promise<StickyNote | null> {
  const accessor = await getBrainAccessor(projectRoot);

  const sticky = await accessor.getStickyNote(id);
  if (!sticky) {
    return null;
  }

  await accessor.updateStickyNote(id, {
    status: 'archived',
  });

  // Fetch updated record
  const updated = await accessor.getStickyNote(id);
  return updated ? rowToStickyNote(updated) : null;
}
