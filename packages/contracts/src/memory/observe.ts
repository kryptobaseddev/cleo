/**
 * BRAIN observation-write wire shapes.
 *
 * Canonical home for the parameters and result types of the public
 * `observeBrain` operation — the unified BRAIN write path that persists
 * agent observations into `brain_observations`. Companion to the
 * read-side trio in {@link ./search.ts}, {@link ./timeline.ts}, and
 * {@link ./fetch.ts}.
 *
 * The `BRAIN_OBSERVATION_SOURCE_TYPES` const is co-located here so the
 * derived `BrainObservationSourceType` union has a single source of truth.
 * `packages/core/src/store/memory-schema.ts` re-exports the const for
 * Drizzle's `enum: [...]` column constraint, which requires the runtime
 * tuple literal.
 *
 * Promoted from `packages/core/src/memory/brain-retrieval.ts` to
 * `@cleocode/contracts` in Phase 0e of SG-ARCH-SOLID
 * (E-CONTRACTS-FOUNDATION).
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9956 (Phase 0e)
 */

import type { BrainSourceConfidence } from '../brain.js';
import type { BrainObservationType } from '../facade.js';

// ── BRAIN_OBSERVATION_SOURCE_TYPES + BrainObservationSourceType ─────

/**
 * Source-type tuple for `brain_observations.source_type` — how the
 * observation was created.
 *
 * Originally defined in `packages/core/src/store/memory-schema.ts:134`.
 * Promoted here so the derived {@link BrainObservationSourceType} union
 * lives alongside its source. `memory-schema.ts` re-exports the const
 * because Drizzle's `{ enum: ... }` column constraint requires the runtime
 * tuple literal.
 *
 * - `agent`           — produced by a spawned agent at task time.
 * - `session-debrief` — synthesized at session end by the debrief pipeline.
 * - `claude-mem`      — imported from a claude-mem migration batch.
 * - `manual`          — typed directly by the owner via `cleo memory observe`.
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9956 (Phase 0e)
 */
export const BRAIN_OBSERVATION_SOURCE_TYPES = [
  'agent',
  'session-debrief',
  'claude-mem',
  'manual',
] as const;

/**
 * Derived string-literal union of valid `source_type` values.
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9956 (Phase 0e)
 */
export type BrainObservationSourceType = (typeof BRAIN_OBSERVATION_SOURCE_TYPES)[number];

// ── ObserveBrainParams ──────────────────────────────────────────────

/**
 * Parameters for `observeBrain`.
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9956 (Phase 0e)
 */
export interface ObserveBrainParams {
  /** Observation narrative — the free-form text persisted to `brain_observations.narrative`. */
  text: string;
  /** Optional display title; auto-derived from `text` when omitted. */
  title?: string;
  /** Optional cognitive observation type (`feature`, `bugfix`, `decision`, …). */
  type?: BrainObservationType;
  /** Optional project scope ID; defaults to the current project root. */
  project?: string;
  /** Session ID that produced the observation (provenance). */
  sourceSessionId?: string;
  /** How the observation was created (default `agent`). */
  sourceType?: BrainObservationSourceType;
  /** T417: agent provenance — the name of the spawned agent producing this observation. */
  agent?: string;
  /**
   * T549 Wave 1-A: source reliability level.
   * Overrides the default routing. If omitted, routing is determined automatically:
   * - sourceType 'manual' → 'owner'
   * - sourceType 'session-debrief' → 'task-outcome'
   * - otherwise → 'agent'
   */
  sourceConfidence?: BrainSourceConfidence;
  /**
   * T794 BRAIN-05: cross-references to other memory entries or external IDs.
   * When this array has ≥1 entry, the observation is auto-promoted from
   * 'short' to 'medium' tier at write time to protect it from soft-eviction.
   */
  crossRef?: string[];
  /**
   * T799: SHA-256 refs of attachments to link to this observation.
   *
   * Stored as a JSON-encoded string in the `attachments_json` column.
   * Each entry must be a 64-char hex SHA-256 from the tasks.db attachment store.
   */
  attachmentRefs?: string[];
  /**
   * T1897: Producer pipeline that created this observation.
   * - `manual`           — typed directly by owner
   * - `auto-extract`     — from fulfillPromotionLog / LLM extraction
   * - `transcript-ingest`— imported from raw session transcript
   * - `session-debrief`  — synthesized at session end
   * - `test`             — inserted by test code
   *
   * Null on legacy rows and when not specified.
   */
  origin?: string | null;
  /**
   * T1897: JSON array of source brain_observations.id values this row was derived from.
   * Null for directly-observed rows.
   */
  provenanceChain?: string[] | null;
  /**
   * T992: Internal flag — when true, bypasses the verifyAndStore gate.
   * Set only by storeVerifiedCandidate in extraction-gate.ts to avoid
   * infinite recursion (gate → storeVerifiedCandidate → observeBrain → gate).
   * External callers MUST NOT set this flag.
   */
  _skipGate?: boolean;
  /**
   * T10351: Internal flag — when true, bypasses the brain writer-thread
   * chokepoint and writes directly. Set ONLY by the writer-thread handler
   * (`brain-writer-handlers.ts`) when re-entering observeBrain from inside
   * the worker, so the routing doesn't recurse forever. External callers
   * MUST NOT set this flag.
   */
  _skipQueue?: boolean;
}

// ── ObserveBrainResult ──────────────────────────────────────────────

/**
 * Result envelope returned by `observeBrain`.
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9956 (Phase 0e)
 */
export interface ObserveBrainResult {
  /** Identifier of the newly-persisted observation row. */
  id: string;
  /** Resolved BRAIN table name (always `observation` for `observeBrain`). */
  type: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}

// ── DocAttachmentObservationPayload ─────────────────────────────────

/**
 * Structured payload stored in the `narrative` of a doc-attachment memory
 * observation emitted by `cleo docs add` (T9976).
 *
 * The observation title is `"Doc attached: <slug>"` (or
 * `"Doc attached: <attachmentId>"` when no slug is set) so
 * `cleo memory find '<slug>'` reliably surfaces the entry via FTS.
 *
 * The payload is serialised as JSON and embedded in the observation
 * `narrative` field so it can be recovered by `cleo memory verify`
 * for round-trip attachment-existence checks.
 *
 * @task T9976
 */
export interface DocAttachmentObservationPayload {
  /** Slug recorded for this attachment (optional — omitted when none set). */
  slug?: string;
  /** Owner entity ID (task, session, observation, …). */
  ownerId: string;
  /** Taxonomy type classification (optional). */
  type?: string;
  /** Attachment ID assigned by the store. */
  attachmentId: string;
  /** ISO 8601 timestamp when the attachment was added. */
  addedAt: string;
  /**
   * Observation kind discriminator — always `"doc-attachment"`.
   * Used by `cleo memory verify` to identify doc-attachment observations
   * and perform round-trip checks against the docs store.
   */
  kind: 'doc-attachment';
}
