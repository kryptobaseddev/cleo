/**
 * Drizzle ORM schema for CLEO brain.db (SQLite via node:sqlite + sqlite-proxy).
 *
 * Tables: brain_decisions, brain_patterns, brain_learnings, brain_memory_links, brain_schema_meta
 * Stores cognitive infrastructure: decisions, patterns, and learnings extracted
 * from CLEO task execution. Cross-references tasks in tasks.db via soft FKs.
 *
 * @epic T5149
 * @task T5127
 */

// Import canonical type aliases from contracts — T1715 deduplication.
// The local const arrays (BRAIN_MEMORY_TIERS, etc.) are kept because Drizzle
// requires runtime values for { enum: ... } column constraints.
import type {
  BrainCognitiveType,
  BrainMemoryTier,
  BrainSourceConfidence,
} from '@cleocode/contracts';
import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

export type { BrainCognitiveType, BrainMemoryTier, BrainSourceConfidence };

// === ENUM CONSTANTS ===

/**
 * Memory retention tiers for the tiered cognitive memory model (T549).
 *
 * - `short`  — Session-scoped working context. Volatile; auto-evicted after 48h if not promoted.
 * - `medium` — Project-scoped verified facts. Retained for weeks; decays if unverified.
 * - `long`   — Architectural bedrock. Permanent; supersession-only eviction.
 *
 * NULL semantics for legacy rows: treat NULL as 'medium' at query time.
 * (Legacy rows survived the T523 purge, so medium is a safe tier assumption.)
 */
export const BRAIN_MEMORY_TIERS = ['short', 'medium', 'long'] as const;

/**
 * Cognitive type taxonomy for the tiered memory model (T549).
 *
 * Uses `BRAIN_COGNITIVE_TYPES` (not `BRAIN_MEMORY_TYPES`) to avoid collision
 * with the link table enum `BRAIN_MEMORY_TYPES` (which stores entity type names).
 *
 * - `semantic`   — Declarative facts: "what is true about this project"
 *                  → brain_decisions (always), brain_learnings (default)
 * - `episodic`   — Event records: "what happened and when"
 *                  → brain_observations (always), brain_learnings (transcript-derived)
 * - `procedural` — Process knowledge: "how to do things"
 *                  → brain_patterns (always)
 */
export const BRAIN_COGNITIVE_TYPES = ['semantic', 'episodic', 'procedural'] as const;

/**
 * Source reliability levels for the tiered memory model (T549).
 *
 * Separate dimension from content `quality_score` — captures source trustworthiness.
 * Each level drives a quality multiplier applied at scoring time.
 *
 * | Level         | Meaning                                 | Quality multiplier |
 * |---------------|-----------------------------------------|--------------------|
 * | `owner`       | Owner explicitly stated this fact       | 1.0                |
 * | `task-outcome`| Verified by completed task with result  | 0.90               |
 * | `agent`       | Agent-inferred during work (default)    | 0.70               |
 * | `speculative` | Agent hypothesis, not yet corroborated  | 0.40               |
 */
export const BRAIN_SOURCE_CONFIDENCE = ['owner', 'task-outcome', 'agent', 'speculative'] as const;

/** Decision types from ADR-009. */
export const BRAIN_DECISION_TYPES = [
  'architecture',
  'technical',
  'process',
  'strategic',
  'tactical',
] as const;

/** Confidence levels for decisions. */
export const BRAIN_CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const;

/** Outcome types for decision tracking. */
export const BRAIN_OUTCOME_TYPES = ['success', 'failure', 'mixed', 'pending'] as const;

/** Pattern types for workflow analysis. */
export const BRAIN_PATTERN_TYPES = [
  'workflow',
  'blocker',
  'success',
  'failure',
  'optimization',
] as const;

/** Impact levels for patterns. */
export const BRAIN_IMPACT_LEVELS = ['low', 'medium', 'high'] as const;

/** Link types for cross-referencing BRAIN entries with tasks. */
export const BRAIN_LINK_TYPES = [
  'produced_by',
  'applies_to',
  'informed_by',
  'contradicts',
] as const;

/** Observation types for claude-mem compatible observations. */
export const BRAIN_OBSERVATION_TYPES = [
  'discovery',
  'change',
  'feature',
  'bugfix',
  'decision',
  'refactor',
  'diary',
  'session-summary',
] as const;

/** Source types for observations (how the observation was created). */
export const BRAIN_OBSERVATION_SOURCE_TYPES = [
  'agent',
  'session-debrief',
  'claude-mem',
  'manual',
] as const;

/** Memory entity types for the links table. */
export const BRAIN_MEMORY_TYPES = ['decision', 'pattern', 'learning', 'observation'] as const;

/** Sticky note status values. */
export const BRAIN_STICKY_STATUSES = ['active', 'converted', 'archived'] as const;

/** Sticky note colors. */
export const BRAIN_STICKY_COLORS = ['yellow', 'blue', 'green', 'red', 'purple'] as const;

/** Sticky note priority levels. */
export const BRAIN_STICKY_PRIORITIES = ['low', 'medium', 'high'] as const;

// === BRAIN_DECISIONS TABLE ===

export const brainDecisions = sqliteTable(
  'brain_decisions',
  {
    id: text('id').primaryKey(),
    type: text('type', { enum: BRAIN_DECISION_TYPES }).notNull(),
    decision: text('decision').notNull(),
    rationale: text('rationale').notNull(),
    confidence: text('confidence', { enum: BRAIN_CONFIDENCE_LEVELS }).notNull(),
    outcome: text('outcome', { enum: BRAIN_OUTCOME_TYPES }),
    alternativesJson: text('alternatives_json'),
    contextEpicId: text('context_epic_id'), // soft FK to tasks.id in tasks.db
    contextTaskId: text('context_task_id'), // soft FK to tasks.id in tasks.db
    contextPhase: text('context_phase'),
    /**
     * Quality score: 0.0 (noise) – 1.0 (canonical). Null for legacy entries.
     * Computed at insert time from confidence, content richness, and context.
     * Entries below 0.3 are excluded from search results (T531).
     */
    qualityScore: real('quality_score'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    updatedAt: text('updated_at'),

    // T549: Tiered + Typed Memory columns

    /**
     * Memory retention tier. NULL on legacy rows → treat as 'medium' at query time.
     * T746: decisions skip short-tier entirely — writers always assign 'medium' (see decisions.ts).
     * The Drizzle DEFAULT is 'medium' to match the write-path behaviour.
     */
    memoryTier: text('memory_tier', { enum: BRAIN_MEMORY_TIERS }).default('medium'),

    /** Cognitive type. Decisions are always 'semantic' (declarative architectural facts). */
    memoryType: text('memory_type', { enum: BRAIN_COGNITIVE_TYPES }).default('semantic'),

    /**
     * Ground-truth verification flag.
     * false = agent-inferred, pending verification.
     * true = confirmed via owner statement, task outcome, corroboration, or manual `cleo memory verify`.
     */
    verified: integer('verified', { mode: 'boolean' }).notNull().default(false),

    /**
     * Bitemporal: when this decision became valid (ISO 8601 text).
     * Defaults to creation time. Can be backdated for historical facts.
     */
    validAt: text('valid_at').notNull().default(sql`(datetime('now'))`),

    /**
     * Bitemporal: when this decision stopped being valid.
     * NULL = currently valid. Prefer `supersedes` graph edges for decision supersession
     * (ADR-009); this column is a convenience gate for bulk eviction queries.
     */
    invalidAt: text('invalid_at'),

    /**
     * Source reliability level — separate from content quality_score (T549 §3.1.5).
     * Drives quality multiplier at scoring time.
     */
    sourceConfidence: text('source_confidence', { enum: BRAIN_SOURCE_CONFIDENCE }).default('agent'),

    /**
     * Number of times this decision has been cited/retrieved (T549 CONFLICT-03).
     * Used by the consolidator for citation-based medium→long promotion.
     */
    citationCount: integer('citation_count').notNull().default(0),

    // T726 Wave 1A: tier promotion audit columns

    /**
     * ISO 8601 timestamp when this decision was last promoted to a higher tier.
     * Null = never promoted (still at its initial tier).
     * Set by runTierPromotion at the moment of promotion.
     */
    tierPromotedAt: text('tier_promoted_at'),

    /**
     * Human-readable reason for the most recent tier promotion.
     * Examples: "citationCount=5 >= 5, age > 7d", "qualityScore=0.82 >= 0.70, age > 24h".
     * Null = never promoted.
     */
    tierPromotionReason: text('tier_promotion_reason'),

    /**
     * SHA-256 prefix (first 16 hex chars) of the normalised decision content.
     * Computed at insert time; used by hashDedupCheck to prevent exact-duplicate decisions.
     * Null on legacy rows (pre-T726).
     */
    contentHash: text('content_hash'),

    // T1260: PSYCHE E3 — provenanceClass sweep gate (M6)

    /**
     * Provenance class for the M6 refusal gate (T1260 PSYCHE E3).
     *
     * - `'unswept-pre-T1151'` — default for legacy rows; refused by buildRetrievalBundle
     *   until the T1147 W7 sweep (.132) stamps entries as clean.
     * - `'swept-clean'`       — row has passed the T1147 reconciler sweep.
     * - `'deriver-synthesized'` — row was created by the T1145 deriver (W5).
     * - `'owner-verified'`    — row was manually promoted via `cleo memory verify`.
     */
    provenanceClass: text('provenance_class').default('unswept-pre-T1151'),

    // T1084: PSYCHE Wave 2 — CANT peer memory isolation

    /**
     * Peer identity for memory isolation (T1084 PSYCHE Wave 2).
     *
     * Identifies which CANT agent produced this entry.
     * `"global"` = shared across all peers (default for legacy rows + unscoped writes).
     * A non-global value means only that peer (and global queries) can see this entry.
     *
     * Staged backfill via T1003 pattern sets existing rows to `'global'`.
     * Writers: `storeDecision()` passes the active `peerId` from session context.
     */
    peerId: text('peer_id').notNull().default('global'),

    /**
     * Peer scope for memory isolation (T1084 PSYCHE Wave 2).
     *
     * Determines the visibility radius:
     * - `"global"` — visible to all peers in this project (equivalent to current behavior).
     * - `"project"` — scoped to the current project; the default for peer-written entries.
     * - `"peer"` — strict per-peer isolation; only the owning peer can retrieve.
     */
    peerScope: text('peer_scope').notNull().default('project'),

    // T1826: Decision Storage Consolidation — ADR tracking + governance columns

    /**
     * Monotonically-increasing ADR sequence number for this decision.
     *
     * Populated at insert time via an app-level MAX(adr_number)+1 sequence helper
     * (SQLite does not natively auto-increment arbitrary integer columns with UNIQUE).
     * NULL for decisions that have not been assigned an ADR number (informal decisions).
     *
     * The UNIQUE constraint prevents collisions when concurrent writes race; the
     * insert helper should use a `SELECT MAX(adr_number) + 1` within the same
     * transaction to minimise gaps.
     */
    adrNumber: integer('adr_number').unique(),

    /**
     * Relative or absolute path to the ADR document on disk (e.g. `"docs/adr/ADR-027.md"`).
     *
     * NULL when the decision has no associated file (informal, ephemeral, or pre-ADR).
     */
    adrPath: text('adr_path'),

    /**
     * ID of the `brain_decisions` row that this decision supersedes.
     *
     * Self-referential FK. NULL when this decision does not replace a prior one.
     * The referenced row's `supersededBy` should be set to this row's ID on write.
     *
     * @see supersededBy — reverse pointer stored on the older row
     */
    supersedes: text('supersedes').references((): AnySQLiteColumn => brainDecisions.id),

    /**
     * ID of the `brain_decisions` row that has superseded this decision.
     *
     * Self-referential FK. NULL while this decision is still active.
     * Set when a newer decision's `supersedes` points to this row.
     *
     * @see supersedes — forward pointer stored on the newer row
     */
    supersededBy: text('superseded_by').references((): AnySQLiteColumn => brainDecisions.id),

    /**
     * Lifecycle state of this decision in the confirmation workflow.
     *
     * - `'proposed'`   — Newly filed; awaiting owner/council review.
     * - `'accepted'`   — Formally approved and active.
     * - `'superseded'` — Replaced by a newer decision (see `supersededBy`).
     *
     * Defaults to `'proposed'` for new rows. Existing rows backfilled to `'accepted'`
     * by the T1826 migration (see `20260504000001_t1826-decisions-v2/migration.sql`).
     */
    confirmationState: text('confirmation_state', {
      enum: ['proposed', 'accepted', 'superseded'],
    })
      .notNull()
      .default('proposed'),

    /**
     * Who approved / originated this decision.
     *
     * - `'owner'`   — Directly authored or approved by the project owner.
     * - `'council'` — Approved via multi-agent consensus (council vote).
     * - `'agent'`   — Agent-inferred; not yet owner/council confirmed.
     *
     * Defaults to `'agent'` so that existing legacy rows receive a safe value
     * during backfill without a write-path change.
     */
    decidedBy: text('decided_by', {
      enum: ['owner', 'council', 'agent'],
    })
      .notNull()
      .default('agent'),

    /**
     * Epoch millisecond timestamp of the most recent LLM-validator run against
     * this decision row (T1828 hook).
     *
     * NULL = never validated. Set by the validator on each successful run so
     * T1829 backfill walker can skip already-processed rows.
     */
    validatorRunAt: integer('validator_run_at'),
  },
  (table) => [
    index('idx_brain_decisions_type').on(table.type),
    index('idx_brain_decisions_confidence').on(table.confidence),
    index('idx_brain_decisions_outcome').on(table.outcome),
    index('idx_brain_decisions_context_epic').on(table.contextEpicId),
    index('idx_brain_decisions_context_task').on(table.contextTaskId),
    index('idx_brain_decisions_quality').on(table.qualityScore),
    // T549 indexes
    index('idx_brain_decisions_tier').on(table.memoryTier),
    index('idx_brain_decisions_mem_type').on(table.memoryType),
    index('idx_brain_decisions_verified').on(table.verified),
    index('idx_brain_decisions_valid_at').on(table.validAt),
    index('idx_brain_decisions_source_conf').on(table.sourceConfidence),
    // T726 indexes
    index('idx_brain_decisions_tier_promoted_at').on(table.tierPromotedAt),
    index('idx_brain_decisions_content_hash').on(table.contentHash),
    // T1084: peer isolation index
    index('idx_brain_decisions_peer_scope').on(table.peerId, table.peerScope),
    // T1826: ADR governance indexes
    index('idx_brain_decisions_adr_number').on(table.adrNumber),
    index('idx_brain_decisions_confirmation_state').on(table.confirmationState),
    index('idx_brain_decisions_decided_by').on(table.decidedBy),
  ],
);

// === BRAIN_PATTERNS TABLE ===

export const brainPatterns = sqliteTable(
  'brain_patterns',
  {
    id: text('id').primaryKey(),
    type: text('type', { enum: BRAIN_PATTERN_TYPES }).notNull(),
    pattern: text('pattern').notNull(),
    context: text('context').notNull(),
    frequency: integer('frequency').notNull().default(1),
    successRate: real('success_rate'),
    impact: text('impact', { enum: BRAIN_IMPACT_LEVELS }),
    antiPattern: text('anti_pattern'),
    mitigation: text('mitigation'),
    examplesJson: text('examples_json').default('[]'),
    extractedAt: text('extracted_at').notNull().default(sql`(datetime('now'))`),
    updatedAt: text('updated_at'),
    /**
     * Quality score: 0.0 (noise) – 1.0 (canonical). Null for legacy entries.
     * Computed at insert time from type, content richness, and examples.
     * Entries below 0.3 are excluded from search results (T531).
     */
    qualityScore: real('quality_score'),

    // T549: Tiered + Typed Memory columns

    /**
     * Memory retention tier. NULL on legacy rows → treat as 'medium' at query time.
     * T746: patterns skip short-tier entirely — writers always assign 'medium' (see patterns.ts).
     * The Drizzle DEFAULT is 'medium' to match the write-path behaviour.
     */
    memoryTier: text('memory_tier', { enum: BRAIN_MEMORY_TIERS }).default('medium'),

    /** Cognitive type. Patterns are always 'procedural' (process/workflow knowledge). */
    memoryType: text('memory_type', { enum: BRAIN_COGNITIVE_TYPES }).default('procedural'),

    /**
     * Ground-truth verification flag.
     * For patterns, this is complementary to frequency+successRate verification.
     * false = agent-inferred. true = confirmed via owner statement or task outcome.
     */
    verified: integer('verified', { mode: 'boolean' }).notNull().default(false),

    /**
     * Bitemporal: when this pattern became valid (ISO 8601 text).
     * Defaults to extraction time.
     */
    validAt: text('valid_at').notNull().default(sql`(datetime('now'))`),

    /**
     * Bitemporal: when this pattern stopped being valid.
     * NULL = currently valid. Set by consolidator when frequency+successRate drops below threshold.
     */
    invalidAt: text('invalid_at'),

    /**
     * Source reliability level — separate from content quality_score (T549 §3.1.5).
     * Drives quality multiplier at scoring time.
     */
    sourceConfidence: text('source_confidence', { enum: BRAIN_SOURCE_CONFIDENCE }).default('agent'),

    /**
     * Number of times this pattern has been cited/retrieved (T549 CONFLICT-03).
     * Used by the consolidator for citation-based medium→long promotion.
     */
    citationCount: integer('citation_count').notNull().default(0),

    // T726 Wave 1A: tier promotion audit columns

    /**
     * ISO 8601 timestamp when this pattern was last promoted to a higher tier.
     * Null = never promoted.
     */
    tierPromotedAt: text('tier_promoted_at'),

    /**
     * Human-readable reason for the most recent tier promotion.
     * Null = never promoted.
     */
    tierPromotionReason: text('tier_promotion_reason'),

    /**
     * SHA-256 prefix (first 16 hex chars) of the normalised pattern content.
     * Computed at insert time; used by hashDedupCheck to prevent exact-duplicate patterns.
     * Null on legacy rows (pre-T726).
     */
    contentHash: text('content_hash'),

    // T1260: PSYCHE E3 — provenanceClass sweep gate (M6)

    /**
     * Provenance class for the M6 refusal gate (T1260 PSYCHE E3).
     * - `'unswept-pre-T1151'` — default; refused by buildRetrievalBundle until W7 sweep.
     * - `'swept-clean'` — passed T1147 reconciler sweep.
     * - `'deriver-synthesized'` — created by T1145 deriver.
     * - `'owner-verified'` — manually promoted via `cleo memory verify`.
     */
    provenanceClass: text('provenance_class').default('unswept-pre-T1151'),

    // T1084: PSYCHE Wave 2 — CANT peer memory isolation

    /**
     * Peer identity for memory isolation (T1084 PSYCHE Wave 2).
     * `"global"` = shared across all peers (default for legacy rows).
     * @see brainDecisions.peerId for full documentation.
     */
    peerId: text('peer_id').notNull().default('global'),

    /**
     * Peer scope for memory isolation (T1084 PSYCHE Wave 2).
     * @see brainDecisions.peerScope for full documentation.
     */
    peerScope: text('peer_scope').notNull().default('project'),
  },
  (table) => [
    index('idx_brain_patterns_type').on(table.type),
    index('idx_brain_patterns_impact').on(table.impact),
    index('idx_brain_patterns_frequency').on(table.frequency),
    index('idx_brain_patterns_quality').on(table.qualityScore),
    // T549 indexes
    index('idx_brain_patterns_tier').on(table.memoryTier),
    index('idx_brain_patterns_mem_type').on(table.memoryType),
    index('idx_brain_patterns_verified').on(table.verified),
    index('idx_brain_patterns_valid_at').on(table.validAt),
    index('idx_brain_patterns_source_conf').on(table.sourceConfidence),
    // T726 indexes
    index('idx_brain_patterns_tier_promoted_at').on(table.tierPromotedAt),
    index('idx_brain_patterns_content_hash').on(table.contentHash),
    // T1084: peer isolation index
    index('idx_brain_patterns_peer_scope').on(table.peerId, table.peerScope),
  ],
);

// === BRAIN_LEARNINGS TABLE ===

export const brainLearnings = sqliteTable(
  'brain_learnings',
  {
    id: text('id').primaryKey(),
    insight: text('insight').notNull(),
    source: text('source').notNull(),
    confidence: real('confidence').notNull(), // 0.0-1.0
    actionable: integer('actionable', { mode: 'boolean' }).notNull().default(false),
    application: text('application'),
    applicableTypesJson: text('applicable_types_json'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    updatedAt: text('updated_at'),
    /**
     * Quality score: 0.0 (noise) – 1.0 (canonical). Null for legacy entries.
     * Computed at insert time from confidence, actionability, and content richness.
     * Entries below 0.3 are excluded from search results (T531).
     */
    qualityScore: real('quality_score'),

    // T549: Tiered + Typed Memory columns

    /** Memory retention tier. NULL on legacy rows → treat as 'medium' at query time. */
    memoryTier: text('memory_tier', { enum: BRAIN_MEMORY_TIERS }).default('short'),

    /**
     * Cognitive type. Learnings are 'semantic' by default (declarative facts).
     * Transcript-derived learnings with source containing 'transcript:ses_' are 'episodic'.
     */
    memoryType: text('memory_type', { enum: BRAIN_COGNITIVE_TYPES }).default('semantic'),

    /**
     * Ground-truth verification flag.
     * false = agent-inferred, pending verification.
     * true = confirmed via owner statement, task outcome, corroboration, or manual verify.
     */
    verified: integer('verified', { mode: 'boolean' }).notNull().default(false),

    /**
     * Bitemporal: when this learning became valid (ISO 8601 text).
     * Defaults to creation time. Facts can change — use invalidAt to retire stale ones.
     */
    validAt: text('valid_at').notNull().default(sql`(datetime('now'))`),

    /**
     * Bitemporal: when this learning stopped being valid.
     * NULL = currently valid. Set by consolidator on contradiction detection or TTL decay.
     */
    invalidAt: text('invalid_at'),

    /**
     * Source reliability level — separate from content quality_score (T549 §3.1.5).
     * Drives quality multiplier at scoring time.
     */
    sourceConfidence: text('source_confidence', { enum: BRAIN_SOURCE_CONFIDENCE }).default('agent'),

    /**
     * Number of times this learning has been cited/retrieved (T549 CONFLICT-03).
     * Used by the consolidator for citation-based medium→long promotion.
     */
    citationCount: integer('citation_count').notNull().default(0),

    // T726 Wave 1A: tier promotion audit columns

    /**
     * ISO 8601 timestamp when this learning was last promoted to a higher tier.
     * Null = never promoted.
     */
    tierPromotedAt: text('tier_promoted_at'),

    /**
     * Human-readable reason for the most recent tier promotion.
     * Null = never promoted.
     */
    tierPromotionReason: text('tier_promotion_reason'),

    /**
     * SHA-256 prefix (first 16 hex chars) of the normalised learning content.
     * Computed at insert time; used by hashDedupCheck to prevent exact-duplicate learnings.
     * Null on legacy rows (pre-T726).
     */
    contentHash: text('content_hash'),

    // T1260: PSYCHE E3 — provenanceClass sweep gate (M6)

    /**
     * Provenance class for the M6 refusal gate (T1260 PSYCHE E3).
     * - `'unswept-pre-T1151'` — default; refused by buildRetrievalBundle until W7 sweep.
     * - `'swept-clean'` — passed T1147 reconciler sweep.
     * - `'deriver-synthesized'` — created by T1145 deriver.
     * - `'owner-verified'` — manually promoted via `cleo memory verify`.
     */
    provenanceClass: text('provenance_class').default('unswept-pre-T1151'),

    // T1084: PSYCHE Wave 2 — CANT peer memory isolation

    /**
     * Peer identity for memory isolation (T1084 PSYCHE Wave 2).
     * `"global"` = shared across all peers (default for legacy rows).
     * @see brainDecisions.peerId for full documentation.
     */
    peerId: text('peer_id').notNull().default('global'),

    /**
     * Peer scope for memory isolation (T1084 PSYCHE Wave 2).
     * @see brainDecisions.peerScope for full documentation.
     */
    peerScope: text('peer_scope').notNull().default('project'),
  },
  (table) => [
    index('idx_brain_learnings_confidence').on(table.confidence),
    index('idx_brain_learnings_actionable').on(table.actionable),
    index('idx_brain_learnings_quality').on(table.qualityScore),
    // T549 indexes
    index('idx_brain_learnings_tier').on(table.memoryTier),
    index('idx_brain_learnings_mem_type').on(table.memoryType),
    index('idx_brain_learnings_verified').on(table.verified),
    index('idx_brain_learnings_valid_at').on(table.validAt),
    index('idx_brain_learnings_invalid').on(table.invalidAt),
    index('idx_brain_learnings_source_conf').on(table.sourceConfidence),
    // T726 indexes
    index('idx_brain_learnings_tier_promoted_at').on(table.tierPromotedAt),
    index('idx_brain_learnings_content_hash').on(table.contentHash),
    // T1084: peer isolation index
    index('idx_brain_learnings_peer_scope').on(table.peerId, table.peerScope),
  ],
);

// === BRAIN_OBSERVATIONS TABLE ===

/** General-purpose observations — replaces claude-mem's observations table. */
export const brainObservations = sqliteTable(
  'brain_observations',
  {
    id: text('id').primaryKey(),
    type: text('type', { enum: BRAIN_OBSERVATION_TYPES }).notNull(),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    narrative: text('narrative'),
    factsJson: text('facts_json'), // JSON array of fact strings
    conceptsJson: text('concepts_json'), // JSON array of concept strings
    project: text('project'),
    filesReadJson: text('files_read_json'), // JSON array of file paths
    filesModifiedJson: text('files_modified_json'), // JSON array of file paths
    sourceSessionId: text('source_session_id'), // soft FK to sessions
    sourceType: text('source_type', { enum: BRAIN_OBSERVATION_SOURCE_TYPES })
      .notNull()
      .default('agent'),
    /** T383/T417: agent provenance — identifies the spawned agent that produced this observation. Null for legacy entries. */
    agent: text('agent'), // nullable — null for legacy observations
    contentHash: text('content_hash'), // SHA-256 prefix for dedup
    discoveryTokens: integer('discovery_tokens'), // cost to produce this observation
    /**
     * Quality score: 0.0 (noise) – 1.0 (canonical). Null for legacy entries.
     * Computed at insert time from content richness and title length.
     * Entries below 0.3 are excluded from search results (T531).
     */
    qualityScore: real('quality_score'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    updatedAt: text('updated_at'),

    // T549: Tiered + Typed Memory columns

    /** Memory retention tier. NULL on legacy rows → treat as 'medium' at query time. */
    memoryTier: text('memory_tier', { enum: BRAIN_MEMORY_TIERS }).default('short'),

    /** Cognitive type. Observations are always 'episodic' (time-anchored event records). */
    memoryType: text('memory_type', { enum: BRAIN_COGNITIVE_TYPES }).default('episodic'),

    /**
     * Ground-truth verification flag.
     * false = agent-inferred, pending verification.
     * true = confirmed via owner statement, task outcome, corroboration, or manual verify.
     */
    verified: integer('verified', { mode: 'boolean' }).notNull().default(false),

    /**
     * Bitemporal: when this observation became valid (ISO 8601 text).
     * Defaults to creation time. Can be backdated for historical facts.
     */
    validAt: text('valid_at').notNull().default(sql`(datetime('now'))`),

    /**
     * Bitemporal: when this observation stopped being valid.
     * NULL = currently valid. Set by consolidator on contradiction detection.
     * Temporal query pattern: WHERE valid_at <= :t AND (invalid_at IS NULL OR invalid_at > :t)
     */
    invalidAt: text('invalid_at'),

    /**
     * Source reliability level — separate from content quality_score (T549 §3.1.5).
     * Drives quality multiplier at scoring time.
     */
    sourceConfidence: text('source_confidence', { enum: BRAIN_SOURCE_CONFIDENCE }).default('agent'),

    /**
     * Number of times this observation has been cited/retrieved (T549 CONFLICT-03).
     * Used by the consolidator for citation-based medium→long promotion.
     */
    citationCount: integer('citation_count').notNull().default(0),

    // T726 Wave 1A: tier promotion audit columns

    /**
     * ISO 8601 timestamp when this observation was last promoted to a higher tier.
     * Null = never promoted.
     */
    tierPromotedAt: text('tier_promoted_at'),

    /**
     * Human-readable reason for the most recent tier promotion.
     * Null = never promoted.
     */
    tierPromotionReason: text('tier_promotion_reason'),

    /**
     * T799: JSON array of attachment SHA-256 refs linked to this observation.
     *
     * Stored as a JSON-encoded string (e.g. `["a1b2...","c3d4..."]`).
     * Null means no attachment refs. Use `cleo memory observe --attach <sha256>`
     * to populate this column.
     *
     * The referenced attachments are stored in the tasks.db attachment registry
     * (same store used by `cleo docs`).  This column is a soft reference only —
     * CLEO does not enforce referential integrity here.
     */
    attachmentsJson: text('attachments_json'),

    /**
     * T1001: Biological-analog stability score: 0.0 (unstable) – 1.0 (consolidated).
     *
     * Mirrors brain_page_edges.stability_score but tracks observation-level consolidation
     * rather than edge-level plasticity. Used as one of the 6 signals in the composite
     * promotion scorer (promotion-score.ts).
     *
     * Default 0.5 = neutral/unknown stability on new observations.
     * Updated by runConsolidation decay pass and STDP backfill.
     *
     * Added via ensureColumns() in runBrainMigrations() — idempotent.
     *
     * @task T1001
     */
    stabilityScore: real('stability_score').default(0.5),

    // T1260: PSYCHE E3 — provenanceClass sweep gate (M6)

    /**
     * Provenance class for the M6 refusal gate (T1260 PSYCHE E3).
     * - `'unswept-pre-T1151'` — default; refused by buildRetrievalBundle until W7 sweep.
     * - `'swept-clean'` — passed T1147 reconciler sweep.
     * - `'deriver-synthesized'` — created by T1145 deriver.
     * - `'owner-verified'` — manually promoted via `cleo memory verify`.
     */
    provenanceClass: text('provenance_class').default('unswept-pre-T1151'),

    // T1084: PSYCHE Wave 2 — CANT peer memory isolation

    /**
     * Peer identity for memory isolation (T1084 PSYCHE Wave 2).
     * `"global"` = shared across all peers (default for legacy rows).
     * @see brainDecisions.peerId for full documentation.
     */
    peerId: text('peer_id').notNull().default('global'),

    /**
     * Peer scope for memory isolation (T1084 PSYCHE Wave 2).
     * @see brainDecisions.peerScope for full documentation.
     */
    peerScope: text('peer_scope').notNull().default('project'),

    // T1145 Wave 5: Deriver lineage + level columns

    /**
     * JSON array of ancestor brain_observations.id values that this entry
     * was derived from. Null for directly-observed entries.
     *
     * @task T1145
     */
    sourceIds: text('source_ids'),

    /**
     * How many times this observation has been derived/synthesized from.
     * Default 1 = created once (not yet re-derived).
     *
     * @task T1145
     */
    timesDerived: integer('times_derived').default(1),

    /**
     * Cognitive derivation level:
     * - `explicit`   — directly observed event (default)
     * - `inductive`  — synthesized by the deriver from a group of observations
     *
     * In-app CHECK enforced at write time; no SQLite CHECK constraint (Lesson 3).
     *
     * @task T1145
     */
    level: text('level').default('explicit'),

    /**
     * FK reference to brain_memory_trees.id — which leaf cluster contains
     * this observation after the last dream cycle.
     * Null until the first dream cycle assigns tree membership.
     *
     * @task T1146
     */
    treeId: integer('tree_id'),
  },
  (table) => [
    index('idx_brain_observations_type').on(table.type),
    index('idx_brain_observations_project').on(table.project),
    index('idx_brain_observations_created_at').on(table.createdAt),
    index('idx_brain_observations_source_type').on(table.sourceType),
    index('idx_brain_observations_source_session').on(table.sourceSessionId),
    // T033: composite replaces single-col content_hash; see brain migration
    index('idx_brain_observations_content_hash_created_at').on(table.contentHash, table.createdAt),
    // T033: type + project compound filter optimization
    index('idx_brain_observations_type_project').on(table.type, table.project),
    // T417: agent provenance index for memory.find --agent filter
    index('idx_brain_observations_agent').on(table.agent),
    // T531: quality score filter index
    index('idx_brain_observations_quality').on(table.qualityScore),
    // T549 indexes
    index('idx_brain_observations_tier').on(table.memoryTier),
    index('idx_brain_observations_mem_type').on(table.memoryType),
    index('idx_brain_observations_verified').on(table.verified),
    index('idx_brain_observations_valid_at').on(table.validAt),
    index('idx_brain_observations_invalid').on(table.invalidAt),
    index('idx_brain_observations_source_conf').on(table.sourceConfidence),
    // T726 indexes
    index('idx_brain_observations_tier_promoted_at').on(table.tierPromotedAt),
    // T1001 indexes
    index('idx_brain_observations_stability_score').on(table.stabilityScore),
    // T1084: peer isolation index
    index('idx_brain_observations_peer_scope').on(table.peerId, table.peerScope),
    // T1145: derivation level index
    index('idx_brain_observations_level').on(table.level),
    // T1146: tree membership index
    index('idx_brain_observations_tree_id').on(table.treeId),
  ],
);

// === BRAIN_STICKY_NOTES TABLE ===

/** Ephemeral sticky notes for quick capture before formal classification. */
export const brainStickyNotes = sqliteTable(
  'brain_sticky_notes',
  {
    id: text('id').primaryKey(),
    content: text('content').notNull(),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    updatedAt: text('updated_at'),
    tagsJson: text('tags_json'),
    status: text('status', { enum: BRAIN_STICKY_STATUSES }).notNull().default('active'),
    convertedToJson: text('converted_to_json'),
    color: text('color', { enum: BRAIN_STICKY_COLORS }),
    priority: text('priority', { enum: BRAIN_STICKY_PRIORITIES }),
    sourceType: text('source_type').default('sticky-note'),
  },
  (table) => [
    index('idx_brain_sticky_status').on(table.status),
    index('idx_brain_sticky_created').on(table.createdAt),
    index('idx_brain_sticky_tags').on(table.tagsJson),
  ],
);

// === BRAIN_MEMORY_LINKS TABLE ===

/** Cross-references between BRAIN entries and tasks in tasks.db. */
export const brainMemoryLinks = sqliteTable(
  'brain_memory_links',
  {
    memoryType: text('memory_type', { enum: BRAIN_MEMORY_TYPES }).notNull(),
    memoryId: text('memory_id').notNull(),
    taskId: text('task_id').notNull(), // soft FK to tasks.id in tasks.db
    linkType: text('link_type', { enum: BRAIN_LINK_TYPES }).notNull(),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    primaryKey({ columns: [table.memoryType, table.memoryId, table.taskId, table.linkType] }),
    index('idx_brain_links_task').on(table.taskId),
    index('idx_brain_links_memory').on(table.memoryType, table.memoryId),
  ],
);

// === SCHEMA METADATA ===

export const brainSchemaMeta = sqliteTable('brain_schema_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

// === PAGEINDEX GRAPH TABLES (T5160, expanded T528) ===

/**
 * Node types for the graph-native memory model.
 * Mirrors typed tables (decision, pattern, learning, observation, sticky),
 * adds task provenance (task, session, epic), codebase bridging (file, symbol),
 * abstract/synthesized types (concept, summary), cross-substrate bridges
 * (msg, llmtxt, commit), and fills in the universal semantic graph for T945.
 *
 * Node ID format: `<type>:<source-id>`.
 *
 * Supported prefixes:
 * - `decision:D-<hash>`         — brain_decisions row
 * - `pattern:P-<hash>`          — brain_patterns row
 * - `learning:L-<hash>`         — brain_learnings row
 * - `observation:O-<hash>-<n>`  — brain_observations row
 * - `sticky:<id>`               — brain_sticky row (scratchpad)
 * - `task:T###`                 — tasks.db row (soft FK)
 * - `session:ses_<ts>_<rand>`   — tasks.db session row (soft FK)
 * - `epic:T###`                 — tasks.db epic row (soft FK)
 * - `file:<relative-path>`      — nexus.db file node (soft FK)
 * - `symbol:<path>::<name>`     — nexus.db symbol node (soft FK)
 * - `concept:<slug>`            — abstract concept (synthesized)
 * - `summary:<hash>`            — synthesized summary node
 * - `msg:<messageId>`           — CONDUIT message (T945 Stage A) — soft FK into conduit.db
 * - `llmtxt:<sha256>`           — llmtxt blob attachment (T945 Stage A) — content-addressable
 * - `commit:<sha>`              — git commit (T945 Stage A) — Tier 3 autonomy audit
 *
 * @task T945
 */
export const BRAIN_NODE_TYPES = [
  // Memory entity types (mirror typed tables)
  'decision',
  'pattern',
  'learning',
  'observation',
  'sticky',
  // Task provenance (soft FK into tasks.db)
  'task',
  'session',
  'epic',
  // Codebase integration (bridge to nexus.db code_index)
  'file',
  'symbol',
  // Abstract / synthesized
  'concept',
  'summary',
  // Cross-substrate bridges (T945 Stage A — universal semantic graph)
  'msg', // CONDUIT message node — `msg:<messageId>`
  'llmtxt', // llmtxt attachment blob — `llmtxt:<sha256>` (content-addressable)
  'commit', // git commit node — `commit:<sha>` (Tier 3 autonomy audit)
] as const;

/** Discriminated union of all supported brain graph node types. */
export type BrainNodeType = (typeof BRAIN_NODE_TYPES)[number];

/**
 * Edge types for the graph-native memory model.
 * Covers provenance/derivation, semantic relationships, structural links,
 * graph bridging between memory entities and codebase nodes, plastic
 * Hebbian/STDP edges, and T945 Stage A cross-substrate relationships.
 *
 * Directionality convention: `from_id` is the source/subject; `to_id` is
 * the target/object. The edge type phrase reads naturally left-to-right
 * (e.g. `task:T1 → blocks → task:T2` means T1 blocks T2).
 *
 * @task T945
 */
export const BRAIN_EDGE_TYPES = [
  // Provenance / derivation
  'derived_from', // learning ← derived_from ← observation
  'produced_by', // observation ← produced_by ← session
  'informed_by', // decision ← informed_by ← pattern
  // Semantic relationship
  'supports', // observation → supports → decision
  'contradicts', // observation → contradicts → decision
  'supersedes', // decision → supersedes → decision (older)
  'applies_to', // decision/pattern → applies_to → task/file/symbol
  // Structural
  'documents', // observation → documents → symbol/file
  'summarizes', // summary → summarizes → observation (consolidation)
  'part_of', // task → part_of → epic
  // Graph bridging (memory ↔ code)
  'references', // observation → references → symbol
  'modified_by', // file → modified_by → session
  'code_reference', // memory node → code_reference → nexus symbol/file (T645)
  'affects', // observation → affects → symbol/file (impact tracking)
  'mentions', // observation → mentions → symbol name (weak reference)
  'conduit_mentions_symbol', // conduit message → mentions nexus symbol (T1071)
  // Plasticity (Hebbian + STDP co-retrieval)
  'co_retrieved', // A → co_retrieved → B (Hebbian: frequently retrieved together)
  // T945 Stage A — universal semantic graph
  'blocks', // task → blocks → task (dependency: A blocks B = B waits on A)
  'discusses', // msg → discusses → task/decision/epic (CONDUIT message bridge)
  'cites', // decision/observation → cites → llmtxt/file (research citation)
  'embeds', // task/observation → embeds → llmtxt (attachment ownership)
  'touches_code', // task → touches_code → file/symbol (more specific than code_reference)
  'task_touches_symbol', // task → task_touches_symbol → nexus symbol (T1067, git-log driven)
] as const;

/** Discriminated union of all supported brain graph edge types. */
export type BrainEdgeType = (typeof BRAIN_EDGE_TYPES)[number];

/**
 * Graph nodes table — the traversable knowledge graph layer.
 *
 * Every entity row in a typed table (decisions, patterns, learnings,
 * observations) gets a corresponding node here. The typed table row is
 * the source of truth; the graph node is the index entry for traversal
 * and cross-entity reasoning.
 *
 * Node ID convention: '<type>:<source-id>' — see BRAIN_NODE_TYPES docstring
 * for the authoritative prefix list.
 *
 * Examples: 'decision:D-abc123', 'observation:O-mntphoj6-0',
 *           'task:T523', 'symbol:src/store/memory-schema.ts::brainPageNodes',
 *           'msg:msg_abc123', 'llmtxt:9f2a...sha256', 'commit:04021568a'
 */
export const brainPageNodes = sqliteTable(
  'brain_page_nodes',
  {
    /** Stable composite ID: '<type>:<source-id>' */
    id: text('id').primaryKey(),

    /** Discriminated type from BRAIN_NODE_TYPES. */
    nodeType: text('node_type', { enum: BRAIN_NODE_TYPES }).notNull(),

    /** Human-readable label (title, name, or generated summary). */
    label: text('label').notNull(),

    /**
     * Quality score: 0.0 (noise) – 1.0 (canonical).
     * Derived from: source confidence, edge density, age decay, agent provenance.
     * Default 0.5 for unknown provenance; 0.0 triggers exclusion from traversal.
     */
    qualityScore: real('quality_score').notNull().default(0.5),

    /**
     * SHA-256 prefix (first 16 hex chars) of the canonical content.
     * Computed at insert time; duplicate hashes are rejected.
     * Null for external references (task, session, symbol nodes).
     */
    contentHash: text('content_hash'),

    /**
     * ISO 8601 timestamp of last activity on this node.
     * Updated when new edges are added, quality changes, or content is revised.
     */
    lastActivityAt: text('last_activity_at').notNull().default(sql`(datetime('now'))`),

    /**
     * Extensible JSON metadata blob — type-specific payload.
     * decision: { type, confidence, outcome }
     * observation: { sourceType, agent, sessionId }
     * symbol: { filePath, kind, startLine, endLine, language }
     * task: { status, priority, epicId }
     */
    metadataJson: text('metadata_json'),

    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    updatedAt: text('updated_at'),
  },
  (table) => [
    index('idx_brain_nodes_type').on(table.nodeType),
    index('idx_brain_nodes_quality').on(table.qualityScore),
    index('idx_brain_nodes_content_hash').on(table.contentHash),
    index('idx_brain_nodes_last_activity').on(table.lastActivityAt),
  ],
);

/**
 * Graph edges table — directed, typed, weighted, provenance-aware links
 * between brain_page_nodes entries (or external nexus node IDs).
 *
 * The composite primary key (fromId, toId, edgeType) prevents duplicate
 * edges of the same type between the same pair of nodes.
 */
export const brainPageEdges = sqliteTable(
  'brain_page_edges',
  {
    fromId: text('from_id').notNull(), // brain_page_nodes.id
    toId: text('to_id').notNull(), // brain_page_nodes.id or nexus node id
    edgeType: text('edge_type', { enum: BRAIN_EDGE_TYPES }).notNull(),

    /**
     * Edge weight / confidence: 0.0 – 1.0.
     * Semantic edges use extractor confidence (similarity score).
     * Structural edges use 1.0 (deterministic).
     * Contradiction edges store the overlap score that triggered detection.
     */
    weight: real('weight').notNull().default(1.0),

    /**
     * Human-readable note on why this edge was emitted.
     * Examples: 'auto:task-complete' | 'auto:session-end' |
     *           'auto:contradiction-detected' | 'auto:consolidation' | 'manual'
     */
    provenance: text('provenance'),

    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),

    // === T673-M3: Plasticity tracking columns ===

    /**
     * ISO 8601 timestamp of the last LTP event applied to this edge.
     * Used by the decay pass: edges with (now - last_reinforced_at) > decay_threshold_days
     * receive a per-day weight decay. Null = never reinforced (structural/semantic edges).
     * Only populated when plasticity_class IN ('hebbian', 'stdp').
     *
     * @task T706
     */
    lastReinforcedAt: text('last_reinforced_at'),

    /**
     * Count of LTP (potentiation) events applied to this edge lifetime.
     * Incremented on every LTP write. Used to compute stability_score.
     *
     * @task T706
     */
    reinforcementCount: integer('reinforcement_count').notNull().default(0),

    /**
     * Plasticity class governing which algorithm(s) write to this edge.
     *
     * - 'static':  Non-plastic edge (structural, semantic, etc.). Immune to decay.
     * - 'hebbian': Written by strengthenCoRetrievedEdges. Subject to decay.
     * - 'stdp':    Written or refined by applyStdpPlasticity. Subject to decay + LTD.
     *
     * Edges start 'static' for all non-co_retrieved types.
     * co_retrieved edges start 'hebbian' (seeded by M3 migration), can upgrade to 'stdp'.
     *
     * @task T706
     */
    plasticityClass: text('plasticity_class', {
      enum: ['static', 'hebbian', 'stdp'] as const,
    })
      .notNull()
      .default('static'),

    /**
     * ISO 8601 timestamp of the last LTD (depression) event on this edge.
     * Null = never depressed. Used for debugging and Studio viz animation.
     *
     * @task T706
     */
    lastDepressedAt: text('last_depressed_at'),

    /**
     * Count of LTD (depression) events applied to this edge lifetime.
     * Enables analysis of edges that are persistently weakened.
     *
     * @task T706
     */
    depressionCount: integer('depression_count').notNull().default(0),

    /**
     * Biological-analog stability score: 0.0 (unstable) – 1.0 (consolidated).
     *
     * Computed by runConsolidation decay pass as:
     *   stability = tanh(reinforcement_count / 10) × exp(-(days_since_reinforced / 30))
     *
     * Null = not yet computed (new edges). Enables fast filtering in decay pass:
     * edges with stability > 0.9 skip the full decay recalculation.
     * Updated at session-end consolidation, NOT per-event.
     *
     * @task T706
     */
    stabilityScore: real('stability_score'),
  },
  (table) => [
    primaryKey({ columns: [table.fromId, table.toId, table.edgeType] }),
    index('idx_brain_edges_from').on(table.fromId),
    index('idx_brain_edges_to').on(table.toId),
    index('idx_brain_edges_type').on(table.edgeType),
    index('idx_brain_edges_last_reinforced').on(table.lastReinforcedAt),
    index('idx_brain_edges_plasticity_class').on(table.plasticityClass),
    index('idx_brain_edges_stability').on(table.stabilityScore),
  ],
);

// ============================================================================
// RETRIEVAL LOG — tracks which entries are retrieved together (T549 §6)
// ============================================================================

/**
 * Retrieval log tracks which brain entries are returned together in search
 * results. This data drives:
 *   - Co-retrieval edge strengthening (consolidation step 6)
 *   - Memory quality instrumentation (retrieval frequency tracking)
 *   - Citation count validation (corroboration for tier promotion)
 *   - STDP plasticity — spike-timing pairs derived from retrieval timestamps (T673)
 *
 * Each row records one retrieval event: the query, which entries were returned,
 * and the retrieval source (find/fetch/hybrid).
 *
 * Column notes (T673-M1):
 *   entry_ids    — stored as JSON array string '["id1","id2"]' (never CSV).
 *                  Writer: JSON.stringify(entryIds). Readers: JSON.parse(row.entry_ids).
 *                  M1 migration converts existing CSV rows to JSON format.
 *   session_id   — synced to live table via M1 ALTER (was missing from live DDL).
 *   reward_signal — R-STDP third-factor: +1.0 verified | +0.5 done | -0.5 cancelled | null.
 *   retrieval_order — existed in live table via self-healing DDL but was absent in Drizzle.
 *                     M1 brings Drizzle into sync (schema drift fix).
 *   delta_ms     — same schema drift resolution as retrieval_order.
 */
export const brainRetrievalLog = sqliteTable(
  'brain_retrieval_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    /** The search query or fetch IDs that triggered this retrieval. */
    query: text('query').notNull(),

    /**
     * JSON array of entry IDs returned in this retrieval.
     * Stored as JSON array string: '["obs:A","obs:B"]'.
     * Always write with JSON.stringify() — NEVER join(',').
     * Readers call JSON.parse(). Migration M1 converts any pre-existing CSV rows.
     */
    entryIds: text('entry_ids').notNull(),

    /** Number of entries returned. */
    entryCount: integer('entry_count').notNull(),

    /** Retrieval source: 'find' | 'fetch' | 'hybrid' | 'timeline' | 'budget' */
    source: text('source').notNull(),

    /** Estimated tokens consumed by this retrieval. */
    tokensUsed: integer('tokens_used'),

    /** Session ID (soft FK to tasks.db sessions). Enables grouping retrievals by session for STDP analysis. */
    sessionId: text('session_id'),

    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),

    // === T673-M1: STDP plasticity columns ===

    /** Sequence position of this retrieval within a batch query (0-based). */
    retrievalOrder: integer('retrieval_order'),

    /** Wall-clock ms since the previous retrieval row in the same batch. */
    deltaMs: integer('delta_ms'),

    /**
     * R-STDP reward signal: scalar [-1.0, +1.0], null = unlabeled.
     * Populated by backfillRewardSignals() at session end (Step 9a).
     * +1.0 = task verified and passed | +0.5 = done (unverified) | -0.5 = cancelled.
     * Per D-BRAIN-VIZ-13. backfillRewardSignals MUST skip rows where
     * session_id LIKE 'ses_backfill_%' (synthetic historical sessions, no task correlation).
     */
    rewardSignal: real('reward_signal'),
  },
  (table) => [
    index('idx_retrieval_log_created').on(table.createdAt),
    index('idx_retrieval_log_source').on(table.source),
    index('idx_retrieval_log_session').on(table.sessionId),
    index('idx_retrieval_log_reward').on(table.rewardSignal),
  ],
);

// ============================================================================
// PLASTICITY EVENTS — STDP weight-change audit log (T626 phase 5)
// ============================================================================

/**
 * Records every STDP weight-change event applied to a brain_page_edges row.
 *
 * Each row captures the causal pair (source_node, target_node), the signed
 * delta applied to the edge weight, whether it was a potentiation or
 * depression event, and which session and timestamp triggered it.
 *
 * @task T626
 * @epic T626
 */
export const brainPlasticityEvents = sqliteTable(
  'brain_plasticity_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** from_id of the affected brain_page_edges row. */
    sourceNode: text('source_node').notNull(),
    /** to_id of the affected brain_page_edges row. */
    targetNode: text('target_node').notNull(),
    /**
     * Signed weight delta applied to the edge.
     * Positive = potentiation (LTP), negative = depression (LTD).
     */
    deltaW: real('delta_w').notNull(),
    /**
     * STDP event kind: `ltp` (Long-Term Potentiation) or `ltd` (Long-Term
     * Depression).
     */
    kind: text('kind', { enum: ['ltp', 'ltd'] }).notNull(),
    /** ISO 8601 timestamp when this event was applied. */
    timestamp: text('timestamp').notNull().default(sql`(datetime('now'))`),
    /** Session ID that triggered the STDP pass, if available. */
    sessionId: text('session_id'),

    // === T673-M2: Observability columns ===

    /**
     * Edge weight immediately BEFORE this plasticity event was applied.
     * Null on the first LTP event that inserts a new edge (edge didn't exist).
     * Enables "show learning history" in Studio viz without querying brain_weight_history.
     *
     * @task T696
     */
    weightBefore: real('weight_before'),

    /**
     * Edge weight immediately AFTER this plasticity event was applied.
     * Computed as CLAMP(weight_before + delta_w, 0.0, 1.0).
     * Redundant with delta_w but enables fast before/after display without arithmetic.
     *
     * @task T696
     */
    weightAfter: real('weight_after'),

    /**
     * Soft FK to brain_retrieval_log.id — the retrieval row that triggered this pair.
     * Null for externally-triggered or legacy events.
     * Enables: "which memory retrieval caused this edge to strengthen?"
     *
     * @task T696
     */
    retrievalLogId: integer('retrieval_log_id'),

    /**
     * R-STDP reward signal active when this event fired.
     * Copied from the retrieval_log row's reward_signal at time of plasticity pass.
     * Null = unmodulated. Denormalized for fast filtering without a JOIN.
     *
     * @task T696
     */
    rewardSignal: real('reward_signal'),

    /**
     * Wall-clock milliseconds between the two spikes that generated this event.
     * Pre-computed at INSERT time — avoids re-deriving from retrieval timestamps.
     * Enables analysis of STDP window distribution.
     *
     * @task T696
     */
    deltaTMs: integer('delta_t_ms'),
  },
  (table) => [
    index('idx_plasticity_source').on(table.sourceNode),
    index('idx_plasticity_target').on(table.targetNode),
    index('idx_plasticity_timestamp').on(table.timestamp),
    index('idx_plasticity_session').on(table.sessionId),
    index('idx_plasticity_kind').on(table.kind),
    index('idx_plasticity_retrieval_log').on(table.retrievalLogId),
    index('idx_plasticity_reward').on(table.rewardSignal),
  ],
);

// ============================================================================
// WEIGHT HISTORY — immutable per-edge Δw audit log (T673-M4, T697)
// ============================================================================

/**
 * Immutable audit log of every edge weight change (LTP, LTD, Hebbian, prune,
 * external). Routine exponential decay writes do NOT appear here — only discrete
 * plasticity events that cross the 1e-6 negligibility threshold.
 *
 * Retention policy: rolling 90 days. runConsolidation Step 9d DELETE sweep
 * purges rows older than 90 days. Actual pruning wired in Wave 3 (T690).
 *
 * Spec: docs/specs/stdp-wire-up-spec.md §2.1.4 (owner Q4 mandate — in scope).
 *
 * @task T697
 * @epic T673
 */
export const brainWeightHistory = sqliteTable(
  'brain_weight_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    /** from_id of the affected brain_page_edges row. */
    edgeFromId: text('edge_from_id').notNull(),

    /** to_id of the affected brain_page_edges row. */
    edgeToId: text('edge_to_id').notNull(),

    /** Edge type of the affected brain_page_edges row (e.g. 'co_retrieved'). */
    edgeType: text('edge_type').notNull(),

    /** Edge weight immediately before this event. Null if the edge was just created. */
    weightBefore: real('weight_before'),

    /** Edge weight after this event. CLAMP(weightBefore + deltaWeight, 0, 1). NOT NULL. */
    weightAfter: real('weight_after').notNull(),

    /**
     * Signed weight delta applied to the edge.
     * Positive = potentiation (LTP/Hebbian), negative = depression (LTD).
     * Prune events record the final weight that triggered deletion (negative).
     */
    deltaWeight: real('delta_weight').notNull(),

    /**
     * Plasticity event kind.
     * 'ltp'      — Long-Term Potentiation (STDP pre-before-post)
     * 'ltd'      — Long-Term Depression (STDP post-before-pre)
     * 'hebbian'  — Co-retrieval Hebbian strengthening
     * 'decay'    — Temporal decay (only prune-triggering decays written here)
     * 'prune'    — Edge deleted (weight fell below min_weight threshold)
     * 'external' — Manually-applied external weight change
     */
    eventKind: text('event_kind').notNull(),

    /** Soft FK to brain_plasticity_events.id — the STDP event that caused this. */
    sourcePlasticityEventId: integer('source_plasticity_event_id'),

    /** Soft FK to brain_retrieval_log.id — the retrieval batch that triggered this. */
    retrievalLogId: integer('retrieval_log_id'),

    /** R-STDP reward signal at time of event (copied from retrieval_log.reward_signal). */
    rewardSignal: real('reward_signal'),

    /** ISO 8601 timestamp when this weight change was applied. */
    changedAt: text('changed_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_weight_history_edge').on(table.edgeFromId, table.edgeToId, table.edgeType),
    index('idx_weight_history_from').on(table.edgeFromId),
    index('idx_weight_history_to').on(table.edgeToId),
    index('idx_weight_history_changed_at').on(table.changedAt),
    index('idx_weight_history_event_kind').on(table.eventKind),
    index('idx_weight_history_plasticity_event').on(table.sourcePlasticityEventId),
  ],
);

// ============================================================================
// BRAIN MODULATORS — R-STDP neuromodulator event log (T673-M4, T699)
// ============================================================================

/**
 * Discrete neuromodulator event log for R-STDP third-factor gating.
 * Records every reward/correction/feedback signal that modulates plasticity.
 * Inserted by backfillRewardSignals for each task outcome it processes.
 *
 * Both writes (retrieval_log UPDATE and modulators INSERT) use two separate
 * SQLite connections — no ATTACH — matching the cross-db-cleanup.ts pattern.
 *
 * Spec: docs/specs/stdp-wire-up-spec.md §2.1.5 (Lead A §4.5).
 *
 * @task T699
 * @epic T673
 */
export const brainModulators = sqliteTable(
  'brain_modulators',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    /**
     * Modulator event type. String (not enum constraint) for extensibility.
     * Expected values: 'task_verified'|'task_completed'|'task_cancelled'|
     * 'owner_verify'|'session_success'|'session_blocker'|'external'
     */
    modulatorType: text('modulator_type').notNull(),

    /**
     * Reward valence in range [-1.0, +1.0].
     * +1.0 = strong reward (verified correct task)
     * +0.5 = moderate reward (done, unverified)
     * -0.5 = mild correction (cancelled task)
     * -1.0 = strong correction (explicit invalidation)
     *  0.0 = neutral signal
     */
    valence: real('valence').notNull(),

    /**
     * Magnitude 0.0–1.0 confidence scaling.
     * Effective reward = valence × magnitude.
     * Defaults to 1.0 (full confidence).
     */
    magnitude: real('magnitude').notNull().default(1.0),

    /** Polymorphic source event ID — task ID, memory entry ID, or other string ref. */
    sourceEventId: text('source_event_id'),

    /** Session ID (soft FK to tasks.db sessions). */
    sessionId: text('session_id'),

    /** Human-readable description of why this modulator was emitted. */
    description: text('description'),

    /** ISO 8601 timestamp when this modulator event was recorded. */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_modulators_type').on(table.modulatorType),
    index('idx_modulators_session').on(table.sessionId),
    index('idx_modulators_created_at').on(table.createdAt),
    index('idx_modulators_source_event').on(table.sourceEventId),
    index('idx_modulators_valence').on(table.valence),
  ],
);

// ============================================================================
// BRAIN CONSOLIDATION EVENTS — pipeline run audit log (T673-M4, T701)
// ============================================================================

/**
 * One row per runConsolidation execution. Enables T628 auto-dream scheduling
 * and pipeline observability. Required by the auto-dream cycle for scheduling.
 *
 * runConsolidation in brain-lifecycle.ts MUST accept an optional trigger
 * parameter and INSERT one row per run with step_results_json + duration_ms.
 *
 * Spec: docs/specs/stdp-wire-up-spec.md §2.1.6 (Lead A + Lead C joint).
 *
 * @task T701
 * @epic T673
 */
export const brainConsolidationEvents = sqliteTable(
  'brain_consolidation_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    /**
     * What triggered this consolidation run. String (not enum constraint) for
     * forward compatibility with T628 scheduler.
     * Expected values: 'session_end' | 'maintenance' | 'scheduled' | 'manual'
     */
    trigger: text('trigger').notNull(),

    /** Session ID that initiated this consolidation (soft FK to tasks.db sessions). */
    sessionId: text('session_id'),

    /**
     * JSON-serialized ConsolidationResult — all per-step counts and metrics.
     * Shape: { [stepName: string]: { count: number, durationMs?: number } }
     * Required NOT NULL — every run must record its results for T628 scheduling.
     */
    stepResultsJson: text('step_results_json').notNull(),

    /** Wall-clock milliseconds from start to completion. Null if run did not complete. */
    durationMs: integer('duration_ms'),

    /**
     * Whether the run succeeded.
     * Stored as integer(boolean) per Drizzle SQLite boolean convention.
     * true = completed without unhandled error, false = partial or error.
     */
    succeeded: integer('succeeded', { mode: 'boolean' }).notNull().default(true),

    /** ISO 8601 timestamp when this consolidation run started. */
    startedAt: text('started_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_consolidation_events_started_at').on(table.startedAt),
    index('idx_consolidation_events_trigger').on(table.trigger),
    index('idx_consolidation_events_session').on(table.sessionId),
  ],
);

// ============================================================================
// BRAIN TRANSCRIPT EVENTS — full-fidelity Claude session ingestion (T1002)
// ============================================================================

/**
 * Full-fidelity transcript event store for Claude session JSONL ingestion.
 *
 * Each row represents one content block from a Claude session transcript:
 * text, tool_use, tool_result, thinking, or system entries. Blocks that
 * contain secrets are flagged via redacted_at before persistence.
 *
 * The (session_id, seq) pair is unique — re-ingesting the same session is
 * idempotent via INSERT OR IGNORE.
 *
 * @task T1002
 * @epic T1000
 */
export const brainTranscriptEvents = sqliteTable(
  'brain_transcript_events',
  {
    id: text('id').primaryKey(),
    /** Session ID sourced from the JSONL filename (ses_YYYYMMDD_xxxxx). */
    sessionId: text('session_id').notNull(),
    /** Ordinal position of this block within the session (0-based). */
    seq: integer('seq').notNull(),
    /**
     * Message role: 'user' | 'assistant' | 'system'.
     * Matches the 'role' field from the Claude message object.
     */
    role: text('role').notNull(),
    /**
     * Content block type: 'text' | 'tool_use' | 'tool_result' | 'thinking'.
     * Preserved exactly from the Claude JSONL block.type field.
     */
    blockType: text('block_type').notNull(),
    /**
     * Serialised block content. For text blocks this is the raw string.
     * For tool_use / tool_result / thinking blocks this is JSON.stringify of
     * the block minus any redacted fields.
     */
    content: text('content').notNull(),
    /** Approximate token count for the block (null when not computable). */
    tokens: integer('tokens'),
    /**
     * ISO 8601 timestamp when this row was redacted (PII/secret scrub applied).
     * Null = block was clean and stored as-is.
     */
    redactedAt: text('redacted_at'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_transcript_events_session').on(table.sessionId),
    index('idx_transcript_events_role').on(table.role),
    index('idx_transcript_events_block_type').on(table.blockType),
    index('idx_transcript_events_created_at').on(table.createdAt),
  ],
);

// ============================================================================
// BRAIN PROMOTION LOG — typed promotion audit trail (T1001)
// ============================================================================

/**
 * Audit log for observation-to-typed-entry promotions.
 *
 * Every time promoteObservationsToTyped() promotes a brain_observations row
 * to a typed entry (brain_learnings, brain_patterns), one row is written here
 * to record what was promoted, why, and the full composite score breakdown.
 *
 * Pairs with T997 promote-explain CLI which reads this table.
 *
 * @task T1001
 * @epic T1000
 */
export const brainPromotionLog = sqliteTable(
  'brain_promotion_log',
  {
    /** Unique promotion event ID. Format: `promo-<timestamp36>-<rand>`. */
    id: text('id').primaryKey(),

    /** ID of the brain_observations row that was evaluated. */
    observationId: text('observation_id').notNull(),

    /**
     * Source tier (always 'observation' for this table — reserved for future
     * multi-source promotion pipelines).
     */
    fromTier: text('from_tier').notNull(),

    /**
     * Target typed entity: 'learning' | 'pattern' | 'decision' | 'diary'.
     * Determines which table the promoted entry lands in.
     */
    toTier: text('to_tier').notNull(),

    /**
     * Composite promotion score at the time of promotion (0.0–1.0).
     * Computed by computePromotionScore() in promotion-score.ts.
     */
    score: real('score').notNull(),

    /** ISO 8601 timestamp when this promotion was decided. */
    decidedAt: text('decided_at').notNull().default(sql`(datetime('now'))`),

    /**
     * Who or what made the promotion decision.
     * 'composite-scorer' = automatic via promoteObservationsToTyped.
     * 'owner' = manually triggered via `cleo memory promote`.
     */
    decidedBy: text('decided_by').notNull().default('composite-scorer'),

    /**
     * JSON-serialized PromotionRationale from promotion-score.ts.
     * Contains per-signal breakdowns and weighted contributions.
     * Null for legacy rows.
     */
    rationaleJson: text('rationale_json'),
  },
  (table) => [
    index('idx_promotion_log_observation').on(table.observationId),
    index('idx_promotion_log_decided_at').on(table.decidedAt),
    index('idx_promotion_log_to_tier').on(table.toTier),
    index('idx_promotion_log_score').on(table.score),
  ],
);

// ============================================================================
// BRAIN BACKFILL RUNS — staged backfill audit log (T1003)
// ============================================================================

/**
 * Staged backfill run registry.
 *
 * Records every staged backfill operation: what was staged, from which source,
 * targeting which table, how many rows, and the current workflow status.
 *
 * A backfill run is immutable once `approved` or `rolled-back`. Attempting
 * to approve/rollback a completed run is a no-op that returns success with
 * an `alreadySettled` flag set to `true`.
 *
 * Rollback safety: `rollback_snapshot_json` contains the full array of
 * row IDs that were staged so approve/rollback are deterministic with no
 * additional DB lookup required.
 *
 * @task T1003
 * @epic T1000
 */
export const brainBackfillRuns = sqliteTable(
  'brain_backfill_runs',
  {
    /** Unique run identifier. Format: `bfr-<timestamp36>-<rand>`. */
    id: text('id').primaryKey(),

    /**
     * Backfill kind — what type of data this run is populating.
     *
     * - `observation-promotion` — promoting brain_observations to typed entries
     * - `transcript-ingest`     — ingesting Claude JSONL session transcripts
     * - `graph-backfill`        — populating brain_page_nodes/edges from typed tables
     * - `noise-sweep-2440`      — T1147 W7: shadow-write BRAIN noise sweep (2440-entry estimate)
     * - `custom`                — ad-hoc runs initiated by the owner
     */
    kind: text('kind').notNull(),

    /**
     * Workflow status of this run.
     *
     * - `staged`      — run has been created; rows are held in a shadow scope (not live).
     * - `approved`    — run was approved; staged rows have been committed to live tables.
     * - `rolled-back` — run was rolled back; staged rows were discarded.
     */
    status: text('status').notNull().default('staged'),

    /** ISO 8601 timestamp when this run was created. */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),

    /**
     * ISO 8601 timestamp when this run was approved (status → 'approved').
     * Null if not yet approved.
     */
    approvedAt: text('approved_at'),

    /**
     * Number of rows that were staged (and would be / were committed on approve).
     * Updated after staging completes.
     */
    rowsAffected: integer('rows_affected').notNull().default(0),

    /**
     * JSON-serialized snapshot of the staged row IDs.
     * Shape: `string[]` — list of target-table primary keys that were staged.
     * Used by rollback to remove committed rows deterministically.
     * Null for large backfills that use cursor-based rollback instead.
     */
    rollbackSnapshotJson: text('rollback_snapshot_json'),

    /**
     * Source descriptor — file path, session ID, or other identifier
     * indicating where the data came from (e.g. a JSONL transcript path).
     */
    source: text('source').notNull().default('unknown'),

    /**
     * Target table name in brain.db (e.g. `brain_observations`, `brain_page_nodes`).
     * Used by rollback to issue DELETE WHERE id IN (...) against the right table.
     */
    targetTable: text('target_table').notNull().default('brain_observations'),

    /**
     * Identity of the agent or human who approved this run.
     * Null if not yet approved or rolled back.
     */
    approvedBy: text('approved_by'),
  },
  (table) => [
    index('idx_backfill_runs_status').on(table.status),
    index('idx_backfill_runs_kind').on(table.kind),
    index('idx_backfill_runs_created_at').on(table.createdAt),
  ],
);

// ============================================================================
// T1089 — Session Narrative (PSYCHE Wave 3)
// ============================================================================

/**
 * Rolling session narrative table.
 *
 * Stores a compact prose summary of what has happened in each CLEO session,
 * updated incrementally by the Dialectic Evaluator's `appendNarrativeDelta()`.
 *
 * PSYCHE reference: `upstream psyche-lineage · deriver/deriver.py`
 * (session state derivation — PSYCHE maintains a rolling representation of
 * what a session "is about" to inform future retrieval and sigil generation).
 *
 * @task T1089
 * @epic T1082
 */
export const sessionNarrative = sqliteTable('session_narrative', {
  /**
   * CLEO session identifier (e.g. `ses_20260422131135_5149eb`).
   * Matches the `session_id` field used throughout the sessions subsystem.
   */
  sessionId: text('session_id').primaryKey(),

  /**
   * Rolling prose summary of the session, updated by `appendNarrativeDelta()`.
   * Maximum length is enforced at the application layer: 2000 characters.
   * When the limit is exceeded, oldest content is trimmed from the left.
   */
  narrative: text('narrative').notNull().default(''),

  /**
   * Number of dialectic turns that have contributed to this narrative.
   * Incremented by one on each `appendNarrativeDelta()` call.
   */
  turnCount: integer('turn_count').notNull().default(0),

  /**
   * Unix epoch milliseconds when the narrative was last updated.
   * Set to `Date.now()` on every `appendNarrativeDelta()` call.
   */
  lastUpdatedAt: integer('last_updated_at').notNull().default(0),

  /**
   * Number of detected topic pivots in this session.
   *
   * Incremented when `detectPivot()` returns true for an incoming delta.
   * A pivot indicates a significant shift in conversation topic, useful for
   * future multi-pass retrieval to weight recent narrative higher.
   */
  pivotCount: integer('pivot_count').notNull().default(0),
});

/** Row type for session_narrative SELECT queries. */
export type SessionNarrativeRow = typeof sessionNarrative.$inferSelect;
/** Row type for session_narrative INSERT operations. */
export type NewSessionNarrativeRow = typeof sessionNarrative.$inferInsert;

// === TYPE EXPORTS ===

export type BrainTranscriptEventRow = typeof brainTranscriptEvents.$inferSelect;
export type NewBrainTranscriptEventRow = typeof brainTranscriptEvents.$inferInsert;

export type BrainRetrievalLogRow = typeof brainRetrievalLog.$inferSelect;
export type NewBrainRetrievalLogRow = typeof brainRetrievalLog.$inferInsert;
export type BrainDecisionRow = typeof brainDecisions.$inferSelect;
export type NewBrainDecisionRow = typeof brainDecisions.$inferInsert;
export type BrainPatternRow = typeof brainPatterns.$inferSelect;
export type NewBrainPatternRow = typeof brainPatterns.$inferInsert;
export type BrainLearningRow = typeof brainLearnings.$inferSelect;
export type NewBrainLearningRow = typeof brainLearnings.$inferInsert;
export type BrainObservationRow = typeof brainObservations.$inferSelect;
export type NewBrainObservationRow = typeof brainObservations.$inferInsert;
export type BrainMemoryLinkRow = typeof brainMemoryLinks.$inferSelect;
export type NewBrainMemoryLinkRow = typeof brainMemoryLinks.$inferInsert;
export type BrainPageNodeRow = typeof brainPageNodes.$inferSelect;
export type NewBrainPageNodeRow = typeof brainPageNodes.$inferInsert;
export type BrainPageEdgeRow = typeof brainPageEdges.$inferSelect;
export type NewBrainPageEdgeRow = typeof brainPageEdges.$inferInsert;
export type BrainStickyNoteRow = typeof brainStickyNotes.$inferSelect;
export type NewBrainStickyNoteRow = typeof brainStickyNotes.$inferInsert;
export type BrainPlasticityEventRow = typeof brainPlasticityEvents.$inferSelect;
export type NewBrainPlasticityEventRow = typeof brainPlasticityEvents.$inferInsert;

/** Row type for brain_weight_history SELECT queries. */
export type BrainWeightHistoryRow = typeof brainWeightHistory.$inferSelect;
/** Row type for brain_weight_history INSERT operations. */
export type BrainWeightHistoryInsert = typeof brainWeightHistory.$inferInsert;

/** Row type for brain_modulators SELECT queries. */
export type BrainModulatorRow = typeof brainModulators.$inferSelect;
/** Row type for brain_modulators INSERT operations. */
export type BrainModulatorInsert = typeof brainModulators.$inferInsert;

/** Row type for brain_consolidation_events SELECT queries. */
export type BrainConsolidationEventRow = typeof brainConsolidationEvents.$inferSelect;
/** Row type for brain_consolidation_events INSERT operations. */
export type BrainConsolidationEventInsert = typeof brainConsolidationEvents.$inferInsert;

/** Row type for brain_promotion_log SELECT queries. */
export type BrainPromotionLogRow = typeof brainPromotionLog.$inferSelect;
/** Row type for brain_promotion_log INSERT operations. */
export type BrainPromotionLogInsert = typeof brainPromotionLog.$inferInsert;

/** Row type for brain_backfill_runs SELECT queries. */
export type BrainBackfillRunRow = typeof brainBackfillRuns.$inferSelect;
/** Row type for brain_backfill_runs INSERT operations. */
export type BrainBackfillRunInsert = typeof brainBackfillRuns.$inferInsert;

/** Valid status values for brain_backfill_runs.status. */
export const BRAIN_BACKFILL_RUN_STATUSES = ['staged', 'approved', 'rolled-back'] as const;
/** Discriminated union of all backfill run statuses. */
export type BrainBackfillRunStatus = (typeof BRAIN_BACKFILL_RUN_STATUSES)[number];

// BrainNodeType and BrainEdgeType are declared alongside their enum arrays above.

// ============================================================================
// DERIVER QUEUE — durable background derivation work items (T1145 Wave 5)
// ============================================================================

/**
 * Valid item types for the deriver queue.
 * - `observation`  — derive an inductive synthesis from a set of observations
 * - `session`      — summarize a session into session_narrative
 * - `narrative`    — update an existing narrative with new observations
 * - `embedding`    — compute/backfill embeddings for an observation
 */
export const DERIVER_QUEUE_ITEM_TYPES = [
  'observation',
  'session',
  'narrative',
  'embedding',
] as const;
/** Discriminated union of deriver queue item types. */
export type DeriverQueueItemType = (typeof DERIVER_QUEUE_ITEM_TYPES)[number];

/**
 * Valid status values for deriver_queue.status.
 * - `pending`     — waiting to be claimed by a worker
 * - `in_progress` — claimed by a worker, being processed
 * - `done`        — successfully processed
 * - `failed`      — permanently failed (moved to DLQ semantics)
 */
export const DERIVER_QUEUE_STATUSES = ['pending', 'in_progress', 'done', 'failed'] as const;
/** Discriminated union of deriver queue status values. */
export type DeriverQueueStatus = (typeof DERIVER_QUEUE_STATUSES)[number];

/**
 * Durable background derivation work queue.
 *
 * Implements a SQLite-WAL-backed producer/consumer queue using the
 * "status column + ORDER BY created_at" pattern (analogous to PostgreSQL
 * `FOR UPDATE SKIP LOCKED`). Workers claim items via exclusive transactions
 * and complete/fail them atomically.
 *
 * Stale items (claimed_at older than threshold) are re-queued to `pending`
 * during maintenance passes.
 *
 * @task T1145
 * @epic T1145
 */
export const deriverQueue = sqliteTable(
  'deriver_queue',
  {
    /** Unique work item identifier. Format: `dq-<timestamp36>-<rand>`. */
    id: text('id').primaryKey(),

    /**
     * The type of derivation work to perform.
     * Drives which deriver function processes this item.
     */
    itemType: text('item_type', { enum: DERIVER_QUEUE_ITEM_TYPES }).notNull(),

    /** Source item ID (e.g. brain_observations.id, session id, etc.). */
    itemId: text('item_id').notNull(),

    /**
     * Priority for ordering within the same status bucket.
     * Higher = more important. Default 0.
     */
    priority: integer('priority').notNull().default(0),

    /**
     * Current processing status.
     * State machine: pending → in_progress → done | failed
     */
    status: text('status', { enum: DERIVER_QUEUE_STATUSES }).notNull().default('pending'),

    /**
     * ISO 8601 timestamp when this item was claimed by a worker.
     * Null when status is `pending` or after re-queue.
     * Used for stale-claim detection.
     */
    claimedAt: text('claimed_at'),

    /**
     * Worker identifier that claimed this item.
     * Format: `worker-<pid>-<timestamp>` or test override string.
     */
    claimedBy: text('claimed_by'),

    /** Error message when status = `failed`. */
    errorMsg: text('error_msg'),

    /**
     * Number of times this item has been retried.
     * After max retries the item moves to `failed` (DLQ semantics).
     */
    retryCount: integer('retry_count').notNull().default(0),

    /** ISO 8601 timestamp when the item was enqueued. */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),

    /** ISO 8601 timestamp when the item was successfully completed. Null until done. */
    completedAt: text('completed_at'),
  },
  (table) => [
    // Primary claim query: pending items ordered by priority desc, created_at asc
    index('idx_deriver_queue_status_priority').on(table.status, table.priority, table.createdAt),
    // Dedup check: one pending/in_progress item per (itemType, itemId)
    index('idx_deriver_queue_item').on(table.itemType, table.itemId),
    // Stale-claim recovery: find in_progress items with old claimed_at
    index('idx_deriver_queue_claimed_at').on(table.claimedAt),
  ],
);

/** Row type for deriver_queue SELECT queries. */
export type DeriverQueueRow = typeof deriverQueue.$inferSelect;
/** Row type for deriver_queue INSERT operations. */
export type DeriverQueueInsert = typeof deriverQueue.$inferInsert;

// ============================================================================
// BRAIN MEMORY TREES — hierarchical RPTree clustering (T1146 Wave 6)
// ============================================================================

/**
 * Hierarchical Random Projection Tree nodes for consolidated memory.
 *
 * Each row represents a node in the RPTree. Leaf nodes contain groups of
 * semantically-similar observations (leaf_ids). Internal nodes group leaves.
 * Trees are rebuilt each dream cycle (full truncate + repopulate).
 *
 * brain_observations.tree_id references the leaf node containing that
 * observation after the last dream cycle.
 *
 * @task T1146
 * @epic T1146
 */
export const brainMemoryTrees = sqliteTable(
  'brain_memory_trees',
  {
    /** Auto-incrementing row id. Used as FK in brain_observations.tree_id. */
    id: integer('id').primaryKey({ autoIncrement: true }),

    /**
     * Depth of this node in the RPTree.
     * 0 = root, 1 = first-level partition, etc.
     */
    depth: integer('depth').notNull().default(0),

    /**
     * JSON array of brain_observations.id values in this leaf cluster.
     * Empty array `[]` for internal (non-leaf) nodes.
     */
    leafIds: text('leaf_ids').notNull().default('[]'),

    /**
     * Serialized float32 centroid of this node's embedding cluster.
     * Null when not computed (e.g. no embeddings available).
     */
    centroid: text('centroid'), // JSON-encoded float array

    /**
     * Parent node id. Null for the root node.
     */
    parentId: integer('parent_id'),

    /** ISO 8601 timestamp when this tree node was created. */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),

    /** ISO 8601 timestamp when this tree node was last updated. */
    updatedAt: text('updated_at'),
  },
  (table) => [
    index('idx_brain_trees_parent').on(table.parentId),
    index('idx_brain_trees_depth').on(table.depth),
  ],
);

/** Row type for brain_memory_trees SELECT queries. */
export type BrainMemoryTreeRow = typeof brainMemoryTrees.$inferSelect;
/** Row type for brain_memory_trees INSERT operations. */
export type BrainMemoryTreeInsert = typeof brainMemoryTrees.$inferInsert;

// ============================================================================
// T1147 — Wave 7: Shadow-write envelope staging table
// ============================================================================

/**
 * Shadow-write staging table for the T1147 BRAIN noise sweep.
 *
 * One row per candidate entry to sweep. Anchored to a `brain_backfill_runs`
 * row (`sweep_run_id`) of kind `noise-sweep-2440`. The workflow is:
 *
 * 1. W7-3 detector populates `brain_observations_staging` + a `brain_backfill_runs`
 *    row (`status: 'staged'`).
 * 2. Autonomous 100-entry stratified validation writes sample JSON.
 * 3. `cleo memory sweep --approve <runId>` calls W7-4 executor, which opens
 *    a cutover tx: applies actions to live tables, updates `brain_backfill_runs`
 *    to `approved`, removes `pending` candidates.
 * 4. Reject: `brain_backfill_runs` → `rolled-back`; candidates discarded.
 *
 * `action` values:
 * - `purge`       — set `invalid_at = now()`, `provenance_class = 'noise-purged'`
 * - `keep`        — set `provenance_class = 'swept-clean'` (no structural change)
 * - `reclassify`  — adjust `quality_score` and mark `swept-clean`
 * - `promote`     — raise tier + `swept-clean`
 *
 * History: renamed from `brain_v2_candidate` (T1402) — the prior name read
 * like a schema version, but the intent was "staging rows awaiting validation."
 *
 * @task T1147
 * @epic T1075
 */
export const brainObservationsStaging = sqliteTable(
  'brain_observations_staging',
  {
    /** Unique candidate identifier. Format: `bos-<timestamp36>-<rand>`. */
    id: text('id').primaryKey(),

    /**
     * The live brain table this candidate targets.
     * One of: `brain_observations`, `brain_learnings`, `brain_decisions`,
     * `brain_patterns`.
     */
    sourceTable: text('source_table').notNull(),

    /** Primary key in the source table for the targeted row. */
    sourceId: text('source_id').notNull(),

    /**
     * FK to `brain_backfill_runs.id`.
     * The sweep run that produced this candidate.
     */
    sweepRunId: text('sweep_run_id').notNull(),

    /**
     * Planned action for this entry during the cutover transaction.
     *
     * - `purge`      — mark `invalid_at`, set `provenance_class='noise-purged'`
     * - `keep`       — set `provenance_class='swept-clean'`, no other changes
     * - `reclassify` — update `quality_score` + mark `swept-clean`
     * - `promote`    — raise memory tier + mark `swept-clean`
     */
    action: text('action').notNull(),

    /**
     * Replacement `quality_score` to write on `reclassify`/`promote`.
     * Null when action is `purge` or `keep`.
     */
    newQualityScore: real('new_quality_score'),

    /**
     * ISO 8601 `invalid_at` value to write for `purge` actions.
     * Null for non-purge actions.
     */
    newInvalidAt: text('new_invalid_at'),

    /**
     * `provenance_class` value to write during cutover.
     *
     * - `swept-clean`    — for `keep` / `reclassify` / `promote` actions
     * - `noise-purged`   — for `purge` actions
     */
    newProvenanceClass: text('new_provenance_class'),

    /**
     * Status of this candidate within the sweep workflow.
     *
     * - `pending`  — awaiting approval
     * - `applied`  — cutover tx committed this row's action to the live table
     * - `skipped`  — cutover tx skipped this row (e.g. already superseded)
     */
    validationStatus: text('validation_status').notNull().default('pending'),

    /** ISO 8601 timestamp when this candidate was created. */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_bos_sweep_run').on(table.sweepRunId),
    index('idx_bos_source').on(table.sourceTable, table.sourceId),
    index('idx_bos_status').on(table.validationStatus),
  ],
);

/** Row type for brain_observations_staging SELECT queries. */
export type BrainObservationsStagingRow = typeof brainObservationsStaging.$inferSelect;
/** Row type for brain_observations_staging INSERT operations. */
export type NewBrainObservationsStagingRow = typeof brainObservationsStaging.$inferInsert;

/** Valid action values for brain_observations_staging.action. */
export const BRAIN_OBSERVATIONS_STAGING_ACTIONS = [
  'purge',
  'keep',
  'reclassify',
  'promote',
] as const;
/** Discriminated union of all candidate actions. */
export type BrainObservationsStagingAction = (typeof BRAIN_OBSERVATIONS_STAGING_ACTIONS)[number];

/** Valid validation_status values for brain_observations_staging. */
export const BRAIN_OBSERVATIONS_STAGING_STATUSES = ['pending', 'applied', 'skipped'] as const;
/** Discriminated union of all candidate validation statuses. */
export type BrainObservationsStagingStatus = (typeof BRAIN_OBSERVATIONS_STAGING_STATUSES)[number];
