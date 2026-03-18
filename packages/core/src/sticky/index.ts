/**
 * Sticky Notes Core Module
 *
 * Barrel exports for sticky note operations.
 *
 * @task T5280
 * @epic T5267
 */

export { archiveSticky } from './archive.js';
export {
  convertStickyToMemory,
  convertStickyToSessionNote,
  convertStickyToTask,
  convertStickyToTaskNote,
} from './convert.js';
export { addSticky } from './create.js';
export { generateStickyId } from './id.js';
export { listStickies } from './list.js';
export { purgeSticky } from './purge.js';
export { getSticky } from './show.js';
export type {
  ConvertedTarget,
  ConvertedTargetType,
  ConvertStickyParams,
  CreateStickyParams,
  ListStickiesParams,
  StickyNote,
  StickyNoteColor,
  StickyNotePriority,
  StickyNoteStatus,
} from './types.js';
