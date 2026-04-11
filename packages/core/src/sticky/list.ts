/**
 * Sticky Note Listing
 *
 * Lists sticky notes with optional filtering.
 *
 * @task T5280
 * @epic T5267
 */

import { getBrainAccessor } from '../store/brain-accessor.js';
import type { BrainStickyNoteRow } from '../store/brain-schema.js';
import type { ListStickiesParams, StickyNote } from './types.js';

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

  // Tags are stored as JSON in a text column, so we filter in-memory after
  // the SQL query. Request extra rows (no limit) when tag filtering is active
  // so we don't inadvertently clip the result set before filtering.
  const hasTagFilter = params.tags && params.tags.length > 0;

  const rows = await accessor.findStickyNotes({
    status: params.status,
    color: params.color,
    priority: params.priority,
    limit: hasTagFilter ? undefined : params.limit,
  });

  let notes = rows.map(rowToStickyNote);

  // In-memory tag filter: keep notes that contain ALL requested tags.
  if (hasTagFilter) {
    const requiredTags = params.tags!;
    notes = notes.filter((note) => requiredTags.every((t) => note.tags.includes(t)));
    if (params.limit && notes.length > params.limit) {
      notes = notes.slice(0, params.limit);
    }
  }

  return notes;
}
