/**
 * Focus management - backward-compatible re-exports.
 *
 * Focus was renamed to task-work. This barrel re-exports the deprecated
 * aliases so existing consumers continue to work.
 *
 * @deprecated Use src/core/task-work/index.ts instead.
 * @task T4462
 * @epic T4454
 */

export {
  showFocus,
  setFocus,
  clearFocus,
  getFocusHistory,
} from '../task-work/index.js';

export type {
  FocusShowResult,
  FocusSetResult,
  FocusHistoryEntry,
} from '../task-work/index.js';
