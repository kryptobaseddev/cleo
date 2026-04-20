/**
 * Sticky Domain Operations Contract (6 operations)
 *
 * Query operations: 2
 * Mutate operations: 4
 *
 * Sticky notes are ephemeral task fragments stored in a project-local SQLite database.
 * They support filtering by status (active/converted/archived), color, priority, and tags.
 * CLI identifiers start with `sticky.*` and are routed through the `sticky` domain handler.
 *
 * SYNC: Canonical type definitions live in packages/core/src/sticky/types.ts.
 * These operation types are the API contract (wire format).
 *
 * @task T1031 — Contract authoring for T980 migration worker
 * @see packages/cleo/src/dispatch/domains/sticky.ts
 * @see packages/core/src/sticky/types.ts
 */

/**
 * Sticky note status classification.
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
 * Converted target type for note transformation.
 */
export type StickyConvertTargetType = 'task' | 'memory' | 'session_note' | 'task_note';

/**
 * Reference to a converted target (task, memory, session note, or task note).
 */
export interface StickyConvertedTarget {
  /** Type of the conversion target. */
  type: StickyConvertTargetType;
  /** ID of the target item. */
  id: string;
}

/**
 * Core sticky note wire format (API projection).
 *
 * Returned by list, show, add, archive, purge operations.
 */
export interface StickyNoteOp {
  /** Unique ID (SN-001, SN-002...). */
  id: string;
  /** Raw note text content. */
  content: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 last update timestamp. */
  updatedAt?: string;
  /** Array of user-assigned tags. */
  tags: string[];
  /** Current status (active/converted/archived). */
  status: StickyNoteStatus;
  /** Conversion target if converted (nullable). */
  convertedTo?: StickyConvertedTarget;
  /** Visual color indicator. */
  color?: StickyNoteColor;
  /** Priority level. */
  priority?: StickyNotePriority;
  /** Source type for BRAIN queries. */
  sourceType: string;
}

/**
 * List of sticky notes with pagination metadata.
 */
export interface StickyListData {
  /** Array of sticky notes matching the filter. */
  stickies: StickyNoteOp[];
  /** Total count of stickies in the project (ignoring pagination). */
  total: number;
  /** Count of stickies that matched the filter. */
  filtered: number;
}

// ============================================================================
// Query Operations
// ============================================================================

// --------------------------------------------------------------------------
// sticky.list
// --------------------------------------------------------------------------

/**
 * Parameters for `sticky.list`.
 *
 * @remarks
 * All filter parameters are optional and combine with AND logic (all must match).
 * Pagination applies to filtered results.
 */
export interface StickyListParams {
  /** Filter to notes with a specific status. */
  status?: StickyNoteStatus;
  /** Filter to notes with a specific color. */
  color?: StickyNoteColor;
  /** Filter to notes with a specific priority. */
  priority?: StickyNotePriority;
  /** Filter to notes containing ALL of the specified tags. */
  tags?: string[];
  /** Max results to return (pagination limit). */
  limit?: number;
  /** Pagination offset (number of results to skip). */
  offset?: number;
}

/**
 * Result of `sticky.list`.
 *
 * @remarks
 * Returns a paginated list of sticky notes with total and filtered counts.
 */
export interface StickyListResult {
  /** Array of sticky notes for this page. */
  stickies: StickyNoteOp[];
  /** Total sticky note count across all filters. */
  total: number;
  /** Count of stickies matching the applied filters. */
  filtered: number;
}

// --------------------------------------------------------------------------
// sticky.show
// --------------------------------------------------------------------------

/**
 * Parameters for `sticky.show`.
 */
export interface StickyShowParams {
  /** Sticky note ID to retrieve (required). */
  stickyId: string;
}

/**
 * Result of `sticky.show`.
 *
 * @remarks
 * Returns the full sticky note record, or error if not found.
 */
export type StickyShowResult = StickyNoteOp;

// ============================================================================
// Mutate Operations
// ============================================================================

// --------------------------------------------------------------------------
// sticky.add
// --------------------------------------------------------------------------

/**
 * Parameters for `sticky.add`.
 */
export interface StickyAddParams {
  /** Note text content (required). */
  content: string;
  /** User-assigned tags. */
  tags?: string[];
  /** Visual color indicator. */
  color?: StickyNoteColor;
  /** Priority level. */
  priority?: StickyNotePriority;
}

/**
 * Result of `sticky.add`.
 *
 * @remarks
 * Returns the newly-created sticky note record.
 */
export type StickyAddResult = StickyNoteOp;

// --------------------------------------------------------------------------
// sticky.convert
// --------------------------------------------------------------------------

/**
 * Parameters for `sticky.convert`.
 *
 * @remarks
 * Converts a sticky note to a different item type (task, memory, session note, task note).
 * Required params vary by targetType:
 *   - task: optional title
 *   - memory: optional memoryType
 *   - session_note: optional sessionId
 *   - task_note: required taskId
 */
export interface StickyConvertParams {
  /** Sticky note ID to convert (required). */
  stickyId: string;
  /** Target item type: task, memory, session_note, or task_note (required). */
  targetType: StickyConvertTargetType;
  /** Optional title when converting to task. */
  title?: string;
  /** Optional memory type when converting to memory (observation, decision, pattern, etc.). */
  memoryType?: string;
  /** Required task ID when converting to task_note. */
  taskId?: string;
  /** Optional session ID when converting to session_note. */
  sessionId?: string;
}

/**
 * Result of `sticky.convert`.
 *
 * @remarks
 * Returns the target item ID that was created/updated by the conversion.
 * The returned key varies by targetType:
 *   - task → taskId
 *   - memory → memoryId
 *   - session_note → sessionId
 *   - task_note → taskId
 */
export interface StickyConvertResult {
  /** ID of the created or updated target item (key name varies by type). */
  taskId?: string;
  memoryId?: string;
  sessionId?: string;
}

// --------------------------------------------------------------------------
// sticky.archive
// --------------------------------------------------------------------------

/**
 * Parameters for `sticky.archive`.
 */
export interface StickyArchiveParams {
  /** Sticky note ID to archive (required). */
  stickyId: string;
}

/**
 * Result of `sticky.archive`.
 *
 * @remarks
 * Returns the archived sticky note record with status updated to 'archived'.
 */
export type StickyArchiveResult = StickyNoteOp;

// --------------------------------------------------------------------------
// sticky.purge
// --------------------------------------------------------------------------

/**
 * Parameters for `sticky.purge`.
 */
export interface StickyPurgeParams {
  /** Sticky note ID to permanently delete (required). */
  stickyId: string;
}

/**
 * Result of `sticky.purge`.
 *
 * @remarks
 * Returns the purged sticky note record. After purge, the note is permanently deleted
 * from the database and cannot be recovered.
 */
export type StickyPurgeResult = StickyNoteOp;

// ============================================================================
// Discriminated Union Types
// ============================================================================

/**
 * All sticky operation keys (for TypedDomainHandler routing).
 */
export type StickyOpKey =
  | 'sticky.list'
  | 'sticky.show'
  | 'sticky.add'
  | 'sticky.convert'
  | 'sticky.archive'
  | 'sticky.purge';

/**
 * Sticky operations discriminated union.
 *
 * @remarks
 * Each variant carries:
 * - `op`: the operation key (for routing)
 * - `params`: strongly-typed parameters for this operation
 * - `result`: strongly-typed return type for this operation
 *
 * Consumed by packages/cleo/src/dispatch/domains/sticky.ts via TypedDomainHandler<StickyOps>.
 *
 * @task T1031
 * @task T980 — migration worker that consumes this contract
 */
export type StickyOps =
  | { op: 'sticky.list'; params: StickyListParams; result: StickyListResult }
  | { op: 'sticky.show'; params: StickyShowParams; result: StickyShowResult }
  | { op: 'sticky.add'; params: StickyAddParams; result: StickyAddResult }
  | { op: 'sticky.convert'; params: StickyConvertParams; result: StickyConvertResult }
  | { op: 'sticky.archive'; params: StickyArchiveParams; result: StickyArchiveResult }
  | { op: 'sticky.purge'; params: StickyPurgeParams; result: StickyPurgeResult };
