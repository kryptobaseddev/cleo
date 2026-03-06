/**
 * Sticky Note Types
 *
 * Type definitions for sticky note domain operations.
 *
 * @task T5280
 * @epic T5267
 */

/**
 * Sticky note status values.
 */
export type StickyNoteStatus = 'active' | 'converted' | 'archived';

/**
 * Sticky note color options.
 */
export type StickyNoteColor = 'yellow' | 'blue' | 'green' | 'red' | 'purple';

/**
 * Sticky note priority levels.
 */
export type StickyNotePriority = 'low' | 'medium' | 'high';

/**
 * Converted target type.
 */
export type ConvertedTargetType = 'task' | 'memory' | 'session_note' | 'task_note';

/**
 * Converted target reference.
 */
export interface ConvertedTarget {
  type: ConvertedTargetType;
  id: string;
}

/**
 * Core sticky note interface.
 */
export interface StickyNote {
  /** Unique ID (SN-001, SN-002...) */
  id: string;
  /** Raw note text */
  content: string;
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** ISO 8601 last update timestamp */
  updatedAt?: string;
  /** Array of tags */
  tags: string[];
  /** Current status */
  status: StickyNoteStatus;
  /** Conversion target if converted */
  convertedTo?: ConvertedTarget;
  /** Visual color */
  color?: StickyNoteColor;
  /** Priority level */
  priority?: StickyNotePriority;
  /** Source type for BRAIN queries */
  sourceType: string;
}

/**
 * Parameters for creating a sticky note.
 */
export interface CreateStickyParams {
  content: string;
  tags?: string[];
  color?: StickyNoteColor;
  priority?: StickyNotePriority;
}

/**
 * Parameters for listing sticky notes.
 */
export interface ListStickiesParams {
  status?: StickyNoteStatus;
  color?: StickyNoteColor;
  priority?: StickyNotePriority;
  limit?: number;
}

/**
 * Parameters for converting a sticky note.
 */
export interface ConvertStickyParams {
  targetType: ConvertedTargetType;
  /** Optional title when converting to task */
  title?: string;
  /** Optional memory type when converting to memory */
  memoryType?: string;
  /** Optional taskId when converting to task note */
  taskId?: string;
}
