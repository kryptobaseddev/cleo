/**
 * Project-scope `cleo.db` — consolidated **conduit** domain (14 tables).
 *
 * Part of the consolidated PROJECT-scope `cleo.db` target shape authored for
 * SG-DB-SUBSTRATE-V2 (saga T11242, epic T11245/E2, task T11360). Target-shape
 * authoring only — physical names carry the `conduit_` domain prefix. The live
 * runtime module `schema/conduit-schema.ts` keeps its UNPREFIXED names
 * (`messages`, `attachments`, `topics`, …) until the exodus migration (T11248)
 * swaps the substrate; do not point runtime accessors at this module.
 *
 * This is the highest-leverage E10 chunk: the conduit domain holds **all 45
 * INTEGER-epoch timestamp non-conformers** (§4) and the **idempotency-key
 * surface** (§7) the canonical typing report calls out.
 *
 * ## E10 §4 — epoch → canonical TEXT ISO8601 (the headline transform)
 *
 * Every `created_at` / `updated_at` / `delivered_at` / `read_at` /
 * `last_message_at` / `next_attempt_at` / `expires_at` / `*_contribution_at` /
 * `subscribed_at` / `applied_at` column was a raw `integer(...)` epoch in the
 * source. In the target shape they are the canonical `text(...)` ISO8601 form
 * with a `datetime('now')` default where the source defaulted, matching the
 * 161-column TEXT ISO8601 majority.
 *
 * **§8.1 epoch-unit disambiguation (RESOLVED).** The doc flags that E2 MUST
 * pick seconds-vs-ms per epoch column. Reading the conduit writer
 * (`packages/core/src/conduit/local-transport.ts`) settles it: every data
 * timestamp is written `Math.floor(Date.now() / 1000)` — **seconds** (15 call
 * sites, zero raw-ms writes) — consistent with `_conduit_meta.updated_at` /
 * `_conduit_migrations.applied_at` (`strftime('%s','now')`, also seconds). So
 * the exodus epoch→ISO8601 conversion is uniformly
 * `strftime('%Y-%m-%dT%H:%M:%fZ', col, 'unixepoch')` for the WHOLE conduit
 * domain (no `/1000` ms divisor anywhere). This resolves §8 item 1.
 *
 * ## E10 §3b — boolean non-conformer
 *
 * `project_agent_refs.enabled` (untyped INTEGER 0/1, default 1) →
 * `integer({ mode: 'boolean' })`. The `CHECK (enabled IN (0,1))` ships as raw
 * DDL at exodus; the builder guarantees the app only writes 0/1.
 *
 * ## E10 §5b — enum-like bare-TEXT non-conformers (deferred enumeration)
 *
 * `conversations.visibility`, `messages.{content_type,status}`,
 * `delivery_jobs.status`, `attachments.mode`, `attachment_versions.change_type`,
 * `attachment_approvals.status`, `project_agent_refs.role`,
 * `topic_messages.kind` carry obviously-enum names but no contracts const
 * array backs their FULL legal set, and the writers only emit a verifiable
 * subset (e.g. message `status` ∈ {pending, delivered} at the sites read, but
 * read/failed states likely exist elsewhere). Per §8.3 + the PR #849
 * `pipeline_manifest.{type,status}` precedent, freezing an incomplete CHECK
 * would reject valid writes — so these remain documented bare TEXT, flagged for
 * the exodus writer audit (T11248) to enumerate exhaustively. NO new
 * LIKE-on-JSON is introduced (§6c).
 *
 * ## E10 §6a / AC4 — JSON-in-TEXT
 *
 * `messages.{attachments,metadata}`, `attachment_versions.sections_modified`
 * stay serialized TEXT (with empty-array/object defaults) per the JSON-Column
 * Audit disposition — no new JSON pattern invented. `attachments.content` is
 * the one BLOB column (`blob({ mode: 'buffer' })`), preserved.
 *
 * ## E10 §7 — idempotency keys (Pattern A)
 *
 * Three retried-write tables gain a nullable `idempotency_key TEXT` + UNIQUE
 * index so a redelivered write coalesces via `onConflictDoNothing` (the UNIQUE
 * constraint ignores NULLs in SQLite, so only keyed writes dedup):
 *   - `conduit_messages`        — LocalTransport delivery + redelivery
 *   - `conduit_topic_messages`  — A2A broadcast republish
 *   - `conduit_delivery_jobs`   — re-enqueue without a stable id
 *
 * ## §6b legacy meta tables
 *
 * `_conduit_meta` / `_conduit_migrations` are the two leading-underscore legacy
 * tables. Their rename-or-drop is owned by EP-DRIZZLE-CONTAINMENT WS2 and
 * applies at exodus, NOT here — so they are intentionally OMITTED from this
 * target family (the consolidated substrate uses `__drizzle_migrations`). The
 * conduit domain therefore contributes 14 prefixed tables, matching the
 * canonical per-scope count.
 *
 * @task T11360
 * @epic T11245
 * @saga T11242
 * @see docs/migration/sqlite-schema-canonical.md §3b · §4 · §5b · §6 · §7 · §8.1
 * @see docs/migration/sqlite-schema-columns.json (per-column affinity SSoT)
 */

import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  blob,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';

// ---------------------------------------------------------------------------
// Conversations & messages
// ---------------------------------------------------------------------------

/**
 * `conduit_conversations` — LocalTransport DM threads.
 *
 * @task T11360 (target shape) · T344 (original)
 */
export const conduitConversations = sqliteTable('conduit_conversations', {
  /** Conversation id (UUID v4). */
  id: text('id').primaryKey(),
  /** JSON array of participant agent ids (TEXT per JSON audit). */
  participants: text('participants').notNull(),
  /** Visibility tag (§5b non-conformer — bare TEXT pending exodus writer audit). */
  visibility: text('visibility').notNull().default('private'),
  /** Cached message count. */
  messageCount: integer('message_count').notNull().default(0),
  /** ISO-8601 UTC instant of the last message; NULL if none (was epoch, §4). */
  lastMessageAt: text('last_message_at'),
  /** ISO-8601 UTC creation instant (was epoch seconds, §4). */
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  /** ISO-8601 UTC last-update instant (was epoch seconds, §4). */
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

/**
 * `conduit_messages` — project-scoped agent-to-agent messages.
 *
 * `conversation_id` references the in-module {@link conduitConversations}.
 * `from_agent_id` / `to_agent_id` are cross-DB soft FKs to signaldock; carried
 * as plain TEXT id columns (no DB-level FK, resolved by the accessor).
 *
 * @task T11360 (target shape) · T344 (original)
 */
export const conduitMessages = sqliteTable(
  'conduit_messages',
  {
    /** Message id (UUID v4). */
    id: text('id').primaryKey(),
    /** FK → `conduit_conversations.id`. */
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conduitConversations.id),
    /** Sender agent id (cross-DB soft FK → signaldock). */
    fromAgentId: text('from_agent_id').notNull(),
    /** Recipient agent id (cross-DB soft FK → signaldock). */
    toAgentId: text('to_agent_id').notNull(),
    /** Message body. */
    content: text('content').notNull(),
    /** Content-type tag (§5b non-conformer — bare TEXT pending exodus audit). */
    contentType: text('content_type').notNull().default('text'),
    /** Delivery status (§5b non-conformer — bare TEXT pending exodus audit). */
    status: text('status').notNull().default('pending'),
    /** JSON array of attachment refs (TEXT per JSON audit; empty-array default). */
    attachments: text('attachments').notNull().default('[]'),
    /** Optional group/batch id. */
    groupId: text('group_id'),
    /** JSON metadata object (TEXT per JSON audit; empty-object default). */
    metadata: text('metadata').default('{}'),
    /** Optional id of the message this replies to. */
    replyTo: text('reply_to'),
    /** ISO-8601 UTC creation instant (was epoch seconds, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC delivery instant; NULL until delivered (was epoch, §4). */
    deliveredAt: text('delivered_at'),
    /** ISO-8601 UTC read instant; NULL until read (was epoch, §4). */
    readAt: text('read_at'),
    /**
     * Caller-supplied stable idempotency key (§7 Pattern A); NULL for legacy /
     * non-agent writes. A redelivered write with the same key is a no-op via
     * `onConflictDoNothing`. UNIQUE ignores NULLs, so only keyed writes dedup.
     */
    idempotencyKey: text('idempotency_key'),
  },
  (table) => [
    index('idx_conduit_messages_conversation').on(table.conversationId),
    index('idx_conduit_messages_from_agent').on(table.fromAgentId),
    index('idx_conduit_messages_to_agent').on(table.toAgentId),
    index('idx_conduit_messages_created_at').on(table.createdAt),
    index('idx_conduit_messages_group_id').on(table.groupId),
    index('idx_conduit_messages_reply_to').on(table.replyTo),
    unique('uq_conduit_messages_idempotency_key').on(table.idempotencyKey),
  ],
);

// ---------------------------------------------------------------------------
// Delivery queue
// ---------------------------------------------------------------------------

/**
 * `conduit_delivery_jobs` — async delivery queue for deferred dispatch.
 *
 * @task T11360 (target shape) · T344 (original)
 */
export const conduitDeliveryJobs = sqliteTable(
  'conduit_delivery_jobs',
  {
    /** Job id (UUID v4) — the natural dedup key. */
    id: text('id').primaryKey(),
    /** Message id this job delivers. */
    messageId: text('message_id').notNull(),
    /** Serialized delivery payload. */
    payload: text('payload').notNull(),
    /** Job status (§5b non-conformer — bare TEXT pending exodus audit). */
    status: text('status').notNull().default('pending'),
    /** Attempt count so far. */
    attempts: integer('attempts').notNull().default(0),
    /** Max attempts before dead-lettering. */
    maxAttempts: integer('max_attempts').notNull().default(6),
    /** ISO-8601 UTC next-retry instant (was epoch seconds, §4). */
    nextAttemptAt: text('next_attempt_at').notNull(),
    /** Last error message; NULL while healthy. */
    lastError: text('last_error'),
    /** ISO-8601 UTC creation instant (was epoch seconds, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC last-update instant (was epoch seconds, §4). */
    updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
    /**
     * Optional idempotency key (§7) — only needed if producers re-enqueue
     * without a stable `id`; otherwise `id` is the dedup key.
     */
    idempotencyKey: text('idempotency_key'),
  },
  (table) => [
    index('idx_conduit_delivery_jobs_status').on(table.status, table.nextAttemptAt),
    unique('uq_conduit_delivery_jobs_idempotency_key').on(table.idempotencyKey),
  ],
);

/**
 * `conduit_dead_letters` — messages that exceeded max delivery attempts.
 *
 * @task T11360 (target shape) · T344 (original)
 */
export const conduitDeadLetters = sqliteTable(
  'conduit_dead_letters',
  {
    /** Dead-letter id (UUID v4). */
    id: text('id').primaryKey(),
    /** Message id that failed. */
    messageId: text('message_id').notNull(),
    /** Originating delivery-job id. */
    jobId: text('job_id').notNull(),
    /** Failure reason. */
    reason: text('reason').notNull(),
    /** Attempts made before dead-lettering. */
    attempts: integer('attempts').notNull(),
    /** ISO-8601 UTC creation instant (was epoch seconds, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [index('idx_conduit_dead_letters_message').on(table.messageId)],
);

// ---------------------------------------------------------------------------
// Message pins
// ---------------------------------------------------------------------------

/**
 * `conduit_message_pins` — pinned messages within a conversation.
 *
 * @task T11360 (target shape) · T344 (original)
 */
export const conduitMessagePins = sqliteTable(
  'conduit_message_pins',
  {
    /** Pin id (UUID v4). */
    id: text('id').primaryKey(),
    /** Pinned message id. */
    messageId: text('message_id').notNull(),
    /** Owning conversation id. */
    conversationId: text('conversation_id').notNull(),
    /** Agent id that created the pin. */
    pinnedBy: text('pinned_by').notNull(),
    /** Optional pin note. */
    note: text('note'),
    /** ISO-8601 UTC creation instant (was epoch seconds, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    unique('uq_conduit_message_pins_message_pinned_by').on(table.messageId, table.pinnedBy),
    index('idx_conduit_message_pins_conversation').on(table.conversationId),
    index('idx_conduit_message_pins_agent').on(table.pinnedBy),
  ],
);

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/**
 * `conduit_attachments` — file/blob attachments associated with messages.
 *
 * `content` stores the compressed blob bytes inline (the one BLOB column in
 * the domain). Distinct from the `docs_attachments` document registry (D11) —
 * conduit attachments are message-scoped transport payloads.
 *
 * @task T11360 (target shape) · T344 (original)
 */
export const conduitAttachments = sqliteTable(
  'conduit_attachments',
  {
    /** Attachment slug (primary key). */
    slug: text('slug').primaryKey(),
    /** Owning conversation id. */
    conversationId: text('conversation_id').notNull(),
    /** Author agent id (cross-DB soft FK → signaldock). */
    fromAgentId: text('from_agent_id').notNull(),
    /** Compressed blob bytes (BLOB, §6 — preserved as buffer). */
    content: blob('content', { mode: 'buffer' }).notNull(),
    /** Uncompressed content size in bytes. */
    originalSize: integer('original_size').notNull(),
    /** Compressed content size in bytes. */
    compressedSize: integer('compressed_size').notNull(),
    /** SHA content hash. */
    contentHash: text('content_hash').notNull(),
    /** Content format tag. */
    format: text('format').notNull().default('text'),
    /** Optional title. */
    title: text('title'),
    /** Token count. */
    tokens: integer('tokens').notNull().default(0),
    /** ISO-8601 UTC expiry instant; empty/NULL = no expiry (was epoch, §4). */
    expiresAt: text('expires_at'),
    /** Optional external storage key. */
    storageKey: text('storage_key'),
    /** Edit mode (§5b non-conformer — bare TEXT pending exodus audit). */
    mode: text('mode').notNull().default('draft'),
    /** Total version count. */
    versionCount: integer('version_count').notNull().default(1),
    /** Current version number. */
    currentVersion: integer('current_version').notNull().default(1),
    /** ISO-8601 UTC creation instant (was epoch seconds, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_conduit_attachments_conversation').on(table.conversationId),
    index('idx_conduit_attachments_agent').on(table.fromAgentId),
  ],
);

/**
 * `conduit_attachment_versions` — version history (collaborative editing).
 *
 * @task T11360 (target shape) · T344 (original)
 */
export const conduitAttachmentVersions = sqliteTable(
  'conduit_attachment_versions',
  {
    /** Version row id (UUID v4). */
    id: text('id').primaryKey(),
    /** FK → `conduit_attachments.slug`. ON DELETE CASCADE. */
    slug: text('slug')
      .notNull()
      .references((): AnySQLiteColumn => conduitAttachments.slug, { onDelete: 'cascade' }),
    /** Monotonic version number. */
    versionNumber: integer('version_number').notNull(),
    /** Revision author agent id (cross-DB soft FK → signaldock). */
    authorAgentId: text('author_agent_id').notNull(),
    /** Change type (§5b non-conformer — bare TEXT pending exodus audit). */
    changeType: text('change_type').notNull().default('patch'),
    /** Optional patch text. */
    patchText: text('patch_text'),
    /** External storage key. */
    storageKey: text('storage_key').notNull(),
    /** SHA content hash. */
    contentHash: text('content_hash').notNull(),
    /** Uncompressed size in bytes. */
    originalSize: integer('original_size').notNull(),
    /** Compressed size in bytes. */
    compressedSize: integer('compressed_size').notNull(),
    /** Token count. */
    tokens: integer('tokens').notNull(),
    /** Optional change summary. */
    changeSummary: text('change_summary'),
    /** JSON array of modified sections (TEXT per JSON audit; empty-array default). */
    sectionsModified: text('sections_modified').notNull().default('[]'),
    /** Tokens added in this version. */
    tokensAdded: integer('tokens_added').notNull().default(0),
    /** Tokens removed in this version. */
    tokensRemoved: integer('tokens_removed').notNull().default(0),
    /** ISO-8601 UTC creation instant (was epoch seconds, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    unique('uq_conduit_attachment_versions_slug_version').on(table.slug, table.versionNumber),
    index('idx_conduit_attachment_versions_slug').on(table.slug),
    index('idx_conduit_attachment_versions_author').on(table.authorAgentId),
  ],
);

/**
 * `conduit_attachment_approvals` — approval records for content review.
 *
 * @task T11360 (target shape) · T344 (original)
 */
export const conduitAttachmentApprovals = sqliteTable(
  'conduit_attachment_approvals',
  {
    /** Approval row id (UUID v4). */
    id: text('id').primaryKey(),
    /** FK → `conduit_attachments.slug`. ON DELETE CASCADE. */
    slug: text('slug')
      .notNull()
      .references((): AnySQLiteColumn => conduitAttachments.slug, { onDelete: 'cascade' }),
    /** Reviewer agent id (cross-DB soft FK → signaldock). */
    reviewerAgentId: text('reviewer_agent_id').notNull(),
    /** Approval status (§5b non-conformer — bare TEXT pending exodus audit). */
    status: text('status').notNull().default('pending'),
    /** Optional reviewer comment. */
    comment: text('comment'),
    /** Version number reviewed. */
    versionReviewed: integer('version_reviewed').notNull(),
    /** ISO-8601 UTC creation instant (was epoch seconds, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC last-update instant (was epoch seconds, §4). */
    updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    unique('uq_conduit_attachment_approvals_slug_reviewer').on(table.slug, table.reviewerAgentId),
    index('idx_conduit_attachment_approvals_slug').on(table.slug),
  ],
);

/**
 * `conduit_attachment_contributors` — contributor stats per attachment.
 *
 * @task T11360 (target shape) · T344 (original)
 */
export const conduitAttachmentContributors = sqliteTable(
  'conduit_attachment_contributors',
  {
    /** FK → `conduit_attachments.slug`. ON DELETE CASCADE. */
    slug: text('slug')
      .notNull()
      .references((): AnySQLiteColumn => conduitAttachments.slug, { onDelete: 'cascade' }),
    /** Contributor agent id (cross-DB soft FK → signaldock). */
    agentId: text('agent_id').notNull(),
    /** Number of versions contributed. */
    versionCount: integer('version_count').notNull().default(0),
    /** Total tokens added across versions. */
    totalTokensAdded: integer('total_tokens_added').notNull().default(0),
    /** Total tokens removed across versions. */
    totalTokensRemoved: integer('total_tokens_removed').notNull().default(0),
    /** ISO-8601 UTC first-contribution instant (was epoch seconds, §4). */
    firstContributionAt: text('first_contribution_at').notNull(),
    /** ISO-8601 UTC last-contribution instant (was epoch seconds, §4). */
    lastContributionAt: text('last_contribution_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.slug, table.agentId] })],
);

// ---------------------------------------------------------------------------
// Per-project agent reference overrides
// ---------------------------------------------------------------------------

/**
 * `conduit_project_agent_refs` — per-project agent reference overrides
 * (ADR-037 §3). `agent_id` is a cross-DB soft FK to signaldock agents.
 *
 * @task T11360 (target shape) · T353 (original)
 */
export const conduitProjectAgentRefs = sqliteTable('conduit_project_agent_refs', {
  /** Override target agent id (cross-DB soft FK → signaldock). */
  agentId: text('agent_id').primaryKey(),
  /** ISO-8601 UTC attach instant (already canonical TEXT, §4). */
  attachedAt: text('attached_at').notNull(),
  /** Override role (§5b non-conformer — bare TEXT pending exodus audit). */
  role: text('role'),
  /** JSON capabilities override (TEXT per JSON audit). */
  capabilitiesOverride: text('capabilities_override'),
  /** ISO-8601 UTC last-used instant (already canonical TEXT, §4). */
  lastUsedAt: text('last_used_at'),
  /** Whether the ref is enabled. E10 §3b: untyped INTEGER 0/1 → typed boolean. */
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
});

// ---------------------------------------------------------------------------
// A2A topics (T1252)
// ---------------------------------------------------------------------------

/**
 * `conduit_topics` — A2A named pub-sub channels.
 *
 * @task T11360 (target shape) · T1252 (original)
 */
export const conduitTopics = sqliteTable(
  'conduit_topics',
  {
    /** Topic id (UUID v4). */
    id: text('id').primaryKey(),
    /** Unique topic name (`<epicId>.<waveId>` / `<epicId>.coordination`). */
    name: text('name').notNull().unique(),
    /** Epic this topic scopes coordination to (cross-DB soft FK → tasks). */
    epicId: text('epic_id').notNull(),
    /** Optional wave id. */
    waveId: integer('wave_id'),
    /** Topic creator agent id (cross-DB soft FK → signaldock). */
    createdBy: text('created_by').notNull(),
    /** ISO-8601 UTC creation instant (was epoch seconds, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [index('idx_conduit_topics_epic').on(table.epicId)],
);

/**
 * `conduit_topic_subscriptions` — agent↔topic subscription bindings.
 *
 * @task T11360 (target shape) · T1252 (original)
 */
export const conduitTopicSubscriptions = sqliteTable(
  'conduit_topic_subscriptions',
  {
    /** FK → `conduit_topics.id`. ON DELETE CASCADE. */
    topicId: text('topic_id')
      .notNull()
      .references(() => conduitTopics.id, { onDelete: 'cascade' }),
    /** Subscriber agent id (cross-DB soft FK → signaldock). */
    agentId: text('agent_id').notNull(),
    /** ISO-8601 UTC subscription instant (was epoch seconds, §4). */
    subscribedAt: text('subscribed_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.topicId, table.agentId] }),
    index('idx_conduit_topic_subscriptions_agent').on(table.agentId),
  ],
);

/**
 * `conduit_topic_messages` — broadcast messages published to a topic.
 *
 * @task T11360 (target shape) · T1252 (original)
 */
export const conduitTopicMessages = sqliteTable(
  'conduit_topic_messages',
  {
    /** Topic-message id (UUID v4). */
    id: text('id').primaryKey(),
    /** FK → `conduit_topics.id`. ON DELETE CASCADE. */
    topicId: text('topic_id')
      .notNull()
      .references(() => conduitTopics.id, { onDelete: 'cascade' }),
    /** Publisher agent id (cross-DB soft FK → signaldock). */
    fromAgentId: text('from_agent_id').notNull(),
    /** Message kind (§5b non-conformer — bare TEXT pending exodus audit). */
    kind: text('kind').notNull().default('message'),
    /** Message body. */
    content: text('content').notNull(),
    /** Optional JSON payload (TEXT per JSON audit). */
    payload: text('payload'),
    /** ISO-8601 UTC creation instant (was epoch seconds, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /**
     * Caller-supplied idempotency key (§7 Pattern A) for A2A broadcast
     * republish; NULL for legacy writes. UNIQUE ignores NULLs.
     */
    idempotencyKey: text('idempotency_key'),
  },
  (table) => [
    index('idx_conduit_topic_messages_topic_created').on(table.topicId, table.createdAt),
    unique('uq_conduit_topic_messages_idempotency_key').on(table.idempotencyKey),
  ],
);

/**
 * `conduit_topic_message_acks` — per-subscriber delivery tracking.
 *
 * @task T11360 (target shape) · T1252 (original)
 */
export const conduitTopicMessageAcks = sqliteTable(
  'conduit_topic_message_acks',
  {
    /** FK → `conduit_topic_messages.id`. ON DELETE CASCADE. */
    messageId: text('message_id')
      .notNull()
      .references(() => conduitTopicMessages.id, { onDelete: 'cascade' }),
    /** ACK-origin subscriber agent id (cross-DB soft FK → signaldock). */
    subscriberAgentId: text('subscriber_agent_id').notNull(),
    /** ISO-8601 UTC delivery instant; NULL until delivered (was epoch, §4). */
    deliveredAt: text('delivered_at'),
    /** ISO-8601 UTC read instant; NULL until read (was epoch, §4). */
    readAt: text('read_at'),
  },
  (table) => [primaryKey({ columns: [table.messageId, table.subscriberAgentId] })],
);

// ---------------------------------------------------------------------------
// Type exports
// ---------------------------------------------------------------------------

/** Row type for `conduit_conversations` SELECT queries (target shape). */
export type ConduitConversationRow = typeof conduitConversations.$inferSelect;
/** Row type for `conduit_conversations` INSERT operations (target shape). */
export type NewConduitConversationRow = typeof conduitConversations.$inferInsert;
/** Row type for `conduit_messages` SELECT queries (target shape). */
export type ConduitMessageRow = typeof conduitMessages.$inferSelect;
/** Row type for `conduit_messages` INSERT operations (target shape). */
export type NewConduitMessageRow = typeof conduitMessages.$inferInsert;
/** Row type for `conduit_delivery_jobs` SELECT queries (target shape). */
export type ConduitDeliveryJobRow = typeof conduitDeliveryJobs.$inferSelect;
/** Row type for `conduit_delivery_jobs` INSERT operations (target shape). */
export type NewConduitDeliveryJobRow = typeof conduitDeliveryJobs.$inferInsert;
/** Row type for `conduit_dead_letters` SELECT queries (target shape). */
export type ConduitDeadLetterRow = typeof conduitDeadLetters.$inferSelect;
/** Row type for `conduit_dead_letters` INSERT operations (target shape). */
export type NewConduitDeadLetterRow = typeof conduitDeadLetters.$inferInsert;
/** Row type for `conduit_message_pins` SELECT queries (target shape). */
export type ConduitMessagePinRow = typeof conduitMessagePins.$inferSelect;
/** Row type for `conduit_message_pins` INSERT operations (target shape). */
export type NewConduitMessagePinRow = typeof conduitMessagePins.$inferInsert;
/** Row type for `conduit_attachments` SELECT queries (target shape). */
export type ConduitAttachmentRow = typeof conduitAttachments.$inferSelect;
/** Row type for `conduit_attachments` INSERT operations (target shape). */
export type NewConduitAttachmentRow = typeof conduitAttachments.$inferInsert;
/** Row type for `conduit_attachment_versions` SELECT queries (target shape). */
export type ConduitAttachmentVersionRow = typeof conduitAttachmentVersions.$inferSelect;
/** Row type for `conduit_attachment_versions` INSERT operations (target shape). */
export type NewConduitAttachmentVersionRow = typeof conduitAttachmentVersions.$inferInsert;
/** Row type for `conduit_attachment_approvals` SELECT queries (target shape). */
export type ConduitAttachmentApprovalRow = typeof conduitAttachmentApprovals.$inferSelect;
/** Row type for `conduit_attachment_approvals` INSERT operations (target shape). */
export type NewConduitAttachmentApprovalRow = typeof conduitAttachmentApprovals.$inferInsert;
/** Row type for `conduit_attachment_contributors` SELECT queries (target shape). */
export type ConduitAttachmentContributorRow = typeof conduitAttachmentContributors.$inferSelect;
/** Row type for `conduit_attachment_contributors` INSERT operations (target shape). */
export type NewConduitAttachmentContributorRow = typeof conduitAttachmentContributors.$inferInsert;
/** Row type for `conduit_project_agent_refs` SELECT queries (target shape). */
export type ConduitProjectAgentRefRow = typeof conduitProjectAgentRefs.$inferSelect;
/** Row type for `conduit_project_agent_refs` INSERT operations (target shape). */
export type NewConduitProjectAgentRefRow = typeof conduitProjectAgentRefs.$inferInsert;
/** Row type for `conduit_topics` SELECT queries (target shape). */
export type ConduitTopicRow = typeof conduitTopics.$inferSelect;
/** Row type for `conduit_topics` INSERT operations (target shape). */
export type NewConduitTopicRow = typeof conduitTopics.$inferInsert;
/** Row type for `conduit_topic_subscriptions` SELECT queries (target shape). */
export type ConduitTopicSubscriptionRow = typeof conduitTopicSubscriptions.$inferSelect;
/** Row type for `conduit_topic_subscriptions` INSERT operations (target shape). */
export type NewConduitTopicSubscriptionRow = typeof conduitTopicSubscriptions.$inferInsert;
/** Row type for `conduit_topic_messages` SELECT queries (target shape). */
export type ConduitTopicMessageRow = typeof conduitTopicMessages.$inferSelect;
/** Row type for `conduit_topic_messages` INSERT operations (target shape). */
export type NewConduitTopicMessageRow = typeof conduitTopicMessages.$inferInsert;
/** Row type for `conduit_topic_message_acks` SELECT queries (target shape). */
export type ConduitTopicMessageAckRow = typeof conduitTopicMessageAcks.$inferSelect;
/** Row type for `conduit_topic_message_acks` INSERT operations (target shape). */
export type NewConduitTopicMessageAckRow = typeof conduitTopicMessageAcks.$inferInsert;
