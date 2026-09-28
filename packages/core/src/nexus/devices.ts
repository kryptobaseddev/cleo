/**
 * Devices (`nexus_devices`) — every machine that runs CLEO against this
 * global store, keyed by the stable `<cleoHome>/device-id` (T9321) that
 * `nexus_project_locations.device_id` already carries (T12469). Resolving a
 * location's device id against this table answers "which machine, which OS,
 * which CLEO version, and when did it last check in".
 *
 * The CLI calls {@link recordDeviceHeartbeat} on start. It is throttled to at
 * most one write per {@link DEVICE_HEARTBEAT_INTERVAL_MS} per device: one
 * primary-key read decides, and only a stale or absent row costs a single
 * primary-key upsert. The upsert repeats the staleness test in its `WHERE`, so
 * concurrent CLI starts cannot both write inside one interval.
 *
 * @task T12510
 * @epic T12496
 */

import { existsSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { NexusDeviceRecord } from '@cleocode/contracts';
import { getCleoHome } from '@cleocode/paths';
import { desc, eq, lt } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { devices } from '../store/schema/nexus-schema.js';
import { isShuttingDown } from '../teardown-signal.js';
import { currentDeviceId } from './path-map.js';

/** Minimum interval between two heartbeat writes for one device. */
export const DEVICE_HEARTBEAT_INTERVAL_MS = 60_000;

/** Registry handle subset the device functions need. */
export type DeviceStoreHandle = Pick<NodeSQLiteDatabase, 'select' | 'insert'>;

/** Descriptive facts about the device sending a heartbeat. */
export interface DeviceFacts {
  /** Stable device id. Defaults to {@link currentDeviceId}. */
  deviceId?: string;
  /** Hostname. Defaults to `os.hostname()`. */
  hostname?: string;
  /** OS. Defaults to `process.platform`. */
  os?: string;
  /** Architecture. Defaults to `process.arch`. */
  arch?: string;
  /** CLEO version. Defaults to the installed package version. */
  cleoVersion?: string;
}

/** What {@link recordDeviceHeartbeat} did. */
export type DeviceHeartbeatOutcome = 'written' | 'throttled';

/**
 * Upsert this device's `nexus_devices` row unless it was written within the
 * last {@link DEVICE_HEARTBEAT_INTERVAL_MS}.
 *
 * Cost: one primary-key read; when stale, one primary-key upsert. Descriptive
 * facts (hostname, version) are resolved only when a write happens.
 *
 * @param db - Global registry handle (`getNexusRegistryDb`).
 * @param now - Heartbeat instant. Defaults to the current time.
 * @param facts - Overrides for the recorded device facts (tests).
 * @returns `written` when the row was inserted or refreshed, else `throttled`.
 * @example
 * ```ts
 * await recordDeviceHeartbeat(await getNexusRegistryDb(getCleoHome()));
 * ```
 */
export async function recordDeviceHeartbeat(
  db: DeviceStoreHandle,
  now: Date = new Date(),
  facts: DeviceFacts = {},
): Promise<DeviceHeartbeatOutcome> {
  const deviceId = facts.deviceId ?? currentDeviceId();
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - DEVICE_HEARTBEAT_INTERVAL_MS).toISOString();

  const existing = db
    .select({ lastHeartbeatAt: devices.lastHeartbeatAt })
    .from(devices)
    .where(eq(devices.deviceId, deviceId))
    .get();
  if (existing && existing.lastHeartbeatAt > staleBefore) return 'throttled';

  const described = {
    hostname: facts.hostname ?? hostname(),
    os: facts.os ?? process.platform,
    arch: facts.arch ?? process.arch,
    cleoVersion: facts.cleoVersion ?? (await installedCleoVersion()),
  };
  const result = db
    .insert(devices)
    .values({ deviceId, ...described, firstSeen: nowIso, lastHeartbeatAt: nowIso })
    .onConflictDoUpdate({
      target: devices.deviceId,
      set: { ...described, lastHeartbeatAt: nowIso },
      // Race guard: a concurrent CLI start that already wrote inside this
      // interval makes this a no-op.
      setWhere: lt(devices.lastHeartbeatAt, staleBefore),
    })
    .run();
  return result.changes > 0 ? 'written' : 'throttled';
}

/**
 * List every known device, most recent heartbeat first.
 *
 * @param db - Global registry handle (`getNexusRegistryDb`).
 * @returns Device records; `current` marks this device.
 * @example
 * ```ts
 * const all = listNexusDevices(await getNexusRegistryDb(getCleoHome()));
 * ```
 */
export function listNexusDevices(db: DeviceStoreHandle): NexusDeviceRecord[] {
  const self = currentDeviceId();
  return db
    .select()
    .from(devices)
    .orderBy(desc(devices.lastHeartbeatAt))
    .all()
    .map((row) => ({ ...row, current: row.deviceId === self }));
}

/** Filename in `<cleoHome>` whose mtime records the last heartbeat attempt. */
export const DEVICE_HEARTBEAT_STAMP = 'device-heartbeat.stamp';

/** What {@link heartbeatThisDevice} did. */
export type DeviceStartupHeartbeatOutcome =
  | DeviceHeartbeatOutcome
  | 'disabled'
  | 'shutting-down'
  | 'no-store';

/**
 * CLI-start heartbeat: record this device in the global store at most once
 * per {@link DEVICE_HEARTBEAT_INTERVAL_MS}.
 *
 * A stamp file's mtime is checked first, so a start inside the interval costs
 * one `stat` and never opens the database. Past the interval it opens the
 * global registry (only if it already exists — a heartbeat never creates the
 * store) and calls {@link recordDeviceHeartbeat}, whose own primary-key check
 * and guarded upsert keep concurrent starts to a single write.
 *
 * Callers MUST treat every error as non-fatal; the CLI swallows it.
 *
 * @param options - `cleoHome` and `now` overrides (tests).
 * @returns What happened.
 * @example
 * ```ts
 * try { await heartbeatThisDevice(); } catch { // never fail the command }
 * ```
 */
export async function heartbeatThisDevice(
  options: { cleoHome?: string; now?: Date } = {},
): Promise<DeviceStartupHeartbeatOutcome> {
  if (isShuttingDown()) return 'shutting-down';
  if (process.env['CLEO_DISABLE_DEVICE_HEARTBEAT'] === '1') return 'disabled';
  const cleoHome = options.cleoHome ?? getCleoHome();
  const now = options.now ?? new Date();
  const stamp = join(cleoHome, DEVICE_HEARTBEAT_STAMP);
  try {
    if (now.getTime() - statSync(stamp).mtimeMs < DEVICE_HEARTBEAT_INTERVAL_MS) return 'throttled';
  } catch {
    // No stamp yet — fall through to the database check.
  }
  const { getNexusRegistryDb, getNexusRegistryDbPath } = await import('../store/nexus-sqlite.js');
  if (!existsSync(getNexusRegistryDbPath(cleoHome))) return 'no-store';
  const outcome = await recordDeviceHeartbeat(await getNexusRegistryDb(cleoHome), now);
  writeFileSync(stamp, now.toISOString());
  utimesSync(stamp, now, now);
  return outcome;
}

/** Installed CLEO version, resolved lazily so throttled starts never read it. */
async function installedCleoVersion(): Promise<string> {
  const { getCleoVersion } = await import('../scaffold/ensure-config.js');
  return getCleoVersion();
}
