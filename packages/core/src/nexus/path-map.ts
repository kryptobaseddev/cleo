/**
 * Project locations (`nexus_project_locations`) — every place a project has
 * been seen, on every device.
 *
 * The registry is keyed by the immutable `project_id` alone (ADR-094 ·
 * T12469); its `project_path` names only the checkout encountered most
 * recently. This table records every checkout as one row per
 * `(project_id, device_id, path)`, so two checkouts of one project coexist and
 * the same project on two devices keeps one registry row.
 *
 * Rows are never deleted because a directory vanished. When a project is
 * recorded, this device's other `live` locations of it whose directory is gone
 * move to `missing`; a location whose path now holds a different project moves
 * to `superseded`. History therefore survives for consumers that need former
 * paths (legacy path-derived credential candidates, T12475).
 *
 * Every writer that records a checkout in the registry records it here in the
 * same transaction: encounter registration, `nexusRegister`, `nexusReconcile`
 * and `nexusMoveProject`. Only an explicit unregister or clean removes rows.
 *
 * ## Compatibility with older binaries sharing the global store
 *
 * Older binaries still read the registry by path (`WHERE project_path = ?
 * LIMIT 1`, and an owner filter of path OR hash OR id). Two registry rows at
 * one path would make them pick a stale row and fail (`E_PROJECT_ID_DRIFT`,
 * identity conflicts). So when a path changes hands, the previous holder's
 * registry row is re-homed in the same transaction ({@link rehomeDisplacedRows}):
 * to its most recent other live location on this device, or, if it has none,
 * to the non-path sentinel {@link supersededRegistryPath} — which no path
 * lookup can match. At most one registry row ever names a real path.
 *
 * The legacy `nexus_project_paths` map is dual-written (upsert only) for one
 * release so older binaries keep reading a current map; drop it with a later
 * migration once those binaries are gone.
 *
 * @task T12354
 * @task T12469
 */

import { existsSync } from 'node:fs';
import type { NexusProjectCheckout } from '@cleocode/contracts';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { getStableDeviceId } from '../llm/stable-device-id.js';
import { projectLocations, projectPaths, projectRegistry } from '../store/schema/nexus-schema.js';
import { generateProjectHash } from './hash.js';
import type { CheckoutEvidence } from './identity.js';
import { registryStorePath } from './registry-hygiene.js';

/** A registry handle or an open transaction on one. */
export type PathMapWriter = Pick<NodeSQLiteDatabase, 'select' | 'insert' | 'delete' | 'update'>;

/**
 * Device id carried by rows the T12469 migration backfilled. SQL cannot read
 * the device id, and the global store is device-local, so every such row
 * belongs to this device; {@link adoptLocalDeviceRows} re-keys them.
 */
export const LOCAL_DEVICE_SENTINEL = 'local';

/** One checkout to record. */
export interface ProjectCheckoutRecord {
  /** Immutable project id. */
  projectId: string;
  /** Absolute checkout root. */
  projectPath: string;
  /**
   * Path fingerprint of the checkout. Accepted for caller compatibility; the
   * location row stores no hash — it is derived from the path when read.
   */
  projectHash?: string;
  /** ISO 8601 timestamp of the encounter. */
  now: string;
  /** Device the checkout is on. Defaults to this device's stable id. */
  deviceId?: string;
  /**
   * Repository evidence for the checkout (T12470). DISPLAYED only — never a
   * proof of identity or of a move (forgeable). Absent fields keep
   * whatever evidence the row already carries.
   */
  evidence?: CheckoutEvidence;
  /**
   * The checkout's nonce from its untracked `project-info.json` (T12470) —
   * the only proof of a move. Recorded on confirmed locations only.
   */
  checkoutNonce?: string | null;
}

/** What {@link recordProjectCheckout} changed besides the recorded location. */
export interface ProjectCheckoutOutcome {
  /** This project's other locations on this device newly marked `missing`. */
  markedMissing: number;
  /** Other projects' locations at this path newly marked `superseded`. */
  superseded: number;
}

/**
 * Return this device's stable id — the persisted `<cleoHome>/device-id`
 * (T9321). Reused rather than minting a second device identity.
 *
 * @returns Opaque stable device id.
 */
export function currentDeviceId(): string {
  return getStableDeviceId();
}

/** Prefix of the registry `project_path` sentinel for a row with no live location. */
export const SUPERSEDED_PATH_PREFIX = 'superseded:';

/**
 * Registry `project_path` for a project whose last checkout now holds another
 * project and which has no other live location. Not an absolute path, so no
 * path lookup (current or older binary) can match it; unique per id.
 *
 * @param projectId - Immutable project id.
 * @returns `superseded:<projectId>`.
 */
export function supersededRegistryPath(projectId: string): string {
  return `${SUPERSEDED_PATH_PREFIX}${projectId}`;
}

/**
 * Whether a registry `project_path` is the {@link supersededRegistryPath} sentinel.
 *
 * @param projectPath - Stored registry path.
 * @returns `true` for the sentinel.
 */
export function isSupersededRegistryPath(projectPath: string): boolean {
  return projectPath.startsWith(SUPERSEDED_PATH_PREFIX);
}

/** Primary-key predicate for one location row. */
function locationKey(projectId: string, deviceId: string, path: string) {
  return and(
    eq(projectLocations.projectId, projectId),
    eq(projectLocations.deviceId, deviceId),
    eq(projectLocations.path, path),
  );
}

/**
 * Re-key migration-backfilled rows (device id {@link LOCAL_DEVICE_SENTINEL})
 * to `deviceId`, merging with any row already recorded under the real id.
 *
 * @param db - Registry handle or transaction.
 * @param deviceId - This device's stable id.
 * @returns Number of sentinel rows adopted.
 */
export function adoptLocalDeviceRows(db: PathMapWriter, deviceId: string): number {
  if (deviceId === LOCAL_DEVICE_SENTINEL) return 0;
  const sentinelRows = db
    .select()
    .from(projectLocations)
    .where(eq(projectLocations.deviceId, LOCAL_DEVICE_SENTINEL))
    .all();
  for (const row of sentinelRows) {
    const existing = db
      .select()
      .from(projectLocations)
      .where(locationKey(row.projectId, deviceId, row.path))
      .get();
    if (existing) {
      db.update(projectLocations)
        .set({
          firstSeen: existing.firstSeen < row.firstSeen ? existing.firstSeen : row.firstSeen,
          lastSeen: existing.lastSeen > row.lastSeen ? existing.lastSeen : row.lastSeen,
        })
        .where(locationKey(row.projectId, deviceId, row.path))
        .run();
    } else {
      db.insert(projectLocations)
        .values({ ...row, deviceId })
        .run();
    }
    db.delete(projectLocations)
      .where(locationKey(row.projectId, LOCAL_DEVICE_SENTINEL, row.path))
      .run();
  }
  return sentinelRows.length;
}

/**
 * Record a checkout as a `live` location, supersede other projects' claims on
 * the same path, and mark this project's vanished paths on this device
 * `missing`. Nothing is deleted.
 *
 * Runs synchronously so it composes with the registry writers' immediate
 * transactions.
 *
 * @param db - Registry handle or transaction.
 * @param record - The checkout encountered.
 * @returns Counts of rows moved to `missing` and `superseded`.
 */
export function recordProjectCheckout(
  db: PathMapWriter,
  record: ProjectCheckoutRecord,
): ProjectCheckoutOutcome {
  const deviceId = record.deviceId ?? currentDeviceId();
  adoptLocalDeviceRows(db, deviceId);

  const evidence = confirmedColumns(record);
  db.insert(projectLocations)
    .values({
      projectId: record.projectId,
      deviceId,
      path: record.projectPath,
      firstSeen: record.now,
      lastSeen: record.now,
      state: 'live',
      ...evidence,
    })
    .onConflictDoUpdate({
      target: [projectLocations.projectId, projectLocations.deviceId, projectLocations.path],
      set: { lastSeen: record.now, state: 'live', ...evidence },
    })
    .run();

  // A path holds one project at a time: other projects' claims on it end.
  const superseded = Number(
    db
      .update(projectLocations)
      .set({ state: 'superseded' })
      .where(
        and(
          eq(projectLocations.deviceId, deviceId),
          eq(projectLocations.path, record.projectPath),
          ne(projectLocations.projectId, record.projectId),
          ne(projectLocations.state, 'superseded'),
        ),
      )
      .run().changes,
  );

  const siblings = db
    .select({ path: projectLocations.path })
    .from(projectLocations)
    .where(
      and(
        eq(projectLocations.projectId, record.projectId),
        eq(projectLocations.deviceId, deviceId),
        eq(projectLocations.state, 'live'),
        ne(projectLocations.path, record.projectPath),
      ),
    )
    .all();
  let markedMissing = 0;
  for (const sibling of siblings) {
    if (existsSync(sibling.path)) continue;
    db.update(projectLocations)
      .set({ state: 'missing' })
      .where(locationKey(record.projectId, deviceId, sibling.path))
      .run();
    markedMissing++;
  }
  rehomeDisplacedRows(db, record.projectId, record.projectPath, deviceId);

  // Legacy path map, dual-written for older binaries (upsert only; see header).
  db.insert(projectPaths)
    .values({
      projectPath: record.projectPath,
      projectId: record.projectId,
      projectHash: record.projectHash ?? generateProjectHash(record.projectPath),
      firstSeen: record.now,
      lastSeen: record.now,
    })
    .onConflictDoUpdate({
      target: projectPaths.projectPath,
      set: {
        projectId: record.projectId,
        projectHash: record.projectHash ?? generateProjectHash(record.projectPath),
        lastSeen: record.now,
      },
    })
    .run();

  return { markedMissing, superseded };
}

/** The non-null displayed-evidence fields of a record, as location columns. */
function evidenceColumns(evidence: CheckoutEvidence | undefined): {
  gitRootCommit?: string;
  gitRemote?: string;
} {
  return {
    ...(evidence?.gitRootCommit ? { gitRootCommit: evidence.gitRootCommit } : {}),
    ...(evidence?.gitRemote ? { gitRemote: evidence.gitRemote } : {}),
  };
}

/** A confirmed record's evidence plus its nonce, as location columns. */
function confirmedColumns(record: ProjectCheckoutRecord): {
  gitRootCommit?: string;
  gitRemote?: string;
  checkoutNonce?: string;
} {
  return {
    ...evidenceColumns(record.evidence),
    ...(record.checkoutNonce ? { checkoutNonce: record.checkoutNonce } : {}),
  };
}

/**
 * How a per-command encounter may bind a checkout that declares `projectId`
 * (T12470). Only explicit commands bind unconditionally; an encounter is a
 * side effect of ANY command, including read-only ones, and the id it sees is
 * committed to git — so any directory can declare it.
 *
 * - `bind` — no registry row for the id yet, or the row already names this
 *   path: record it as the live location.
 * - `refresh` — this path is already a confirmed (`live`) location of the id
 *   on this device, but the row names another: refresh the location only.
 * - `promote` — a proven move: the row's path was recorded on THIS device,
 *   is gone from disk, and the nonce recorded there equals the one in this
 *   checkout's untracked `project-info.json`. The row follows the checkout.
 * - `candidate` — anything else: record an unconfirmed location. The registry
 *   row, its path and its permissions are left untouched.
 */
export type EncounterBinding = 'bind' | 'refresh' | 'promote' | 'candidate';

/**
 * Decide how an encounter may bind a checkout (see {@link EncounterBinding}).
 *
 * @param db - Registry handle or transaction.
 * @param record - The encountered checkout and its evidence.
 * @returns The permitted binding.
 *
 * @example
 * ```ts
 * const binding = decideEncounterBinding(tx, { projectId, projectPath, now, evidence });
 * ```
 */
export function decideEncounterBinding(
  db: PathMapWriter,
  record: ProjectCheckoutRecord,
): EncounterBinding {
  const deviceId = record.deviceId ?? currentDeviceId();
  const row = db
    .select({ projectPath: projectRegistry.projectPath })
    .from(projectRegistry)
    .where(eq(projectRegistry.projectId, record.projectId))
    .get();
  if (!row || row.projectPath === record.projectPath) return 'bind';

  const here = db
    .select({ state: projectLocations.state })
    .from(projectLocations)
    .where(
      and(
        eq(projectLocations.projectId, record.projectId),
        inArray(projectLocations.deviceId, [deviceId, LOCAL_DEVICE_SENTINEL]),
        eq(projectLocations.path, record.projectPath),
      ),
    )
    .all();
  if (here.some((location) => location.state === 'live')) return 'refresh';

  const oldPath = row.projectPath;
  if (isSupersededRegistryPath(oldPath) || existsSync(oldPath)) return 'candidate';
  // Proof of a move is the checkout's NONCE alone (T12470): local, untracked
  // state that a real `mv` or a restore of `.cleo/` carries and a clone
  // cannot have. Root commit and remote are forgeable (a clone shares them, a
  // bare `git init` can add any remote, `refs/replace` fakes a root commit),
  // so they are displayed evidence only and never promote.
  const nonce = record.checkoutNonce ?? null;
  if (nonce === null) return 'candidate';
  const previous = db
    .select({ checkoutNonce: projectLocations.checkoutNonce })
    .from(projectLocations)
    .where(
      and(
        eq(projectLocations.projectId, record.projectId),
        inArray(projectLocations.deviceId, [deviceId, LOCAL_DEVICE_SENTINEL]),
        eq(projectLocations.path, oldPath),
      ),
    )
    .all();
  return previous.some((location) => location.checkoutNonce === nonce) ? 'promote' : 'candidate';
}

/**
 * Record an UNCONFIRMED location of a project (T12470): the checkout declares
 * the id, but nothing has confirmed it. The registry row, its path and its
 * permissions are not touched, and no other project's claim on the path ends.
 * A location that is already `live` stays `live`.
 *
 * @param db - Registry handle or transaction.
 * @param record - The encountered checkout.
 * @returns `true` when the candidate was recorded for the first time.
 *
 * @example
 * ```ts
 * recordCandidateLocation(tx, { projectId, projectPath, now, evidence });
 * ```
 */
export function recordCandidateLocation(db: PathMapWriter, record: ProjectCheckoutRecord): boolean {
  const deviceId = record.deviceId ?? currentDeviceId();
  adoptLocalDeviceRows(db, deviceId);
  const key = locationKey(record.projectId, deviceId, record.projectPath);
  const existing = db
    .select({ state: projectLocations.state })
    .from(projectLocations)
    .where(key)
    .get();
  const evidence = evidenceColumns(record.evidence);
  if (!existing) {
    db.insert(projectLocations)
      .values({
        projectId: record.projectId,
        deviceId,
        path: record.projectPath,
        firstSeen: record.now,
        lastSeen: record.now,
        state: 'candidate',
        ...evidence,
      })
      .run();
    return true;
  }
  db.update(projectLocations)
    .set({
      lastSeen: record.now,
      ...(existing.state === 'live' ? {} : { state: 'candidate' as const }),
      ...evidence,
    })
    .where(key)
    .run();
  return false;
}

/**
 * Demote a location this device no longer treats as the project's home
 * (T12556 · T12558). `cleo project move` leaves the source tree behind as a
 * `candidate` (it still declares the id but is no longer confirmed);
 * `cleo project reroot` leaves the old root with no `.cleo/` at all, so it is
 * `missing`. A location that was never recorded is recorded in that state so
 * the history is complete. The registry row is not touched.
 *
 * @param db - Registry handle or transaction.
 * @param record - The location to demote.
 * @param state - `candidate` (still declares the id) or `missing` (does not).
 *
 * @example
 * ```ts
 * demoteProjectLocation(tx, { projectId, projectPath: oldRoot, now }, 'missing');
 * ```
 */
export function demoteProjectLocation(
  db: PathMapWriter,
  record: ProjectCheckoutRecord,
  state: 'candidate' | 'missing',
): void {
  const deviceId = record.deviceId ?? currentDeviceId();
  adoptLocalDeviceRows(db, deviceId);
  db.insert(projectLocations)
    .values({
      projectId: record.projectId,
      deviceId,
      path: record.projectPath,
      firstSeen: record.now,
      lastSeen: record.now,
      state,
    })
    .onConflictDoUpdate({
      target: [projectLocations.projectId, projectLocations.deviceId, projectLocations.path],
      set: { state },
    })
    .run();
}

/**
 * Refresh an already-confirmed location without repointing the registry row.
 *
 * @param db - Registry handle or transaction.
 * @param record - The encountered checkout.
 */
export function touchProjectLocation(db: PathMapWriter, record: ProjectCheckoutRecord): void {
  const deviceId = record.deviceId ?? currentDeviceId();
  adoptLocalDeviceRows(db, deviceId);
  db.update(projectLocations)
    .set({ lastSeen: record.now, ...confirmedColumns(record) })
    .where(locationKey(record.projectId, deviceId, record.projectPath))
    .run();
}

/**
 * Explicitly confirm a checkout as a project's live location and point the
 * registry row at it (T12470) — the promotion path for a `candidate` used by
 * `cleo doctor project-identity --resolve`. Permissions stay on the row.
 *
 * @param db - Registry handle or transaction.
 * @param record - The checkout to confirm.
 * @returns `false` when the project has no registry row to point.
 *
 * @example
 * ```ts
 * confirmProjectLocation(tx, { projectId, projectPath, now, evidence });
 * ```
 */
export function confirmProjectLocation(db: PathMapWriter, record: ProjectCheckoutRecord): boolean {
  const row = db
    .select({ projectId: projectRegistry.projectId })
    .from(projectRegistry)
    .where(eq(projectRegistry.projectId, record.projectId))
    .get();
  if (!row) return false;
  db.update(projectRegistry)
    .set({
      projectPath: record.projectPath,
      projectHash: generateProjectHash(record.projectPath),
      lastSeen: record.now,
      brainDbPath: registryStorePath(record.projectPath),
      tasksDbPath: registryStorePath(record.projectPath),
    })
    .where(eq(projectRegistry.projectId, record.projectId))
    .run();
  recordProjectCheckout(db, record);
  return true;
}

/**
 * Keep at most one registry row per real path: move every OTHER project's
 * registry row that still names `projectPath` to that project's most recent
 * other live location on this device, or to its
 * {@link supersededRegistryPath} sentinel when it has none.
 *
 * @param db - Registry handle or transaction.
 * @param projectId - The project that now holds `projectPath`.
 * @param projectPath - The path that changed hands.
 * @param deviceId - This device's stable id.
 * @returns Number of registry rows re-homed.
 */
export function rehomeDisplacedRows(
  db: PathMapWriter,
  projectId: string,
  projectPath: string,
  deviceId: string,
): number {
  const displaced = db
    .select({ projectId: projectRegistry.projectId })
    .from(projectRegistry)
    .where(
      and(eq(projectRegistry.projectPath, projectPath), ne(projectRegistry.projectId, projectId)),
    )
    .all();
  for (const row of displaced) {
    const candidates = db
      .select({ path: projectLocations.path })
      .from(projectLocations)
      .where(
        and(
          eq(projectLocations.projectId, row.projectId),
          eq(projectLocations.deviceId, deviceId),
          eq(projectLocations.state, 'live'),
          ne(projectLocations.path, projectPath),
        ),
      )
      .orderBy(desc(projectLocations.lastSeen))
      .all();
    // A candidate must exist on disk and not already name another registry row.
    const home = candidates.find(
      (c) =>
        existsSync(c.path) &&
        db
          .select({ projectId: projectRegistry.projectId })
          .from(projectRegistry)
          .where(eq(projectRegistry.projectPath, c.path))
          .all().length === 0,
    )?.path;
    const nextPath = home ?? supersededRegistryPath(row.projectId);
    db.update(projectRegistry)
      .set({
        projectPath: nextPath,
        projectHash: generateProjectHash(nextPath),
        brainDbPath: home ? registryStorePath(home) : null,
        tasksDbPath: home ? registryStorePath(home) : null,
      })
      .where(eq(projectRegistry.projectId, row.projectId))
      .run();
  }
  return displaced.length;
}

/**
 * List every recorded location of a project, newest first.
 *
 * @param projectId - Immutable project id.
 * @param opts - `allDevices: true` includes other devices' locations; by
 *   default only this device's are listed.
 * @returns Locations with their state and an `exists` flag (checked only for
 *   this device's rows; `false` for another device's).
 * @example
 * ```ts
 * const checkouts = await listProjectCheckouts(projectId);
 * const live = checkouts.filter((c) => c.state === 'live');
 * ```
 */
export async function listProjectCheckouts(
  projectId: string,
  opts: { allDevices?: boolean } = {},
): Promise<NexusProjectCheckout[]> {
  const { getNexusRegistryDb } = await import('../store/nexus-sqlite.js');
  const { getCleoHome } = await import('../paths.js');
  const db = await getNexusRegistryDb(getCleoHome());
  const deviceId = currentDeviceId();
  const out: NexusProjectCheckout[] = [];
  for (const row of db
    .select()
    .from(projectLocations)
    .where(eq(projectLocations.projectId, projectId))
    .orderBy(desc(projectLocations.lastSeen))
    .all()) {
    // Migration-backfilled rows are this device's until adopted.
    const local = row.deviceId === deviceId || row.deviceId === LOCAL_DEVICE_SENTINEL;
    if (!local && !opts.allDevices) continue;
    out.push({
      projectPath: row.path,
      projectHash: generateProjectHash(row.path),
      firstSeen: row.firstSeen,
      lastSeen: row.lastSeen,
      exists: local && existsSync(row.path),
      deviceId: local ? deviceId : row.deviceId,
      state: row.state,
    });
  }
  return out;
}
