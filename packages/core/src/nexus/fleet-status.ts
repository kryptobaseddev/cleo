/**
 * Fleet view (`nexus.projects.fleet`, T12513): every project, where it lives
 * on each device, and its last recorded git state — local (branch, HEAD,
 * dirty) and remote (upstream, ahead/behind as of the last fetch) — with
 * staleness flags.
 *
 * ## Read path only
 *
 * This module never runs git and never touches a project's own store. It
 * reads the rows `nexus.projects.status` (T12511) recorded in the global
 * `cleo.db`: `nexus_project_registry`, `nexus_project_locations`,
 * `nexus_project_git_state` and `nexus_devices`. Freshness is reported, not
 * repaired: `git.probedAt` / `probeStale` say how old the local picture is and
 * `git.remote.fetchedAt` / `remote.stale` how old the remote picture is. A
 * live refresh is the caller's explicit choice (`--refresh`), which runs the
 * bounded probe for THIS device only — other devices' rows can only be
 * refreshed on those devices.
 *
 * ## Cost per call
 *
 * A fixed number of SQL statements, independent of the number of projects:
 *
 * 1. `COUNT(*)` of the registry (total).
 * 2. `COUNT(*)` of the registry under the filter (matched).
 * 3. One page of registry rows, `ORDER BY name, project_id LIMIT ? OFFSET ?`.
 * 4. The locations + git state of THAT page only (`project_id IN (page)`).
 * 5. One aggregate pass over locations for the project-level summary.
 * 6. One `GROUP BY device_id` pass for the per-device summary.
 * 7. The device table (one row per machine).
 *
 * `summary` and `devices` are scoped by the `device` filter only; the flag
 * filters narrow `matched` and the page, never those counts.
 *
 * Filters are one correlated `EXISTS` per registry row, and every join is on
 * the `(project_id, device_id, path)` primary key both location tables share,
 * so no statement scans a table per project.
 *
 * @task T12513
 * @epic T12496
 */

import type {
  NexusFleetDevice,
  NexusFleetDeviceSummary,
  NexusFleetFlag,
  NexusFleetGitSummary,
  NexusFleetLocation,
  NexusFleetProject,
  NexusProjectsFleetParams,
  NexusProjectsFleetResult,
} from '@cleocode/contracts';
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import {
  type DeviceRow,
  devices,
  type ProjectGitStateRow,
  type ProjectLocationRow,
  projectGitState,
  projectLocations,
  projectRegistry,
} from '../store/schema/nexus-schema.js';
import { GIT_STATE_DEFAULTS } from './git-state.js';
import { currentDeviceId } from './path-map.js';
import { NexusDeviceNotFoundError } from './registry-errors.js';

/** Paging defaults for the fleet view. */
export const FLEET_DEFAULTS = {
  /** Projects per page. */
  limit: 50,
  /** Largest page a caller may ask for (`0` still means "every match"). */
  maxLimit: 500,
} as const;

/** Location states the fleet view shows; `superseded` and `candidate` are history, not presence. */
const VISIBLE_STATES = ['live', 'missing'] as const;

/** Registry handle subset the fleet view needs. */
export type FleetStoreHandle = Pick<NodeSQLiteDatabase, 'select'>;

/** Flags a caller can filter on, in output order. */
const FILTER_FLAGS = ['missing', 'dirty', 'behind', 'ahead', 'stale', 'errored'] as const;

/** Join condition: a location and its probe row share the full primary key. */
const gitJoin = and(
  eq(projectGitState.projectId, projectLocations.projectId),
  eq(projectGitState.deviceId, projectLocations.deviceId),
  eq(projectGitState.path, projectLocations.path),
);

/**
 * SQL for one location flag over `nexus_project_locations` LEFT JOIN
 * `nexus_project_git_state`. Must agree with {@link locationFlags}.
 *
 * @param flag - The flag.
 * @param cutoff - ISO instant; older probes and fetches are stale.
 * @returns A boolean SQL expression.
 */
function flagSql(flag: NexusFleetFlag, cutoff: string): SQL {
  const g = projectGitState;
  switch (flag) {
    case 'missing':
      return sql`(${projectLocations.state} = 'missing' OR ${g.probeErrorCode} = 'E_PATH_MISSING')`;
    case 'dirty':
      return sql`(coalesce(${g.dirtyCount}, 0) + coalesce(${g.untrackedCount}, 0)) > 0`;
    case 'behind':
      return sql`coalesce(${g.behind}, 0) > 0`;
    case 'ahead':
      return sql`coalesce(${g.ahead}, 0) > 0`;
    case 'errored':
      return sql`${g.probeErrorCode} IS NOT NULL`;
    case 'unprobed':
      return sql`${g.probedAt} IS NULL`;
    case 'stale':
      return sql`(${g.probedAt} IS NULL OR ${g.probedAt} < ${cutoff} OR ((${g.remoteName} IS NOT NULL OR ${g.upstream} IS NOT NULL) AND (${g.remoteFetchedAt} IS NULL OR ${g.remoteFetchedAt} < ${cutoff})))`;
  }
}

/**
 * Flags of one location, computed from its rows. Must agree with {@link flagSql}.
 *
 * @param loc - Location row.
 * @param git - Its probe row, or `null` when never probed.
 * @param cutoff - ISO instant; older probes and fetches are stale.
 * @returns The flags that hold, in canonical order.
 */
export function locationFlags(
  loc: Pick<ProjectLocationRow, 'state'>,
  git: ProjectGitStateRow | null,
  cutoff: string,
): NexusFleetFlag[] {
  const flags: NexusFleetFlag[] = [];
  if (loc.state === 'missing' || git?.probeErrorCode === 'E_PATH_MISSING') flags.push('missing');
  if (git === null) {
    flags.push('stale', 'unprobed');
    return flags;
  }
  if ((git.dirtyCount ?? 0) + (git.untrackedCount ?? 0) > 0) flags.push('dirty');
  if ((git.behind ?? 0) > 0) flags.push('behind');
  if ((git.ahead ?? 0) > 0) flags.push('ahead');
  if (git.probedAt < cutoff || remoteStale(git, cutoff)) flags.push('stale');
  if (git.probeErrorCode !== null) flags.push('errored');
  return flags;
}

/** Remote state is stale: there is a remote and its last fetch is unknown or older than `cutoff`. */
function remoteStale(git: ProjectGitStateRow, cutoff: string): boolean {
  if (git.remoteName === null && git.upstream === null) return false;
  return git.remoteFetchedAt === null || git.remoteFetchedAt < cutoff;
}

/** Contract shape of a stored probe row. */
function gitSummary(git: ProjectGitStateRow, cutoff: string): NexusFleetGitSummary {
  return {
    branch: git.branch,
    headSha: git.headSha,
    headCommittedAt: git.headCommittedAt,
    detached: git.detached,
    dirtyCount: git.dirtyCount,
    untrackedCount: git.untrackedCount,
    remote: {
      name: git.remoteName,
      url: git.remoteUrl,
      upstream: git.upstream,
      headSha: git.remoteHeadSha,
      ahead: git.ahead,
      behind: git.behind,
      fetchedAt: git.remoteFetchedAt,
      stale: remoteStale(git, cutoff),
    },
    probedAt: git.probedAt,
    probeStale: git.probedAt < cutoff,
    probeErrorCode: git.probeErrorCode,
    probeError: git.probeError,
  };
}

/** Normalised paging: `limit` 0 = unbounded, else 1..maxLimit. */
function resolvePaging(params: NexusProjectsFleetParams): { limit: number; offset: number } {
  const rawLimit =
    params.limit === undefined || !Number.isFinite(params.limit)
      ? FLEET_DEFAULTS.limit
      : Math.trunc(params.limit);
  const limit = rawLimit <= 0 ? 0 : Math.min(FLEET_DEFAULTS.maxLimit, rawLimit);
  const offset =
    params.offset === undefined || !Number.isFinite(params.offset)
      ? 0
      : Math.max(0, Math.trunc(params.offset));
  return { limit, offset };
}

/**
 * Resolve a `device` filter to device ids: `current`, an exact device id
 * (known by heartbeat or by a location), or a hostname (case-insensitive).
 *
 * @throws {NexusDeviceNotFoundError} When nothing matches.
 */
function resolveDeviceFilter(
  db: FleetStoreHandle,
  device: string | undefined,
  self: string,
  known: readonly DeviceRow[],
): string[] | null {
  const wanted = device?.trim();
  if (wanted === undefined || wanted.length === 0) return null;
  if (wanted === 'current') return [self];
  const lower = wanted.toLowerCase();
  const ids = new Set(
    known
      .filter((d) => d.deviceId === wanted || d.hostname.toLowerCase() === lower)
      .map((d) => d.deviceId),
  );
  if (ids.size === 0) {
    const located = db
      .select({ deviceId: projectLocations.deviceId })
      .from(projectLocations)
      .where(eq(projectLocations.deviceId, wanted))
      .limit(1)
      .get();
    if (located) ids.add(located.deviceId);
  }
  if (ids.size === 0) {
    throw new NexusDeviceNotFoundError(
      wanted,
      known.map((d) => ({ deviceId: d.deviceId, hostname: d.hostname })),
    );
  }
  return [...ids];
}

/** The location scope every statement shares: visible state, optionally one device set. */
function locationScope(deviceIds: readonly string[] | null): SQL | undefined {
  return and(
    inArray(projectLocations.state, [...VISIBLE_STATES]),
    deviceIds === null ? undefined : inArray(projectLocations.deviceId, [...deviceIds]),
  );
}

/** Correlated filter on the registry row, or `undefined` when nothing filters. */
function registryFilter(
  params: NexusProjectsFleetParams,
  deviceIds: readonly string[] | null,
  cutoff: string,
): SQL | undefined {
  const wanted = FILTER_FLAGS.filter((f) => params[f] === true);
  if (wanted.length === 0 && deviceIds === null) return undefined;
  const predicate = and(locationScope(deviceIds), ...wanted.map((f) => flagSql(f, cutoff)));
  return sql`EXISTS (SELECT 1 FROM ${projectLocations} LEFT JOIN ${projectGitState} ON ${gitJoin} WHERE ${projectLocations.projectId} = ${projectRegistry.projectId} AND ${predicate})`;
}

/** `count(DISTINCT project_id)` of locations carrying `flag`. */
function projectsWith(flag: NexusFleetFlag, cutoff: string): SQL<number> {
  return sql<number>`count(DISTINCT CASE WHEN ${flagSql(flag, cutoff)} THEN ${projectLocations.projectId} END)`;
}

/** `sum` of locations carrying `flag`. */
function locationsWith(flag: NexusFleetFlag, cutoff: string): SQL<number> {
  return sql<number>`coalesce(sum(CASE WHEN ${flagSql(flag, cutoff)} THEN 1 ELSE 0 END), 0)`;
}

/** Contract shape of a device, with or without a heartbeat row. */
function fleetDevice(
  deviceId: string,
  row: DeviceRow | undefined,
  self: string,
  cutoff: string,
): NexusFleetDevice {
  return {
    deviceId,
    hostname: row?.hostname ?? null,
    os: row?.os ?? null,
    arch: row?.arch ?? null,
    cleoVersion: row?.cleoVersion ?? null,
    lastHeartbeatAt: row?.lastHeartbeatAt ?? null,
    heartbeatStale: row === undefined || row.lastHeartbeatAt < cutoff,
    current: deviceId === self,
  };
}

/** Per-device counts, joined to the device table in memory (one row per machine). */
function deviceSummaries(
  db: FleetStoreHandle,
  deviceIds: readonly string[] | null,
  known: readonly DeviceRow[],
  self: string,
  cutoff: string,
): NexusFleetDeviceSummary[] {
  const counts = db
    .select({
      deviceId: projectLocations.deviceId,
      locations: sql<number>`count(*)`,
      missing: locationsWith('missing', cutoff),
      dirty: locationsWith('dirty', cutoff),
      behind: locationsWith('behind', cutoff),
      stale: locationsWith('stale', cutoff),
    })
    .from(projectLocations)
    .innerJoin(projectRegistry, eq(projectRegistry.projectId, projectLocations.projectId))
    .leftJoin(projectGitState, gitJoin)
    .where(locationScope(deviceIds))
    .groupBy(projectLocations.deviceId)
    .all();
  const byId = new Map(known.map((d) => [d.deviceId, d]));
  const out: NexusFleetDeviceSummary[] = counts.map((c) => ({
    ...fleetDevice(c.deviceId, byId.get(c.deviceId), self, cutoff),
    locations: c.locations,
    missing: c.missing,
    dirty: c.dirty,
    behind: c.behind,
    stale: c.stale,
  }));
  // A device known by heartbeat that holds nothing is still part of the fleet.
  const listed = new Set(out.map((d) => d.deviceId));
  for (const d of known) {
    if (listed.has(d.deviceId)) continue;
    if (deviceIds !== null && !deviceIds.includes(d.deviceId)) continue;
    out.push({
      ...fleetDevice(d.deviceId, d, self, cutoff),
      locations: 0,
      missing: 0,
      dirty: 0,
      behind: 0,
      stale: 0,
    });
  }
  return out.sort(
    (a, b) =>
      Number(b.current) - Number(a.current) ||
      (b.lastHeartbeatAt ?? '').localeCompare(a.lastHeartbeatAt ?? '') ||
      a.deviceId.localeCompare(b.deviceId),
  );
}

/** Union of location flags in canonical order. */
function unionFlags(locations: readonly NexusFleetLocation[]): NexusFleetFlag[] {
  const order: readonly NexusFleetFlag[] = [
    'missing',
    'dirty',
    'behind',
    'ahead',
    'stale',
    'errored',
    'unprobed',
  ];
  const seen = new Set(locations.flatMap((l) => l.flags));
  return order.filter((f) => seen.has(f));
}

/**
 * Read the fleet view: counts first, then one page of projects with every
 * visible location, its device and its last recorded git state.
 *
 * Read-only and git-free; see the module header for the per-call cost.
 *
 * @param db - Global registry handle (`getNexusRegistryDb`).
 * @param params - Filters, staleness window and paging.
 * @param overrides - Device id and clock (tests).
 * @returns The fleet view.
 * @throws {NexusDeviceNotFoundError} When `device` names no known device.
 * @example
 * ```ts
 * const view = listFleetStatus(await getNexusRegistryDb(getCleoHome()), { dirty: true, limit: 20 });
 * console.log(view.matched, view.projects.map((p) => p.name));
 * ```
 */
export function listFleetStatus(
  db: FleetStoreHandle,
  params: NexusProjectsFleetParams = {},
  overrides: { deviceId?: string; now?: Date } = {},
): NexusProjectsFleetResult {
  const now = overrides.now ?? new Date();
  const self = overrides.deviceId ?? currentDeviceId();
  const staleAfterMs =
    params.staleAfterMs !== undefined &&
    Number.isFinite(params.staleAfterMs) &&
    params.staleAfterMs >= 0
      ? params.staleAfterMs
      : GIT_STATE_DEFAULTS.staleAfterMs;
  const cutoff = new Date(now.getTime() - staleAfterMs).toISOString();
  const { limit, offset } = resolvePaging(params);

  const known = db.select().from(devices).all();
  const deviceIds = resolveDeviceFilter(db, params.device, self, known);
  const filter = registryFilter(params, deviceIds, cutoff);

  const total = db.select({ n: sql<number>`count(*)` }).from(projectRegistry).get()?.n ?? 0;
  const matched =
    filter === undefined
      ? total
      : (db.select({ n: sql<number>`count(*)` }).from(projectRegistry).where(filter).get()?.n ?? 0);

  const pageQuery = db
    .select({
      projectId: projectRegistry.projectId,
      name: projectRegistry.name,
      lastOpenedAt: projectRegistry.lastOpenedAt,
      lastProbedAt: projectRegistry.lastProbedAt,
    })
    .from(projectRegistry)
    .where(filter)
    .orderBy(projectRegistry.name, projectRegistry.projectId);
  // SQLite needs a LIMIT before OFFSET; -1 is its "no limit".
  const page = pageQuery
    .limit(limit === 0 ? -1 : limit)
    .offset(offset)
    .all();

  const pageIds = page.map((p) => p.projectId);
  const detail =
    pageIds.length === 0
      ? []
      : db
          .select({ loc: projectLocations, git: projectGitState })
          .from(projectLocations)
          .leftJoin(projectGitState, gitJoin)
          .where(and(inArray(projectLocations.projectId, pageIds), locationScope(deviceIds)))
          .orderBy(projectLocations.projectId, projectLocations.deviceId, projectLocations.path)
          .all();

  const hostById = new Map(known.map((d) => [d.deviceId, d.hostname]));
  const byProject = new Map<string, NexusFleetLocation[]>();
  for (const { loc, git } of detail) {
    const list = byProject.get(loc.projectId) ?? [];
    list.push({
      deviceId: loc.deviceId,
      hostname: hostById.get(loc.deviceId) ?? null,
      current: loc.deviceId === self,
      path: loc.path,
      state: loc.state === 'missing' ? 'missing' : 'live',
      lastSeen: loc.lastSeen,
      git: git === null ? null : gitSummary(git, cutoff),
      flags: locationFlags(loc, git, cutoff),
    });
    byProject.set(loc.projectId, list);
  }
  const projects: NexusFleetProject[] = page.map((p) => {
    const locations = byProject.get(p.projectId) ?? [];
    return {
      projectId: p.projectId,
      name: p.name,
      lastOpenedAt: p.lastOpenedAt,
      lastProbedAt: p.lastProbedAt,
      deviceCount: new Set(locations.map((l) => l.deviceId)).size,
      flags: unionFlags(locations),
      locations,
    };
  });

  const agg = db
    .select({
      located: sql<number>`count(DISTINCT ${projectLocations.projectId})`,
      locations: sql<number>`count(*)`,
      missing: projectsWith('missing', cutoff),
      dirty: projectsWith('dirty', cutoff),
      behind: projectsWith('behind', cutoff),
      ahead: projectsWith('ahead', cutoff),
      stale: projectsWith('stale', cutoff),
      errored: projectsWith('errored', cutoff),
      unprobed: projectsWith('unprobed', cutoff),
    })
    .from(projectLocations)
    .innerJoin(projectRegistry, eq(projectRegistry.projectId, projectLocations.projectId))
    .leftJoin(projectGitState, gitJoin)
    .where(locationScope(deviceIds))
    .get();

  return {
    total,
    matched,
    returned: projects.length,
    offset,
    limit,
    hasMore: offset + projects.length < matched,
    staleAfterMs,
    generatedAt: now.toISOString(),
    currentDeviceId: self,
    summary: {
      located: agg?.located ?? 0,
      locations: agg?.locations ?? 0,
      missing: agg?.missing ?? 0,
      dirty: agg?.dirty ?? 0,
      behind: agg?.behind ?? 0,
      ahead: agg?.ahead ?? 0,
      stale: agg?.stale ?? 0,
      errored: agg?.errored ?? 0,
      unprobed: agg?.unprobed ?? 0,
    },
    devices: deviceSummaries(db, deviceIds, known, self, cutoff),
    projects,
  };
}
