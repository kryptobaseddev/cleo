/**
 * Which machine a registry row belongs to (T14013).
 *
 * `nexus_project_registry` is one row per project, shared by every device that
 * syncs the global store, and records no host. `nexus_project_locations`
 * records every checkout with the device it is on and its state, so a row's
 * host is read from there. A project with a LIVE location on another device
 * belongs to another host, even when this device also recorded it (a clone
 * here that is now `missing`): removing the row would delete that device's
 * project and its locations, and the deletion syncs. Otherwise a project this
 * device recorded is local. A row with no location at all (a legacy row) is
 * judged only by its path: when even the first two levels of the path do not
 * exist here (`/mnt/projects/...` or `/home/<user>/...` on a Mac), it was never
 * created on this machine; a path under the same username on another machine
 * cannot be told apart and stays removable.
 *
 * `projects clean` removes a row only when it is `local` or `unknown`; every
 * other row is kept and reported.
 *
 * Code placed in `packages/core/` per Package-Boundary Check — verified against AGENTS.md.
 *
 * @module nexus/registry-host
 * @task T14013
 */

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { isEphemeralPath } from './registry-hygiene.js';

/** Where a registry row's project lives, as far as this device can tell. */
export type RegistryRowHost = 'local' | 'other-host' | 'foreign-root' | 'unknown';

/** One recorded checkout location (project, device, state). */
export interface RegistryLocationRef {
  /** Project id. */
  projectId: string;
  /** Device the checkout is on. */
  deviceId: string;
  /** `live`, `missing`, `superseded` or `candidate`; only `live` proves a checkout exists. */
  state: string;
}

/** A row's host, with the devices that hold it when known. */
export interface RegistryRowHostVerdict {
  /** The host class. */
  host: RegistryRowHost;
  /** Devices holding a recorded location for the project (other hosts only). */
  devices: string[];
}

/** Path depth (`/` = 0, `/mnt` = 1, `/home/user` = 2). */
function depth(path: string): number {
  return resolve(path).split(sep).filter(Boolean).length;
}

/**
 * Whether a path's first two levels do not exist on this machine, so it was
 * never a checkout here (`/mnt/projects/x` or `/home/<user>/x` on macOS).
 * Temp paths are never foreign: they are this machine's scratch checkouts.
 *
 * @param path - A registry `project_path`.
 * @returns True when the nearest existing ancestor is the filesystem root or one level below it.
 */
export function hasForeignPathRoot(path: string): boolean {
  if (!isAbsolute(path) || isEphemeralPath(path)) return false;
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return true;
    current = parent;
  }
  return depth(current) < 2 && depth(path) >= 2;
}

/**
 * Classify a registry row's host from the recorded locations: a live
 * location on another device makes it `other-host`; else a location on this
 * device (any state) makes it `local`; else its path root decides.
 *
 * @param row - The registry row.
 * @param locations - Every recorded location (any project).
 * @param thisDevice - This device's stable id.
 * @returns The host class and, for another host, its devices.
 * @example
 * ```ts
 * classifyRegistryRowHost(row, locations, currentDeviceId());
 * ```
 */
export function classifyRegistryRowHost(
  row: { projectId: string; projectPath: string },
  locations: readonly RegistryLocationRef[],
  thisDevice: string,
): RegistryRowHostVerdict {
  const recorded = locations.filter((l) => l.projectId === row.projectId);
  const liveElsewhere = [
    ...new Set(
      recorded
        .filter((l) => l.state === 'live' && l.deviceId !== thisDevice)
        .map((l) => l.deviceId),
    ),
  ];
  if (liveElsewhere.length > 0) return { host: 'other-host', devices: liveElsewhere.sort() };
  if (recorded.some((l) => l.deviceId === thisDevice)) return { host: 'local', devices: [] };
  return { host: hasForeignPathRoot(row.projectPath) ? 'foreign-root' : 'unknown', devices: [] };
}
