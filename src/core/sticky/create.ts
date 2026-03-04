/**
 * Sticky Note Creation
 *
 * Creates new sticky notes in brain.db.
 *
 * @task T5280
 * @epic T5267
 */

import { getBrainAccessor } from '../../store/brain-accessor.js';
import { generateStickyId } from './id.js';
import type { StickyNote, CreateStickyParams } from './types.js';
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
 * Create a new sticky note.
 *
 * @param params - Creation parameters
 * @param projectRoot - Project root path
 * @returns The created sticky note
 */
export async function addSticky(
  params: CreateStickyParams,
  projectRoot: string,
): Promise<StickyNote> {
  const accessor = await getBrainAccessor(projectRoot);

  const id = await generateStickyId(projectRoot);

  const row = await accessor.addStickyNote({
    id,
    content: params.content,
    tagsJson: params.tags ? JSON.stringify(params.tags) : null,
    status: 'active',
    color: params.color ?? null,
    priority: params.priority ?? null,
  });

  return rowToStickyNote(row);
}
