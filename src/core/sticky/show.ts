/**
 * Sticky Note Retrieval
 *
 * Gets a single sticky note by ID.
 *
 * @task T5280
 * @epic T5267
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
 * Get a sticky note by ID.
 *
 * @param id - Sticky note ID (e.g., "SN-042")
 * @param projectRoot - Project root path
 * @returns The sticky note or null if not found
 */
export async function getSticky(
  id: string,
  projectRoot: string,
): Promise<StickyNote | null> {
  const accessor = await getBrainAccessor(projectRoot);

  const row = await accessor.getStickyNote(id);
  if (!row) {
    return null;
  }

  return rowToStickyNote(row);
}
