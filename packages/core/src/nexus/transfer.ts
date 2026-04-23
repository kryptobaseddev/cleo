/**
 * Cross-project task transfer engine for NEXUS.
 *
 * Provides executeTransfer() and previewTransfer() for moving/copying
 * tasks between registered NEXUS projects with full provenance tracking.
 *
 * Also provides importUserProfile() and exportUserProfile() for portable
 * user-profile JSON exchange (PSYCHE Wave 1 — T1079).
 *
 * @task T046, T049, T050, T051, T052, T053
 * @task T1079
 * @epic T4540
 * @epic T1076
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { UserProfileTrait } from '@cleocode/contracts';
import { importFromPackage } from '../admin/import-tasks.js';
import { getLogger } from '../logger.js';
import { createLink } from '../reconciliation/link-store.js';
import { getAccessor } from '../store/data-accessor.js';
import { exportSingle, exportSubtree } from '../store/export.js';
import { BrainDataAccessor } from '../store/memory-accessor.js';
import { getBrainDb } from '../store/memory-sqlite.js';
import { getNexusDb } from '../store/nexus-sqlite.js';
import { requirePermission } from './permissions.js';
import { nexusGetProject } from './registry.js';
import type {
  TransferManifest,
  TransferManifestEntry,
  TransferParams,
  TransferResult,
} from './transfer-types.js';
import {
  getUserProfileTrait,
  listUserProfile,
  supersedeTrait,
  upsertUserProfileTrait,
} from './user-profile.js';

const log = getLogger('nexus:transfer');

// ---------------------------------------------------------------------------
// User-profile portable JSON schema
// ---------------------------------------------------------------------------

/**
 * JSON envelope for portable user-profile exports.
 *
 * Written to `~/.cleo/user_profile.json` by default.  The `$schema` field
 * is advisory — no runtime validation is performed against it.
 */
interface UserProfileJson {
  /** Advisory JSON Schema URL. */
  $schema: 'https://cleocode.dev/schemas/user-profile/v1.json';
  /** ISO 8601 timestamp when this file was exported. */
  exportedAt: string;
  /** All non-superseded traits at export time. */
  traits: UserProfileTrait[];
}

/** Default path for the portable user-profile JSON file. */
export function getDefaultUserProfilePath(): string {
  const cleoHome = process.env['CLEO_HOME'] ?? `${homedir()}/.local/share/cleo`;
  return resolve(cleoHome, 'user_profile.json');
}

// ---------------------------------------------------------------------------
// T1079 — importUserProfile
// ---------------------------------------------------------------------------

/**
 * Result of importing a user-profile JSON file.
 */
export interface ImportUserProfileResult {
  /** Number of traits successfully upserted. */
  imported: number;
  /** Number of traits skipped (incoming had lower confidence). */
  skipped: number;
  /** Number of traits where the incoming entry superseded the existing one. */
  superseded: number;
}

/**
 * Import a portable user-profile JSON file into nexus.db.
 *
 * Conflict resolution per PLAN.md §T1079:
 *   - Higher confidence wins.
 *   - On equal confidence, more-recent `lastReinforcedAt` wins.
 *   - The loser is linked to the winner via `supersedeTrait` (T1139 prep).
 *
 * @param path - Absolute path to the JSON file.  Defaults to
 *               `~/.cleo/user_profile.json` (via `getDefaultUserProfilePath()`).
 * @returns Import result counts.
 */
export async function importUserProfile(path?: string): Promise<ImportUserProfileResult> {
  const filePath = path ?? getDefaultUserProfilePath();
  const raw = await readFile(filePath, 'utf8');
  const json = JSON.parse(raw) as Partial<UserProfileJson>;

  const traits: UserProfileTrait[] = Array.isArray(json.traits) ? json.traits : [];

  const nexusDb = await getNexusDb();

  let imported = 0;
  let skipped = 0;
  let superseded = 0;

  for (const incoming of traits) {
    if (!incoming.traitKey || !incoming.traitValue) continue;

    const existing = await getUserProfileTrait(nexusDb, incoming.traitKey);

    if (!existing) {
      // Brand-new trait — upsert directly.
      await upsertUserProfileTrait(nexusDb, {
        ...incoming,
        source: incoming.source || 'import:user_profile.json',
        firstObservedAt: incoming.firstObservedAt || new Date().toISOString(),
        lastReinforcedAt: incoming.lastReinforcedAt || new Date().toISOString(),
        reinforcementCount: incoming.reinforcementCount ?? 1,
        supersededBy: null,
        derivedFromMessageId: incoming.derivedFromMessageId ?? null,
      });
      imported++;
      continue;
    }

    // Conflict resolution: higher confidence wins; tiebreak on recency.
    const existingDate = new Date(existing.lastReinforcedAt).getTime();
    const incomingDate = new Date(incoming.lastReinforcedAt || 0).getTime();

    const incomingWins =
      incoming.confidence > existing.confidence ||
      (incoming.confidence === existing.confidence && incomingDate > existingDate);

    if (incomingWins) {
      // Mark existing as superseded by incoming key (same key — self-supersede
      // means the imported data replaces the local data).
      await supersedeTrait(nexusDb, existing.traitKey, incoming.traitKey);
      await upsertUserProfileTrait(nexusDb, {
        ...incoming,
        source: incoming.source || 'import:user_profile.json',
        firstObservedAt: existing.firstObservedAt, // preserve original observation
        lastReinforcedAt: incoming.lastReinforcedAt || new Date().toISOString(),
        reinforcementCount: incoming.reinforcementCount ?? existing.reinforcementCount,
        supersededBy: null,
        derivedFromMessageId: incoming.derivedFromMessageId ?? null,
      });
      superseded++;
    } else {
      // Existing wins — skip the incoming entry.
      skipped++;
    }
  }

  log.info({ path: filePath, imported, skipped, superseded }, 'user-profile import complete');

  return { imported, skipped, superseded };
}

// ---------------------------------------------------------------------------
// T1079 — exportUserProfile
// ---------------------------------------------------------------------------

/**
 * Result of exporting user-profile traits to JSON.
 */
export interface ExportUserProfileResult {
  /** Absolute path the JSON file was written to. */
  path: string;
  /** Number of traits written. */
  count: number;
}

/**
 * Export the current user-profile traits to a portable JSON file.
 *
 * Only non-superseded traits (those with `supersededBy IS NULL`) are
 * included.  The output is a `UserProfileJson` envelope containing a
 * `$schema` URL and an `exportedAt` timestamp.
 *
 * @param path - Absolute output path.  Defaults to
 *               `~/.cleo/user_profile.json` (via `getDefaultUserProfilePath()`).
 * @returns Export result with path and count.
 */
export async function exportUserProfile(path?: string): Promise<ExportUserProfileResult> {
  const filePath = path ?? getDefaultUserProfilePath();
  const nexusDb = await getNexusDb();

  const traits = await listUserProfile(nexusDb, { includeSuperseded: false });

  const envelope: UserProfileJson = {
    $schema: 'https://cleocode.dev/schemas/user-profile/v1.json',
    exportedAt: new Date().toISOString(),
    traits,
  };

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(envelope, null, 2) + '\n', 'utf8');

  log.info({ path: filePath, count: traits.length }, 'user-profile export complete');

  return { path: filePath, count: traits.length };
}

/**
 * Preview a transfer without writing any data.
 * Validates projects, permissions, and builds the manifest.
 */
export async function previewTransfer(params: TransferParams): Promise<TransferResult> {
  return executeTransferInternal({ ...params, dryRun: true });
}

/**
 * Execute a cross-project task transfer.
 *
 * Pipeline:
 *   1. Validate source/target projects via nexusGetProject()
 *   2. Check permissions: read on source, write on target
 *   3. Read source tasks
 *   4. Build ExportPackage via exportSubtree/exportSingle
 *   5. Import into target via importFromPackage()
 *   6. Create bidirectional external_task_links
 *   7. Write nexus_audit_log entry
 *   8. If move mode: archive source tasks
 *   9. If transferBrain: copy brain observations
 */
export async function executeTransfer(params: TransferParams): Promise<TransferResult> {
  return executeTransferInternal(params);
}

async function executeTransferInternal(params: TransferParams): Promise<TransferResult> {
  const {
    taskIds,
    sourceProject: sourceProjectRef,
    targetProject: targetProjectRef,
    mode = 'copy',
    scope = 'subtree',
    onConflict = 'rename',
    onMissingDep = 'strip',
    provenance = true,
    targetParent,
    transferBrain = false,
    dryRun = false,
  } = params;

  if (!taskIds.length) {
    throw new Error('No task IDs specified for transfer');
  }

  // Step 1: Validate projects
  const sourceProject = await nexusGetProject(sourceProjectRef);
  if (!sourceProject) {
    throw new Error(`Source project not found: ${sourceProjectRef}`);
  }

  const targetProject = await nexusGetProject(targetProjectRef);
  if (!targetProject) {
    throw new Error(`Target project not found: ${targetProjectRef}`);
  }

  if (sourceProject.hash === targetProject.hash) {
    throw new Error('Source and target projects must be different');
  }

  // Step 2: Check permissions
  await requirePermission(sourceProject.hash, 'read', 'nexus.transfer');
  await requirePermission(targetProject.hash, 'write', 'nexus.transfer');

  // Step 3: Read source tasks
  const sourceAccessor = await getAccessor(sourceProject.path);
  const { tasks: allSourceTasks } = await sourceAccessor.queryTasks({});

  // Step 4: Build ExportPackage for each task
  const exportPackages = [];
  for (const taskId of taskIds) {
    const pkg =
      scope === 'subtree'
        ? exportSubtree(taskId, allSourceTasks, sourceProject.name)
        : exportSingle(taskId, allSourceTasks, sourceProject.name);

    if (!pkg) {
      throw new Error(`Task not found in source project: ${taskId}`);
    }
    exportPackages.push(pkg);
  }

  // Merge all packages into one (dedup by task ID)
  const seenIds = new Set<string>();
  const mergedTasks = [];
  for (const pkg of exportPackages) {
    for (const task of pkg.tasks) {
      if (!seenIds.has(task.id)) {
        seenIds.add(task.id);
        mergedTasks.push(task);
      }
    }
  }

  // Use the first package as base and replace tasks
  const mergedPkg = { ...exportPackages[0]! };
  mergedPkg.tasks = mergedTasks;
  mergedPkg._meta = { ...mergedPkg._meta, taskCount: mergedTasks.length };

  // Step 5: Import into target
  const importResult = await importFromPackage(mergedPkg, {
    cwd: targetProject.path,
    dryRun,
    parent: targetParent,
    provenance,
    onConflict,
    onMissingDep,
  });

  // Build manifest
  const entries: TransferManifestEntry[] = mergedTasks.map((t) => ({
    sourceId: t.id,
    targetId: importResult.idRemap[t.id] ?? t.id,
    title: t.title,
    type: t.type ?? 'task',
  }));

  const manifest: TransferManifest = {
    sourceProject: sourceProject.name,
    targetProject: targetProject.name,
    mode,
    scope,
    entries,
    idRemap: importResult.idRemap,
    brainObservationsTransferred: 0,
  };

  const result: TransferResult = {
    dryRun,
    transferred: importResult.imported,
    skipped: importResult.skipped,
    archived: 0,
    linksCreated: 0,
    brainObservationsTransferred: 0,
    manifest,
  };

  if (dryRun) {
    return result;
  }

  // Step 6: Create bidirectional external_task_links
  // Only create links for tasks that were actually imported (verify they exist in target).
  // Wrapped in try-catch: link creation is non-critical — the transfer itself has already
  // succeeded by this point. If the target DB predates the wave0-schema-hardening migration
  // and table creation fails, we log a warning and continue rather than aborting the transfer.
  let linksCreated = 0;
  try {
    const targetAccessor = await getAccessor(targetProject.path);
    const { tasks: targetTasks } = await targetAccessor.queryTasks({});
    const targetTaskIds = new Set(targetTasks.map((t) => t.id));

    for (const entry of entries) {
      if (importResult.idRemap[entry.sourceId] && targetTaskIds.has(entry.targetId)) {
        // Link in target: points back to source
        await createLink(
          {
            taskId: entry.targetId,
            providerId: `nexus:${sourceProject.name}`,
            externalId: entry.sourceId,
            externalTitle: entry.title,
            linkType: 'transferred',
            syncDirection: 'inbound',
            metadata: {
              transferMode: mode,
              transferScope: scope,
              sourceProject: sourceProject.name,
              transferredAt: new Date().toISOString(),
            },
          },
          targetProject.path,
        );
        linksCreated++;

        // Link in source: points to target
        await createLink(
          {
            taskId: entry.sourceId,
            providerId: `nexus:${targetProject.name}`,
            externalId: entry.targetId,
            externalTitle: entry.title,
            linkType: 'transferred',
            syncDirection: 'outbound',
            metadata: {
              transferMode: mode,
              transferScope: scope,
              targetProject: targetProject.name,
              transferredAt: new Date().toISOString(),
            },
          },
          sourceProject.path,
        );
        linksCreated++;
      }
    }
  } catch (err) {
    log.warn(
      { err, linksCreated },
      'Failed to create external_task_links during transfer — tasks were transferred successfully but provenance links could not be written',
    );
  }
  result.linksCreated = linksCreated;

  // Step 7: Write audit log
  try {
    const { getNexusDb } = await import('../store/nexus-sqlite.js');
    const { nexusAuditLog } = await import('../store/nexus-schema.js');
    const db = await getNexusDb();
    await db.insert(nexusAuditLog).values({
      id: randomUUID(),
      action: 'transfer',
      projectHash: sourceProject.hash,
      projectId: sourceProject.projectId,
      domain: 'nexus',
      operation: 'transfer',
      success: 1,
      detailsJson: JSON.stringify({
        sourceProject: sourceProject.name,
        targetProject: targetProject.name,
        mode,
        scope,
        taskCount: result.transferred,
        idRemap: importResult.idRemap,
      }),
    });
  } catch (err) {
    log.warn({ err }, 'nexus transfer audit write failed');
  }

  // Step 8: Move mode — archive source tasks
  if (mode === 'move') {
    let archived = 0;
    for (const entry of entries) {
      if (importResult.idRemap[entry.sourceId]) {
        try {
          await sourceAccessor.archiveSingleTask(entry.sourceId, {
            archivedAt: new Date().toISOString(),
            archiveReason: `Transferred to ${targetProject.name} as ${entry.targetId}`,
          });
          archived++;
        } catch (err) {
          log.warn({ err, taskId: entry.sourceId }, 'failed to archive source task after transfer');
        }
      }
    }
    result.archived = archived;
  }

  // Step 9: Brain observation transfer
  if (transferBrain) {
    let brainTransferred = 0;
    try {
      const sourceBrainDb = await getBrainDb(sourceProject.path);
      const targetBrainDb = await getBrainDb(targetProject.path);
      const sourceBrain = new BrainDataAccessor(sourceBrainDb);
      const targetBrain = new BrainDataAccessor(targetBrainDb);

      for (const entry of entries) {
        if (!importResult.idRemap[entry.sourceId]) continue;

        const links = await sourceBrain.getLinksForTask(entry.sourceId);
        for (const link of links) {
          if (link.memoryType !== 'observation') continue;

          const observation = await sourceBrain.getObservation(link.memoryId);
          if (!observation) continue;

          const newObsId = `O-${randomUUID().slice(0, 8)}`;
          await targetBrain.addObservation({
            ...observation,
            id: newObsId,
            createdAt: observation.createdAt,
            updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
          });

          await targetBrain.addLink({
            memoryType: 'observation',
            memoryId: newObsId,
            taskId: entry.targetId,
            linkType: 'applies_to',
            createdAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
          });

          brainTransferred++;
        }
      }
    } catch (err) {
      log.warn({ err }, 'brain observation transfer failed');
    }
    result.brainObservationsTransferred = brainTransferred;
    result.manifest.brainObservationsTransferred = brainTransferred;
  }

  return result;
}
