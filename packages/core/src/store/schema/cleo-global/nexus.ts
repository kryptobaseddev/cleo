/**
 * Global-scope `cleo.db` — consolidated **nexus registry/identity** domain (6 tables).
 *
 * Part of the consolidated GLOBAL-scope `cleo.db` target shape authored for
 * SG-DB-SUBSTRATE-V2 (saga T11242, epic T11245/E2, task T11361). Target-shape
 * authoring only — physical names carry the `nexus_` domain prefix. The live
 * runtime modules `schema/nexus-schema.ts` + `schema/code-index.ts` keep their
 * UNPREFIXED / partially-prefixed names until the exodus migration (T11248)
 * swaps the substrate to this shape.
 *
 * ## Nexus code-graph residency move (ADR-090 · T11539 — REMOVED from here)
 *
 * The four per-project code/knowledge-graph tables — `nexus_nodes`,
 * `nexus_relations`, `nexus_contracts`, `nexus_code_index` (ADR-090 "Category A")
 * — were REMOVED from this GLOBAL module and now reside in PROJECT scope
 * (`../cleo-project/nexus-graph.ts`, T11538), dropping the `project_id` column
 * (scope is implicit in which project's `.cleo/cleo.db` is open). This reduces
 * the nexus GLOBAL table count from 10 → 6. The six tables retained here are the
 * genuinely-global "Category B" registry/identity tables (see below). Exodus
 * routes the four graph tables to PROJECT scope per
 * `../exodus/table-name-map.ts` (`NEXUS_GRAPH_PROJECT_TABLES`).
 *
 * ## Idempotent prefixer (AC1)
 *
 * The six retained tables: `nexus_audit_log` · `nexus_schema_meta` already carry
 * the recognized `nexus_` prefix and are NOT double-prefixed. The remaining four
 * bare tables gain the domain prefix at exodus: `project_registry` →
 * `nexus_project_registry` · `project_id_aliases` → `nexus_project_id_aliases` ·
 * `user_profile` → `nexus_user_profile` · `sigils` → `nexus_sigils`.
 *
 * ## E10 typing applied
 *
 * - **§4 timestamps (Drizzle-Date non-conformers → TEXT ISO8601):**
 *   `nexus_user_profile.{first_observed_at,last_reinforced_at}` and
 *   `nexus_sigils.{created_at,updated_at}` were `integer({ mode:'timestamp' })`
 *   (the 4 Date non-conformers in §4). They become canonical `text` ISO8601;
 *   the matching `CHECK (col GLOB 'YYYY-MM-DD*')` ships as raw DDL at exodus.
 * - **§5b enum-like bare TEXT → `{ enum }`:** `nexus_sigils.role` →
 *   `{ enum: SIGIL_ROLES }`. The const array below is minted in-module (no
 *   cross-package contracts const exists) per §5b — the CHECK list derives from
 *   the identifier, never a hand-typed literal. (`nexus_code_index.kind` →
 *   `{ enum: CODE_INDEX_KINDS }` moved with the graph tables to
 *   `../cleo-project/nexus-graph.ts`.)
 *
 * ## FK reconciliation to single-file Pattern A (AC4)
 *
 * The nexus source used soft FKs (plain `text` + `@cross-db` annotations) for
 * every cross-table reference; none crossed file boundaries via a real
 * `.references()`. Under the consolidated GLOBAL `cleo.db` they remain plain
 * `text` soft FKs:
 *   - `nexus_project_id_aliases.canonical_id` → `nexus_project_registry` and
 *     `nexus_audit_log.project_id` → `nexus_project_registry` stay soft because
 *     the source never declared them as enforced FKs.
 *   - cross-domain refs (`nexus_audit_log.session_id` → project-scope
 *     `tasks_sessions`, `nexus_user_profile.derived_from_message_id` →
 *     `conduit_session_messages`) point at the PROJECT-scope `cleo.db`, so they
 *     CANNOT be native FKs — they remain soft TEXT, resolved by the nexus
 *     accessor. No ATTACH; no cross-file FK.
 *
 * @task T11361 · T11539 (nexus graph residency removal)
 * @epic T11245 · T11535 (nexus residency)
 * @saga T11242
 * @see ../cleo-project/nexus-graph.ts (the PROJECT-scope home of the 4 graph tables)
 * @see docs/migration/sqlite-schema-canonical.md §1 (D1″ · global counts) · §4 · §5b
 * @see docs/migration/sqlite-schema-columns.json (per-column affinity SSoT)
 * @see ../nexus-schema.ts · ../code-index.ts (the runtime source modules)
 * @see cleo docs fetch adr-090-nexus-graph-residency-split
 */

import { USER_PROFILE_SCOPES } from '@cleocode/contracts';
import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { makeSchemaMetaTable } from '../schema-utils.js';

// ---------------------------------------------------------------------------
// E10 §5b — enum const arrays minted in-module (no cross-package contracts SSoT)
// ---------------------------------------------------------------------------

/**
 * Legal `nexus_sigils.role` values — the `.cant` agent role taxonomy.
 *
 * E10 §5b: `sigils.role` was bare `text('role')` (default `''`). The value is
 * the `role:` frontmatter field of a `.cant` agent file, parsed by
 * `nexus/sigil-sync.ts`. The legal set enumerated from the writer + canonical
 * seed roster (`project-orchestrator`, `project-dev-lead`, `project-*-worker`)
 * and the parsed-sigil fixtures (`subagent`, `specialist`). `''` is retained
 * because the column defaults to empty before a `.cant` role is associated.
 *
 * @task T11361
 */
export const SIGIL_ROLES = [
  '',
  'orchestrator',
  'lead',
  'worker',
  'subagent',
  'specialist',
  'validator',
] as const;

/** TypeScript union derived from {@link SIGIL_ROLES}. */
export type SigilRole = (typeof SIGIL_ROLES)[number];

// ---------------------------------------------------------------------------
// Registry + aliases
// ---------------------------------------------------------------------------

/**
 * `nexus_project_registry` — central registry of all CLEO projects known to the
 * Nexus (one row per project). Bare `project_registry` → `nexus_project_registry`
 * under the AC1 idempotent prefixer.
 *
 * @task T11361 (target shape) · T5365 / T529 (original)
 */
export const nexusProjectRegistry = sqliteTable(
  'nexus_project_registry',
  {
    /** Canonical 12-hex-char project identifier (T9149 W5). Primary key. */
    projectId: text('project_id').primaryKey(),
    /**
     * Path fingerprint of the most recently encountered checkout. NOT unique:
     * the registry is keyed by `project_id` alone (ADR-094 · T12469).
     * It is NOT the write-once identity `projectHash` from project-info.json
     * (T12557): never join it to `audit_log.project_hash` or release ids.
     */
    projectHash: text('project_hash').notNull(),
    /**
     * Most recently encountered checkout root. NOT unique: a path names a
     * location, never an identity. Every checkout on every device lives in
     * `nexus_project_locations` (ADR-094 · T12469).
     */
    projectPath: text('project_path').notNull(),
    /** Human-readable project name. */
    name: text('name').notNull(),
    /** ISO-8601 UTC registration instant (canonical TEXT, §4). */
    registeredAt: text('registered_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC last-seen instant (canonical TEXT, §4). */
    lastSeen: text('last_seen').notNull().default(sql`(datetime('now'))`),
    /** Health status string (e.g. "healthy", "warning", "unknown"). */
    healthStatus: text('health_status').notNull().default('unknown'),
    /** ISO-8601 UTC last health-check instant; NULL until first check. */
    healthLastCheck: text('health_last_check'),
    /** Permission level ("read" / "write"). */
    permissions: text('permissions').notNull().default('read'),
    /** ISO-8601 UTC last-sync instant (canonical TEXT, §4). */
    lastSync: text('last_sync').notNull().default(sql`(datetime('now'))`),
    /** Cached task count for the project. */
    taskCount: integer('task_count').notNull().default(0),
    /** JSON array of project labels (serialized TEXT per JSON-Column Audit). */
    labelsJson: text('labels_json').notNull().default('[]'),
    /**
     * Legacy mirror of the project store path. Written for older binaries that
     * share this global store; never read — the path is derived from
     * `project_path` at runtime (T12469).
     */
    brainDbPath: text('brain_db_path'),
    /** Legacy mirror of the project store path; never read (see `brainDbPath`, T12469). */
    tasksDbPath: text('tasks_db_path'),
    /** ISO-8601 UTC last successful code-intelligence index run; NULL until indexed. */
    lastIndexed: text('last_indexed'),
    /** JSON object with per-project code-intelligence stats (serialized TEXT). */
    statsJson: text('stats_json').notNull().default('{}'),
    /**
     * ISO-8601 UTC instant of the last health check, `nexus sync` or git state
     * probe (T12512). Never evidence of use; NULL until first probed.
     */
    lastProbedAt: text('last_probed_at'),
    /**
     * ISO-8601 UTC instant of the last real CLI use inside the project
     * (T12512), written at most once a minute. NULL until first opened.
     */
    lastOpenedAt: text('last_opened_at'),
  },
  (table) => [
    index('idx_nexus_project_registry_hash').on(table.projectHash),
    index('idx_nexus_project_registry_path').on(table.projectPath),
    index('idx_nexus_project_registry_health').on(table.healthStatus),
    index('idx_nexus_project_registry_name').on(table.name),
    index('idx_nexus_project_registry_last_indexed').on(table.lastIndexed),
    index('idx_nexus_project_registry_last_opened').on(table.lastOpenedAt),
  ],
);

/**
 * `nexus_project_id_aliases` — maps legacy base64url(path) project IDs to their
 * canonical IDs (T9149 W5). Bare `project_id_aliases` → `nexus_project_id_aliases`.
 *
 * @task T11361 (target shape) · T9149 (original)
 */
export const nexusProjectIdAliases = sqliteTable(
  'nexus_project_id_aliases',
  {
    /** Legacy base64url(path) ID. Primary key. */
    legacyId: text('legacy_id').primaryKey(),
    /** Canonical 12-hex-char ID this alias maps to (soft FK → nexus_project_registry). */
    canonicalId: text('canonical_id').notNull(),
    /** ISO-8601 UTC creation instant (canonical TEXT, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [index('idx_nexus_project_id_aliases_canonical').on(table.canonicalId)],
);

/**
 * `nexus_project_paths` — device-local path map: every checkout of a project
 * seen on this device, keyed by path (T12354). The registry row holds one path
 * per `project_id`; this table lets two checkouts of one project coexist.
 *
 * @deprecated Superseded by {@link nexusProjectLocations} (T12469). Kept so
 *   older binaries that share this global store keep working; current code
 *   neither reads nor writes it.
 * @task T12354
 */
export const nexusProjectPaths = sqliteTable(
  'nexus_project_paths',
  {
    /** Absolute checkout root on this device. Primary key. */
    projectPath: text('project_path').primaryKey(),
    /** Immutable project id (soft FK → nexus_project_registry). */
    projectId: text('project_id').notNull(),
    /** Path fingerprint of this checkout. */
    projectHash: text('project_hash').notNull(),
    /** ISO-8601 UTC first-recorded instant (canonical TEXT, §4). */
    firstSeen: text('first_seen').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC last-encountered instant (canonical TEXT, §4). */
    lastSeen: text('last_seen').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [index('idx_nexus_project_paths_project_id').on(table.projectId)],
);

/** Lifecycle states of one project location (T12469). */
export const PROJECT_LOCATION_STATES = ['live', 'missing', 'superseded', 'candidate'] as const;

/**
 * `nexus_project_locations` — every place a project has been seen, on every
 * device (ADR-094 · T12469). One row per `(project_id, device_id, path)`; rows
 * are never deleted when a directory vanishes — they move to `missing`, and a
 * path now claimed by another project moves to `superseded`, so location
 * history survives for consumers such as legacy credential derivation.
 *
 * @task T12469
 */
export const nexusProjectLocations = sqliteTable(
  'nexus_project_locations',
  {
    /** Immutable project id (soft FK → nexus_project_registry). */
    projectId: text('project_id').notNull(),
    /** Stable device id (`<cleoHome>/device-id`) of the device the path is on. */
    deviceId: text('device_id').notNull(),
    /** Absolute checkout root on that device. */
    path: text('path').notNull(),
    /** ISO-8601 UTC first-recorded instant (canonical TEXT, §4). */
    firstSeen: text('first_seen').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC last-encountered instant (canonical TEXT, §4). */
    lastSeen: text('last_seen').notNull().default(sql`(datetime('now'))`),
    /**
     * `live` · `missing` (directory gone) · `superseded` (path now holds another
     * project) · `candidate` (declares the id but is not confirmed, T12470).
     */
    state: text('state', { enum: PROJECT_LOCATION_STATES }).notNull().default('live'),
    /**
     * Random per-checkout nonce held in the checkout's untracked
     * `project-info.json` (T12470) — the only evidence that proves a move.
     */
    checkoutNonce: text('checkout_nonce'),
    /** First (parentless) commit — displayed evidence only, never proof (T12470). */
    gitRootCommit: text('git_root_commit'),
    /** Normalised `origin` URL — displayed evidence only, never proof (T12470). */
    gitRemote: text('git_remote'),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.deviceId, table.path] }),
    index('idx_nexus_project_locations_device_path').on(table.deviceId, table.path),
  ],
);

/**
 * `nexus_devices` — one row per machine that runs CLEO against this global
 * store (T12510). `device_id` is the persisted `<cleoHome>/device-id` UUID
 * (T9321), the same id {@link nexusProjectLocations} rows carry, so a location
 * resolves to a hostname / OS / arch / CLEO version and a last heartbeat. The
 * CLI upserts this device's row at most once per minute.
 *
 * @task T12510
 */
export const nexusDevices = sqliteTable(
  'nexus_devices',
  {
    /** Stable device id (`<cleoHome>/device-id`). Primary key. */
    deviceId: text('device_id').primaryKey(),
    /** `os.hostname()` at the last heartbeat. */
    hostname: text('hostname').notNull(),
    /** `process.platform` (e.g. `darwin`, `linux`, `win32`). */
    os: text('os').notNull(),
    /** `process.arch` (e.g. `arm64`, `x64`). */
    arch: text('arch').notNull(),
    /** CLEO version that sent the last heartbeat. */
    cleoVersion: text('cleo_version').notNull(),
    /** ISO-8601 UTC first-heartbeat instant (canonical TEXT, §4). */
    firstSeen: text('first_seen').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC last-heartbeat instant (canonical TEXT, §4). */
    lastHeartbeatAt: text('last_heartbeat_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [index('idx_nexus_devices_last_heartbeat').on(table.lastHeartbeatAt)],
);

/** Probe error codes a `nexus_project_git_state` row may carry (T12511). */
export const GIT_PROBE_ERROR_CODES = [
  'E_PATH_MISSING',
  'E_PATH_ACCESS',
  'E_NOT_GIT_REPO',
  'E_GIT_TIMEOUT',
  'E_GIT_FAILED',
  'E_FETCH_FAILED',
] as const;

/**
 * `nexus_project_git_state` — the last git state probe of one project location
 * (T12511). Keyed exactly like {@link nexusProjectLocations}: `(project_id, device_id,
 * path)`, one row per checkout per device, so another device reading this
 * store sees where each project lives and what state it was last seen in.
 *
 * Remote columns describe the remote as of `remote_fetched_at` (FETCH_HEAD's
 * mtime), never "now": the probe does not fetch unless asked. A failed probe
 * still writes its row, with `probe_error_code` set — errors are never dropped.
 *
 * @task T12511
 */
export const nexusProjectGitState = sqliteTable(
  'nexus_project_git_state',
  {
    /** Immutable project id (soft FK → nexus_project_locations.project_id). */
    projectId: text('project_id').notNull(),
    /** Stable device id of the device the location is on. */
    deviceId: text('device_id').notNull(),
    /** Location path (soft FK → nexus_project_locations.path). */
    path: text('path').notNull(),
    /** Directory git ran in: `path`, or its declared `evidence.gitRoot`. */
    gitRoot: text('git_root'),
    /** Checked-out branch; NULL when detached or unknown. */
    branch: text('branch'),
    /** HEAD commit; NULL for an unborn branch or a failed probe. */
    headSha: text('head_sha'),
    /** 1 when HEAD is detached. */
    detached: integer('detached', { mode: 'boolean' }).notNull().default(false),
    /** 1 for a shallow clone. */
    shallow: integer('shallow', { mode: 'boolean' }).notNull().default(false),
    /** Tracked entries with staged or unstaged changes. */
    dirtyCount: integer('dirty_count'),
    /** Untracked, not-ignored entries. */
    untrackedCount: integer('untracked_count'),
    /** Upstream ref (e.g. `origin/main`). */
    upstream: text('upstream'),
    /** Commits on HEAD not on the upstream, as of the last fetch. */
    ahead: integer('ahead'),
    /** Commits on the upstream not on HEAD, as of the last fetch. */
    behind: integer('behind'),
    /** Remote the upstream belongs to (else `origin`, else the first remote). */
    remoteName: text('remote_name'),
    /** That remote's configured URL. */
    remoteUrl: text('remote_url'),
    /** Upstream tracking-ref commit, as of the last fetch. */
    remoteHeadSha: text('remote_head_sha'),
    /** ISO-8601 UTC instant of the last fetch (FETCH_HEAD mtime); NULL if never. */
    remoteFetchedAt: text('remote_fetched_at'),
    /** ISO-8601 UTC instant of this probe (canonical TEXT, §4). */
    probedAt: text('probed_at').notNull(),
    /** Probe wall time, milliseconds. */
    durationMs: integer('duration_ms').notNull().default(0),
    /** Why the probe could not describe (all of) the location. */
    probeErrorCode: text('probe_error_code', { enum: GIT_PROBE_ERROR_CODES }),
    /** Detail for `probe_error_code`. */
    probeError: text('probe_error'),
    /**
     * ISO-8601 UTC instant HEAD was committed (`git log --format=%cI`, normalized
     * to `Z`); NULL for an unborn branch, a failed probe, or a row probed before
     * T12721. Local-only: never leaves the device through sync.
     */
    headCommittedAt: text('head_committed_at'),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.deviceId, table.path] }),
    index('idx_nexus_project_git_state_device').on(table.deviceId),
  ],
);

// ---------------------------------------------------------------------------
// Audit + schema meta
// ---------------------------------------------------------------------------

/**
 * `nexus_audit_log` — append-only audit log for all Nexus operations across
 * projects. Already domain-prefixed; the idempotent prefixer is a no-op.
 *
 * @task T11361 (target shape) · T5365 (original)
 */
export const nexusAuditLog = sqliteTable(
  'nexus_audit_log',
  {
    /** UUID primary key. */
    id: text('id').primaryKey(),
    /** ISO-8601 UTC instant of the audited operation (canonical TEXT, §4). */
    timestamp: text('timestamp').notNull().default(sql`(datetime('now'))`),
    /** Audited action name. */
    action: text('action').notNull(),
    /** Project hash context; NULL for global operations. */
    projectHash: text('project_hash'),
    /** Project id (soft FK → nexus_project_registry.project_id). */
    projectId: text('project_id'),
    /** Operation domain (e.g. "tasks", "memory"). */
    domain: text('domain'),
    /** Operation name. */
    operation: text('operation'),
    /**
     * Project-tier session that issued the audited operation.
     *
     * Cross-domain soft FK → PROJECT-scope `cleo.db` `tasks_sessions.id`.
     * CANNOT be a native FK (different scope DB file); resolved by the nexus
     * accessor (AC4 — no ATTACH).
     */
    sessionId: text('session_id'),
    /** Correlated request id. */
    requestId: text('request_id'),
    /** Originating source/process. */
    source: text('source'),
    /** CQRS gateway ("query" / "mutate"). */
    gateway: text('gateway'),
    /** Outcome flag (numeric LAFS code echo; not a strict 0/1 boolean). */
    success: integer('success'),
    /** Wall-clock duration in milliseconds. */
    durationMs: integer('duration_ms'),
    /** JSON detail blob (serialized TEXT). */
    detailsJson: text('details_json').default('{}'),
    /** Error message when the operation failed. */
    errorMessage: text('error_message'),
  },
  (table) => [
    index('idx_nexus_audit_timestamp').on(table.timestamp),
    index('idx_nexus_audit_action').on(table.action),
    index('idx_nexus_audit_project_hash').on(table.projectHash),
    index('idx_nexus_audit_project_id').on(table.projectId),
    index('idx_nexus_audit_session').on(table.sessionId),
  ],
);

/**
 * `nexus_schema_meta` — key-value schema-version tracking (single-table KV).
 * Already domain-prefixed.
 *
 * @task T11361 (target shape) · T5365 (original)
 */
export const nexusSchemaMeta = makeSchemaMetaTable('nexus_schema_meta');

// ---------------------------------------------------------------------------
// Global identity / preference layers
// ---------------------------------------------------------------------------

/**
 * `nexus_user_profile` — global user identity / preference profile (PSYCHE
 * Wave 1, T1077). Bare `user_profile` → `nexus_user_profile`.
 *
 * E10 §4: `first_observed_at` / `last_reinforced_at` were
 * `integer({ mode:'timestamp' })` (Drizzle-Date non-conformers) — now canonical
 * TEXT ISO8601.
 *
 * @task T11361 (target shape) · T1077 (original)
 */
export const nexusUserProfile = sqliteTable(
  'nexus_user_profile',
  {
    /** Stable semantic trait key. Primary key — traits are upserted by key. */
    traitKey: text('trait_key').primaryKey(),
    /** JSON-encoded trait value (serialized TEXT). */
    traitValue: text('trait_value').notNull(),
    /** Bayesian confidence in [0.0, 1.0]. */
    confidence: real('confidence').notNull(),
    /** Trait origin (e.g. "dialectic:<sessionId>", "import:...", "manual"). */
    source: text('source').notNull(),
    /**
     * Source message id.
     *
     * Cross-domain soft FK → PROJECT-scope `cleo.db`
     * `conduit_session_messages.id` (RESERVED — table ships in Wave 5 / T1145).
     * CANNOT be a native FK (different scope DB file); resolved by the nexus
     * accessor (AC4 — no ATTACH).
     */
    derivedFromMessageId: text('derived_from_message_id'),
    /** ISO-8601 UTC first-observed instant (E10 §4: Drizzle-Date → TEXT ISO8601). */
    firstObservedAt: text('first_observed_at').notNull(),
    /** ISO-8601 UTC last-reinforced instant (E10 §4: Drizzle-Date → TEXT ISO8601). */
    lastReinforcedAt: text('last_reinforced_at').notNull(),
    /** Number of reinforcement events (starts at 1). */
    reinforcementCount: integer('reinforcement_count').notNull().default(1),
    /** traitKey of the trait that supersedes this one (T1139 supersession graph). */
    supersededBy: text('superseded_by'),

    /**
     * Portable project id (`.cleo/project-id`, ADR-094) of the project this
     * trait was derived in. `NULL` = unknown origin (rows written before
     * T12543): excluded from spawn prompts, still queryable.
     *
     * @task T12543
     */
    projectId: text('project_id'),

    /**
     * Visibility scope (`project` | `user`). `project` rows are injected only
     * into prompts for the project in `project_id`; `user` rows are explicitly
     * user-global. Defaults to `project`.
     *
     * @task T12543
     */
    scope: text('scope', { enum: USER_PROFILE_SCOPES }).notNull().default('project'),
  },
  (table) => [
    index('idx_nexus_user_profile_confidence').on(table.confidence),
    index('idx_nexus_user_profile_source').on(table.source),
    index('idx_nexus_user_profile_last_reinforced').on(table.lastReinforcedAt),
    index('idx_nexus_user_profile_superseded').on(table.supersededBy),
    index('idx_nexus_user_profile_project').on(table.projectId, table.scope),
  ],
);

/**
 * `nexus_sigils` — peer-card sigil identity layer for CANT agents (PSYCHE
 * Wave 8, T1148). Bare `sigils` → `nexus_sigils`.
 *
 * E10 §5b: `role` was bare `text('role')` → `{ enum: SIGIL_ROLES }`.
 * E10 §4: `created_at` / `updated_at` were `integer({ mode:'timestamp' })`
 * (Drizzle-Date non-conformers) — now canonical TEXT ISO8601.
 *
 * @task T11361 (target shape) · T1148 (original)
 */
export const nexusSigils = sqliteTable(
  'nexus_sigils',
  {
    /** Stable peer id (matches `peer_id` on brain tables). Primary key. */
    peerId: text('peer_id').primaryKey(),
    /** Absolute/relative path to the CANT (.cant) agent file; NULL if unassociated. */
    cantFile: text('cant_file'),
    /** Human-readable display name. */
    displayName: text('display_name').notNull().default(''),
    /** Short role from {@link SIGIL_ROLES} (E10 §5b — was bare TEXT). */
    role: text('role', { enum: SIGIL_ROLES }).notNull().default(''),
    /** System-prompt fragment injected into spawn payloads; NULL if none. */
    systemPromptFragment: text('system_prompt_fragment'),
    /** JSON-encoded capability flags object (serialized TEXT); NULL until set. */
    capabilityFlags: text('capability_flags'),
    /** ISO-8601 UTC creation instant (E10 §4: Drizzle-Date → TEXT ISO8601). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC last-update instant (E10 §4: Drizzle-Date → TEXT ISO8601). */
    updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_nexus_sigils_display_name').on(table.displayName),
    index('idx_nexus_sigils_role').on(table.role),
  ],
);

// ---------------------------------------------------------------------------
// Inferred row + insert types
// ---------------------------------------------------------------------------

/** Row type for `nexus_project_registry` SELECT (target shape). */
export type NexusProjectRegistryRow = typeof nexusProjectRegistry.$inferSelect;
/** Row type for `nexus_project_registry` INSERT (target shape). */
export type NewNexusProjectRegistryRow = typeof nexusProjectRegistry.$inferInsert;
/** Row type for `nexus_project_id_aliases` SELECT (target shape). */
export type NexusProjectIdAliasRow = typeof nexusProjectIdAliases.$inferSelect;
/** Row type for `nexus_project_id_aliases` INSERT (target shape). */
export type NewNexusProjectIdAliasRow = typeof nexusProjectIdAliases.$inferInsert;
/** Row type for `nexus_project_paths` SELECT (T12354). */
export type NexusProjectPathRow = typeof nexusProjectPaths.$inferSelect;
/** Row type for `nexus_project_paths` INSERT (T12354). */
export type NewNexusProjectPathRow = typeof nexusProjectPaths.$inferInsert;
/** Row type for `nexus_project_locations` SELECT (T12469). */
export type NexusProjectLocationRow = typeof nexusProjectLocations.$inferSelect;
/** Row type for `nexus_project_locations` INSERT (T12469). */
export type NewNexusProjectLocationRow = typeof nexusProjectLocations.$inferInsert;
/** Row type for `nexus_audit_log` SELECT (target shape). */
export type NexusAuditLogRow = typeof nexusAuditLog.$inferSelect;
/** Row type for `nexus_audit_log` INSERT (target shape). */
export type NewNexusAuditLogRow = typeof nexusAuditLog.$inferInsert;
/** Row type for `nexus_schema_meta` SELECT (target shape). */
export type NexusSchemaMetaRow = typeof nexusSchemaMeta.$inferSelect;
/** Row type for `nexus_schema_meta` INSERT (target shape). */
export type NewNexusSchemaMetaRow = typeof nexusSchemaMeta.$inferInsert;
/** Row type for `nexus_user_profile` SELECT (target shape). */
export type NexusUserProfileRow = typeof nexusUserProfile.$inferSelect;
/** Row type for `nexus_user_profile` INSERT (target shape). */
export type NewNexusUserProfileRow = typeof nexusUserProfile.$inferInsert;
/** Row type for `nexus_sigils` SELECT (target shape). */
export type NexusSigilRow = typeof nexusSigils.$inferSelect;
/** Row type for `nexus_sigils` INSERT (target shape). */
export type NewNexusSigilRow = typeof nexusSigils.$inferInsert;
