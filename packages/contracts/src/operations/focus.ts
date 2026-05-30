/**
 * Focus Domain Operations — single-envelope task orientation.
 *
 * `cleo focus <id>` aggregates 8 separate orientation calls into one
 * wire-format envelope covering identity, scope, members, blockers,
 * the next parallel-safe wave, attached docs, recent git activity, and
 * scope-filtered brain context.
 *
 * Token budget: ≤ 1 500 tokens for a typical task orientation request.
 *
 * @task T9973
 * @epic T9964 E-ORIENT-V2
 */

import type { MviDigest } from '../mvi.js';
import type { AttentionScopeKind } from './attention.js';
import type { MemoryCompactHit } from './memory.js';

/**
 * A minimal preview element for the attention digest (T11374 · Epic T11288).
 *
 * The MVI digest preview carries only the few fields an agent needs to glance
 * at a jot — the full item is one `cleo attention show` away (the expand hint).
 */
export interface AttentionDigestPreviewItem {
  /** Item id. */
  id: string;
  /** Truncated jot content. */
  content: string;
  /** Scope kind the jot is keyed to. */
  scopeKind: AttentionScopeKind;
}

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

/**
 * Parameters for `focus.show`.
 *
 * @task T9973
 */
export interface FocusShowParams {
  /** Task, Epic, or Saga ID to orient on (e.g. `T9973`, `T9831`). Required. */
  id: string;
}

// ---------------------------------------------------------------------------
// Result sub-types
// ---------------------------------------------------------------------------

/**
 * Minimal identity block surfaced for the focused entity.
 *
 * @task T9973
 */
export interface FocusIdentity {
  /** Task / Epic / Saga identifier. */
  id: string;
  /** Human-readable title. */
  title: string;
  /** Entity tier — `'task'`, `'epic'`, or `'saga'`. */
  type: string;
  /** Current lifecycle status. */
  status: string;
  /** Parent task / Epic identifier, if any. */
  parentId?: string | null;
}

/**
 * Scope hierarchy resolved from the focused entity's ancestry.
 *
 * @task T9973
 */
export interface FocusScope {
  /** Saga ID, when the entity belongs to a Saga. */
  sagaId?: string;
  /** Epic ID when the entity is a task or the focused entity itself is an Epic. */
  epicId?: string;
  /** Task ID when the focused entity is a task. */
  taskId?: string;
}

/**
 * One member Epic of a Saga, with a rollup status.
 *
 * Populated only when `focus.show` is called on a Saga ID.
 *
 * @task T9973
 */
export interface FocusSagaMember {
  /** Epic task identifier. */
  epicId: string;
  /** Rollup status for the Epic (e.g. `'active'`, `'done'`). */
  status: string;
  /** Epic title. */
  title: string;
}

/**
 * One task blocking the focused entity.
 *
 * @task T9973
 */
export interface FocusBlocker {
  /** ID of the task that is blocking. */
  id: string;
  /** Title of the blocking task. */
  title: string;
  /** Human-readable reason the dependency is unresolved. */
  reason: string;
}

/**
 * One ready task from the next parallel-safe wave of the parent Epic.
 *
 * @task T9973
 */
export interface FocusReadyTask {
  /** Task identifier. */
  id: string;
  /** Task title. */
  title: string;
  /** Engine-rolled priority. */
  priority: string;
  /** Dependency IDs (already satisfied for ready tasks). */
  depends: string[];
}

/**
 * One doc attachment linked to the focused entity.
 *
 * @task T9973
 */
export interface FocusAttachedDoc {
  /** Attachment identifier (att_* or UUID). */
  attachmentId: string;
  /** Human-friendly slug, when assigned. */
  slug?: string;
  /** Taxonomy classification, when assigned. */
  type?: string;
  /** Storage kind (e.g. `'local-file'`, `'url'`, `'blob'`). */
  kind: string;
}

/**
 * One recent git commit mentioning the focused task ID.
 *
 * @task T9973
 */
export interface FocusRecentCommit {
  /** Full 40-character commit SHA. */
  commitSha: string;
  /** Commit subject line (first line of the commit message). */
  message: string;
  /** ISO 8601 author date. */
  date: string;
}

/**
 * Brain context scoped to the focused entity (≤ 3 entries per category).
 *
 * @task T9973
 */
export interface FocusBrainContext {
  /** Recent observations relevant to the focused entity. */
  observations: MemoryCompactHit[];
  /** Learnings relevant to the focused entity. */
  learnings: MemoryCompactHit[];
  /** Decisions relevant to the focused entity. */
  decisions: MemoryCompactHit[];
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * Result of `focus.show` — the single-envelope task orientation response.
 *
 * All fields except `identity` and `scope` are omitted when the
 * underlying data source returns nothing (empty arrays, unavailable stores,
 * git not in repo). Consumers MUST handle optional fields gracefully.
 *
 * Token budget: ≤ 1 500 tokens for typical task orientation.
 *
 * @task T9973
 * @epic T9964
 */
export interface FocusShowResult {
  /** Core identity of the focused entity. */
  identity: FocusIdentity;
  /** Scope hierarchy (saga → epic → task) derived from ancestry. */
  scope: FocusScope;
  /**
   * Saga member Epics with rollup statuses.
   * Populated only when `id` resolves to a Saga (`type='saga'`).
   */
  members?: FocusSagaMember[];
  /**
   * Tasks that are blocking the focused entity.
   * Empty array when the entity is not blocked.
   */
  blockers: FocusBlocker[];
  /**
   * Next parallel-safe wave of tasks from the parent Epic.
   * Omitted when the entity has no parent Epic or the ready-set is empty.
   */
  readyWave?: FocusReadyTask[];
  /**
   * Docs attached to the focused task/epic.
   * Omitted when the docs store is unavailable or no attachments exist.
   */
  attachedDocs?: FocusAttachedDoc[];
  /**
   * Up to 5 most-recent git commits mentioning the focused task ID.
   * Omitted when git is unavailable or no matching commits are found.
   */
  recentActivity?: FocusRecentCommit[];
  /**
   * Scope-filtered brain context — up to 3 entries per category.
   * Omitted when the BRAIN store is unavailable.
   */
  brainContext?: FocusBrainContext;
  /**
   * Tier-2 attention digest — a budget-bounded MVI summary of the open
   * working-memory jots visible to the calling agent in this scope (T11374 ·
   * Epic T11288). Carries a one-line summary, the live count, a tiny preview,
   * and the `cleo attention show` expand hint — never a full dump. Omitted when
   * there are zero open items (the empty-attention contract) or the buffer is
   * unavailable.
   */
  attentionDigest?: MviDigest<AttentionDigestPreviewItem>;
  /** Estimated token weight of this envelope. */
  tokensEstimated: number;
}

// ---------------------------------------------------------------------------
// Typed op record
// ---------------------------------------------------------------------------

/**
 * Typed operation record for the focus domain.
 *
 * Maps each operation name to its `[Params, Result]` tuple for compile-time
 * narrowing in the dispatch layer.
 *
 * @task T9973
 */
export type FocusOps = {
  readonly show: readonly [FocusShowParams, FocusShowResult];
};
