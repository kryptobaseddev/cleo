/**
 * Sticky Note Archival
 *
 * Archives sticky notes (soft delete).
 *
 * @task T5280
 * @epic T5267
 */

import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { CleoError } from '../errors.js';
import { getBrainAccessor } from '../store/memory-accessor.js';
import type { BrainStickyNoteRow } from '../store/schema/memory-schema.js';
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
 * @throws CleoError when the sticky was converted (T13620)
 */
export async function archiveSticky(id: string, projectRoot: string): Promise<StickyNote | null> {
  const accessor = await getBrainAccessor(projectRoot);

  const sticky = await accessor.getStickyNote(id);
  if (!sticky) {
    return null;
  }
  // T13620: the status only moves forward (active < archived < converted,
  // sticky.status.one-way): archiving a converted sticky would lower it here
  // while every synced peer keeps it converted, so it is refused; an
  // archived sticky is left as it is.
  if (sticky.status === 'converted') {
    // @sync-invariant sticky.status.one-way a converted sticky is never lowered to archived locally, matching every peer's merge
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Sticky note ${id} was converted (${sticky.convertedToJson ?? 'unknown target'}) and cannot be archived`,
      { fix: 'Work with the conversion target instead; a converted sticky stays converted' },
    );
  }
  if (sticky.status === 'archived') return rowToStickyNote(sticky);

  await accessor.updateStickyNote(id, {
    status: 'archived',
  });

  // Fetch updated record
  const updated = await accessor.getStickyNote(id);
  return updated ? rowToStickyNote(updated) : null;
}
