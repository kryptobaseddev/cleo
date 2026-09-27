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
 * @task T12354
 * @task T12469
 */

import { existsSync } from 'node:fs';
import type { NexusProjectCheckout } from '@cleocode/contracts';
import { and, desc, eq, ne } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { getStableDeviceId } from '../llm/stable-device-id.js';
import { projectLocations } from '../store/schema/nexus-schema.js';
import { generateProjectHash } from './hash.js';

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

  db.insert(projectLocations)
    .values({
      projectId: record.projectId,
      deviceId,
      path: record.projectPath,
      firstSeen: record.now,
      lastSeen: record.now,
      state: 'live',
    })
    .onConflictDoUpdate({
      target: [projectLocations.projectId, projectLocations.deviceId, projectLocations.path],
      set: { lastSeen: record.now, state: 'live' },
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
  return { markedMissing, superseded };
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
