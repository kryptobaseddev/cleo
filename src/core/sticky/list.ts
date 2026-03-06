/**
 * Sticky Note Listing
 *
 * Lists sticky notes with optional filtering.
 *
 * @task T5280
 * @epic T5267
 */

import { getBrainAccessor } from '../../store/brain-accessor.js';
import type { StickyNote, ListStickiesParams } from './types.js';
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
 * List sticky notes with optional filters.
 *
 * @param params - Filter parameters
 * @param projectRoot - Project root path
 * @returns Array of sticky notes
 */
export async function listStickies(
  params: ListStickiesParams,
  projectRoot: string,
): Promise<StickyNote[]> {
  const accessor = await getBrainAccessor(projectRoot);

  const rows = await accessor.findStickyNotes({
    status: params.status,
    color: params.color,
    priority: params.priority,
    limit: params.limit,
  });

  return rows.map(rowToStickyNote);
}
