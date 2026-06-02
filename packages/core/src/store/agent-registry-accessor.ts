/**
 * Agent Registry Accessor — cross-DB CRUD for agent data.
 *
 * Post-T11622 cutover (folds T11578 AC2), agent identity lives in the GLOBAL
 * PREFIXED `agent_registry_agents` table (+ `agent_registry_capabilities` /
 * `agent_registry_skills` / `agent_registry_agent_capabilities` /
 * `agent_registry_agent_skills`); per-project visibility and overrides live in the
 * PROJECT `conduit_project_agent_refs` table (T11578 · AC4 — conduit namespace
 * cutover). The bare legacy `agents` shape is no longer read or written.
 *
 * Post-E6-L5 (T11525) / E6-L6 (T11526), both tables are hosted inside the
 * CONSOLIDATED dual-scope `cleo.db` files (global `$XDG_DATA_HOME/cleo/cleo.db`
 * and project `.cleo/cleo.db`) — the standalone `signaldock.db` / `conduit.db`
 * files are gone. The global `agent_registry_*` tables are owned by the
 * consolidated cleo-global migration (T11622 rename of `signaldock_*`);
 * `ensureGlobalAgentRegistryDb()` opens the shared consolidated handle. The
 * prefixed conduit `conduit_project_agent_refs` table is created by the
 * consolidated cleo-project migration (T11578 · AC4) and `ensureConduitDb()`
 * ensures the project `cleo.db` is open. The read path MUST therefore go through
 * those `ensure*` calls so it shares the same handle as the write path (T11562 —
 * agents read/write path divergence regression).
 *
 * The consolidated `agent_registry_agents` table carries TEXT ISO-8601 timestamps
 * (`created_at` / `updated_at` / `last_used_at`, each with a GLOB CHECK) — every
 * write path below stamps ISO strings, not the legacy epoch integers (T11622
 * write-path constraint reconciliation).
 *
 * This module provides three module-level functions that perform the in-memory
 * cross-DB join, plus the backward-compatible `AgentRegistryAccessor` class that
 * wraps them.
 *
 * Architecture:
 *   global  cleo.db — canonical identity `agent_registry_agents` (openGlobalDb → ensureGlobalAgentRegistryDb)
 *   project cleo.db — `conduit_project_agent_refs` (openConduitDb)
 *   Join performed in Node (SQLite cannot cross-file-handle JOIN).
 *
 * @see .cleo/rcasd/T310/specification/T310-specification.md §3.5
 * @see .cleo/adrs/ADR-037-conduit-signaldock-separation.md
 * @task T355
 * @task T11562
 * @task T11622
 * @epic T310
 * @epic T11249
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import type {
  AgentCredential,
  AgentListFilter,
  AgentRegistryAPI,
  AgentRegistryExtendedFields,
  AgentTier,
  AgentWithProjectOverride,
  ProjectAgentRef,
  ResolvedAgent,
  TransportConfig,
} from '@cleocode/contracts';
import { getCleoHome } from '../paths.js';
import {
  ensureGlobalAgentRegistryDb,
  getGlobalAgentRegistryNativeDb,
} from './agent-registry-store.js';
import { deriveApiKey } from './api-key-kdf.js';
import { ensureConduitDb, getConduitDbPath } from './conduit-sqlite.js';
import { getGlobalSalt } from './global-salt.js';
import { applyPerfPragmas } from './sqlite-pragmas.js';

// ---------------------------------------------------------------------------
// node:sqlite interop (createRequire for ESM / Vitest compat)
// ---------------------------------------------------------------------------

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => _DatabaseSyncType;
};

// ---------------------------------------------------------------------------
// Machine-key helper (internal — mirrors credentials.ts private getMachineKey)
// ---------------------------------------------------------------------------

/** Machine-key constants. */
const MACHINE_KEY_LENGTH = 32;

/**
 * Read or auto-generate the machine key (32 bytes).
 * Machine key lives at `getCleoHome()/machine-key` (same XDG root as the global salt).
 *
 * @returns A 32-byte Buffer.
 * @task T355
 * @epic T310
 */
function readMachineKey(): Buffer {
  const keyPath = join(getCleoHome(), 'machine-key');

  if (!existsSync(keyPath)) {
    const cleoHome = getCleoHome();
    if (!existsSync(cleoHome)) {
      mkdirSync(cleoHome, { recursive: true });
    }
    const key = randomBytes(MACHINE_KEY_LENGTH);
    writeFileSync(keyPath, key, { mode: 0o600 });
    return key;
  }

  // Validate permissions on POSIX
  if (process.platform !== 'win32') {
    const stat = statSync(keyPath);
    const mode = stat.mode & 0o777;
    if (mode !== 0o600) {
      throw new Error(
        `Machine key at ${keyPath} has wrong permissions: expected 0o600, got 0o${mode.toString(8)}. ` +
          `Fix with: chmod 600 ${keyPath}`,
      );
    }
  }

  const key = readFileSync(keyPath);
  if (key.length !== MACHINE_KEY_LENGTH) {
    throw new Error(
      `Machine key at ${keyPath} has wrong length: expected ${MACHINE_KEY_LENGTH} bytes, got ${key.length}.`,
    );
  }
  return key;
}

// ---------------------------------------------------------------------------
// Raw row shapes
// ---------------------------------------------------------------------------

/**
 * Raw row shape from global cleo.db:agent_registry_agents.
 *
 * The T897 v3 columns (tier, can_spawn, orch_level, reports_to, cant_path,
 * cant_sha256, installed_from, installed_at) are typed as OPTIONAL here so
 * this interface can accept rows from databases where the v3 migration has
 * not yet been applied (freshly-cloned projects, pre-upgrade snapshots).
 *
 * Callers that require v3 fields (e.g. `rowToResolvedAgent`) MUST check
 * migration state or narrow the row through `hasV3Fields()` first.
 *
 * @task T897
 * @epic T889
 */
interface AgentDbRow {
  id: string;
  agent_id: string;
  name: string;
  description: string | null;
  class: string;
  privacy_tier: string;
  capabilities: string;
  skills: string;
  transport_type: string;
  api_key_encrypted: string | null;
  api_base_url: string;
  classification: string | null;
  transport_config: string;
  is_active: number;
  // T11622 cutover: the consolidated `agent_registry_agents` carries TEXT ISO-8601
  // timestamps (CHECK GLOB) — not the legacy INTEGER epoch shape.
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
  // ---- T897 v3 extensions ----
  tier?: string;
  can_spawn?: number;
  orch_level?: number;
  reports_to?: string | null;
  cant_path?: string | null;
  cant_sha256?: string | null;
  installed_from?: string | null;
  installed_at?: string | null;
}

/** Raw row shape from conduit.db:project_agent_refs. */
interface ProjectAgentRefRow {
  agent_id: string;
  attached_at: string;
  role: string | null;
  capabilities_override: string | null;
  last_used_at: string | null;
  enabled: number;
}

// ---------------------------------------------------------------------------
// Row-to-type converters
// ---------------------------------------------------------------------------

/**
 * Convert a project_agent_refs row to a `ProjectAgentRef` contract object.
 *
 * @param row - Raw SQLite row from conduit.db:project_agent_refs.
 * @returns Typed `ProjectAgentRef` object.
 * @task T355
 * @epic T310
 */
function rowToProjectRef(row: ProjectAgentRefRow): ProjectAgentRef {
  return {
    agentId: row.agent_id,
    attachedAt: row.attached_at,
    role: row.role,
    capabilitiesOverride: row.capabilities_override,
    lastUsedAt: row.last_used_at,
    enabled: row.enabled,
  };
}

/**
 * Convert a global cleo.db:agent_registry_agents row to an `AgentCredential`.
 * API key is stored as binary (derived via KDF) — returned as hex string.
 * Legacy encrypted values (pre-T310) are left as-is; the reauth flag handles
 * forced re-authentication at the CLI layer.
 *
 * @param row - Raw SQLite row from global cleo.db:agent_registry_agents.
 * @returns Typed `AgentCredential` (apiKey is hex-encoded derived bytes or empty).
 * @task T355
 * @epic T310
 */
function rowToCredential(row: AgentDbRow): AgentCredential {
  return {
    agentId: row.agent_id,
    displayName: row.name,
    // api_key_encrypted stores the KDF-derived key as binary or a legacy ciphertext.
    // Return as hex-encoded bytes for callers that need the raw key.
    // The reauth flow in `cleo agent auth` handles re-keying (T358).
    apiKey: row.api_key_encrypted ? Buffer.from(row.api_key_encrypted).toString('hex') : '',
    apiBaseUrl: row.api_base_url,
    classification: row.classification ?? undefined,
    privacyTier: row.privacy_tier as AgentCredential['privacyTier'],
    capabilities: JSON.parse(row.capabilities) as string[],
    skills: JSON.parse(row.skills) as string[],
    transportType: (row.transport_type ?? 'http') as AgentCredential['transportType'],
    transportConfig: JSON.parse(row.transport_config) as TransportConfig,
    isActive: row.is_active === 1,
    // T11622 cutover: `agent_registry_agents` timestamps are TEXT ISO-8601 — read
    // through as-is (no epoch→ms conversion).
    lastUsedAt: row.last_used_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Narrow a value to the set of valid `AgentTier` literals.
 *
 * Returns `'fallback'` for any value the CHECK constraint would reject.
 * Keeping this permissive (instead of throwing) preserves the behavior
 * required by `rowToResolvedAgent` on pre-migration DBs, where callers
 * expect a default rather than a crash.
 *
 * @task T897
 * @epic T889
 */
function coerceTier(value: string | undefined): AgentTier {
  return value === 'project' || value === 'global' || value === 'packaged' || value === 'fallback'
    ? value
    : 'fallback';
}

/**
 * Extract the T897 v3 extended fields from a raw agents row. Populates safe
 * defaults for any field the v3 migration has not yet provisioned (tier:
 * 'fallback', canSpawn: false, orchLevel: 2). Callers that need strict
 * migration presence MUST check `row.tier !== undefined` before invoking.
 *
 * @param row - Raw SQLite row from cleo.db:agent_registry_agents
 * @returns The extended field block, with safe fallbacks for absent columns
 * @task T897
 * @epic T889
 */
function rowToExtendedFields(row: AgentDbRow): AgentRegistryExtendedFields {
  return {
    tier: coerceTier(row.tier),
    canSpawn: row.can_spawn === 1,
    orchLevel: typeof row.orch_level === 'number' ? row.orch_level : 2,
    reportsTo: row.reports_to ?? null,
    cantPath: row.cant_path ?? null,
    cantSha256: row.cant_sha256 ?? null,
    installedFrom:
      row.installed_from === 'seed' ||
      row.installed_from === 'user' ||
      row.installed_from === 'manual'
        ? row.installed_from
        : null,
    installedAt: row.installed_at ?? null,
  };
}

/**
 * Build a `ResolvedAgent` envelope from a global agents row. This is
 * scaffolding consumed by future `resolveAgent()` / `installAgentFromCant()`
 * work (W2-3, W2-4). It does NOT perform tier-merging, alias lookup, or
 * skill unioning — it simply projects a single row into the resolved shape.
 *
 * Returns `null` when the row lacks the hard-required `cant_path` /
 * `cant_sha256` pair (a row from a pre-T897 DB, or an agents row that has
 * never been bound to a `.cant`). Callers that need a synthesized fallback
 * envelope MUST handle the null return explicitly.
 *
 * @param row - Raw agent_registry_agents row from the global cleo.db
 * @returns A ResolvedAgent envelope, or null when provenance is missing
 * @task T897
 * @epic T889
 */
export function rowToResolvedAgent(row: AgentDbRow): ResolvedAgent | null {
  const extended = rowToExtendedFields(row);
  if (!extended.cantPath || !extended.cantSha256) {
    return null;
  }
  const skills = JSON.parse(row.skills) as string[];
  return {
    agentId: row.agent_id,
    tier: extended.tier,
    cantPath: extended.cantPath,
    cantSha256: extended.cantSha256,
    canSpawn: extended.canSpawn,
    orchLevel: extended.orchLevel,
    reportsTo: extended.reportsTo,
    skills,
    source: extended.tier,
    aliasApplied: false,
  };
}

/**
 * Merge a global agent row with an optional project_agent_refs row into an
 * `AgentWithProjectOverride` object.
 *
 * @param agentRow - Row from global cleo.db:agent_registry_agents.
 * @param refRow   - Row from conduit.db:project_agent_refs, or null.
 * @returns Merged `AgentWithProjectOverride`.
 * @task T355
 * @epic T310
 */
function mergeToAgentWithOverride(
  agentRow: AgentDbRow,
  refRow: ProjectAgentRefRow | null,
): AgentWithProjectOverride {
  return {
    ...rowToCredential(agentRow),
    projectRef: refRow ? rowToProjectRef(refRow) : null,
  };
}

// ---------------------------------------------------------------------------
// Database handle helpers (short-lived, caller closes)
// ---------------------------------------------------------------------------

/**
 * Acquire the SHARED, fully-migrated handle to the GLOBAL agent identity DB —
 * the consolidated dual-scope global `cleo.db` (post-E6-L5 / T11525).
 *
 * Routes through {@link ensureGlobalAgentRegistryDb}, which opens the consolidated
 * `cleo.db` via `openDualScopeDb('global')` (whose consolidated cleo-global
 * migration creates the prefixed `agent_registry_*` tables this accessor's raw SQL
 * now queries, post-T11622 cutover), reconciles the health-probe ledger, and
 * stores the native handle for reuse. The returned handle is the SAME one the
 * write path uses — reads and writes are aligned to `cleo.db` (T11562).
 *
 * Replaces the previous `new DatabaseSync(getGlobalAgentRegistryDbPath())` raw-open,
 * which diverged from the write path (T11562).
 *
 * The handle is SHARED and co-owned by the nexus / skills global domains — its
 * lifecycle is owned by `openDualScopeDb`. Callers MUST NOT call `db.close()` on
 * it (doing so would break in-flight sibling queries). This is why every former
 * `globalDb.close()` in this module was removed (T11562).
 *
 * @returns The shared consolidated global `cleo.db` native handle.
 * @throws {Error} If the shared handle is unexpectedly absent after ensure.
 * @task T355
 * @task T11562
 * @epic T310
 * @epic T11249
 */
async function openGlobalDb(): Promise<DatabaseSync> {
  // Idempotent: opens the consolidated global cleo.db, runs the legacy
  // (the consolidated cleo-global migration creates the agent_registry_* tables),
  // and caches the shared native handle (T11622 cutover).
  await ensureGlobalAgentRegistryDb();
  const db = getGlobalAgentRegistryNativeDb();
  if (!db) {
    throw new Error(
      'openGlobalDb: ensureGlobalAgentRegistryDb() did not yield a shared global ' +
        'cleo.db handle (getGlobalAgentRegistryNativeDb() returned null). This indicates ' +
        'the dual-scope global chokepoint failed to initialize — fix the caller, do ' +
        'not suppress.',
    );
  }
  return db;
}

/**
 * Open a short-lived read/write handle to the PROJECT conduit.db.
 * Caller MUST call `db.close()` when done.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @task T355
 * @epic T310
 */
function openConduitDb(projectRoot: string): DatabaseSync {
  const dbPath = getConduitDbPath(projectRoot);
  const db = new DatabaseSync(dbPath);
  applyPerfPragmas(db); // replaces inline PRAGMA calls with SSoT set (T9023)
  return db;
}

// ---------------------------------------------------------------------------
// junction table sync (global cleo.db (Agent Registry) only)
// ---------------------------------------------------------------------------

/**
 * Sync capabilities/skills to junction tables in global cleo.db (Agent Registry).
 * Junction tables are the SSoT — JSON columns are a materialized cache.
 *
 * @param db         - Open handle to global cleo.db (Agent Registry).
 * @param agentUuid  - The `id` (UUID primary key) from the agents row.
 * @param capabilities - Array of capability slugs.
 * @param skills       - Array of skill slugs.
 * @task T355
 * @epic T310
 */
function syncJunctionTables(
  db: DatabaseSync,
  agentUuid: string,
  capabilities: string[],
  skills: string[],
): void {
  db.prepare('DELETE FROM agent_registry_agent_capabilities WHERE agent_id = ?').run(agentUuid);
  db.prepare('DELETE FROM agent_registry_agent_skills WHERE agent_id = ?').run(agentUuid);
  for (const cap of capabilities) {
    const capRow = db
      .prepare('SELECT id FROM agent_registry_capabilities WHERE slug = ?')
      .get(cap) as { id: string } | undefined;
    if (capRow) {
      db.prepare(
        'INSERT OR IGNORE INTO agent_registry_agent_capabilities (agent_id, capability_id) VALUES (?, ?)',
      ).run(agentUuid, capRow.id);
    }
  }
  for (const skill of skills) {
    const skillRow = db.prepare('SELECT id FROM agent_registry_skills WHERE slug = ?').get(skill) as
      | { id: string }
      | undefined;
    if (skillRow) {
      db.prepare(
        'INSERT OR IGNORE INTO agent_registry_agent_skills (agent_id, skill_id) VALUES (?, ?)',
      ).run(agentUuid, skillRow.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level cross-DB functions (spec §3.5)
// ---------------------------------------------------------------------------

/**
 * Cross-DB agent lookup. Opens both the global cleo.db (Agent Registry) and the
 * current project's conduit.db, joins project_agent_refs ⨝ agents by
 * agentId, and returns the merged view.
 *
 * Default (includeGlobal=false): returns null if no project_agent_refs row
 * exists, even if the agent exists globally. An enabled=0 row is also treated
 * as absent.
 *
 * includeGlobal=true: returns the global agent with `projectRef: null` if no
 * project attachment row exists.
 *
 * Dangling soft-FK detection: if a project_agent_refs row exists but the
 * referenced global agent does not, logs a WARN and returns null.
 *
 * Both `agents` (global) and `project_agent_refs` (project) tables are
 * materialized into their consolidated `cleo.db` files lazily, so this function
 * ensures both DBs (via the shared `openGlobalDb` / `ensureConduitDb`
 * chokepoints) before reading — keeping the read path aligned with the write
 * path (T11562). It is therefore async.
 *
 * @param projectRoot     - Absolute path to the project root directory.
 * @param agentId         - Agent business identifier.
 * @param opts.includeGlobal - When true, returns global identity even without project ref.
 * @returns Merged agent record or null if not found.
 *
 * @task T355
 * @task T11562
 * @epic T310
 * @epic T11249
 */
export async function lookupAgent(
  projectRoot: string,
  agentId: string,
  opts?: { includeGlobal?: boolean },
): Promise<AgentWithProjectOverride | null> {
  const includeGlobal = opts?.includeGlobal ?? false;

  // Ensure the consolidated project cleo.db has the prefixed
  // `conduit_project_agent_refs` table (T11578 · AC4) before the raw-open read
  // below (mirrors the global side, which is ensured inside openGlobalDb).
  await ensureConduitDb(projectRoot);

  // SHARED global cleo.db handle — do NOT close (lifecycle owned by openDualScopeDb).
  const globalDb = await openGlobalDb();
  const conduitDb = openConduitDb(projectRoot);

  try {
    const agentRow = globalDb
      .prepare('SELECT * FROM agent_registry_agents WHERE agent_id = ?')
      .get(agentId) as AgentDbRow | undefined;

    const refRow = conduitDb
      .prepare('SELECT * FROM conduit_project_agent_refs WHERE agent_id = ?')
      .get(agentId) as ProjectAgentRefRow | undefined;

    // Dangling soft-FK: ref exists in conduit but not in global
    if (refRow && !agentRow) {
      console.warn(
        `[agent-registry-accessor] WARN: dangling project_agent_refs row for agent_id="${agentId}". ` +
          `No matching row in global cleo.db:agents. Row will be ignored.`,
      );
      return null;
    }

    // Agent does not exist globally at all
    if (!agentRow) return null;

    if (!includeGlobal) {
      // INNER JOIN semantics: must have a project ref with enabled=1
      if (!refRow || refRow.enabled === 0) return null;
      return mergeToAgentWithOverride(agentRow, refRow);
    }

    // includeGlobal=true: return global agent; populate projectRef only when enabled=1
    const effectiveRef = refRow && refRow.enabled === 1 ? refRow : null;
    return mergeToAgentWithOverride(agentRow, effectiveRef);
  } finally {
    // NOTE: globalDb is the SHARED dual-scope handle — never close it (T11562).
    conduitDb.close();
  }
}

/**
 * Lists agents visible in the current project.
 *
 * Default (includeGlobal=false): INNER JOIN on project_agent_refs (enabled=1)
 * — only agents explicitly attached to this project are returned.
 *
 * includeGlobal=true: returns all global agents regardless of project
 * attachment, with projectRef populated for attached ones and null for the rest.
 *
 * includeDisabled=true: also returns agents with enabled=0 in project_agent_refs.
 * Ignored when includeGlobal=true (all global agents are returned regardless).
 *
 * Both `agents` (global) and `project_agent_refs` (project) tables are
 * materialized into their consolidated `cleo.db` files lazily, so this function
 * ensures both DBs (via the shared `openGlobalDb` / `ensureConduitDb`
 * chokepoints) before reading — keeping the read path aligned with the write
 * path (T11562). It is therefore async.
 *
 * @param projectRoot            - Absolute path to the project root directory.
 * @param opts.includeGlobal     - Include all global agents (bypasses project filter).
 * @param opts.includeDisabled   - Include agents with enabled=0 in project_agent_refs.
 * @returns Array of merged agent records.
 *
 * @task T355
 * @task T11562
 * @epic T310
 * @epic T11249
 */
export async function listAgentsForProject(
  projectRoot: string,
  opts?: { includeGlobal?: boolean; includeDisabled?: boolean },
): Promise<AgentWithProjectOverride[]> {
  const includeGlobal = opts?.includeGlobal ?? false;
  const includeDisabled = opts?.includeDisabled ?? false;

  // Ensure the consolidated project cleo.db has the prefixed
  // `conduit_project_agent_refs` table (T11578 · AC4) before the raw-open read
  // below (mirrors the global side, which is ensured inside openGlobalDb).
  await ensureConduitDb(projectRoot);

  // SHARED global cleo.db handle — do NOT close (lifecycle owned by openDualScopeDb).
  const globalDb = await openGlobalDb();
  const conduitDb = openConduitDb(projectRoot);

  try {
    const allAgents = globalDb
      .prepare('SELECT * FROM agent_registry_agents ORDER BY name ASC')
      .all() as unknown as AgentDbRow[];

    const allRefs = conduitDb
      .prepare('SELECT * FROM conduit_project_agent_refs')
      .all() as unknown as ProjectAgentRefRow[];

    // Build a map from agentId → ref row for O(1) lookup during join
    const refMap = new Map<string, ProjectAgentRefRow>();
    for (const ref of allRefs) {
      refMap.set(ref.agent_id, ref);
    }

    const result: AgentWithProjectOverride[] = [];

    for (const agentRow of allAgents) {
      const ref = refMap.get(agentRow.agent_id);

      if (includeGlobal) {
        // Return all global agents; populate projectRef only for attached ones
        const effectiveRef = ref && ref.enabled === 1 ? ref : null;
        result.push(mergeToAgentWithOverride(agentRow, effectiveRef));
      } else {
        // INNER JOIN: only agents with a project ref row
        if (!ref) continue;
        if (!includeDisabled && ref.enabled === 0) continue;
        result.push(mergeToAgentWithOverride(agentRow, ref));
      }
    }

    return result;
  } finally {
    // NOTE: globalDb is the SHARED dual-scope handle — never close it (T11562).
    conduitDb.close();
  }
}

/**
 * Creates a new agent: writes identity row to global cleo.db (Agent Registry) AND attaches
 * it to the current project via conduit.db:project_agent_refs.
 *
 * Write order: global first, then project ref. If the project ref write fails,
 * the global row remains (recoverable via `cleo agent attach <id>`).
 *
 * API key derivation: HMAC-SHA256(machineKey || globalSalt, agentId) per ADR-037 §5.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param spec        - Agent creation spec (without createdAt/updatedAt).
 * @returns Merged agent record including the new project ref.
 *
 * @task T355
 * @epic T310
 */
export async function createProjectAgent(
  projectRoot: string,
  spec: Omit<AgentCredential, 'createdAt' | 'updatedAt'>,
): Promise<AgentWithProjectOverride> {
  // E6-L3 (T11523): ensureConduitDb is now async (routes through the dual-scope
  // cleo.db chokepoint). ensureGlobalAgentRegistryDb is already async. Await both so
  // the bare schema exists before the short-lived raw handles below read/write it.
  await ensureGlobalAgentRegistryDb();
  await ensureConduitDb(projectRoot);

  const nowTs = Math.floor(Date.now() / 1000);
  const nowIso = new Date(nowTs * 1000).toISOString();

  // Derive API key using the T310 KDF
  const machineKey = readMachineKey();
  const globalSalt = getGlobalSalt();
  const derivedKey = deriveApiKey({
    machineKey,
    globalSalt,
    agentId: spec.agentId,
  });
  // Store as hex string in the encrypted column
  const apiKeyEncrypted = derivedKey.toString('hex');

  // SHARED global cleo.db handle — do NOT close (lifecycle owned by openDualScopeDb).
  const globalDb = await openGlobalDb();
  {
    const existing = globalDb
      .prepare('SELECT id FROM agent_registry_agents WHERE agent_id = ?')
      .get(spec.agentId) as { id: string } | undefined;

    let agentUuid: string;

    if (!existing) {
      agentUuid = crypto.randomUUID();
      globalDb
        .prepare(
          `INSERT INTO agent_registry_agents (id, agent_id, name, class, privacy_tier, capabilities, skills,
           transport_type, api_key_encrypted, api_base_url, classification, transport_config,
           is_active, last_used_at, status, created_at, updated_at, requires_reauth)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'online', ?, ?, 0)`,
        )
        .run(
          agentUuid,
          spec.agentId,
          spec.displayName,
          spec.classification ?? 'custom',
          spec.privacyTier,
          JSON.stringify(spec.capabilities),
          JSON.stringify(spec.skills),
          spec.transportType ?? 'http',
          apiKeyEncrypted,
          spec.apiBaseUrl,
          spec.classification ?? null,
          JSON.stringify(spec.transportConfig),
          spec.isActive ? 1 : 0,
          // T11622 cutover: TEXT ISO-8601 to satisfy the consolidated GLOB CHECK.
          spec.lastUsedAt ? new Date(spec.lastUsedAt).toISOString() : null,
          nowIso,
          nowIso,
        );
      syncJunctionTables(globalDb, agentUuid, spec.capabilities, spec.skills);
    } else {
      agentUuid = existing.id;
      // Update identity in global DB (idempotent re-register)
      globalDb
        .prepare(
          `UPDATE agent_registry_agents SET name = ?, class = ?, privacy_tier = ?, capabilities = ?, skills = ?,
           transport_type = ?, api_key_encrypted = ?, api_base_url = ?, classification = ?,
           transport_config = ?, is_active = ?, updated_at = ? WHERE agent_id = ?`,
        )
        .run(
          spec.displayName,
          spec.classification ?? 'custom',
          spec.privacyTier,
          JSON.stringify(spec.capabilities),
          JSON.stringify(spec.skills),
          spec.transportType ?? 'http',
          apiKeyEncrypted,
          spec.apiBaseUrl,
          spec.classification ?? null,
          JSON.stringify(spec.transportConfig),
          spec.isActive ? 1 : 0,
          nowIso,
          spec.agentId,
        );
      syncJunctionTables(globalDb, agentUuid, spec.capabilities, spec.skills);
    }
  }
  // NOTE: globalDb is the SHARED dual-scope handle — never close it (T11562).

  // Attach to project via conduit.db:project_agent_refs
  const conduitDb = openConduitDb(projectRoot);
  try {
    const existingRef = conduitDb
      .prepare('SELECT agent_id, enabled FROM conduit_project_agent_refs WHERE agent_id = ?')
      .get(spec.agentId) as { agent_id: string; enabled: number } | undefined;

    if (!existingRef) {
      conduitDb
        .prepare(
          `INSERT INTO conduit_project_agent_refs (agent_id, attached_at, role, capabilities_override, last_used_at, enabled)
           VALUES (?, ?, NULL, NULL, NULL, 1)`,
        )
        .run(spec.agentId, nowIso);
    } else if (existingRef.enabled === 0) {
      // Re-enable a previously detached agent
      conduitDb
        .prepare(
          `UPDATE conduit_project_agent_refs SET enabled = 1, attached_at = ? WHERE agent_id = ?`,
        )
        .run(nowIso, spec.agentId);
    }
    // If enabled=1 already, leave the existing ref intact
  } finally {
    conduitDb.close();
  }

  const result = await lookupAgent(projectRoot, spec.agentId, { includeGlobal: false });
  if (!result) {
    throw new Error(`createProjectAgent: failed to retrieve agent after creation: ${spec.agentId}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Standalone attach / detach helpers (T364)
// ---------------------------------------------------------------------------

/**
 * Attach a globally-registered agent to the current project.
 *
 * Creates a `project_agent_refs` row with `enabled=1`. If a row already exists
 * with `enabled=0`, it is re-enabled (idempotent). If the row already has
 * `enabled=1`, this is a no-op.
 *
 * The agent MUST already exist in the global `cleo.db:agent_registry_agents` table.
 * This function does NOT validate global existence — callers must check via
 * `lookupAgent(..., { includeGlobal: true })` first.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param agentId     - Agent business identifier.
 * @param opts.role                - Optional per-project role override (nullable).
 * @param opts.capabilitiesOverride - Optional JSON blob of capability overrides (nullable).
 *
 * @task T364
 * @epic T310
 */
export function attachAgentToProject(
  projectRoot: string,
  agentId: string,
  opts?: { role?: string | null; capabilitiesOverride?: string | null },
): void {
  const conduitDb = openConduitDb(projectRoot);
  const nowIso = new Date().toISOString();
  try {
    const existingRef = conduitDb
      .prepare('SELECT agent_id, enabled FROM conduit_project_agent_refs WHERE agent_id = ?')
      .get(agentId) as { agent_id: string; enabled: number } | undefined;

    if (!existingRef) {
      conduitDb
        .prepare(
          `INSERT INTO conduit_project_agent_refs (agent_id, attached_at, role, capabilities_override, last_used_at, enabled)
           VALUES (?, ?, ?, ?, NULL, 1)`,
        )
        .run(agentId, nowIso, opts?.role ?? null, opts?.capabilitiesOverride ?? null);
    } else if (existingRef.enabled === 0) {
      conduitDb
        .prepare(
          `UPDATE conduit_project_agent_refs SET enabled = 1, attached_at = ?, role = ?, capabilities_override = ? WHERE agent_id = ?`,
        )
        .run(nowIso, opts?.role ?? null, opts?.capabilitiesOverride ?? null, agentId);
    }
    // enabled=1 already — no-op
  } finally {
    conduitDb.close();
  }
}

/**
 * Detach an agent from the current project by setting `project_agent_refs.enabled=0`.
 *
 * This is a soft-delete: the global `cleo.db:agent_registry_agents` row is preserved.
 * The agent can be re-attached later via `attachAgentToProject`.
 *
 * Returns `false` if no row exists in `project_agent_refs` for the given agentId
 * (agent was never attached or was already fully removed).
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param agentId     - Agent business identifier.
 * @returns `true` if a row was updated; `false` if no row existed.
 *
 * @task T364
 * @epic T310
 */
export function detachAgentFromProject(projectRoot: string, agentId: string): boolean {
  const conduitDb = openConduitDb(projectRoot);
  try {
    const ref = conduitDb
      .prepare('SELECT agent_id FROM conduit_project_agent_refs WHERE agent_id = ?')
      .get(agentId) as { agent_id: string } | undefined;

    if (!ref) return false;

    conduitDb
      .prepare('UPDATE conduit_project_agent_refs SET enabled = 0 WHERE agent_id = ?')
      .run(agentId);
    return true;
  } finally {
    conduitDb.close();
  }
}

/**
 * Get the raw `project_agent_refs` row for a given agentId in this project.
 *
 * Returns `null` if no row exists (agent not attached to this project).
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param agentId     - Agent business identifier.
 * @returns Typed `ProjectAgentRef` object or `null`.
 *
 * @task T364
 * @epic T310
 */
export function getProjectAgentRef(projectRoot: string, agentId: string): ProjectAgentRef | null {
  const conduitDb = openConduitDb(projectRoot);
  try {
    const row = conduitDb
      .prepare('SELECT * FROM conduit_project_agent_refs WHERE agent_id = ?')
      .get(agentId) as ProjectAgentRefRow | undefined;
    if (!row) return null;
    return rowToProjectRef(row);
  } finally {
    conduitDb.close();
  }
}

// ---------------------------------------------------------------------------
// AgentRegistryAccessor class (backward-compatible wrapper)
// ---------------------------------------------------------------------------

/**
 * AgentRegistryAccessor — backward-compatible CRUD wrapper around the
 * cross-DB module-level functions.
 *
 * Post-T310 (ADR-037), the constructor accepts the project root (same
 * semantics as `projectPath` in the pre-T310 version). All operations are
 * routed through the cross-DB functions above.
 *
 * @task T355
 * @epic T310
 */
export class AgentRegistryAccessor implements AgentRegistryAPI {
  /**
   * @param projectPath - Absolute path to the project root directory.
   *   Used as the `projectRoot` argument for all cross-DB operations.
   * @task T355
   * @epic T310
   */
  constructor(private readonly projectPath: string) {}

  /**
   * Ensure both databases exist with their full schemas before any operation.
   *
   * @task T355
   * @epic T310
   */
  private async ensureDbs(): Promise<void> {
    // E6-L3 (T11523): ensureConduitDb is now async (dual-scope cleo.db
    // chokepoint); ensureGlobalAgentRegistryDb is already async. Await both.
    await ensureGlobalAgentRegistryDb();
    await ensureConduitDb(this.projectPath);
  }

  /**
   * Register (create or update) an agent in global cleo.db (Agent Registry) and attach
   * it to the current project via conduit.db:project_agent_refs.
   *
   * @param credential - Agent spec (without createdAt/updatedAt).
   * @returns The registered agent credential.
   * @task T355
   * @epic T310
   */
  async register(
    credential: Omit<AgentCredential, 'createdAt' | 'updatedAt'>,
  ): Promise<AgentCredential> {
    await this.ensureDbs();
    return createProjectAgent(this.projectPath, credential);
  }

  /**
   * Get agent by agentId. Project-scoped by default (INNER JOIN).
   *
   * @param agentId             - Agent business identifier.
   * @param opts.includeGlobal  - When true, returns global identity even without project ref.
   * @returns The agent credential, or null if not found.
   * @task T355
   * @epic T310
   */
  async get(agentId: string, opts?: { includeGlobal?: boolean }): Promise<AgentCredential | null> {
    await this.ensureDbs();
    return lookupAgent(this.projectPath, agentId, opts);
  }

  /**
   * Lists project-scoped agents (INNER JOIN on project_agent_refs with enabled=1).
   *
   * @param filter - Optional filter (active field maps to is_active in global agents).
   * @returns Array of agent credentials visible in this project.
   * @task T355
   * @epic T310
   */
  async list(filter?: AgentListFilter): Promise<AgentCredential[]> {
    await this.ensureDbs();
    const results = await listAgentsForProject(this.projectPath, { includeGlobal: false });
    if (filter?.active !== undefined) {
      return results.filter((a) => a.isActive === filter.active);
    }
    return results;
  }

  /**
   * Lists all global agents (no project filter). Exposed for `--global` CLI flag.
   *
   * @param filter - Optional filter (active field maps to is_active in global agents).
   * @returns Array of all globally registered agent credentials.
   * @task T355
   * @epic T310
   */
  async listGlobal(filter?: AgentListFilter): Promise<AgentCredential[]> {
    await this.ensureDbs();
    // SHARED global cleo.db handle — do NOT close (lifecycle owned by openDualScopeDb).
    const globalDb = await openGlobalDb();
    const rows =
      filter?.active !== undefined
        ? (globalDb
            .prepare('SELECT * FROM agent_registry_agents WHERE is_active = ? ORDER BY name ASC')
            .all(filter.active ? 1 : 0) as unknown as AgentDbRow[])
        : (globalDb
            .prepare('SELECT * FROM agent_registry_agents ORDER BY name ASC')
            .all() as unknown as AgentDbRow[]);
    return rows.map(rowToCredential);
  }

  /**
   * Update agent identity fields in global cleo.db (Agent Registry).
   * Project-specific fields (role, capabilitiesOverride) require direct
   * conduit.db manipulation (not yet exposed by this method).
   *
   * @param agentId  - Agent business identifier.
   * @param updates  - Partial set of fields to update.
   * @returns The updated agent credential (project-scoped lookup).
   * @task T355
   * @epic T310
   */
  async update(
    agentId: string,
    updates: Partial<Omit<AgentCredential, 'agentId' | 'createdAt'>>,
  ): Promise<AgentCredential> {
    await this.ensureDbs();
    const existing = await this.get(agentId, { includeGlobal: true });
    if (!existing) throw new Error(`Agent not found: ${agentId}`);

    // T11622 cutover: `agent_registry_agents.updated_at` is TEXT ISO-8601 (GLOB CHECK).
    const nowIso = new Date().toISOString();
    // SHARED global cleo.db handle — do NOT close (lifecycle owned by openDualScopeDb).
    const globalDb = await openGlobalDb();
    {
      const sets: string[] = ['updated_at = ?'];
      const params: unknown[] = [nowIso];

      if (updates.displayName !== undefined) {
        sets.push('name = ?');
        params.push(updates.displayName);
      }
      if (updates.apiBaseUrl !== undefined) {
        sets.push('api_base_url = ?');
        params.push(updates.apiBaseUrl);
      }
      if (updates.classification !== undefined) {
        sets.push('classification = ?');
        params.push(updates.classification);
      }
      if (updates.privacyTier !== undefined) {
        sets.push('privacy_tier = ?');
        params.push(updates.privacyTier);
      }
      if (updates.capabilities !== undefined) {
        sets.push('capabilities = ?');
        params.push(JSON.stringify(updates.capabilities));
      }
      if (updates.skills !== undefined) {
        sets.push('skills = ?');
        params.push(JSON.stringify(updates.skills));
      }
      if (updates.transportType !== undefined) {
        sets.push('transport_type = ?');
        params.push(updates.transportType);
      }
      if (updates.transportConfig !== undefined) {
        sets.push('transport_config = ?');
        params.push(JSON.stringify(updates.transportConfig));
      }
      if (updates.isActive !== undefined) {
        sets.push('is_active = ?');
        params.push(updates.isActive ? 1 : 0);
      }
      if (updates.apiKey !== undefined) {
        // Re-derive using new T310 KDF
        const machineKey = readMachineKey();
        const globalSalt = getGlobalSalt();
        const derivedKey = deriveApiKey({ machineKey, globalSalt, agentId });
        sets.push('api_key_encrypted = ?');
        params.push(derivedKey.toString('hex'));
      }

      params.push(agentId);
      globalDb
        .prepare(`UPDATE agent_registry_agents SET ${sets.join(', ')} WHERE agent_id = ?`)
        .run(...(params as Array<string | number | null>));

      // Sync junction tables if capabilities or skills changed
      if (updates.capabilities !== undefined || updates.skills !== undefined) {
        const agentRow = globalDb
          .prepare('SELECT id FROM agent_registry_agents WHERE agent_id = ?')
          .get(agentId) as { id: string } | undefined;
        if (agentRow) {
          syncJunctionTables(
            globalDb,
            agentRow.id,
            updates.capabilities ?? existing.capabilities,
            updates.skills ?? existing.skills,
          );
        }
      }
    }
    // NOTE: globalDb is the SHARED dual-scope handle — never close it (T11562).

    const result = await this.get(agentId, { includeGlobal: true });
    if (!result) throw new Error(`Agent not found after update: ${agentId}`);
    return result;
  }

  /**
   * Remove agent from current project (sets project_agent_refs.enabled=0).
   * Does NOT delete from global cleo.db (Agent Registry) (per ADR-037 §6 / Q4=C).
   *
   * @param agentId - Agent business identifier.
   * @task T355
   * @epic T310
   */
  async remove(agentId: string): Promise<void> {
    await this.ensureDbs();

    const conduitDb = openConduitDb(this.projectPath);
    try {
      const ref = conduitDb
        .prepare('SELECT agent_id FROM conduit_project_agent_refs WHERE agent_id = ?')
        .get(agentId) as { agent_id: string } | undefined;
      if (!ref) {
        throw new Error(`Agent not found in current project: ${agentId}`);
      }
      conduitDb
        .prepare('UPDATE conduit_project_agent_refs SET enabled = 0 WHERE agent_id = ?')
        .run(agentId);
    } finally {
      conduitDb.close();
    }
  }

  /**
   * Remove agent from global cleo.db (Agent Registry).
   * Requires explicit opt-in. Warns if cross-project refs may exist.
   *
   * @param agentId     - Agent business identifier.
   * @param opts.force  - Skip the global-delete warning when refs exist.
   * @task T355
   * @epic T310
   */
  async removeGlobal(agentId: string, opts?: { force?: boolean }): Promise<void> {
    await this.ensureDbs();
    // SHARED global cleo.db handle — do NOT close (lifecycle owned by openDualScopeDb).
    const globalDb = await openGlobalDb();
    const existing = globalDb
      .prepare('SELECT id FROM agent_registry_agents WHERE agent_id = ?')
      .get(agentId) as { id: string } | undefined;
    if (!existing) {
      throw new Error(`Agent not found globally: ${agentId}`);
    }

    if (!opts?.force) {
      // Best-effort cross-project scan: check the current project's conduit.db
      const conduitDb = openConduitDb(this.projectPath);
      try {
        const ref = conduitDb
          .prepare(
            'SELECT agent_id FROM conduit_project_agent_refs WHERE agent_id = ? AND enabled = 1',
          )
          .get(agentId) as { agent_id: string } | undefined;
        if (ref) {
          throw new Error(
            `Agent "${agentId}" still has project references in the current project. ` +
              `Use removeGlobal(id, { force: true }) to skip this check.`,
          );
        }
      } finally {
        conduitDb.close();
      }
    }

    globalDb.prepare('DELETE FROM agent_registry_agents WHERE agent_id = ?').run(agentId);
    // NOTE: globalDb is the SHARED dual-scope handle — never close it (T11562).
  }

  /**
   * Rotate API key via cloud endpoint and re-encrypt with the new T310 KDF
   * in global cleo.db (Agent Registry).
   *
   * @param agentId - Agent business identifier.
   * @returns Object with agentId and a redacted new API key string.
   * @task T355
   * @epic T310
   */
  async rotateKey(agentId: string): Promise<{ agentId: string; newApiKey: string }> {
    await this.ensureDbs();
    const credential = await this.get(agentId, { includeGlobal: true });
    if (!credential) throw new Error(`Agent not found: ${agentId}`);

    const response = await fetch(`${credential.apiBaseUrl}/agents/${agentId}/rotate-key`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential.apiKey}`,
        'X-Agent-Id': agentId,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to rotate key on cloud: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { data?: { apiKey?: string } };
    const newApiKey = data.data?.apiKey;
    if (!newApiKey) throw new Error('Cloud API did not return a new API key');

    // Re-derive and store using T310 KDF
    const machineKey = readMachineKey();
    const globalSalt = getGlobalSalt();
    const derivedKey = deriveApiKey({ machineKey, globalSalt, agentId });
    // T11622 cutover: `updated_at` is TEXT ISO-8601 (GLOB CHECK).
    const nowIso = new Date().toISOString();

    // SHARED global cleo.db handle — do NOT close (lifecycle owned by openDualScopeDb).
    const globalDb = await openGlobalDb();
    globalDb
      .prepare(
        'UPDATE agent_registry_agents SET api_key_encrypted = ?, updated_at = ?, requires_reauth = 0 WHERE agent_id = ?',
      )
      .run(derivedKey.toString('hex'), nowIso, agentId);
    // NOTE: globalDb is the SHARED dual-scope handle — never close it (T11562).

    return { agentId, newApiKey: `${newApiKey.substring(0, 8)}...rotated` };
  }

  /**
   * Get the most recently used active agent in the current project.
   *
   * @returns The most-recently-used active agent, or null if none found.
   * @task T355
   * @epic T310
   */
  async getActive(): Promise<AgentCredential | null> {
    await this.ensureDbs();

    // SHARED global cleo.db handle — do NOT close (lifecycle owned by openDualScopeDb).
    const globalDb = await openGlobalDb();
    const conduitDb = openConduitDb(this.projectPath);
    try {
      // Get all project-attached, enabled agent IDs ordered by project last_used_at
      const enabledRefs = conduitDb
        .prepare(
          'SELECT agent_id, last_used_at FROM conduit_project_agent_refs WHERE enabled = 1 ORDER BY last_used_at DESC',
        )
        .all() as unknown as Array<{ agent_id: string; last_used_at: string | null }>;

      for (const ref of enabledRefs) {
        const agentRow = globalDb
          .prepare('SELECT * FROM agent_registry_agents WHERE agent_id = ? AND is_active = 1')
          .get(ref.agent_id) as AgentDbRow | undefined;
        if (agentRow) return rowToCredential(agentRow);
      }

      // Fall back to global last_used_at if no project-local activity recorded
      const row = globalDb
        .prepare(
          'SELECT * FROM agent_registry_agents WHERE is_active = 1 ORDER BY last_used_at DESC, created_at DESC LIMIT 1',
        )
        .get() as AgentDbRow | undefined;
      if (!row) return null;
      return rowToCredential(row);
    } finally {
      // NOTE: globalDb is the SHARED dual-scope handle — never close it (T11562).
      conduitDb.close();
    }
  }

  /**
   * Update last_used_at in both global cleo.db:agent_registry_agents and
   * conduit.db:project_agent_refs.
   *
   * @param agentId - Agent business identifier.
   * @task T355
   * @epic T310
   */
  async markUsed(agentId: string): Promise<void> {
    await this.ensureDbs();
    // T11622 cutover: `last_used_at` / `updated_at` are TEXT ISO-8601 (GLOB CHECK)
    // in `agent_registry_agents`; `conduit_project_agent_refs.last_used_at` is also ISO.
    const nowIso = new Date().toISOString();

    // SHARED global cleo.db handle — do NOT close (lifecycle owned by openDualScopeDb).
    const globalDb = await openGlobalDb();
    globalDb
      .prepare(
        'UPDATE agent_registry_agents SET last_used_at = ?, updated_at = ? WHERE agent_id = ?',
      )
      .run(nowIso, nowIso, agentId);
    // NOTE: globalDb is the SHARED dual-scope handle — never close it (T11562).

    const conduitDb = openConduitDb(this.projectPath);
    try {
      conduitDb
        .prepare('UPDATE conduit_project_agent_refs SET last_used_at = ? WHERE agent_id = ?')
        .run(nowIso, agentId);
    } finally {
      conduitDb.close();
    }
  }
}
