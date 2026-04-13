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

import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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

/** Discriminated union of all memory retention tiers. */
export type BrainMemoryTier = (typeof BRAIN_MEMORY_TIERS)[number];

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

/** Discriminated union of all cognitive memory types. */
export type BrainCognitiveType = (typeof BRAIN_COGNITIVE_TYPES)[number];

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

/** Discriminated union of all source confidence levels. */
export type BrainSourceConfidence = (typeof BRAIN_SOURCE_CONFIDENCE)[number];

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

    /** Memory retention tier. NULL on legacy rows → treat as 'medium' at query time. */
    memoryTier: text('memory_tier', { enum: BRAIN_MEMORY_TIERS }).default('short'),

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

    /** Memory retention tier. NULL on legacy rows → treat as 'medium' at query time. */
    memoryTier: text('memory_tier', { enum: BRAIN_MEMORY_TIERS }).default('short'),

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
 * and abstract/synthesized types (concept, summary).
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
] as const;

/** Discriminated union of all supported brain graph node types. */
export type BrainNodeType = (typeof BRAIN_NODE_TYPES)[number];

/**
 * Edge types for the graph-native memory model.
 * Covers provenance/derivation, semantic relationships, structural links,
 * and graph bridging between memory entities and codebase nodes.
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
 * Node ID convention: '<type>:<source-id>'
 * Examples: 'decision:D-abc123', 'observation:O-mntphoj6-0',
 *           'task:T523', 'symbol:src/store/brain-schema.ts::brainPageNodes'
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
  },
  (table) => [
    primaryKey({ columns: [table.fromId, table.toId, table.edgeType] }),
    index('idx_brain_edges_from').on(table.fromId),
    index('idx_brain_edges_to').on(table.toId),
    index('idx_brain_edges_type').on(table.edgeType),
  ],
);

// === TYPE EXPORTS ===

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
// BrainNodeType and BrainEdgeType are declared alongside their enum arrays above.
