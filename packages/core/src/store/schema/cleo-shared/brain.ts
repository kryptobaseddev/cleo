/**
 * Consolidated **`brain_*` memory family** — MIRRORED across BOTH cleo.db scopes.
 *
 * SG-DB-SUBSTRATE-V2 · saga T11242 · epic T11245 (E2) · task T11360 (final
 * project-tier increment). This is the LAST piece of the project schema.
 *
 * ## Why `cleo-shared/` (the mirroring contract — read this, T11361)
 *
 * Per owner decision D1″, `brain_*` is the ONE domain that lives in BOTH the
 * PROJECT-scope `cleo.db` (`<projectRoot>/.cleo/cleo.db` — this project's local
 * memory) AND the GLOBAL-scope `cleo.db` (`$XDG_DATA_HOME/cleo/cleo.db` —
 * cross-project memory). Same DDL, two physical DB files, data partitioned by
 * scope. To avoid duplication, the prefixed E10-typed `brain_*` target tables
 * are authored ONCE here, under `cleo-shared/`, and imported by BOTH scope
 * barrels:
 *   - `cleo-project/index.ts` re-exports this module (wired by THIS task, T11360).
 *   - `cleo-global/index.ts` (the future global barrel, T11361) MUST re-export
 *     this same module — do NOT copy these definitions; import them.
 *
 * Target-shape authoring only — the live runtime module
 * `packages/core/src/store/schema/memory-schema.ts` keeps its physical names
 * (already `brain_*`-prefixed for most tables) until the exodus migration
 * (T11248) swaps the substrate; the migration-baseline test asserts the live
 * existence table `brain_decisions`, so the live module is NOT changed in-place.
 *
 * ## Idempotent prefixer (AC1)
 *
 * Most source tables are already `brain_*`-prefixed → the idempotent prefixer is
 * a no-op (a recognized-prefix table is NOT double-prefixed). The three source
 * tables WITHOUT the prefix gain it per their `targetTable`:
 *   - `sticky_tags`        → `brain_sticky_tags`
 *   - `session_narrative`  → `brain_session_narrative`
 *   - `deriver_queue`      → `brain_deriver_queue`
 *
 * ## E10 typing applied
 *
 * - **§5b enum-like bare-TEXT → { enum } from named const arrays (§5a):**
 *   - `brain_transcript_events.role` → { enum: BRAIN_TRANSCRIPT_ROLES } (the
 *     source doc-comment confirms the exhaustive set user|assistant|system).
 *   - `brain_backfill_runs.kind`   → { enum: BRAIN_BACKFILL_KINDS } (5 values
 *     enumerated from the source doc-comment).
 *   - `brain_backfill_runs.status` → { enum: BRAIN_BACKFILL_RUN_STATUSES }
 *     (reused from the source module — staged|approved|rolled-back).
 *   (The nexus `sigils.role` non-conformer the report also flags is GLOBAL-only
 *   — it belongs to `nexus_*`, authored in the global batch T11361, not here.)
 * - **§4 epoch → canonical TEXT ISO8601** (these are the ONLY brain epoch
 *   non-conformers; the other ~157 brain timestamps were already TEXT ISO8601):
 *   - `brain_decisions.validator_run_at`        (was INTEGER ms epoch)
 *   - `brain_attention.{created_at,expires_at}`  (was INTEGER ms epoch)
 *   - `brain_session_narrative.last_updated_at`  (was INTEGER ms epoch)
 *   **§8.1 epoch-unit RESOLVED:** all four are MILLISECONDS — the writers use
 *   `Date.now()` / `unixepoch() * 1000`, so the exodus conversion uses the
 *   `/1000` ms divisor: `strftime('%Y-%m-%dT%H:%M:%fZ', col/1000, 'unixepoch')`.
 * - **§3 booleans:** every `verified` flag, `brain_learnings.actionable`, and
 *   `brain_consolidation_events.succeeded` are already
 *   `integer({ mode: 'boolean' })` — preserved.
 * - **§6a JSON / §6b junction (AC4):** JSON-in-TEXT columns stay serialized TEXT
 *   per the JSON-Column Audit; `brain_attention.tags` keeps the EXISTING E4
 *   `jsonb<T>()` JSONB-BLOB pattern from `../jsonb.js` (NOT re-invented). Per
 *   §6b the json-storage-jsonb-audit routes `brain_sticky_notes.tags_json` to
 *   the `brain_sticky_tags` junction — authored here mirroring the live
 *   `sticky_tags` E4 junction; the legacy `tags_json` column is RETAINED for
 *   whole-array compatibility (the junction is the membership SSoT).
 *
 * Cross-DB soft FKs (brain→tasks/sessions/nexus/conduit) are carried as plain
 * TEXT id columns (resolved by the brain accessor; no DB-level FK, since the
 * scopes are separate files); intra-domain self-FKs (decision supersession,
 * sticky→tags) are real `.references()`.
 *
 * - **§7 idempotency (Pattern A · T11362):** `brain_observations` — the highest-
 *   leverage retried-write target (`cleo memory observe` retries + the
 *   graph-memory-bridge `setImmediate` observers re-emit on race) — gains a
 *   nullable `idempotency_key TEXT` + UNIQUE so a redelivered observation is a
 *   no-op via `onConflictDoNothing`. Because this family is mirrored, the dedup
 *   grain is each scope's own physical `cleo.db`.
 *
 * @task T11360 · T11362 (§7 idempotency key)
 * @epic T11245
 * @saga T11242
 * @see docs/migration/sqlite-schema-canonical.md §1 (mirrored) · §3 · §4 · §5b · §6 · §7 · §8.1
 * @see docs/migration/sqlite-schema-columns.json (per-column affinity SSoT)
 */

import { BRAIN_OBSERVATION_SOURCE_TYPES } from '@cleocode/contracts';
import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';
import { jsonb } from '../jsonb.js';
import {
  BRAIN_ATTENTION_SCOPE_KINDS,
  BRAIN_ATTENTION_STATUSES,
  BRAIN_BACKFILL_RUN_STATUSES,
  BRAIN_COGNITIVE_TYPES,
  BRAIN_CONFIDENCE_LEVELS,
  BRAIN_DECISION_CATEGORIES,
  BRAIN_DECISION_TYPES,
  BRAIN_EDGE_TYPES,
  BRAIN_IMPACT_LEVELS,
  BRAIN_LINK_TYPES,
  BRAIN_MEMORY_TIERS,
  BRAIN_MEMORY_TYPES,
  BRAIN_NODE_TYPES,
  BRAIN_OBSERVATION_TYPES,
  BRAIN_OUTCOME_TYPES,
  BRAIN_PATTERN_TYPES,
  BRAIN_SOURCE_CONFIDENCE,
  BRAIN_STICKY_COLORS,
  BRAIN_STICKY_PRIORITIES,
  BRAIN_STICKY_STATUSES,
  DERIVER_QUEUE_ITEM_TYPES,
  DERIVER_QUEUE_STATUSES,
} from '../memory-schema.js';

// ---------------------------------------------------------------------------
// §5b enum const arrays minted here (CHECK derivation references identifiers)
// ---------------------------------------------------------------------------

/**
 * Transcript message roles — minted for `brain_transcript_events.role` (§5b →
 * §5a). The exhaustive set is taken from the source doc-comment ("'user' |
 * 'assistant' | 'system'") which mirrors the Claude message `role` field.
 */
export const BRAIN_TRANSCRIPT_ROLES = ['user', 'assistant', 'system'] as const;

/**
 * Backfill-run kinds — minted for `brain_backfill_runs.kind` (§5b → §5a).
 * Enumerated from the source doc-comment.
 */
export const BRAIN_BACKFILL_KINDS = [
  'observation-promotion',
  'transcript-ingest',
  'graph-backfill',
  'noise-sweep-2440',
  'custom',
] as const;

/** Decision confirmation states — promoted from inline literal (§5a). */
export const BRAIN_DECISION_CONFIRMATION_STATES = ['proposed', 'accepted', 'superseded'] as const;
/** Decision decided-by actors — promoted from inline literal (§5a). */
export const BRAIN_DECISION_DECIDED_BY = ['owner', 'council', 'agent'] as const;

// ---------------------------------------------------------------------------
// Decisions / patterns / learnings / observations
// ---------------------------------------------------------------------------

/**
 * `brain_decisions` — architectural/technical decision records.
 *
 * @task T11360 (target shape) · T5127 (original)
 */
export const brainDecisions = sqliteTable(
  'brain_decisions',
  {
    /** Decision id. */
    id: text('id').primaryKey(),
    /** Decision type — CHECK-backed via {@link BRAIN_DECISION_TYPES}. */
    type: text('type', { enum: BRAIN_DECISION_TYPES }).notNull(),
    /** Decision statement. */
    decision: text('decision').notNull(),
    /** Rationale. */
    rationale: text('rationale').notNull(),
    /** Confidence — CHECK-backed via {@link BRAIN_CONFIDENCE_LEVELS}. */
    confidence: text('confidence', { enum: BRAIN_CONFIDENCE_LEVELS }).notNull(),
    /** Outcome — CHECK-backed via {@link BRAIN_OUTCOME_TYPES}. */
    outcome: text('outcome', { enum: BRAIN_OUTCOME_TYPES }),
    /** JSON alternatives (TEXT per JSON audit). */
    alternativesJson: text('alternatives_json'),
    /** Decision context epic (cross-DB soft FK → tasks). */
    contextEpicId: text('context_epic_id'),
    /** Decision context task (cross-DB soft FK → tasks). */
    contextTaskId: text('context_task_id'),
    /** Context phase. */
    contextPhase: text('context_phase'),
    /** Quality score 0.0–1.0. */
    qualityScore: real('quality_score'),
    /** ISO-8601 UTC creation instant (canonical TEXT, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC last-update instant (canonical TEXT, §4). */
    updatedAt: text('updated_at'),
    /** Memory retention tier — CHECK-backed via {@link BRAIN_MEMORY_TIERS}. */
    memoryTier: text('memory_tier', { enum: BRAIN_MEMORY_TIERS }).default('medium'),
    /** Cognitive type — CHECK-backed via {@link BRAIN_COGNITIVE_TYPES}. */
    memoryType: text('memory_type', { enum: BRAIN_COGNITIVE_TYPES }).default('semantic'),
    /** Ground-truth verified flag. §3 boolean — already typed, preserved. */
    verified: integer('verified', { mode: 'boolean' }).notNull().default(false),
    /** Bitemporal valid-from (canonical TEXT, §4). */
    validAt: text('valid_at').notNull().default(sql`(datetime('now'))`),
    /** Bitemporal valid-until (canonical TEXT, §4). */
    invalidAt: text('invalid_at'),
    /** Source reliability — CHECK-backed via {@link BRAIN_SOURCE_CONFIDENCE}. */
    sourceConfidence: text('source_confidence', { enum: BRAIN_SOURCE_CONFIDENCE }).default('agent'),
    /** Citation count. */
    citationCount: integer('citation_count').notNull().default(0),
    /** ISO-8601 UTC tier-promotion instant (canonical TEXT, §4). */
    tierPromotedAt: text('tier_promoted_at'),
    /** Tier-promotion reason. */
    tierPromotionReason: text('tier_promotion_reason'),
    /** Dedup content hash. */
    contentHash: text('content_hash'),
    /** Provenance sweep class. */
    provenanceClass: text('provenance_class').default('swept-clean'),
    /** Peer identity (memory isolation). */
    peerId: text('peer_id').notNull().default('global'),
    /** Peer scope (memory isolation). */
    peerScope: text('peer_scope').notNull().default('project'),
    /** Monotonic ADR sequence number (UNIQUE). */
    adrNumber: integer('adr_number').unique(),
    /** ADR document path. */
    adrPath: text('adr_path'),
    /** Self-FK → superseded decision. */
    supersedes: text('supersedes').references((): AnySQLiteColumn => brainDecisions.id),
    /** Self-FK → superseding decision. */
    supersededBy: text('superseded_by').references((): AnySQLiteColumn => brainDecisions.id),
    /** Confirmation state — CHECK-backed via the inline-promoted const below. */
    confirmationState: text('confirmation_state', {
      enum: BRAIN_DECISION_CONFIRMATION_STATES,
    })
      .notNull()
      .default('proposed'),
    /** Decided-by — CHECK-backed via the inline-promoted const below. */
    decidedBy: text('decided_by', { enum: BRAIN_DECISION_DECIDED_BY }).notNull().default('agent'),
    /** ISO-8601 UTC last validator-run instant (was ms epoch, §4 / §8.1). */
    validatorRunAt: text('validator_run_at'),
    /** Decision category — CHECK-backed via {@link BRAIN_DECISION_CATEGORIES}. */
    decisionCategory: text('decision_category', { enum: BRAIN_DECISION_CATEGORIES })
      .notNull()
      .default('architectural'),
  },
  (table) => [
    index('idx_brain_decisions_type').on(table.type),
    index('idx_brain_decisions_confidence').on(table.confidence),
    index('idx_brain_decisions_outcome').on(table.outcome),
    index('idx_brain_decisions_context_epic').on(table.contextEpicId),
    index('idx_brain_decisions_context_task').on(table.contextTaskId),
    index('idx_brain_decisions_quality').on(table.qualityScore),
    index('idx_brain_decisions_tier').on(table.memoryTier),
    index('idx_brain_decisions_mem_type').on(table.memoryType),
    index('idx_brain_decisions_verified').on(table.verified),
    index('idx_brain_decisions_valid_at').on(table.validAt),
    index('idx_brain_decisions_source_conf').on(table.sourceConfidence),
    index('idx_brain_decisions_tier_promoted_at').on(table.tierPromotedAt),
    index('idx_brain_decisions_content_hash').on(table.contentHash),
    index('idx_brain_decisions_peer_scope').on(table.peerId, table.peerScope),
    index('idx_brain_decisions_adr_number').on(table.adrNumber),
    index('idx_brain_decisions_confirmation_state').on(table.confirmationState),
    index('idx_brain_decisions_decided_by').on(table.decidedBy),
    index('idx_brain_decisions_decision_category').on(table.decisionCategory),
  ],
);

/**
 * `brain_patterns` — workflow/process patterns.
 *
 * @task T11360 (target shape)
 */
export const brainPatterns = sqliteTable(
  'brain_patterns',
  {
    /** Pattern id. */
    id: text('id').primaryKey(),
    /** Pattern type — CHECK-backed via {@link BRAIN_PATTERN_TYPES}. */
    type: text('type', { enum: BRAIN_PATTERN_TYPES }).notNull(),
    /** Pattern statement. */
    pattern: text('pattern').notNull(),
    /** Context. */
    context: text('context').notNull(),
    /** Observation frequency. */
    frequency: integer('frequency').notNull().default(1),
    /** Success rate 0.0–1.0. */
    successRate: real('success_rate'),
    /** Impact — CHECK-backed via {@link BRAIN_IMPACT_LEVELS}. */
    impact: text('impact', { enum: BRAIN_IMPACT_LEVELS }),
    /** Anti-pattern note. */
    antiPattern: text('anti_pattern'),
    /** Mitigation note. */
    mitigation: text('mitigation'),
    /** JSON examples (TEXT per JSON audit; empty-array default). */
    examplesJson: text('examples_json').default('[]'),
    /** ISO-8601 UTC extraction instant (canonical TEXT, §4). */
    extractedAt: text('extracted_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC last-update instant (canonical TEXT, §4). */
    updatedAt: text('updated_at'),
    /** Quality score 0.0–1.0. */
    qualityScore: real('quality_score'),
    /** Memory tier — CHECK-backed via {@link BRAIN_MEMORY_TIERS}. */
    memoryTier: text('memory_tier', { enum: BRAIN_MEMORY_TIERS }).default('medium'),
    /** Cognitive type — CHECK-backed via {@link BRAIN_COGNITIVE_TYPES}. */
    memoryType: text('memory_type', { enum: BRAIN_COGNITIVE_TYPES }).default('procedural'),
    /** Verified flag. §3 boolean — already typed, preserved. */
    verified: integer('verified', { mode: 'boolean' }).notNull().default(false),
    /** Bitemporal valid-from (canonical TEXT, §4). */
    validAt: text('valid_at').notNull().default(sql`(datetime('now'))`),
    /** Bitemporal valid-until (canonical TEXT, §4). */
    invalidAt: text('invalid_at'),
    /** Source reliability — CHECK-backed via {@link BRAIN_SOURCE_CONFIDENCE}. */
    sourceConfidence: text('source_confidence', { enum: BRAIN_SOURCE_CONFIDENCE }).default('agent'),
    /** Citation count. */
    citationCount: integer('citation_count').notNull().default(0),
    /** ISO-8601 UTC tier-promotion instant (canonical TEXT, §4). */
    tierPromotedAt: text('tier_promoted_at'),
    /** Tier-promotion reason. */
    tierPromotionReason: text('tier_promotion_reason'),
    /** Dedup content hash. */
    contentHash: text('content_hash'),
    /** Provenance sweep class. */
    provenanceClass: text('provenance_class').default('swept-clean'),
    /** Peer identity. */
    peerId: text('peer_id').notNull().default('global'),
    /** Peer scope. */
    peerScope: text('peer_scope').notNull().default('project'),
    /** Dedup occurrence count. */
    occurrenceCount: integer('occurrence_count').notNull().default(1),
    /** ISO-8601 UTC last-seen instant (canonical TEXT, §4). */
    lastSeenAt: text('last_seen_at'),
  },
  (table) => [
    index('idx_brain_patterns_type').on(table.type),
    index('idx_brain_patterns_impact').on(table.impact),
    index('idx_brain_patterns_frequency').on(table.frequency),
    index('idx_brain_patterns_quality').on(table.qualityScore),
    index('idx_brain_patterns_occurrence_count').on(table.occurrenceCount),
    index('idx_brain_patterns_last_seen_at').on(table.lastSeenAt),
    index('idx_brain_patterns_tier').on(table.memoryTier),
    index('idx_brain_patterns_mem_type').on(table.memoryType),
    index('idx_brain_patterns_verified').on(table.verified),
    index('idx_brain_patterns_valid_at').on(table.validAt),
    index('idx_brain_patterns_source_conf').on(table.sourceConfidence),
    index('idx_brain_patterns_tier_promoted_at').on(table.tierPromotedAt),
    index('idx_brain_patterns_content_hash').on(table.contentHash),
    index('idx_brain_patterns_peer_scope').on(table.peerId, table.peerScope),
  ],
);

/**
 * `brain_learnings` — extracted insights.
 *
 * @task T11360 (target shape)
 */
export const brainLearnings = sqliteTable(
  'brain_learnings',
  {
    /** Learning id. */
    id: text('id').primaryKey(),
    /** Insight statement. */
    insight: text('insight').notNull(),
    /** Source descriptor. */
    source: text('source').notNull(),
    /** Confidence 0.0–1.0. */
    confidence: real('confidence').notNull(),
    /** Whether actionable. §3 boolean — already typed, preserved. */
    actionable: integer('actionable', { mode: 'boolean' }).notNull().default(false),
    /** Application note. */
    application: text('application'),
    /** JSON applicable-types array (TEXT per JSON audit). */
    applicableTypesJson: text('applicable_types_json'),
    /** ISO-8601 UTC creation instant (canonical TEXT, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC last-update instant (canonical TEXT, §4). */
    updatedAt: text('updated_at'),
    /** Quality score 0.0–1.0. */
    qualityScore: real('quality_score'),
    /** Memory tier — CHECK-backed via {@link BRAIN_MEMORY_TIERS}. */
    memoryTier: text('memory_tier', { enum: BRAIN_MEMORY_TIERS }).default('short'),
    /** Cognitive type — CHECK-backed via {@link BRAIN_COGNITIVE_TYPES}. */
    memoryType: text('memory_type', { enum: BRAIN_COGNITIVE_TYPES }).default('semantic'),
    /** Verified flag. §3 boolean — already typed, preserved. */
    verified: integer('verified', { mode: 'boolean' }).notNull().default(false),
    /** Bitemporal valid-from (canonical TEXT, §4). */
    validAt: text('valid_at').notNull().default(sql`(datetime('now'))`),
    /** Bitemporal valid-until (canonical TEXT, §4). */
    invalidAt: text('invalid_at'),
    /** Source reliability — CHECK-backed via {@link BRAIN_SOURCE_CONFIDENCE}. */
    sourceConfidence: text('source_confidence', { enum: BRAIN_SOURCE_CONFIDENCE }).default('agent'),
    /** Citation count. */
    citationCount: integer('citation_count').notNull().default(0),
    /** ISO-8601 UTC tier-promotion instant (canonical TEXT, §4). */
    tierPromotedAt: text('tier_promoted_at'),
    /** Tier-promotion reason. */
    tierPromotionReason: text('tier_promotion_reason'),
    /** Dedup content hash. */
    contentHash: text('content_hash'),
    /** Provenance sweep class. */
    provenanceClass: text('provenance_class').default('swept-clean'),
    /** Peer identity. */
    peerId: text('peer_id').notNull().default('global'),
    /** Peer scope. */
    peerScope: text('peer_scope').notNull().default('project'),
  },
  (table) => [
    index('idx_brain_learnings_confidence').on(table.confidence),
    index('idx_brain_learnings_actionable').on(table.actionable),
    index('idx_brain_learnings_quality').on(table.qualityScore),
    index('idx_brain_learnings_tier').on(table.memoryTier),
    index('idx_brain_learnings_mem_type').on(table.memoryType),
    index('idx_brain_learnings_verified').on(table.verified),
    index('idx_brain_learnings_valid_at').on(table.validAt),
    index('idx_brain_learnings_invalid').on(table.invalidAt),
    index('idx_brain_learnings_source_conf').on(table.sourceConfidence),
    index('idx_brain_learnings_tier_promoted_at').on(table.tierPromotedAt),
    index('idx_brain_learnings_content_hash').on(table.contentHash),
    index('idx_brain_learnings_peer_scope').on(table.peerId, table.peerScope),
  ],
);

/**
 * `brain_observations` — episodic event records.
 *
 * @task T11360 (target shape)
 */
export const brainObservations = sqliteTable(
  'brain_observations',
  {
    /** Observation id. */
    id: text('id').primaryKey(),
    /** Observation type — CHECK-backed via {@link BRAIN_OBSERVATION_TYPES}. */
    type: text('type', { enum: BRAIN_OBSERVATION_TYPES }).notNull(),
    /** Title. */
    title: text('title').notNull(),
    /** Subtitle. */
    subtitle: text('subtitle'),
    /** Narrative body. */
    narrative: text('narrative'),
    /** JSON facts array (TEXT per JSON audit). */
    factsJson: text('facts_json'),
    /** JSON concepts array (TEXT per JSON audit). */
    conceptsJson: text('concepts_json'),
    /** Project tag. */
    project: text('project'),
    /** JSON files-read array (TEXT per JSON audit). */
    filesReadJson: text('files_read_json'),
    /** JSON files-modified array (TEXT per JSON audit). */
    filesModifiedJson: text('files_modified_json'),
    /** Origin session (cross-DB soft FK → tasks.sessions). */
    sourceSessionId: text('source_session_id'),
    /** Source type — CHECK-backed via {@link BRAIN_OBSERVATION_SOURCE_TYPES}. */
    sourceType: text('source_type', { enum: BRAIN_OBSERVATION_SOURCE_TYPES })
      .notNull()
      .default('agent'),
    /** Producing agent. */
    agent: text('agent'),
    /** Dedup content hash. */
    contentHash: text('content_hash'),
    /** Discovery token cost. */
    discoveryTokens: integer('discovery_tokens'),
    /** Quality score 0.0–1.0. */
    qualityScore: real('quality_score'),
    /** ISO-8601 UTC creation instant (canonical TEXT, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC last-update instant (canonical TEXT, §4). */
    updatedAt: text('updated_at'),
    /** Memory tier — CHECK-backed via {@link BRAIN_MEMORY_TIERS}. */
    memoryTier: text('memory_tier', { enum: BRAIN_MEMORY_TIERS }).default('short'),
    /** Cognitive type — CHECK-backed via {@link BRAIN_COGNITIVE_TYPES}. */
    memoryType: text('memory_type', { enum: BRAIN_COGNITIVE_TYPES }).default('episodic'),
    /** Verified flag. §3 boolean — already typed, preserved. */
    verified: integer('verified', { mode: 'boolean' }).notNull().default(false),
    /** Bitemporal valid-from (canonical TEXT, §4). */
    validAt: text('valid_at').notNull().default(sql`(datetime('now'))`),
    /** Bitemporal valid-until (canonical TEXT, §4). */
    invalidAt: text('invalid_at'),
    /** Source reliability — CHECK-backed via {@link BRAIN_SOURCE_CONFIDENCE}. */
    sourceConfidence: text('source_confidence', { enum: BRAIN_SOURCE_CONFIDENCE }).default('agent'),
    /** Citation count. */
    citationCount: integer('citation_count').notNull().default(0),
    /** ISO-8601 UTC tier-promotion instant (canonical TEXT, §4). */
    tierPromotedAt: text('tier_promoted_at'),
    /** Tier-promotion reason. */
    tierPromotionReason: text('tier_promotion_reason'),
    /** JSON attachment-refs array (TEXT per JSON audit). */
    attachmentsJson: text('attachments_json'),
    /** Stability score 0.0–1.0. */
    stabilityScore: real('stability_score').default(0.5),
    /** Provenance sweep class. */
    provenanceClass: text('provenance_class').default('swept-clean'),
    /** Peer identity. */
    peerId: text('peer_id').notNull().default('global'),
    /** Peer scope. */
    peerScope: text('peer_scope').notNull().default('project'),
    /** JSON ancestor-ids (TEXT per JSON audit). */
    sourceIds: text('source_ids'),
    /** Times derived counter. */
    timesDerived: integer('times_derived').default(1),
    /** Derivation level. */
    level: text('level').default('explicit'),
    /** FK → brain_memory_trees.id (leaf cluster). */
    treeId: integer('tree_id'),
    /** Producer origin tag. */
    origin: text('origin'),
    /** ISO-8601 UTC operator-validation instant (canonical TEXT, §4). */
    validatedAt: text('validated_at'),
    /** JSON provenance chain (TEXT per JSON audit). */
    provenanceChain: text('provenance_chain'),
    /**
     * Caller-supplied stable idempotency key (§7 Pattern A · highest leverage);
     * NULL for legacy / non-agent observations. `cleo memory observe` retries and
     * the graph-memory-bridge `setImmediate` async observers re-emit on race — a
     * redelivered write with the same key is a no-op via `onConflictDoNothing`.
     * UNIQUE ignores NULLs in SQLite, so only keyed writes dedup; because the
     * `brain_*` family is mirrored into BOTH cleo.db scopes, the dedup grain is
     * each scope's own `cleo.db` file.
     */
    idempotencyKey: text('idempotency_key'),
  },
  (table) => [
    index('idx_brain_observations_type').on(table.type),
    index('idx_brain_observations_project').on(table.project),
    index('idx_brain_observations_created_at').on(table.createdAt),
    index('idx_brain_observations_source_type').on(table.sourceType),
    index('idx_brain_observations_source_session').on(table.sourceSessionId),
    index('idx_brain_observations_content_hash_created_at').on(table.contentHash, table.createdAt),
    index('idx_brain_observations_type_project').on(table.type, table.project),
    index('idx_brain_observations_agent').on(table.agent),
    index('idx_brain_observations_quality').on(table.qualityScore),
    index('idx_brain_observations_tier').on(table.memoryTier),
    index('idx_brain_observations_mem_type').on(table.memoryType),
    index('idx_brain_observations_verified').on(table.verified),
    index('idx_brain_observations_valid_at').on(table.validAt),
    index('idx_brain_observations_invalid').on(table.invalidAt),
    index('idx_brain_observations_source_conf').on(table.sourceConfidence),
    index('idx_brain_observations_tier_promoted_at').on(table.tierPromotedAt),
    index('idx_brain_observations_stability_score').on(table.stabilityScore),
    index('idx_brain_observations_peer_scope').on(table.peerId, table.peerScope),
    index('idx_brain_observations_level').on(table.level),
    index('idx_brain_observations_tree_id').on(table.treeId),
    index('idx_brain_observations_origin').on(table.origin),
    index('idx_brain_observations_validated_at').on(table.validatedAt),
    unique('uq_brain_observations_idempotency_key').on(table.idempotencyKey),
  ],
);

// ---------------------------------------------------------------------------
// Sticky notes + junction (§6b)
// ---------------------------------------------------------------------------

/**
 * `brain_sticky_notes` — ephemeral quick-capture notes.
 *
 * @task T11360 (target shape)
 */
export const brainStickyNotes = sqliteTable(
  'brain_sticky_notes',
  {
    /** Sticky id. */
    id: text('id').primaryKey(),
    /** Note content. */
    content: text('content').notNull(),
    /** ISO-8601 UTC creation instant (canonical TEXT, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC last-update instant (canonical TEXT, §4). */
    updatedAt: text('updated_at'),
    /** Legacy whole-array JSON tags (TEXT per JSON audit; junction = brain_sticky_tags, §6b). */
    tagsJson: text('tags_json'),
    /** Status — CHECK-backed via {@link BRAIN_STICKY_STATUSES}. */
    status: text('status', { enum: BRAIN_STICKY_STATUSES }).notNull().default('active'),
    /** JSON converted-to refs (TEXT per JSON audit). */
    convertedToJson: text('converted_to_json'),
    /** Color — CHECK-backed via {@link BRAIN_STICKY_COLORS}. */
    color: text('color', { enum: BRAIN_STICKY_COLORS }),
    /** Priority — CHECK-backed via {@link BRAIN_STICKY_PRIORITIES}. */
    priority: text('priority', { enum: BRAIN_STICKY_PRIORITIES }),
    /** Source-type tag. */
    sourceType: text('source_type').default('sticky-note'),
  },
  (table) => [
    index('idx_brain_sticky_status').on(table.status),
    index('idx_brain_sticky_created').on(table.createdAt),
    index('idx_brain_sticky_tags').on(table.tagsJson),
  ],
);

/**
 * `brain_sticky_tags` — sticky→tag membership junction (§6b · AC4 · E4 pattern).
 *
 * Domain-prefixed target of the live `sticky_tags` junction (T11355). The
 * json-storage-jsonb-audit routes `brain_sticky_notes.tags_json` here; the
 * legacy column is retained for whole-array compatibility while this junction
 * is the membership-query SSoT. `(sticky_id, tag)` is the natural composite
 * identity. No new JSON pattern invented.
 *
 * @task T11360 (target shape) · T11355 (original)
 */
export const brainStickyTags = sqliteTable(
  'brain_sticky_tags',
  {
    /** FK → `brain_sticky_notes.id`. ON DELETE CASCADE. */
    stickyId: text('sticky_id')
      .notNull()
      .references(() => brainStickyNotes.id, { onDelete: 'cascade' }),
    /** A single tag string (one row per tag). */
    tag: text('tag').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.stickyId, table.tag] }),
    index('idx_brain_sticky_tags_tag').on(table.tag),
  ],
);

// ---------------------------------------------------------------------------
// Attention (E4 jsonb + §4 epoch→ISO8601)
// ---------------------------------------------------------------------------

/**
 * `brain_attention` — Tier-2 decaying, scope-keyed working-memory buffer.
 *
 * `tags` keeps the EXISTING E4 `jsonb<string[]>()` JSONB-BLOB pattern (read via
 * `json_each(tags)` / `jsonbText`, never raw-parsed). The `created_at` /
 * `expires_at` epoch-ms timestamps are converted to canonical TEXT ISO8601
 * (§4 / §8.1 — ms divisor at exodus); the decay/TTL predicate operates on the
 * ISO8601 text via `datetime()` post-cutover.
 *
 * @task T11360 (target shape) · T11371 (original)
 */
export const brainAttention = sqliteTable(
  'brain_attention',
  {
    /** Item id. */
    id: text('id').primaryKey(),
    /** Jot content. */
    content: text('content').notNull(),
    /** Writer session (cross-DB soft FK → tasks.sessions). */
    sessionId: text('session_id'),
    /** Writer agent identity. */
    agentId: text('agent_id'),
    /** Narrowest scope kind — CHECK-backed via {@link BRAIN_ATTENTION_SCOPE_KINDS}. */
    scopeKind: text('scope_kind', { enum: BRAIN_ATTENTION_SCOPE_KINDS }).notNull(),
    /** Scope-bound id. */
    scopeId: text('scope_id').notNull(),
    /** Tag set as a JSONB BLOB (E4 jsonb helper — read via json_each/jsonbText). */
    tags: jsonb<string[]>('tags').default(sql`jsonb('[]')`),
    /** ISO-8601 UTC creation instant (was ms epoch, §4 / §8.1). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC hard-TTL instant; NULL = no TTL (was ms epoch, §4 / §8.1). */
    expiresAt: text('expires_at'),
    /** Decay score [0,1]; NULL = no decay applied. */
    decayScore: real('decay_score'),
    /** Lifecycle status — CHECK-backed via {@link BRAIN_ATTENTION_STATUSES}. */
    status: text('status', { enum: BRAIN_ATTENTION_STATUSES }).notNull().default('open'),
  },
  (table) => [
    index('idx_brain_attention_scope').on(table.scopeKind, table.scopeId),
    index('idx_brain_attention_session').on(table.sessionId),
    index('idx_brain_attention_status_expires').on(table.status, table.expiresAt),
  ],
);

// ---------------------------------------------------------------------------
// Links / meta
// ---------------------------------------------------------------------------

/**
 * `brain_memory_links` — cross-references between BRAIN entries and tasks.
 *
 * @task T11360 (target shape)
 */
export const brainMemoryLinks = sqliteTable(
  'brain_memory_links',
  {
    /** Memory entity type — CHECK-backed via {@link BRAIN_MEMORY_TYPES}. */
    memoryType: text('memory_type', { enum: BRAIN_MEMORY_TYPES }).notNull(),
    /** Memory entity id. */
    memoryId: text('memory_id').notNull(),
    /** Linked task (cross-DB soft FK → tasks). */
    taskId: text('task_id').notNull(),
    /** Link type — CHECK-backed via {@link BRAIN_LINK_TYPES}. */
    linkType: text('link_type', { enum: BRAIN_LINK_TYPES }).notNull(),
    /** ISO-8601 UTC creation instant (canonical TEXT, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    primaryKey({ columns: [table.memoryType, table.memoryId, table.taskId, table.linkType] }),
    index('idx_brain_links_task').on(table.taskId),
    index('idx_brain_links_memory').on(table.memoryType, table.memoryId),
  ],
);

/**
 * `brain_schema_meta` — key-value schema-version store.
 *
 * @task T11360 (target shape)
 */
export const brainSchemaMeta = sqliteTable('brain_schema_meta', {
  /** Config key. */
  key: text('key').primaryKey(),
  /** Config value. */
  value: text('value').notNull(),
});

// ---------------------------------------------------------------------------
// PageIndex graph (nodes + edges)
// ---------------------------------------------------------------------------

/**
 * `brain_page_nodes` — traversable knowledge-graph node layer.
 *
 * @task T11360 (target shape)
 */
export const brainPageNodes = sqliteTable(
  'brain_page_nodes',
  {
    /** Composite node id `<type>:<source-id>`. */
    id: text('id').primaryKey(),
    /** Node type — CHECK-backed via {@link BRAIN_NODE_TYPES}. */
    nodeType: text('node_type', { enum: BRAIN_NODE_TYPES }).notNull(),
    /** Human-readable label. */
    label: text('label').notNull(),
    /** Quality score 0.0–1.0. */
    qualityScore: real('quality_score').notNull().default(0.5),
    /** Dedup content hash. */
    contentHash: text('content_hash'),
    /** ISO-8601 UTC last-activity instant (canonical TEXT, §4). */
    lastActivityAt: text('last_activity_at').notNull().default(sql`(datetime('now'))`),
    /** JSON type-specific metadata (TEXT per JSON audit). */
    metadataJson: text('metadata_json'),
    /** ISO-8601 UTC creation instant (canonical TEXT, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC last-update instant (canonical TEXT, §4). */
    updatedAt: text('updated_at'),
  },
  (table) => [
    index('idx_brain_nodes_type').on(table.nodeType),
    index('idx_brain_nodes_quality').on(table.qualityScore),
    index('idx_brain_nodes_content_hash').on(table.contentHash),
    index('idx_brain_nodes_last_activity').on(table.lastActivityAt),
  ],
);

/** Edge plasticity classes — promoted from inline literal (§5a). */
export const BRAIN_EDGE_PLASTICITY_CLASSES = ['static', 'hebbian', 'stdp'] as const;

/**
 * `brain_page_edges` — directed, typed, weighted, plasticity-aware graph edges.
 *
 * @task T11360 (target shape)
 */
export const brainPageEdges = sqliteTable(
  'brain_page_edges',
  {
    /** Source node id. */
    fromId: text('from_id').notNull(),
    /** Target node id. */
    toId: text('to_id').notNull(),
    /** Edge type — CHECK-backed via {@link BRAIN_EDGE_TYPES}. */
    edgeType: text('edge_type', { enum: BRAIN_EDGE_TYPES }).notNull(),
    /** Edge weight 0.0–1.0. */
    weight: real('weight').notNull().default(1.0),
    /** Provenance note. */
    provenance: text('provenance'),
    /** ISO-8601 UTC creation instant (canonical TEXT, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC last-reinforced instant (canonical TEXT, §4). */
    lastReinforcedAt: text('last_reinforced_at'),
    /** LTP reinforcement count. */
    reinforcementCount: integer('reinforcement_count').notNull().default(0),
    /** Plasticity class — CHECK-backed via {@link BRAIN_EDGE_PLASTICITY_CLASSES} (§5a). */
    plasticityClass: text('plasticity_class', { enum: BRAIN_EDGE_PLASTICITY_CLASSES })
      .notNull()
      .default('static'),
    /** ISO-8601 UTC last-depressed instant (canonical TEXT, §4). */
    lastDepressedAt: text('last_depressed_at'),
    /** LTD depression count. */
    depressionCount: integer('depression_count').notNull().default(0),
    /** Stability score 0.0–1.0. */
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

// ---------------------------------------------------------------------------
// Plasticity / retrieval / modulators / consolidation
// ---------------------------------------------------------------------------

/**
 * `brain_retrieval_log` — co-retrieval event log.
 *
 * @task T11360 (target shape)
 */
export const brainRetrievalLog = sqliteTable(
  'brain_retrieval_log',
  {
    /** Auto-increment PK. */
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Query string. */
    query: text('query').notNull(),
    /** JSON array of returned entry ids (TEXT per JSON audit). */
    entryIds: text('entry_ids').notNull(),
    /** Returned entry count. */
    entryCount: integer('entry_count').notNull(),
    /** Retrieval source. */
    source: text('source').notNull(),
    /** Tokens consumed. */
    tokensUsed: integer('tokens_used'),
    /** Originating session (cross-DB soft FK → tasks.sessions). */
    sessionId: text('session_id'),
    /** ISO-8601 UTC creation instant (canonical TEXT, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** Sequence position within a batch. */
    retrievalOrder: integer('retrieval_order'),
    /** Wall-clock ms since previous batch row. */
    deltaMs: integer('delta_ms'),
    /** R-STDP reward signal [-1,1]. */
    rewardSignal: real('reward_signal'),
  },
  (table) => [
    index('idx_retrieval_log_created').on(table.createdAt),
    index('idx_retrieval_log_source').on(table.source),
    index('idx_retrieval_log_session').on(table.sessionId),
    index('idx_retrieval_log_reward').on(table.rewardSignal),
  ],
);

/** STDP event kinds — promoted from inline literal (§5a). */
export const BRAIN_PLASTICITY_KINDS = ['ltp', 'ltd'] as const;

/**
 * `brain_plasticity_events` — STDP weight-change audit log.
 *
 * @task T11360 (target shape)
 */
export const brainPlasticityEvents = sqliteTable(
  'brain_plasticity_events',
  {
    /** Auto-increment PK. */
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Affected edge from_id. */
    sourceNode: text('source_node').notNull(),
    /** Affected edge to_id. */
    targetNode: text('target_node').notNull(),
    /** Signed weight delta. */
    deltaW: real('delta_w').notNull(),
    /** STDP kind — CHECK-backed via {@link BRAIN_PLASTICITY_KINDS} (§5a). */
    kind: text('kind', { enum: BRAIN_PLASTICITY_KINDS }).notNull(),
    /** ISO-8601 UTC event instant (canonical TEXT, §4). */
    timestamp: text('timestamp').notNull().default(sql`(datetime('now'))`),
    /** Triggering session (cross-DB soft FK → tasks.sessions). */
    sessionId: text('session_id'),
    /** Edge weight before. */
    weightBefore: real('weight_before'),
    /** Edge weight after. */
    weightAfter: real('weight_after'),
    /** Soft FK → brain_retrieval_log.id. */
    retrievalLogId: integer('retrieval_log_id'),
    /** Active reward signal. */
    rewardSignal: real('reward_signal'),
    /** Spike-pair delta in ms. */
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

/**
 * `brain_weight_history` — immutable per-edge Δw audit log.
 *
 * @task T11360 (target shape)
 */
export const brainWeightHistory = sqliteTable(
  'brain_weight_history',
  {
    /** Auto-increment PK. */
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Affected edge from_id. */
    edgeFromId: text('edge_from_id').notNull(),
    /** Affected edge to_id. */
    edgeToId: text('edge_to_id').notNull(),
    /** Affected edge type. */
    edgeType: text('edge_type').notNull(),
    /** Weight before. */
    weightBefore: real('weight_before'),
    /** Weight after. */
    weightAfter: real('weight_after').notNull(),
    /** Signed weight delta. */
    deltaWeight: real('delta_weight').notNull(),
    /** Event kind (open extensible set — bare TEXT). */
    eventKind: text('event_kind').notNull(),
    /** Soft FK → brain_plasticity_events.id. */
    sourcePlasticityEventId: integer('source_plasticity_event_id'),
    /** Soft FK → brain_retrieval_log.id. */
    retrievalLogId: integer('retrieval_log_id'),
    /** Active reward signal. */
    rewardSignal: real('reward_signal'),
    /** ISO-8601 UTC change instant (canonical TEXT, §4). */
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

/**
 * `brain_modulators` — R-STDP neuromodulator event log.
 *
 * @task T11360 (target shape)
 */
export const brainModulators = sqliteTable(
  'brain_modulators',
  {
    /** Auto-increment PK. */
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Modulator type (open extensible set — bare TEXT per source). */
    modulatorType: text('modulator_type').notNull(),
    /** Reward valence [-1,1]. */
    valence: real('valence').notNull(),
    /** Magnitude 0.0–1.0. */
    magnitude: real('magnitude').notNull().default(1.0),
    /** Polymorphic source event id. */
    sourceEventId: text('source_event_id'),
    /** Emitting session (cross-DB soft FK → tasks.sessions). */
    sessionId: text('session_id'),
    /** Description. */
    description: text('description'),
    /** ISO-8601 UTC creation instant (canonical TEXT, §4). */
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

/**
 * `brain_consolidation_events` — consolidation-pipeline run audit log.
 *
 * @task T11360 (target shape)
 */
export const brainConsolidationEvents = sqliteTable(
  'brain_consolidation_events',
  {
    /** Auto-increment PK. */
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Trigger (open extensible set — bare TEXT per source). */
    trigger: text('trigger').notNull(),
    /** Initiating session (cross-DB soft FK → tasks.sessions). */
    sessionId: text('session_id'),
    /** JSON step-results (TEXT per JSON audit). */
    stepResultsJson: text('step_results_json').notNull(),
    /** Run duration in ms. */
    durationMs: integer('duration_ms'),
    /** Whether the run succeeded. §3 boolean — already typed, preserved. */
    succeeded: integer('succeeded', { mode: 'boolean' }).notNull().default(true),
    /** ISO-8601 UTC start instant (canonical TEXT, §4). */
    startedAt: text('started_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_consolidation_events_started_at').on(table.startedAt),
    index('idx_consolidation_events_trigger').on(table.trigger),
    index('idx_consolidation_events_session').on(table.sessionId),
  ],
);

// ---------------------------------------------------------------------------
// Transcript / promotion / backfill / narrative / deriver / trees / staging
// ---------------------------------------------------------------------------

/**
 * `brain_transcript_events` — full-fidelity Claude session ingestion.
 *
 * @task T11360 (target shape)
 */
export const brainTranscriptEvents = sqliteTable(
  'brain_transcript_events',
  {
    /** Event id. */
    id: text('id').primaryKey(),
    /** Source session (cross-DB soft FK → tasks.sessions). */
    sessionId: text('session_id').notNull(),
    /** Ordinal within the session. */
    seq: integer('seq').notNull(),
    /** Message role — E10 §5b CHECK-backed via {@link BRAIN_TRANSCRIPT_ROLES} (§5a). */
    role: text('role', { enum: BRAIN_TRANSCRIPT_ROLES }).notNull(),
    /** Content block type (open extensible set — bare TEXT per source). */
    blockType: text('block_type').notNull(),
    /** Serialised block content. */
    content: text('content').notNull(),
    /** Approximate token count. */
    tokens: integer('tokens'),
    /** ISO-8601 UTC redaction instant; NULL = clean (canonical TEXT, §4). */
    redactedAt: text('redacted_at'),
    /** ISO-8601 UTC creation instant (canonical TEXT, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_transcript_events_session').on(table.sessionId),
    index('idx_transcript_events_role').on(table.role),
    index('idx_transcript_events_block_type').on(table.blockType),
    index('idx_transcript_events_created_at').on(table.createdAt),
  ],
);

/**
 * `brain_promotion_log` — observation→typed promotion audit log.
 *
 * @task T11360 (target shape)
 */
export const brainPromotionLog = sqliteTable(
  'brain_promotion_log',
  {
    /** Promotion event id. */
    id: text('id').primaryKey(),
    /** Evaluated observation id. */
    observationId: text('observation_id').notNull(),
    /** Source tier. */
    fromTier: text('from_tier').notNull(),
    /** Target typed entity. */
    toTier: text('to_tier').notNull(),
    /** Composite promotion score 0.0–1.0. */
    score: real('score').notNull(),
    /** ISO-8601 UTC decision instant (canonical TEXT, §4). */
    decidedAt: text('decided_at').notNull().default(sql`(datetime('now'))`),
    /** Decider tag. */
    decidedBy: text('decided_by').notNull().default('composite-scorer'),
    /** JSON rationale (TEXT per JSON audit). */
    rationaleJson: text('rationale_json'),
  },
  (table) => [
    index('idx_promotion_log_observation').on(table.observationId),
    index('idx_promotion_log_decided_at').on(table.decidedAt),
    index('idx_promotion_log_to_tier').on(table.toTier),
    index('idx_promotion_log_score').on(table.score),
  ],
);

/**
 * `brain_backfill_runs` — staged-backfill run registry.
 *
 * @task T11360 (target shape)
 */
export const brainBackfillRuns = sqliteTable(
  'brain_backfill_runs',
  {
    /** Run id. */
    id: text('id').primaryKey(),
    /** Backfill kind — E10 §5b CHECK-backed via {@link BRAIN_BACKFILL_KINDS} (§5a). */
    kind: text('kind', { enum: BRAIN_BACKFILL_KINDS }).notNull(),
    /** Workflow status — E10 §5b CHECK-backed via {@link BRAIN_BACKFILL_RUN_STATUSES} (§5a). */
    status: text('status', { enum: BRAIN_BACKFILL_RUN_STATUSES }).notNull().default('staged'),
    /** ISO-8601 UTC creation instant (canonical TEXT, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC approval instant (canonical TEXT, §4). */
    approvedAt: text('approved_at'),
    /** Rows affected. */
    rowsAffected: integer('rows_affected').notNull().default(0),
    /** JSON rollback snapshot of staged ids (TEXT per JSON audit). */
    rollbackSnapshotJson: text('rollback_snapshot_json'),
    /** Source descriptor. */
    source: text('source').notNull().default('unknown'),
    /** Target table name. */
    targetTable: text('target_table').notNull().default('brain_observations'),
    /** Approver identity. */
    approvedBy: text('approved_by'),
  },
  (table) => [
    index('idx_backfill_runs_status').on(table.status),
    index('idx_backfill_runs_kind').on(table.kind),
    index('idx_backfill_runs_created_at').on(table.createdAt),
  ],
);

/**
 * `brain_session_narrative` — rolling per-session prose summary.
 *
 * Domain-prefixed target of the live `session_narrative` table. `last_updated_at`
 * epoch-ms → canonical TEXT ISO8601 (§4 / §8.1 — ms divisor at exodus).
 *
 * @task T11360 (target shape) · T1089 (original)
 */
export const brainSessionNarrative = sqliteTable('brain_session_narrative', {
  /** Session id (cross-DB soft FK → tasks.sessions). */
  sessionId: text('session_id').primaryKey(),
  /** Rolling prose summary. */
  narrative: text('narrative').notNull().default(''),
  /** Dialectic turn count. */
  turnCount: integer('turn_count').notNull().default(0),
  /** ISO-8601 UTC last-update instant (was ms epoch, §4 / §8.1). */
  lastUpdatedAt: text('last_updated_at'),
  /** Topic-pivot count. */
  pivotCount: integer('pivot_count').notNull().default(0),
});

/**
 * `brain_deriver_queue` — durable background derivation work queue.
 *
 * Domain-prefixed target of the live `deriver_queue` table.
 *
 * @task T11360 (target shape) · T1145 (original)
 */
export const brainDeriverQueue = sqliteTable(
  'brain_deriver_queue',
  {
    /** Work-item id. */
    id: text('id').primaryKey(),
    /** Item type — CHECK-backed via {@link DERIVER_QUEUE_ITEM_TYPES}. */
    itemType: text('item_type', { enum: DERIVER_QUEUE_ITEM_TYPES }).notNull(),
    /** Source item id. */
    itemId: text('item_id').notNull(),
    /** Priority. */
    priority: integer('priority').notNull().default(0),
    /** Status — CHECK-backed via {@link DERIVER_QUEUE_STATUSES}. */
    status: text('status', { enum: DERIVER_QUEUE_STATUSES }).notNull().default('pending'),
    /** ISO-8601 UTC claim instant (canonical TEXT, §4). */
    claimedAt: text('claimed_at'),
    /** Claiming worker id. */
    claimedBy: text('claimed_by'),
    /** Error message on failure. */
    errorMsg: text('error_msg'),
    /** Retry count. */
    retryCount: integer('retry_count').notNull().default(0),
    /** ISO-8601 UTC enqueue instant (canonical TEXT, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC completion instant (canonical TEXT, §4). */
    completedAt: text('completed_at'),
  },
  (table) => [
    index('idx_brain_deriver_queue_status_priority').on(
      table.status,
      table.priority,
      table.createdAt,
    ),
    index('idx_brain_deriver_queue_item').on(table.itemType, table.itemId),
    index('idx_brain_deriver_queue_claimed_at').on(table.claimedAt),
  ],
);

/**
 * `brain_memory_trees` — hierarchical RPTree clustering nodes.
 *
 * @task T11360 (target shape)
 */
export const brainMemoryTrees = sqliteTable(
  'brain_memory_trees',
  {
    /** Auto-increment PK (FK target for brain_observations.tree_id). */
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** RPTree node depth. */
    depth: integer('depth').notNull().default(0),
    /** JSON array of leaf observation ids (TEXT per JSON audit; empty-array default). */
    leafIds: text('leaf_ids').notNull().default('[]'),
    /** JSON-encoded float centroid (TEXT per JSON audit; Float32 BLOB at exodus per §8.7). */
    centroid: text('centroid'),
    /** Parent node id. */
    parentId: integer('parent_id'),
    /** ISO-8601 UTC creation instant (canonical TEXT, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC last-update instant (canonical TEXT, §4). */
    updatedAt: text('updated_at'),
  },
  (table) => [
    index('idx_brain_trees_parent').on(table.parentId),
    index('idx_brain_trees_depth').on(table.depth),
  ],
);

/** Staging candidate actions — promoted from inline literal (§5a). */
export const BRAIN_STAGING_ACTIONS = ['purge', 'keep', 'reclassify', 'promote'] as const;
/** Staging candidate validation statuses — promoted from inline literal (§5a). */
export const BRAIN_STAGING_VALIDATION_STATUSES = ['pending', 'applied', 'skipped'] as const;

/**
 * `brain_observations_staging` — shadow-write candidate staging for noise sweeps.
 *
 * @task T11360 (target shape)
 */
export const brainObservationsStaging = sqliteTable(
  'brain_observations_staging',
  {
    /** Candidate id. */
    id: text('id').primaryKey(),
    /** Live source table name. */
    sourceTable: text('source_table').notNull(),
    /** Source-table primary key. */
    sourceId: text('source_id').notNull(),
    /** FK → brain_backfill_runs.id. */
    sweepRunId: text('sweep_run_id').notNull(),
    /** Planned action — CHECK-backed via {@link BRAIN_STAGING_ACTIONS} (§5a). */
    action: text('action', { enum: BRAIN_STAGING_ACTIONS }).notNull(),
    /** Replacement quality score. */
    newQualityScore: real('new_quality_score'),
    /** ISO-8601 UTC invalid-at to write for purge (canonical TEXT, §4). */
    newInvalidAt: text('new_invalid_at'),
    /** Provenance class to write at cutover. */
    newProvenanceClass: text('new_provenance_class'),
    /** Validation status — CHECK-backed via {@link BRAIN_STAGING_VALIDATION_STATUSES} (§5a). */
    validationStatus: text('validation_status', { enum: BRAIN_STAGING_VALIDATION_STATUSES })
      .notNull()
      .default('pending'),
    /** ISO-8601 UTC creation instant (canonical TEXT, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_bos_sweep_run').on(table.sweepRunId),
    index('idx_bos_source').on(table.sourceTable, table.sourceId),
    index('idx_bos_status').on(table.validationStatus),
  ],
);

// === TYPE EXPORTS ===

/** Row type for `brain_decisions` SELECT queries (target shape). */
export type BrainDecisionRow = typeof brainDecisions.$inferSelect;
/** Row type for `brain_decisions` INSERT operations (target shape). */
export type NewBrainDecisionRow = typeof brainDecisions.$inferInsert;
/** Row type for `brain_patterns` SELECT queries (target shape). */
export type BrainPatternRow = typeof brainPatterns.$inferSelect;
/** Row type for `brain_patterns` INSERT operations (target shape). */
export type NewBrainPatternRow = typeof brainPatterns.$inferInsert;
/** Row type for `brain_learnings` SELECT queries (target shape). */
export type BrainLearningRow = typeof brainLearnings.$inferSelect;
/** Row type for `brain_learnings` INSERT operations (target shape). */
export type NewBrainLearningRow = typeof brainLearnings.$inferInsert;
/** Row type for `brain_observations` SELECT queries (target shape). */
export type BrainObservationRow = typeof brainObservations.$inferSelect;
/** Row type for `brain_observations` INSERT operations (target shape). */
export type NewBrainObservationRow = typeof brainObservations.$inferInsert;
/** Row type for `brain_sticky_notes` SELECT queries (target shape). */
export type BrainStickyNoteRow = typeof brainStickyNotes.$inferSelect;
/** Row type for `brain_sticky_notes` INSERT operations (target shape). */
export type NewBrainStickyNoteRow = typeof brainStickyNotes.$inferInsert;
/** Row type for `brain_sticky_tags` SELECT queries (target shape). */
export type BrainStickyTagRow = typeof brainStickyTags.$inferSelect;
/** Row type for `brain_sticky_tags` INSERT operations (target shape). */
export type NewBrainStickyTagRow = typeof brainStickyTags.$inferInsert;
/** Row type for `brain_attention` SELECT queries (target shape). */
export type BrainAttentionRow = typeof brainAttention.$inferSelect;
/** Row type for `brain_attention` INSERT operations (target shape). */
export type NewBrainAttentionRow = typeof brainAttention.$inferInsert;
/** Row type for `brain_memory_links` SELECT queries (target shape). */
export type BrainMemoryLinkRow = typeof brainMemoryLinks.$inferSelect;
/** Row type for `brain_memory_links` INSERT operations (target shape). */
export type NewBrainMemoryLinkRow = typeof brainMemoryLinks.$inferInsert;
/** Row type for `brain_schema_meta` SELECT queries (target shape). */
export type BrainSchemaMetaRow = typeof brainSchemaMeta.$inferSelect;
/** Row type for `brain_schema_meta` INSERT operations (target shape). */
export type NewBrainSchemaMetaRow = typeof brainSchemaMeta.$inferInsert;
/** Row type for `brain_page_nodes` SELECT queries (target shape). */
export type BrainPageNodeRow = typeof brainPageNodes.$inferSelect;
/** Row type for `brain_page_nodes` INSERT operations (target shape). */
export type NewBrainPageNodeRow = typeof brainPageNodes.$inferInsert;
/** Row type for `brain_page_edges` SELECT queries (target shape). */
export type BrainPageEdgeRow = typeof brainPageEdges.$inferSelect;
/** Row type for `brain_page_edges` INSERT operations (target shape). */
export type NewBrainPageEdgeRow = typeof brainPageEdges.$inferInsert;
/** Row type for `brain_retrieval_log` SELECT queries (target shape). */
export type BrainRetrievalLogRow = typeof brainRetrievalLog.$inferSelect;
/** Row type for `brain_retrieval_log` INSERT operations (target shape). */
export type NewBrainRetrievalLogRow = typeof brainRetrievalLog.$inferInsert;
/** Row type for `brain_plasticity_events` SELECT queries (target shape). */
export type BrainPlasticityEventRow = typeof brainPlasticityEvents.$inferSelect;
/** Row type for `brain_plasticity_events` INSERT operations (target shape). */
export type NewBrainPlasticityEventRow = typeof brainPlasticityEvents.$inferInsert;
/** Row type for `brain_weight_history` SELECT queries (target shape). */
export type BrainWeightHistoryRow = typeof brainWeightHistory.$inferSelect;
/** Row type for `brain_weight_history` INSERT operations (target shape). */
export type NewBrainWeightHistoryRow = typeof brainWeightHistory.$inferInsert;
/** Row type for `brain_modulators` SELECT queries (target shape). */
export type BrainModulatorRow = typeof brainModulators.$inferSelect;
/** Row type for `brain_modulators` INSERT operations (target shape). */
export type NewBrainModulatorRow = typeof brainModulators.$inferInsert;
/** Row type for `brain_consolidation_events` SELECT queries (target shape). */
export type BrainConsolidationEventRow = typeof brainConsolidationEvents.$inferSelect;
/** Row type for `brain_consolidation_events` INSERT operations (target shape). */
export type NewBrainConsolidationEventRow = typeof brainConsolidationEvents.$inferInsert;
/** Row type for `brain_transcript_events` SELECT queries (target shape). */
export type BrainTranscriptEventRow = typeof brainTranscriptEvents.$inferSelect;
/** Row type for `brain_transcript_events` INSERT operations (target shape). */
export type NewBrainTranscriptEventRow = typeof brainTranscriptEvents.$inferInsert;
/** Row type for `brain_promotion_log` SELECT queries (target shape). */
export type BrainPromotionLogRow = typeof brainPromotionLog.$inferSelect;
/** Row type for `brain_promotion_log` INSERT operations (target shape). */
export type NewBrainPromotionLogRow = typeof brainPromotionLog.$inferInsert;
/** Row type for `brain_backfill_runs` SELECT queries (target shape). */
export type BrainBackfillRunRow = typeof brainBackfillRuns.$inferSelect;
/** Row type for `brain_backfill_runs` INSERT operations (target shape). */
export type NewBrainBackfillRunRow = typeof brainBackfillRuns.$inferInsert;
/** Row type for `brain_session_narrative` SELECT queries (target shape). */
export type BrainSessionNarrativeRow = typeof brainSessionNarrative.$inferSelect;
/** Row type for `brain_session_narrative` INSERT operations (target shape). */
export type NewBrainSessionNarrativeRow = typeof brainSessionNarrative.$inferInsert;
/** Row type for `brain_deriver_queue` SELECT queries (target shape). */
export type BrainDeriverQueueRow = typeof brainDeriverQueue.$inferSelect;
/** Row type for `brain_deriver_queue` INSERT operations (target shape). */
export type NewBrainDeriverQueueRow = typeof brainDeriverQueue.$inferInsert;
/** Row type for `brain_memory_trees` SELECT queries (target shape). */
export type BrainMemoryTreeRow = typeof brainMemoryTrees.$inferSelect;
/** Row type for `brain_memory_trees` INSERT operations (target shape). */
export type NewBrainMemoryTreeRow = typeof brainMemoryTrees.$inferInsert;
/** Row type for `brain_observations_staging` SELECT queries (target shape). */
export type BrainObservationsStagingRow = typeof brainObservationsStaging.$inferSelect;
/** Row type for `brain_observations_staging` INSERT operations (target shape). */
export type NewBrainObservationsStagingRow = typeof brainObservationsStaging.$inferInsert;
