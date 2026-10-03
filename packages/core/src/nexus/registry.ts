/**
 * NEXUS project registry - cross-project registration and management.
 *
 * SQLite-backed via nexus.db (Drizzle ORM). The global project registry
 * is stored in ~/.cleo/nexus.db in the project_registry table.
 *
 * Legacy JSON backend (projects-registry.json) is migrated on first init
 * via migrate-json-to-sqlite.ts.
 *
 * @task T5366
 * @epic T4540
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  ExitCode,
  type NexusInitParams,
  type NexusListParams,
  type NexusPermissionSetParams,
  type NexusProjectCandidate,
  type NexusProjectsFleetParams,
  type NexusProjectsFleetResult,
  type NexusProjectsStatusParams,
  type NexusProjectsStatusResult,
  type NexusReconcileParams,
  type NexusRegisterParams,
  type NexusShowParams,
  type NexusSyncParams,
  type NexusUnregisterParams,
} from '@cleocode/contracts';
import { pushWarning } from '@cleocode/lafs';
import { isVaultRemotePath, readPortableProjectId } from '@cleocode/paths';
import { desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { CleoError } from '../errors.js';
import { getLogger } from '../logger.js';
import { paginate } from '../pagination.js';
import { getCleoHome, worktreeScope } from '../paths.js';
import { getTaskAccessor } from '../store/data-accessor.js';
// Re-export only: resetNexusDbState used by tests and index barrel.
import { resetNexusDbState } from '../store/nexus-sqlite.js';
import type { ProjectRegistryRow } from '../store/schema/nexus-schema.js';
import {
  nexusAuditLog,
  projectGitState,
  projectIdAliases,
  projectLocations,
  projectPaths,
  projectRegistry,
} from '../store/schema/nexus-schema.js';
import { ensureCheckoutNonce } from './checkout-nonce.js';
import { listNexusDevices } from './devices.js';
import { generateProjectHash } from './hash.js';
import {
  collectCheckoutEvidence,
  legacyProjectId,
  projectPathFingerprint,
  requireNexusProjectId,
} from './identity.js';
import { registryAliasClaimants, resolveProjectAlias } from './legacy-alias.js';
import {
  isSupersededRegistryPath,
  recordCandidateLocation,
  recordProjectCheckout,
} from './path-map.js';
import { projectLastActivitySql } from './project-activity.js';
import {
  NexusDeviceNotFoundError,
  NexusRegistryReadError,
  toRegistryReadError,
} from './registry-errors.js';
import { registryStorePath } from './registry-hygiene.js';

// ── Domain types ─────────────────────────────────────────────────────
//
// These are plain interfaces (not Zod schemas) because they represent
// the domain shape AFTER row-to-domain mapping. The DB row validation
// is handled by Drizzle's type system (ProjectRegistryRow) and by the
// drizzle-derived schemas in nexus-validation-schemas.ts.

export type NexusPermissionLevel = 'read' | 'write' | 'execute';

export type NexusHealthStatus = 'unknown' | 'healthy' | 'degraded' | 'unreachable';

/** Per-project code intelligence statistics stored in stats_json. */
export interface NexusProjectStats {
  nodeCount: number;
  relationCount: number;
  fileCount: number;
}

/** Domain representation of a registered Nexus project. */
export interface NexusProject {
  hash: string;
  projectId: string;
  path: string;
  name: string;
  registeredAt: string;
  lastSeen: string;
  healthStatus: NexusHealthStatus;
  healthLastCheck: string | null;
  permissions: NexusPermissionLevel;
  lastSync: string;
  taskCount: number;
  labels: string[];
  /** Absolute path to the project's live store holding brain tables (`.cleo/cleo.db`). Null if not yet populated. */
  brainDbPath: string | null;
  /** Absolute path to the project's live store holding task tables (`.cleo/cleo.db`). Null if not yet populated. */
  tasksDbPath: string | null;
  /** ISO 8601 timestamp of the last code intelligence index run. Null if never indexed. */
  lastIndexed: string | null;
  /** Code intelligence stats from the last index run. */
  stats: NexusProjectStats;
  /** ISO 8601 instant of the last health check, sync or git probe (T12512); null if never. */
  lastProbedAt?: string | null;
  /** ISO 8601 instant of the last real CLI use inside the project (T12512); null if never. */
  lastOpenedAt?: string | null;
  /**
   * The project lives on another machine (a row a cloud vault restore brought):
   * `path` is a placeholder, not a location here, so nothing may probe or open
   * it (T13006). Absent for a project on this machine.
   */
  remote?: true;
}

/** Legacy registry file shape (pre-SQLite). Retained for migration compatibility. */
export interface NexusRegistryFile {
  $schema?: string;
  schemaVersion: string;
  lastUpdated: string;
  projects: Record<string, NexusProject>;
}

// ── Path helpers ─────────────────────────────────────────────────────

/** Get path to the NEXUS home directory (cache, etc.). */
export function getNexusHome(): string {
  return process.env['NEXUS_HOME'] ?? join(getCleoHome(), 'nexus');
}

/** Get path to the NEXUS cache directory. */
export function getNexusCacheDir(): string {
  return process.env['NEXUS_CACHE_DIR'] ?? join(getNexusHome(), 'cache');
}

/**
 * Get path to the legacy projects registry JSON file.
 * @deprecated Use nexus.db via getNexusDb() instead. Retained for JSON-to-SQLite migration.
 */
export function getRegistryPath(): string {
  return process.env['NEXUS_REGISTRY_FILE'] ?? join(getCleoHome(), 'projects-registry.json');
}

// ── Row-to-NexusProject mapping ─────────────────────────────────────

/**
 * Convert a project_registry row to a NexusProject object. A row whose path
 * is a cloud vault placeholder is flagged `remote` (T13006).
 */
function rowToProject(row: ProjectRegistryRow): NexusProject {
  const remote = isVaultRemotePath(row.projectPath);
  const noLocation = remote || isSupersededRegistryPath(row.projectPath);
  let labels: string[] = [];
  try {
    labels = JSON.parse(row.labelsJson);
  } catch {
    labels = [];
  }
  let stats: NexusProjectStats = { nodeCount: 0, relationCount: 0, fileCount: 0 };
  try {
    const parsed = JSON.parse(row.statsJson ?? '{}') as Partial<NexusProjectStats>;
    stats = {
      nodeCount: parsed.nodeCount ?? 0,
      relationCount: parsed.relationCount ?? 0,
      fileCount: parsed.fileCount ?? 0,
    };
  } catch {
    stats = { nodeCount: 0, relationCount: 0, fileCount: 0 };
  }
  return {
    hash: row.projectHash,
    projectId: row.projectId,
    path: row.projectPath,
    name: row.name,
    registeredAt: row.registeredAt,
    lastSeen: row.lastSeen,
    healthStatus: row.healthStatus as NexusHealthStatus,
    healthLastCheck: row.healthLastCheck ?? null,
    permissions: row.permissions as NexusPermissionLevel,
    lastSync: row.lastSync,
    taskCount: row.taskCount,
    labels,
    // T12469: derived from the path at runtime; the stored columns are a
    // legacy mirror for older binaries and are never read. A placeholder
    // (superseded, or another machine's project, T13006) has no store here.
    brainDbPath: noLocation ? null : registryStorePath(row.projectPath),
    tasksDbPath: noLocation ? null : registryStorePath(row.projectPath),
    lastIndexed: row.lastIndexed ?? null,
    stats,
    lastProbedAt: row.lastProbedAt ?? null,
    lastOpenedAt: row.lastOpenedAt ?? null,
    ...(remote ? { remote: true as const } : {}),
  };
}

// ── Audit logging ───────────────────────────────────────────────────

interface NexusAuditFields {
  action: string;
  projectHash?: string;
  projectId?: string;
  operation?: string;
  sessionId?: string;
  requestId?: string;
  source?: string;
  gateway?: string;
  success: boolean;
  durationMs?: number;
  details?: Record<string, unknown>;
  errorMessage?: string;
}

/**
 * Write an audit entry to the nexus_audit_log table and emit a Pino log.
 * Audit failures are caught and logged as warnings — they must never break
 * primary operations.
 */
async function writeNexusAudit(fields: NexusAuditFields): Promise<void> {
  try {
    const { getNexusDb } = await import('../store/nexus-sqlite.js');
    const db = await getNexusDb();
    await db.insert(nexusAuditLog).values({
      id: randomUUID(),
      action: fields.action,
      projectHash: fields.projectHash,
      projectId: fields.projectId,
      domain: 'nexus',
      operation: fields.operation,
      sessionId: fields.sessionId,
      requestId: fields.requestId,
      source: fields.source,
      gateway: fields.gateway,
      success: fields.success ? 1 : 0,
      durationMs: fields.durationMs,
      detailsJson: JSON.stringify(fields.details ?? {}),
      errorMessage: fields.errorMessage,
    });

    getLogger('nexus').info({ ...fields, domain: 'nexus' }, `nexus audit: ${fields.action}`);
  } catch (err) {
    getLogger('nexus').warn({ err }, 'nexus audit write failed');
  }
}

// ── Registry operations ──────────────────────────────────────────────

/**
 * Run a registry query against a LIVE nexus handle, retrying ONCE if the shared
 * project handle was closed mid-flight (ADR-090 · T11648).
 *
 * The nexus runtime handle is the PROJECT-scope `cleo.db` (graph home) with the
 * GLOBAL registry ATTACHed. That handle is SHARED with the tasks/brain domains;
 * a concurrent cross-project open (`getTaskAccessor(otherProject)`), a
 * `resetDbState()`, or a sibling exodus-on-open can close it between our
 * `getNexusDb()` await and the query await — surfacing as `"database is not
 * open"`. The liveness guard inside `getNexusDb()` re-derives a fresh handle (and
 * re-attaches the registry), so re-acquiring and retrying once makes registry
 * reads deterministic under that churn.
 *
 * @param fn - Receives a freshly-acquired nexus drizzle handle.
 * @returns The result of `fn`, or re-throws after one failed retry.
 */
async function withLiveNexusDb<T>(
  fn: (db: Awaited<ReturnType<typeof import('../store/nexus-sqlite.js').getNexusDb>>) => Promise<T>,
): Promise<T> {
  const { getNexusDb } = await import('../store/nexus-sqlite.js');
  try {
    return await fn(await getNexusDb());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/database is not open|not open/i.test(msg)) throw err;
    // Re-acquire a live handle (the liveness guard re-opens + re-attaches) and retry once.
    return await fn(await getNexusDb());
  }
}

/**
 * Read all projects from nexus.db and return as a NexusRegistryFile.
 * Compatibility wrapper for consumers that expect the legacy JSON shape.
 *
 * @throws {NexusRegistryReadError} When the registry cannot be read — a
 *   broken registry never looks empty (T12512).
 */
export async function readRegistry(): Promise<NexusRegistryFile> {
  let rows: ProjectRegistryRow[];
  try {
    rows = await withLiveNexusDb((db) => db.select().from(projectRegistry));
  } catch (error) {
    throw toRegistryReadError('read registry', error);
  }
  const projects: Record<string, NexusProject> = {};
  let latestUpdate = '';
  for (const row of rows) {
    const p = rowToProject(row);
    projects[p.hash] = p;
    if (p.lastSeen > latestUpdate) latestUpdate = p.lastSeen;
  }
  return {
    schemaVersion: '1.0.0',
    lastUpdated: latestUpdate || new Date().toISOString(),
    projects,
  };
}

/**
 * Read the global registry.
 *
 * @deprecated {@link readRegistry} now throws a typed error itself (T12512).
 * @throws {NexusRegistryReadError} When the registry cannot be read.
 */
export async function readRegistryRequired(): Promise<NexusRegistryFile> {
  return readRegistry();
}

/**
 * Initialize the NEXUS directory structure and nexus.db.
 * Idempotent -- safe to call multiple times.
 * Migrates legacy JSON registry on first run if present.
 */
export async function nexusInit(_projectRoot = '', _params: NexusInitParams = {}): Promise<void> {
  const nexusHome = getNexusHome();
  const cacheDir = getNexusCacheDir();

  // Create directories
  await mkdir(nexusHome, { recursive: true });
  await mkdir(cacheDir, { recursive: true });

  // Initialize nexus.db (runs migrations) then check for legacy migration
  const { getNexusDb } = await import('../store/nexus-sqlite.js');
  await getNexusDb();

  // Migrate legacy JSON if nexus.db is empty and JSON exists
  const db = await getNexusDb();
  const existing = await db.select().from(projectRegistry);
  if (existing.length === 0) {
    const { migrateJsonToSqlite } = await import('./migrate-json-to-sqlite.js');
    await migrateJsonToSqlite();
  }
}

/** Read actual task metadata; an unavailable store is not an empty project. */
async function readProjectMeta(
  projectPath: string,
): Promise<{ taskCount: number; labels: string[] }> {
  if (isVaultRemotePath(projectPath)) {
    // T13006: another machine's project; opening it would create a store here.
    // @sync-invariant none:local-only a placeholder path names no location on this machine; it gates a local store open, never a synced write
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `This project lives on another machine (restored from the cloud vault); it has no task store here: ${projectPath}`,
      {
        fix: 'Run `cleo cloud restore --project <id> --into <dir>` to bring it onto this machine.',
      },
    );
  }
  try {
    const accessor = await getTaskAccessor(projectPath);
    const { tasks } = await accessor.queryTasks({});
    return {
      taskCount: tasks.length,
      labels: [...new Set(tasks.flatMap((task) => task.labels ?? []))].sort(),
    };
  } catch (error) {
    throw new CleoError(
      ExitCode.CONFIG_ERROR,
      `Cannot read project task metadata at ${projectPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Read the declared immutable identity; absence differs from unreadable metadata.
 *
 * The TRACKED id wins (T12470, T12716): `.cleo/project.json`, else the legacy
 * `.cleo/project-id`, through `readPortableProjectId` — the same order as
 * `readDeclaredProjectIdentity` and `decideProjectIdentity`. The
 * `project-info.json` id is only a cache, used when nothing is tracked yet.
 * A fresh clone that has not run `cleo init` therefore declares the tracked id
 * and never registers under a path-derived fallback.
 */
async function readProjectId(projectPath: string): Promise<string> {
  const infoPath = join(projectPath, '.cleo', 'project-info.json');
  const tracked = readPortableProjectId(projectPath);
  if (tracked.status === 'valid') return tracked.projectId;
  try {
    return (
      z
        .object({ projectId: z.string().min(1).optional() })
        .parse(JSON.parse(await readFile(infoPath, 'utf8'))).projectId ?? ''
    );
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '';
    throw new CleoError(
      ExitCode.CONFIG_ERROR,
      `Cannot read project identity at ${infoPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Return the id a project root declares, adopting one first when it declares
 * none (T12470).
 *
 * A path — or any hash of it — is never a project identity. A root with no
 * tracked identity (`.cleo/project.json` / `.cleo/project-id`) and no
 * `project-info.json` id gets one the same way `cleo init` does: re-linked
 * from the registry when exactly one registered identity matches, otherwise
 * freshly minted — and recorded write-once in `.cleo/project.json` (plus the
 * legacy `.cleo/project-id` mirror), so every later resolution returns it.
 *
 * @throws {CleoError} `CONFIG_ERROR` when no identity can be recorded.
 */
async function adoptDeclaredProjectId(projectPath: string): Promise<string> {
  const declaredId = await readProjectId(projectPath);
  if (declaredId) return declaredId;
  const { decideProjectIdentity, ensurePortableProjectId } = await import(
    '../scaffold/project-identity.js'
  );
  const decision = await decideProjectIdentity(projectPath, undefined);
  await ensurePortableProjectId(projectPath, decision.projectId);
  const recorded = await readProjectId(projectPath);
  if (recorded) return recorded;
  throw new CleoError(
    ExitCode.CONFIG_ERROR,
    `Project at ${projectPath} declares no identity and none could be recorded in .cleo/project.json; refusing to derive one from its path`,
    { fix: `Run \`cleo init\` in ${projectPath} to record the project's identity` },
  );
}

/** Record alternate project identity tokens as aliases for registry lookup. */
async function recordProjectIdAliases(
  projectId: string,
  aliases: Iterable<string>,
  createdAt: string,
): Promise<void> {
  const { getNexusDb } = await import('../store/nexus-sqlite.js');
  const db = await getNexusDb();
  for (const legacyId of new Set(aliases)) {
    if (!legacyId) continue;
    try {
      // T12589: never record a key another project also claims.
      if (registryAliasClaimants(db, legacyId).some((id) => id !== projectId)) continue;
      await db
        .insert(projectIdAliases)
        .values({ legacyId, canonicalId: projectId, createdAt })
        .onConflictDoNothing();
    } catch {
      // Alias rows are compatibility accelerators; registry writes remain authoritative.
    }
  }
}

/**
 * Register or refresh the same immutable project in the global registry.
 * @param _projectRoot - Calling context; the explicit params.path owns the registration.
 * @param params - Target path and optional requested name and permission.
 * @returns The canonical path fingerprint of the registered project.
 * @remarks Metadata is read before a synchronous ownership recheck and atomic
 * registry/alias transaction. Encounter-time store initialization and audit logging
 * are separate operations. Ownership is the immutable project id alone (ADR-094 ·
 * T12469): the same id at a new path moves the row to that checkout and records a
 * location; a different id at a registered path registers beside the old row.
 * @example
 * ```ts
 * const hash = await nexusRegister(projectRoot, { path: projectRoot, name: 'app', permission: 'read' });
 * ```
 */
export async function nexusRegister(
  _projectRoot: string,
  params: NexusRegisterParams,
): Promise<string>;
/** @deprecated Use `nexusRegister(projectRoot, params)` — ADR-057 D1 */
export async function nexusRegister(
  projectPath: string,
  name?: string,
  permissions?: NexusPermissionLevel,
): Promise<string>;
export async function nexusRegister(
  projectRootOrPath: string,
  paramsOrName?: NexusRegisterParams | string,
  permissionsArg?: NexusPermissionLevel,
): Promise<string> {
  let projectPath: string;
  let name: string | undefined;
  let permissions: NexusPermissionLevel | undefined;

  if (paramsOrName !== undefined && typeof paramsOrName === 'object') {
    // New normalized signature: (projectRoot, params)
    projectPath = paramsOrName.path;
    name = paramsOrName.name;
    permissions =
      paramsOrName.permission === undefined
        ? undefined
        : z.enum(['read', 'write', 'execute']).parse(paramsOrName.permission);
  } else {
    // Legacy positional signature
    projectPath = projectRootOrPath;
    name = paramsOrName as string | undefined;
    permissions =
      permissionsArg === undefined
        ? undefined
        : z.enum(['read', 'write', 'execute']).parse(permissionsArg);
  }

  if (!projectPath) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'Project path required');
  }

  // Canonicalize before hashing so relative and symlink spelling cannot create owners.
  const resolvedPath = await realpath(resolve(projectPath));
  const projectHash = generateProjectHash(resolvedPath);
  // Capture explicit ownership across awaits; ambient CLEO_ROOT/CLEO_DIR may
  // belong to another project or change while metadata is being loaded.
  return worktreeScope.run({ worktreeRoot: resolvedPath, projectHash }, async () => {
    if (!(await stat(join(resolvedPath, '.cleo'))).isDirectory()) {
      throw new CleoError(ExitCode.NOT_FOUND, `Path missing .cleo directory: ${resolvedPath}`);
    }
    const declaredId = await adoptDeclaredProjectId(resolvedPath);
    const declared = readPortableProjectId(resolvedPath);
    const declaredName = declared.status === 'valid' ? declared.name : undefined;
    const pathFingerprint = await projectPathFingerprint(resolvedPath);
    const evidence = await collectCheckoutEvidence(resolvedPath);
    await nexusInit();
    const { getNexusDb } = await import('../store/nexus-sqlite.js');
    // T12469 · T12470: ownership is the DECLARED id alone — never the path or
    // a hash of it. The path fingerprint is recorded below only as an alias.
    const ownerId = declaredId;
    const ownershipFilter = eq(projectRegistry.projectId, ownerId);

    // The accessor may auto-register this path. Never carry an absence observation
    // across this await into the write transaction.
    const meta = await readProjectMeta(resolvedPath);
    if ((await readProjectId(resolvedPath)) !== declaredId) {
      throw new CleoError(
        ExitCode.NEXUS_PROJECT_EXISTS,
        `Project identity changed during registration: ${resolvedPath}`,
      );
    }
    const db = await getNexusDb();
    const now = new Date().toISOString();
    const legacyAlias = legacyProjectId(resolvedPath);
    const skippedAliases: string[] = [];
    const projectId = db.transaction(
      (tx) => {
        // Keyed by the primary key, so at most one row: no owner conflict exists.
        const existing = tx.select().from(projectRegistry).where(ownershipFilter).get();
        const immutableId = ownerId;
        const takenByOther = (candidate: string): boolean =>
          tx
            .select()
            .from(projectRegistry)
            .where(eq(projectRegistry.name, candidate))
            .all()
            .some((row) => row.projectId !== immutableId);
        // T12716: an explicit name; else the row's current label (a repeat
        // registration never silently relabels — `cleo doctor
        // project-identity` reports drift and `--resolve` syncs it); else, for
        // a new row, the committed `.cleo/project.json` name unless another
        // project on this device already holds it; else the basename.
        const projectName =
          name ||
          existing?.name ||
          (declaredName !== undefined && !takenByOther(declaredName) ? declaredName : '') ||
          basename(resolvedPath) ||
          'unnamed';
        if (takenByOther(projectName)) {
          throw new CleoError(
            ExitCode.VALIDATION_ERROR,
            `Project name '${projectName}' already exists in registry`,
          );
        }
        const metadata = {
          name: projectName,
          permissions: permissions ?? existing?.permissions ?? 'read',
          lastSync: now,
          taskCount: meta.taskCount,
          labelsJson: JSON.stringify(meta.labels),
          lastSeen: now,
          // The row names the checkout encountered most recently (T12469).
          projectPath: resolvedPath,
          projectHash,
          brainDbPath: registryStorePath(resolvedPath),
          tasksDbPath: registryStorePath(resolvedPath),
        };
        if (existing)
          tx.update(projectRegistry)
            .set(metadata)
            .where(eq(projectRegistry.projectId, immutableId))
            .run();
        else
          tx.insert(projectRegistry)
            .values({
              ...metadata,
              projectId: immutableId,
              registeredAt: now,
              healthStatus: 'unknown',
              statsJson: '{}',
            })
            .run();
        // T12354 · T12469: record this checkout as a live location.
        recordProjectCheckout(tx, {
          projectId: immutableId,
          projectPath: resolvedPath,
          projectHash,
          now,
          evidence,
          checkoutNonce: ensureCheckoutNonce(resolvedPath),
        });
        for (const alias of new Set([pathFingerprint.id, legacyAlias])) {
          if (alias === immutableId) continue;
          const aliasOwner = tx
            .select()
            .from(projectIdAliases)
            .where(eq(projectIdAliases.legacyId, alias))
            .get();
          // T12589: a legacy key shared by several projects names none of them;
          // it is not recorded again and is not a conflict worth reporting.
          if (
            alias === legacyAlias &&
            registryAliasClaimants(tx, alias, aliasOwner?.canonicalId).some(
              (id) => id !== immutableId,
            )
          )
            continue;
          const directOwner = tx
            .select()
            .from(projectRegistry)
            .where(eq(projectRegistry.projectId, alias))
            .get();
          if (
            (aliasOwner && aliasOwner.canonicalId !== immutableId) ||
            (directOwner && directOwner.projectId !== immutableId)
          ) {
            // Both aliases are derived from the PATH (base64url path, git-root
            // hash), so another owner means the path changed hands, not an
            // identity conflict (T12469). Preserve its owner and disclose the
            // omitted compatibility alias; never redirect another project.
            skippedAliases.push(alias);
            continue;
          }
          tx.insert(projectIdAliases)
            .values({ legacyId: alias, canonicalId: immutableId, createdAt: now })
            .onConflictDoNothing()
            .run();
        }
        return immutableId;
      },
      { behavior: 'immediate' },
    );
    if (skippedAliases.length)
      pushWarning({
        code: 'W_PROJECT_ALIAS_CONFLICT',
        message: 'Registration retained existing owners of ambiguous legacy path aliases.',
        severity: 'warn',
        context: { projectId, aliases: skippedAliases },
      });

    await writeNexusAudit({
      action: 'register',
      projectHash,
      projectId,
      operation: 'register',
      success: true,
    });

    return projectHash;
  });
}

/**
 * Unregister a project from the global registry.
 */
export async function nexusUnregister(
  _projectRoot: string,
  params: NexusUnregisterParams,
): Promise<void>;
/** @deprecated Use `nexusUnregister(projectRoot, params)` — ADR-057 D1 */
export async function nexusUnregister(nameOrHash: string): Promise<void>;
export async function nexusUnregister(
  projectRootOrNameOrHash: string,
  paramsOrUndefined?: NexusUnregisterParams,
): Promise<void> {
  const nameOrHash =
    paramsOrUndefined !== undefined ? paramsOrUndefined.name : projectRootOrNameOrHash;
  if (!nameOrHash) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'Project name or hash required');
  }

  const project = await nexusGetProject(nameOrHash);
  if (!project) {
    throw new CleoError(ExitCode.NOT_FOUND, `Project not found in registry: ${nameOrHash}`);
  }

  const { getNexusDb } = await import('../store/nexus-sqlite.js');
  const { eq } = await import('drizzle-orm');
  const db = await getNexusDb();
  await db.delete(projectRegistry).where(eq(projectRegistry.projectId, project.projectId));
  // T12469: an explicitly unregistered project keeps no locations. (A vanished
  // directory is marked `missing` instead; only this owner action deletes.)
  await db.delete(projectLocations).where(eq(projectLocations.projectId, project.projectId));
  // T12511: its probed git state goes with it.
  await db.delete(projectGitState).where(eq(projectGitState.projectId, project.projectId));
  // Legacy path map, still dual-written for older binaries (T12469).
  await db.delete(projectPaths).where(eq(projectPaths.projectId, project.projectId));

  await writeNexusAudit({
    action: 'unregister',
    projectHash: project.hash,
    projectId: project.projectId,
    operation: 'unregister',
    success: true,
  });
}

/**
 * List all registered projects.
 *
 * @throws {NexusRegistryReadError} When the registry cannot be read — never
 *   an empty list that hides the failure (T12512).
 */
export async function nexusList(
  _projectRoot = '',
  _params: NexusListParams = {},
): Promise<NexusProject[]> {
  let rows: ProjectRegistryRow[];
  try {
    rows = await withLiveNexusDb((db) => db.select().from(projectRegistry));
  } catch (error) {
    throw toRegistryReadError('list projects', error);
  }
  return rows.map(rowToProject);
}

/**
 * A project NAME matched more than one registry row (T12510). Names are not
 * unique — two checkouts or two unrelated projects can share one — so the
 * lookup refuses to pick one and lists every candidate id instead.
 *
 * @example
 * ```ts
 * try { await nexusGetProject('', { name: 'api' }); }
 * catch (e) { if (e instanceof NexusProjectAmbiguityError) console.error(e.candidates); }
 * ```
 */
export class NexusProjectAmbiguityError extends CleoError {
  /** Stable machine-readable error code. */
  readonly codeName = 'E_NEXUS_PROJECT_AMBIGUOUS';
  /** Every matching project, most recently active first (`projectLastActivity`). */
  readonly candidates: NexusProjectCandidate[];

  /**
   * @param name - The ambiguous project name, or alias key (T12589).
   * @param rows - Every registry row that matches it.
   * @param field - What `name` is: a project name, or an alias key that more
   *   than one project claims.
   */
  constructor(
    name: string,
    rows: ReadonlyArray<ProjectRegistryRow>,
    field: 'name' | 'alias' = 'name',
  ) {
    const candidates = rows.map((r) => ({
      projectId: r.projectId,
      name: r.name,
      path: r.projectPath,
      lastSeen: r.lastSeen,
    }));
    super(
      ExitCode.INVALID_INPUT,
      `${field === 'name' ? 'Project name' : 'Legacy project alias'} '${name}' is ambiguous: ${candidates.length} projects match (${candidates
        .map((c) => c.projectId)
        .join(', ')}). Use a project id.`,
      {
        fix: `Pass one of the candidate project ids instead of the ${field}.`,
        details: {
          field,
          expected: 'a unique project name, id or hash',
          actual: name,
          candidates,
        },
      },
    );
    this.name = 'NexusProjectAmbiguityError';
    this.candidates = candidates;
  }
}

/**
 * Look up a portable project id or an unambiguous recorded legacy alias.
 * Names and path hashes are not project ids and are not accepted here.
 *
 * @param projectRoot - Calling checkout (consistent with the registry API).
 * @param projectId - Portable id, or a recorded alias retained for compatibility.
 * @returns The registered project, or null when the id is not registered.
 * @throws {NexusProjectAmbiguityError} When several projects claim an alias.
 * @throws {NexusRegistryReadError} When registry access fails.
 */
export async function nexusGetProjectById(
  _projectRoot: string,
  projectId: string,
): Promise<NexusProject | null> {
  try {
    const row = await withLiveNexusDb(async (db) => {
      const exact = db
        .select()
        .from(projectRegistry)
        .where(eq(projectRegistry.projectId, projectId))
        .get();
      if (exact) return exact;
      const alias = resolveProjectAlias(db, projectId);
      if (alias.status === 'none') return null;
      if (alias.status === 'ambiguous') {
        const claimants = db
          .select()
          .from(projectRegistry)
          .where(inArray(projectRegistry.projectId, [...alias.claimants]))
          .all();
        // @sync-invariant none:local-only ambiguous query selectors cannot select a local registry project
        throw new NexusProjectAmbiguityError(projectId, claimants, 'alias');
      }
      const canonical = db
        .select()
        .from(projectRegistry)
        .where(eq(projectRegistry.projectId, alias.canonicalId))
        .get();
      if (canonical) {
        pushWarning({
          // @sync-invariant none:local-only a successful legacy query resolution emits an advisory, not a synced write rejection
          code: 'W_NEXUS_LEGACY_PROJECT_ID',
          severity: 'warn',
          message: `Project alias '${projectId}' is deprecated; use '${canonical.projectId}'.`,
          context: { alias: projectId, projectId: canonical.projectId },
        });
      }
      return canonical ?? null;
    });
    return row ? rowToProject(row) : null;
  } catch (error) {
    // @sync-invariant none:local-only a registry query failure remains a typed read error, never an empty result
    throw toRegistryReadError('get project by id', error);
  }
}

/**
 * Bind a project-scoped graph query to its checkout's portable identity.
 * An override may name that identity or its unique legacy alias, never another
 * project: the graph store cannot be selected by relabeling its counts.
 *
 * @param projectRoot - Checkout whose project-scoped graph will be queried.
 * @param requestedId - Optional explicit portable id or recorded legacy alias.
 * @returns The current checkout's canonical id.
 * @throws {CleoError} On missing identity or a foreign/unresolved override.
 */
export async function resolveNexusQueryProjectId(
  projectRoot: string,
  requestedId?: string,
): Promise<string> {
  const projectId = requireNexusProjectId(projectRoot);
  if (requestedId === undefined || requestedId === projectId) return projectId;
  const registered = await nexusGetProjectById(projectRoot, requestedId);
  if (registered?.projectId === projectId) return projectId;
  // @sync-invariant none:local-only a foreign query id cannot relabel the current project graph; no synced write occurs
  throw new CleoError(
    ExitCode.INVALID_INPUT,
    `Project '${requestedId}' cannot select the graph for '${projectId}' at ${projectRoot}.`,
    { fix: 'Run the query from the intended project, using its portable project id.' },
  );
}

/**
 * Get a project by name or hash.
 * Returns null if not found.
 */
export async function nexusGetProject(
  _projectRoot: string,
  params: NexusShowParams,
): Promise<NexusProject | null>;
/** @deprecated Use `nexusGetProject(projectRoot, params)` — ADR-057 D1 */
export async function nexusGetProject(nameOrHash: string): Promise<NexusProject | null>;
export async function nexusGetProject(
  projectRootOrNameOrHash: string,
  paramsOrUndefined?: NexusShowParams,
): Promise<NexusProject | null> {
  const nameOrHash =
    paramsOrUndefined !== undefined ? paramsOrUndefined.name : projectRootOrNameOrHash;
  try {
    const { eq } = await import('drizzle-orm');
    // ADR-090 · T11648: run on a LIVE handle with retry — the registry lives in
    // the GLOBAL ATTACH of the shared project handle, which a concurrent
    // cross-project open can close mid-query.
    const row = await withLiveNexusDb(async (db) => {
      // T12469: the immutable id is the key, so it wins; a path hash is not
      // unique, so among hash/name matches the most recently active row wins
      // (max of last_seen/last_opened_at/last_probed_at, T12512).
      let rows = await db
        .select()
        .from(projectRegistry)
        .where(eq(projectRegistry.projectId, nameOrHash));
      if (rows.length === 0) {
        rows = await db
          .select()
          .from(projectRegistry)
          .where(eq(projectRegistry.projectHash, nameOrHash))
          .orderBy(desc(projectLastActivitySql));
      }
      if (rows.length === 0) {
        // T12510: a name is not unique. One match resolves; several are
        // ambiguous and the caller must choose by id — never rows[0].
        rows = await db
          .select()
          .from(projectRegistry)
          .where(eq(projectRegistry.name, nameOrHash))
          .orderBy(desc(projectLastActivitySql));
        if (rows.length > 1) throw new NexusProjectAmbiguityError(nameOrHash, rows);
      }
      if (rows.length === 0) {
        // Try alias resolution: legacyId → canonicalId lookup (T11025). An
        // alias several projects claim is refused, never rows[0] (T12589).
        const alias = resolveProjectAlias(db, nameOrHash);
        if (alias.status === 'ambiguous') {
          const claimed = await db
            .select()
            .from(projectRegistry)
            .where(inArray(projectRegistry.projectId, [...alias.claimants]))
            .orderBy(desc(projectLastActivitySql));
          throw new NexusProjectAmbiguityError(nameOrHash, claimed, 'alias');
        }
        if (alias.status === 'resolved') {
          rows = await db
            .select()
            .from(projectRegistry)
            .where(eq(projectRegistry.projectId, alias.canonicalId));
        }
      }
      return rows[0] ?? null;
    });

    if (!row) return null;
    return rowToProject(row);
  } catch (error) {
    // T12512: `null` means "no such project", never "could not read".
    throw toRegistryReadError('get project', error);
  }
}

/**
 * Check if a project exists in the registry.
 */
export async function nexusProjectExists(nameOrHash: string): Promise<boolean> {
  const project = await nexusGetProject(nameOrHash);
  return project !== null;
}

/**
 * Sync project metadata (task count, labels) for a registered project.
 */
export async function nexusSync(_projectRoot: string, params: NexusSyncParams): Promise<void>;
/** @deprecated Use `nexusSync(projectRoot, params)` — ADR-057 D1 */
export async function nexusSync(nameOrHash: string): Promise<void>;
export async function nexusSync(
  projectRootOrName: string,
  paramsOrUndefined?: NexusSyncParams,
): Promise<void> {
  const nameOrHash =
    paramsOrUndefined !== undefined ? (paramsOrUndefined.name ?? '') : projectRootOrName;
  if (!nameOrHash) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'Project name or hash required');
  }

  const project = await nexusGetProject(nameOrHash);
  if (!project) {
    throw new CleoError(ExitCode.NOT_FOUND, `Project not found in registry: ${nameOrHash}`);
  }

  const meta = await readProjectMeta(project.path);
  const now = new Date().toISOString();
  const { getNexusDb } = await import('../store/nexus-sqlite.js');
  const { eq } = await import('drizzle-orm');
  const db = await getNexusDb();

  await db
    .update(projectRegistry)
    .set({
      taskCount: meta.taskCount,
      labelsJson: JSON.stringify(meta.labels),
      lastSync: now,
      // T12512: a sync probes the project; it is not evidence of use.
      lastProbedAt: now,
    })
    .where(eq(projectRegistry.projectId, project.projectId));

  await writeNexusAudit({
    action: 'sync',
    projectHash: project.hash,
    projectId: project.projectId,
    operation: 'sync',
    success: true,
  });
}

/**
 * Sync all registered projects. A project that lives on another machine (a
 * cloud vault placeholder row) is skipped: it has no store here (T13006).
 * @returns Counts of synced and failed projects.
 */
export async function nexusSyncAll(): Promise<{ synced: number; failed: number }> {
  const projects = await nexusList();
  let synced = 0;
  let failed = 0;
  const { getNexusDb } = await import('../store/nexus-sqlite.js');
  const { eq } = await import('drizzle-orm');

  for (const project of projects) {
    // T13006: another machine's project has no store here to sync from.
    if (project.remote) continue;
    try {
      // readProjectMeta opens the TARGET project's own `cleo.db` (a different
      // project than the open nexus handle). Under the ADR-090 · T11648 residency
      // split the nexus runtime handle is the PROJECT-scope `cleo.db` (graph home)
      // with the GLOBAL registry ATTACHed; opening another project's `cleo.db`
      // can churn the shared dual-scope project cache and close our nexus handle.
      // Re-acquire `getNexusDb()` AFTER readProjectMeta so the registry UPDATE
      // always runs against a live handle (the liveness guard re-opens + re-attaches).
      const meta = await readProjectMeta(project.path);
      const db = await getNexusDb();
      const now = new Date().toISOString();
      await db
        .update(projectRegistry)
        .set({
          taskCount: meta.taskCount,
          labelsJson: JSON.stringify(meta.labels),
          lastSync: now,
          lastProbedAt: now,
        })
        .where(eq(projectRegistry.projectId, project.projectId));
      synced++;
    } catch {
      failed++;
    }
  }

  await writeNexusAudit({
    action: 'sync-all',
    operation: 'sync-all',
    success: true,
    details: { synced, failed },
  });

  return { synced, failed };
}

/**
 * Update code intelligence index stats for a registered project.
 *
 * Called after a successful `cleo nexus analyze` run to record the
 * latest node/relation/file counts and the indexed timestamp.
 *
 * @param projectPath - Absolute path to the project root.
 * @param stats       - Results from the pipeline run.
 * @task T622
 */
export async function nexusUpdateIndexStats(
  projectPath: string,
  stats: NexusProjectStats,
): Promise<void> {
  if (!projectPath) return;

  const projectHash = generateProjectHash(projectPath);
  const now = new Date().toISOString();

  try {
    const { getNexusDb } = await import('../store/nexus-sqlite.js');
    const { eq } = await import('drizzle-orm');
    const db = await getNexusDb();

    // T12469: a path hash is not unique; the most recently active row for this
    // checkout is the one being indexed, and it is updated by its id.
    const ownerAt = async () =>
      (
        await db
          .select({ projectId: projectRegistry.projectId })
          .from(projectRegistry)
          .where(eq(projectRegistry.projectHash, projectHash))
          .orderBy(desc(projectLastActivitySql))
          .limit(1)
      )[0];
    let owner = await ownerAt();

    if (!owner) {
      // Not yet registered — record the encounter (best effort). T12470: never
      // `nexusRegister` here: analyze is not an explicit registration, so it
      // must neither mint/write `.cleo/project-id` nor repoint an existing
      // project's row to this path. The encounter records an unconfirmed
      // checkout as a candidate, which owns no row and gets no stats.
      try {
        const { recordProjectEncounter } = await import('../paths.js');
        await recordProjectEncounter(projectPath);
      } catch {
        // Cannot record — ignore; stats are best effort.
      }
      owner = await ownerAt();
    }

    if (owner)
      await db
        .update(projectRegistry)
        .set({
          lastIndexed: now,
          statsJson: JSON.stringify(stats),
          lastSeen: now,
        })
        .where(eq(projectRegistry.projectId, owner.projectId));

    await writeNexusAudit({
      action: 'update-index-stats',
      projectHash,
      operation: 'update-index-stats',
      success: true,
      details: {
        nodeCount: stats.nodeCount,
        relationCount: stats.relationCount,
        fileCount: stats.fileCount,
      },
    });
  } catch (err) {
    // Non-fatal — index stats update must never break the analyze pipeline
    getLogger('nexus').warn({ err }, 'nexus: failed to update index stats');
  }
}

/**
 * Update a project's permission level in the registry.
 * Used by permissions.ts to avoid direct JSON file writes.
 */
export async function nexusSetPermission(
  _projectRoot: string,
  params: NexusPermissionSetParams,
): Promise<void>;
/** @deprecated Use `nexusSetPermission(projectRoot, params)` — ADR-057 D1 */
export async function nexusSetPermission(
  nameOrHash: string,
  permission: NexusPermissionLevel,
): Promise<void>;
export async function nexusSetPermission(
  projectRoot: string,
  params: NexusPermissionSetParams | NexusPermissionLevel,
): Promise<void> {
  // ADR-057 D1 enforces uniform `(projectRoot, params)` shape. The second
  // overload at line 712 preserves the legacy `(name, level)` call sites
  // until they migrate; the runtime branch below dispatches by type.
  let nameOrHash: string;
  let permission: NexusPermissionLevel;
  if (params !== undefined && typeof params === 'object') {
    nameOrHash = params.name;
    permission = params.level as NexusPermissionLevel;
  } else {
    // Legacy call form: `nexusSetPermission(nameOrHash, level)` —
    // `projectRoot` is actually the name/hash here.
    nameOrHash = projectRoot;
    permission = (params as NexusPermissionLevel | undefined) ?? 'read';
  }
  const project = await nexusGetProject(nameOrHash);
  if (!project) {
    throw new CleoError(ExitCode.NOT_FOUND, `Project not found in registry: ${nameOrHash}`);
  }

  const { getNexusDb } = await import('../store/nexus-sqlite.js');
  const { eq } = await import('drizzle-orm');
  const db = await getNexusDb();
  await db
    .update(projectRegistry)
    .set({ permissions: permission })
    .where(eq(projectRegistry.projectId, project.projectId));

  await writeNexusAudit({
    action: 'set-permission',
    projectHash: project.hash,
    projectId: project.projectId,
    operation: 'set-permission',
    success: true,
    details: { permission },
  });
}

/**
 * Reconcile the current project's identity with the global nexus registry.
 *
 * 3-scenario policy, keyed by the immutable project id alone (ADR-094 · T12469):
 *   1. projectId in registry + path matches → update lastSeen, return {status:'ok'}
 *   2. projectId in registry + path changed → update path+hash, return {status:'path_updated'}
 *   3. projectId not in registry → auto-register, return {status:'auto_registered'}
 *
 * The former scenario 4 (a row at this path hash under another id → identity
 * conflict) is gone: a path is a location, not an identity. That row is a
 * stale location of another project, recorded as `superseded` in
 * `nexus_project_locations` when this project is recorded.
 *
 * @task T5368
 */
export async function nexusReconcile(
  projectRoot: string,
  params: NexusReconcileParams = {},
): Promise<{
  status: 'ok' | 'path_updated' | 'auto_registered' | 'candidate';
  oldPath?: string;
  newPath?: string;
}> {
  if (!projectRoot) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'Project root path required');
  }

  await nexusInit();
  const { getNexusDb } = await import('../store/nexus-sqlite.js');
  const { eq } = await import('drizzle-orm');
  const db = await getNexusDb();

  // T12470: reconcile never mints or writes an identity — that is `cleo init`
  // / `cleo nexus register` / `cleo doctor project-identity --resolve`.
  const projectId = await readProjectId(projectRoot);
  if (!projectId)
    throw new CleoError(
      ExitCode.CONFIG_ERROR,
      `Project at ${projectRoot} declares no identity (.cleo/project-id or project-info.json projectId); refusing to derive one from its path`,
      { fix: `Run \`cleo init\` in ${projectRoot} to record the project's identity` },
    );
  const currentHash = generateProjectHash(projectRoot);
  const pathFingerprint = await projectPathFingerprint(projectRoot);
  const evidence = await collectCheckoutEvidence(projectRoot);
  // T12470: the declared id alone; the path fingerprint is an alias only.
  const stableProjectId = projectId;

  // Look up by the immutable id (stable across moves). T12469: the path and
  // its hash are never consulted — a row at this path under another id is a
  // stale location of another project, superseded when this one is recorded.
  const idRows = await db
    .select()
    .from(projectRegistry)
    .where(eq(projectRegistry.projectId, stableProjectId));
  const existing = idRows[0];

  if (existing) {
    const now = new Date().toISOString();

    if (existing.projectPath === projectRoot) {
      // Scenario 1: path matches — just update lastSeen
      await db
        .update(projectRegistry)
        .set({ lastSeen: now })
        .where(eq(projectRegistry.projectId, stableProjectId));
      recordProjectCheckout(db, {
        projectId: stableProjectId,
        projectPath: projectRoot,
        projectHash: currentHash,
        now,
        evidence,
        checkoutNonce: ensureCheckoutNonce(projectRoot),
      });
      await writeNexusAudit({
        action: 'reconcile',
        projectHash: currentHash,
        projectId: stableProjectId,
        operation: 'reconcile',
        success: true,
        details: { status: 'ok' },
      });
      await recordProjectIdAliases(
        stableProjectId,
        [stableProjectId, pathFingerprint.id, legacyProjectId(projectRoot)],
        now,
      );
      return { status: 'ok' };
    }

    // Scenario 2: path changed — update path, hash, lastSeen, and DB paths
    const oldPath = existing.projectPath;
    // T12470: even an explicit reconcile never takes the row (and its
    // permissions) away from a location that still exists on this device —
    // that is a second checkout or a clone, not a move. It is recorded as a
    // candidate unless the caller explicitly asks to rebind.
    if (!params.forceRebind && !isSupersededRegistryPath(oldPath) && existsSync(oldPath)) {
      recordCandidateLocation(db, {
        projectId: stableProjectId,
        projectPath: projectRoot,
        projectHash: currentHash,
        now,
        evidence,
      });
      await writeNexusAudit({
        action: 'reconcile',
        projectHash: currentHash,
        projectId: stableProjectId,
        operation: 'reconcile',
        success: true,
        details: { status: 'candidate', oldPath, newPath: projectRoot },
      });
      return { status: 'candidate', oldPath, newPath: projectRoot };
    }
    const newBrainDbPath = registryStorePath(projectRoot);
    const newTasksDbPath = registryStorePath(projectRoot);
    await db
      .update(projectRegistry)
      .set({
        projectPath: projectRoot,
        projectHash: currentHash,
        lastSeen: now,
        brainDbPath: newBrainDbPath,
        tasksDbPath: newTasksDbPath,
      })
      .where(eq(projectRegistry.projectId, stableProjectId));
    recordProjectCheckout(db, {
      projectId: stableProjectId,
      projectPath: projectRoot,
      projectHash: currentHash,
      now,
      evidence,
      checkoutNonce: ensureCheckoutNonce(projectRoot),
    });
    await writeNexusAudit({
      action: 'reconcile',
      projectHash: currentHash,
      projectId: stableProjectId,
      operation: 'reconcile',
      success: true,
      details: { status: 'path_updated', oldPath, newPath: projectRoot },
    });
    await recordProjectIdAliases(
      stableProjectId,
      [stableProjectId, pathFingerprint.id, legacyProjectId(projectRoot)],
      now,
    );
    return { status: 'path_updated', oldPath, newPath: projectRoot };
  }

  // Scenario 3: not in registry — auto-register
  try {
    await nexusRegister(projectRoot);
  } catch (err) {
    const errStr = String(err);
    if (!errStr.includes('already registered') && !errStr.includes('NEXUS_PROJECT_EXISTS')) {
      throw err;
    }
  }
  await writeNexusAudit({
    action: 'reconcile',
    projectHash: currentHash,
    projectId: projectId || undefined,
    operation: 'reconcile',
    success: true,
    details: { status: 'auto_registered' },
  });
  return { status: 'auto_registered' };
}

/**
 * Update a project's registry entry after a filesystem move. @task T11024
 */
export async function nexusMoveProject(projectId: string, newPath: string): Promise<NexusProject> {
  if (!projectId) throw new CleoError(ExitCode.INVALID_INPUT, 'projectId required');
  if (!newPath) throw new CleoError(ExitCode.INVALID_INPUT, 'newPath required');
  await nexusInit();
  const { getNexusDb } = await import('../store/nexus-sqlite.js');
  const { eq } = await import('drizzle-orm');
  const db = await getNexusDb();
  const rows = await db
    .select()
    .from(projectRegistry)
    .where(eq(projectRegistry.projectId, projectId))
    .limit(1);
  const existing = rows[0];
  if (!existing) throw new CleoError(ExitCode.NOT_FOUND, `Project not found: ${projectId}`);
  const resolvedPath = resolve(newPath);
  const newHash = generateProjectHash(resolvedPath);
  const now = new Date().toISOString();
  const newBrainDbPath = registryStorePath(resolvedPath);
  const newTasksDbPath = registryStorePath(resolvedPath);
  const oldPath = existing.projectPath;
  await db
    .update(projectRegistry)
    .set({
      projectPath: resolvedPath,
      projectHash: newHash,
      lastSeen: now,
      brainDbPath: newBrainDbPath,
      tasksDbPath: newTasksDbPath,
    })
    .where(eq(projectRegistry.projectId, projectId));
  // Record the location (and re-home any row displaced from the new path)
  // immediately, so two rows never share a path (T12469).
  recordProjectCheckout(db, { projectId, projectPath: resolvedPath, projectHash: newHash, now });
  await writeNexusAudit({
    action: 'move',
    projectHash: newHash,
    projectId,
    operation: 'move',
    success: true,
    details: { oldPath, newPath: resolvedPath, newHash },
  });
  await nexusReconcile(resolvedPath, {});
  return rowToProject({
    ...existing,
    projectPath: resolvedPath,
    projectHash: newHash,
    lastSeen: now,
    brainDbPath: newBrainDbPath,
    tasksDbPath: newTasksDbPath,
  });
}

/**
 * Update a project's name in the registry after a rename. @task T11024
 */
export async function nexusRenameProject(
  projectId: string,
  newName: string,
): Promise<NexusProject> {
  if (!projectId) throw new CleoError(ExitCode.INVALID_INPUT, 'projectId required');
  if (!newName) throw new CleoError(ExitCode.INVALID_INPUT, 'newName required');
  await nexusInit();
  const { getNexusDb } = await import('../store/nexus-sqlite.js');
  const { eq } = await import('drizzle-orm');
  const db = await getNexusDb();
  const rows = await db
    .select()
    .from(projectRegistry)
    .where(eq(projectRegistry.projectId, projectId))
    .limit(1);
  const existing = rows[0];
  if (!existing) throw new CleoError(ExitCode.NOT_FOUND, `Project not found: ${projectId}`);
  const now = new Date().toISOString();
  const currentHash = generateProjectHash(existing.projectPath);
  const oldName = existing.name;
  await db
    .update(projectRegistry)
    .set({ name: newName, lastSeen: now })
    .where(eq(projectRegistry.projectId, projectId));
  // Record self-alias for dispatch-layer consumer compatibility (T11025)
  await db
    .insert(projectIdAliases)
    .values({ legacyId: projectId, canonicalId: projectId, createdAt: now })
    .onConflictDoNothing();
  await writeNexusAudit({
    action: 'rename',
    projectHash: currentHash,
    projectId,
    operation: 'rename',
    success: true,
    details: { oldName, newName },
  });
  return rowToProject({ ...existing, name: newName, lastSeen: now });
}

/**
 * Reset the nexus database singleton state.
 * Re-exported from nexus-sqlite for test convenience.
 */
export { resetNexusDbState };

// ---------------------------------------------------------------------------
// EngineResult-returning wrappers (T1569 / ADR-057 / ADR-058)
// ---------------------------------------------------------------------------

/**
 * Convert a caught error to an EngineResult failure, keeping the code, exit
 * code, fix and details of a typed registry error (`E_NEXUS_REGISTRY_READ`,
 * `E_NEXUS_DEVICE_NOT_FOUND`, `E_NEXUS_PROJECT_AMBIGUOUS`, `E_PROJECT_MOVED`)
 * instead of collapsing it to `E_INTERNAL` (T12512). Every nexus engine
 * wrapper that reads the registry uses this.
 *
 * @param error - The caught value.
 * @param fallbackMsg - Message used when `error` is not an `Error`.
 * @returns A failed EngineResult.
 * @example
 * ```ts
 * try { return engineSuccess(await nexusList()); }
 * catch (error) { return nexusCaughtToEngineError(error, 'Failed to list projects'); }
 * ```
 * @task T12512
 */
export function nexusCaughtToEngineError<T>(error: unknown, fallbackMsg: string): EngineResult<T> {
  if (
    error instanceof NexusProjectAmbiguityError ||
    error instanceof NexusRegistryReadError ||
    error instanceof NexusDeviceNotFoundError
  ) {
    return engineError<T>(error.codeName, error.message, {
      exitCode: error.code,
      details: error.details,
      fix: error.fix,
    });
  }
  // T12558: a refusal at a relocated root keeps its typed code, exit class,
  // fix and details (`movedTo`) instead of collapsing to E_INTERNAL.
  if (error instanceof CleoError && error.code === ExitCode.PROJECT_MOVED) {
    return engineError<T>('E_PROJECT_MOVED', error.message, {
      exitCode: error.code,
      details: error.details,
      fix: error.fix,
    });
  }
  const e = error instanceof Error ? error : null;
  return engineError<T>('E_INTERNAL', e?.message ?? fallbackMsg);
}

/**
 * Get nexus status (initialized, project count, last updated).
 *
 * @task T1569
 */
// SSoT-EXEMPT:engine-migration-T1569
export async function nexusStatus(): Promise<
  EngineResult<{
    initialized: boolean;
    projectCount: number;
    lastUpdated: string | null;
  }>
> {
  try {
    // T12512: an unreadable registry is an error envelope, never "not initialized".
    const registry = await readRegistry();
    return engineSuccess({
      initialized: true,
      projectCount: Object.keys(registry.projects).length,
      lastUpdated: registry.lastUpdated,
    });
  } catch (error) {
    return nexusCaughtToEngineError(error, 'Failed to get nexus status');
  }
}

/**
 * List all registered projects with pagination.
 *
 * @task T1569
 */
// SSoT-EXEMPT:engine-migration-T1569
export async function nexusListProjects(
  limit?: number,
  offset?: number,
): Promise<
  EngineResult<{
    projects: Awaited<ReturnType<typeof nexusList>>;
    count: number;
    total: number;
    filtered: number;
    page: ReturnType<typeof paginate>['page'];
  }>
> {
  try {
    const projects = await nexusList('', {});
    const page = paginate(projects, limit, offset);
    return {
      success: true,
      data: {
        projects: page.items as Awaited<ReturnType<typeof nexusList>>,
        count: projects.length,
        total: projects.length,
        filtered: projects.length,
        page: page.page,
      },
      page: page.page,
    };
  } catch (error) {
    return nexusCaughtToEngineError(error, 'Failed to list projects');
  }
}

/**
 * Show a single project by name.
 *
 * @task T1569
 */
// SSoT-EXEMPT:engine-migration-T1569
export async function nexusShowProject(
  name: string,
): Promise<EngineResult<Awaited<ReturnType<typeof nexusGetProject>>>> {
  try {
    const project = await nexusGetProject('', { name });
    if (!project) {
      return engineError('E_NOT_FOUND', `Project not found: ${name}`);
    }
    return engineSuccess(project);
  } catch (error) {
    return nexusCaughtToEngineError(error, `Failed to show project: ${name}`);
  }
}

/**
 * Initialize the nexus.
 *
 * @task T1569
 */
// SSoT-EXEMPT:engine-migration-T1569
export async function nexusInitialize(): Promise<EngineResult<{ message: string }>> {
  try {
    await nexusInit('', {});
    return engineSuccess({ message: 'NEXUS initialized successfully' });
  } catch (error) {
    return nexusCaughtToEngineError(error, 'Failed to initialize nexus');
  }
}

/**
 * Register a project in the nexus.
 *
 * @task T1569
 */
// SSoT-EXEMPT:engine-migration-T1569
export async function nexusRegisterProject(
  path: string,
  name?: string,
  permission: NexusPermissionLevel = 'read',
): Promise<EngineResult<{ hash: string; message: string }>> {
  try {
    const hash = await nexusRegister('', { path, name, permission });
    return engineSuccess({ hash, message: `Project registered with hash: ${hash}` });
  } catch (error) {
    return nexusCaughtToEngineError(error, `Failed to register project: ${path}`);
  }
}

/**
 * Unregister a project from the nexus.
 *
 * @task T1569
 */
// SSoT-EXEMPT:engine-migration-T1569
export async function nexusUnregisterProject(
  name: string,
): Promise<EngineResult<{ message: string }>> {
  try {
    await nexusUnregister('', { name });
    return engineSuccess({ message: `Project unregistered: ${name}` });
  } catch (error) {
    return nexusCaughtToEngineError(error, `Failed to unregister project: ${name}`);
  }
}

/**
 * Sync a specific project or all projects.
 *
 * @task T1569
 */
// SSoT-EXEMPT:engine-migration-T1569
export async function nexusSyncProject(name?: string): Promise<EngineResult<unknown>> {
  try {
    if (name) {
      await nexusSync('', { name });
      return engineSuccess({ message: `Project synced: ${name}` });
    }
    const result = await nexusSyncAll();
    return engineSuccess(result);
  } catch (error) {
    return nexusCaughtToEngineError(error, 'Failed to sync project');
  }
}

/**
 * Reconcile the nexus registry with the filesystem.
 *
 * @task T1569
 */
// SSoT-EXEMPT:engine-migration-T1569
export async function nexusReconcileProject(
  projectRoot: string,
  params: NexusReconcileParams = {},
): Promise<EngineResult<Awaited<ReturnType<typeof nexusReconcile>>>> {
  try {
    const result = await nexusReconcile(projectRoot, params);
    return engineSuccess(result);
  } catch (error) {
    return nexusCaughtToEngineError(error, `Failed to reconcile project: ${projectRoot}`);
  }
}

/**
 * List all projects in the global nexus registry (Phase 2 dispatch op).
 *
 * @task T1569
 */
// SSoT-EXEMPT:engine-migration-T1569
export async function nexusProjectsList(): Promise<EngineResult<unknown>> {
  try {
    const list = await nexusList('', {});
    const { getNexusRegistryDb } = await import('../store/nexus-sqlite.js');
    const devices = listNexusDevices(await getNexusRegistryDb(getCleoHome()));
    return engineSuccess({ projects: list, count: list.length, devices });
  } catch (error) {
    return nexusCaughtToEngineError(error, 'Failed to list nexus projects');
  }
}

/**
 * Probe and record the git state of every project location on this device
 * (`nexus.projects.status`, T12511). Bounded concurrency, a per-location
 * timeout, no network unless `fetch` — see `nexus/git-state.ts`.
 *
 * @param _projectRoot - Unused: the probe covers every location on this device
 *   (uniform ADR-057 signature).
 * @param params - Fetch, concurrency, timeout and staleness.
 * @returns Fresh rows for this device plus recorded rows of other devices.
 * @task T12511
 */
export async function nexusProjectsStatus(
  _projectRoot: string,
  params: NexusProjectsStatusParams,
): Promise<EngineResult<NexusProjectsStatusResult>> {
  try {
    const { getNexusRegistryDb } = await import('../store/nexus-sqlite.js');
    const { runProjectsGitStatus } = await import('./git-state.js');
    let db: Awaited<ReturnType<typeof getNexusRegistryDb>>;
    try {
      db = await getNexusRegistryDb(getCleoHome());
    } catch (error) {
      throw toRegistryReadError('open project registry', error);
    }
    return engineSuccess(await runProjectsGitStatus(db, params));
  } catch (error) {
    return nexusCaughtToEngineError(error, 'Failed to probe project git state');
  }
}

/**
 * Fleet view (`nexus.projects.fleet`, T12513): every project, where it lives
 * on each device, and its last recorded git state, paged with counts first.
 * Read-only: it never runs git — see `nexus/fleet-status.ts`.
 *
 * @param _projectRoot - Unused: the fleet spans every registered project
 *   (uniform ADR-057 signature).
 * @param params - Filters, staleness window and paging.
 * @returns The fleet view, or a typed error (`E_NEXUS_REGISTRY_READ`,
 *   `E_NEXUS_DEVICE_NOT_FOUND`) — never an empty page that hides a failure.
 * @task T12513
 */
export async function nexusProjectsFleet(
  _projectRoot: string,
  params: NexusProjectsFleetParams,
): Promise<EngineResult<NexusProjectsFleetResult>> {
  const { getNexusRegistryDb } = await import('../store/nexus-sqlite.js');
  const { listFleetStatus } = await import('./fleet-status.js');
  try {
    return engineSuccess(listFleetStatus(await getNexusRegistryDb(getCleoHome()), params));
  } catch (error) {
    // A typed error (unknown device) passes through; anything else is a read failure.
    return nexusCaughtToEngineError(
      toRegistryReadError('read fleet status', error),
      'Failed to read fleet status',
    );
  }
}

/**
 * Register a project in the global nexus registry (Phase 2 dispatch op).
 *
 * @param repoPath - Absolute path to the project directory.
 * @param name     - Custom project name (optional).
 * @task T1569
 */
// SSoT-EXEMPT:engine-migration-T1569
export async function nexusProjectsRegister(
  repoPath: string,
  name?: string,
): Promise<EngineResult<{ hash: string; path: string }>> {
  try {
    const hash = await nexusRegister(repoPath, name);
    return engineSuccess({ hash, path: repoPath });
  } catch (error) {
    return nexusCaughtToEngineError(error, `Failed to register project: ${repoPath}`);
  }
}

/**
 * Remove a project from the global nexus registry by name or hash (Phase 2 dispatch op).
 *
 * @param nameOrHash - Project name or hash to remove.
 * @task T1569
 */
// SSoT-EXEMPT:engine-migration-T1569
export async function nexusProjectsRemove(
  nameOrHash: string,
): Promise<EngineResult<{ removed: string }>> {
  try {
    await nexusUnregister(nameOrHash);
    return engineSuccess({ removed: nameOrHash });
  } catch (error) {
    return nexusCaughtToEngineError(error, `Failed to remove project: ${nameOrHash}`);
  }
}
