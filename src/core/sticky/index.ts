/**
 * Sticky Notes Core Module
 *
 * Barrel exports for sticky note operations.
 *
 * @task T5280
 * @epic T5267
 */

export type {
  StickyNote,
  StickyNoteStatus,
  StickyNoteColor,
  StickyNotePriority,
  CreateStickyParams,
  ListStickiesParams,
  ConvertStickyParams,
  ConvertedTarget,
  ConvertedTargetType,
} from './types.js';

export { addSticky } from './create.js';
export { listStickies } from './list.js';
export { getSticky } from './show.js';
export { convertStickyToTask, convertStickyToMemory, convertStickyToTaskNote, convertStickyToSessionNote } from './convert.js';
export { archiveSticky } from './archive.js';
export { purgeSticky } from './purge.js';
export { generateStickyId } from './id.js';
