/**
 * Sticky domain Core operation signatures.
 *
 * Declares the `stickyCoreOps` registry — the type source for
 * `OpsFromCore<typeof stickyCoreOps>` inference in the dispatch layer.
 *
 * Each key maps to a typed operation function (or thin wrapper) whose
 * signature is derived from the canonical contracts in
 * `@cleocode/contracts/operations/sticky.ts`.
 *
 * Architecture note: Engine functions in
 * `packages/cleo/src/dispatch/engines/sticky-engine.ts` use positional args
 * (projectRoot, stickyId, …). The dispatch layer wraps them in single-param
 * functions so `OpsFromCore` can infer the full typed record (matching the
 * pipeline.ts canonical pattern — ADR-058 D1 exception applies).
 *
 * T1537 sub-operation split: the old `convert` handler branch is factored
 * into four dedicated keys (`convert.task`, `convert.memory`,
 * `convert.session_note`, `convert.task_note`). The public dispatch surface
 * retains the single `convert` operation with a `targetType` discriminant,
 * but the internal typed handler routes each variant to its own wrapper,
 * eliminating nested if/else chains and reducing each path to ≤5 LOC.
 *
 * @module sticky/ops
 * @task T1535 — sticky dispatch OpsFromCore migration (ADR-058)
 * @task T1537 — split sticky convert handler into sub-operations
 *
 * @example
 * ```ts
 * import { stickyCoreOps } from '@cleocode/core/sticky';
 * import type { OpsFromCore } from '../adapters/typed.js';
 *
 * type StickyDispatchOps = OpsFromCore<typeof stickyCoreOps>;
 * ```
 */

import type {
  StickyAddParams,
  StickyAddResult,
  StickyArchiveParams,
  StickyArchiveResult,
  StickyConvertResult,
  StickyListParams,
  StickyListResult,
  StickyPurgeParams,
  StickyPurgeResult,
  StickyShowParams,
  StickyShowResult,
} from '@cleocode/contracts/operations/sticky';

// Re-export StickyConvertResult so callers can import it from this module.
// T1714: SSoT is @cleocode/contracts/operations/sticky; no local redeclaration.
export type { StickyConvertResult };

// ---------------------------------------------------------------------------
// Sub-operation param types for convert (T1537 split)
// ---------------------------------------------------------------------------

/**
 * Params for `sticky.convert.task` — convert a sticky note to a new task.
 *
 * @task T1537
 */
export interface StickyConvertTaskParams {
  /** Sticky note ID to convert (required). */
  stickyId: string;
  /** Optional title for the new task. Defaults to the first 50 chars of content. */
  title?: string;
}

/**
 * Params for `sticky.convert.memory` — convert a sticky note to a memory observation.
 *
 * @task T1537
 */
export interface StickyConvertMemoryParams {
  /** Sticky note ID to convert (required). */
  stickyId: string;
  /** Optional observation type (discovery, decision, pattern, etc.). */
  memoryType?: string;
}

/**
 * Params for `sticky.convert.session_note` — convert a sticky note to a session note.
 *
 * @task T1537
 */
export interface StickyConvertSessionNoteParams {
  /** Sticky note ID to convert (required). */
  stickyId: string;
  /** Optional target session ID. Defaults to the current active session. */
  sessionId?: string;
}

/**
 * Params for `sticky.convert.task_note` — attach a sticky note to an existing task.
 *
 * @task T1537
 */
export interface StickyConvertTaskNoteParams {
  /** Sticky note ID to convert (required). */
  stickyId: string;
  /** Target task ID (required for task_note conversion). */
  taskId: string;
}

// ---------------------------------------------------------------------------
// stickyCoreOps registry — OpsFromCore inference source
// ---------------------------------------------------------------------------

/**
 * Sticky operation registry used by the dispatch layer for
 * `OpsFromCore<typeof stickyCoreOps>` inference.
 *
 * Query operations: `list`, `show`
 * Mutate operations: `add`, `convert.task`, `convert.memory`,
 *                    `convert.session_note`, `convert.task_note`,
 *                    `archive`, `purge`
 *
 * The four `convert.*` keys replace the old monolithic `convert` case
 * (T1537 split). The public registry still exposes `convert` as a single
 * entry point; the handler uses `targetType` to route to the correct key.
 *
 * @task T1535 — OpsFromCore migration per ADR-058
 * @task T1537 — convert sub-operation split
 */
export declare const stickyCoreOps: {
  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------
  /** List sticky notes with optional filtering and pagination. */
  readonly list: (params: StickyListParams) => Promise<StickyListResult>;
  /** Retrieve a single sticky note by ID. */
  readonly show: (params: StickyShowParams) => Promise<StickyShowResult>;

  // -------------------------------------------------------------------------
  // Mutate — non-convert
  // -------------------------------------------------------------------------
  /** Create a new sticky note. */
  readonly add: (params: StickyAddParams) => Promise<StickyAddResult>;
  /** Archive a sticky note (status → archived). */
  readonly archive: (params: StickyArchiveParams) => Promise<StickyArchiveResult>;
  /** Permanently delete a sticky note. */
  readonly purge: (params: StickyPurgeParams) => Promise<StickyPurgeResult>;

  // -------------------------------------------------------------------------
  // Mutate — convert sub-operations (T1537 split)
  // -------------------------------------------------------------------------
  /** Convert a sticky note into a new task. */
  readonly 'convert.task': (params: StickyConvertTaskParams) => Promise<StickyConvertResult>;
  /** Convert a sticky note into a memory observation. */
  readonly 'convert.memory': (params: StickyConvertMemoryParams) => Promise<StickyConvertResult>;
  /** Convert a sticky note into a session note. */
  readonly 'convert.session_note': (
    params: StickyConvertSessionNoteParams,
  ) => Promise<StickyConvertResult>;
  /** Attach a sticky note to an existing task as a note. */
  readonly 'convert.task_note': (
    params: StickyConvertTaskNoteParams,
  ) => Promise<StickyConvertResult>;
};
