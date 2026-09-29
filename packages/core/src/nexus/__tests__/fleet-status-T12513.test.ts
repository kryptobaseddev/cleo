/**
 * Fleet view (T12513): every project with its location on each device, its
 * last recorded git state and freshness; SQL paging with counts first;
 * filters for missing, dirty, behind, ahead, stale, errored and device.
 *
 * Every case runs against a temp `CLEO_HOME`. The read path is exercised on
 * seeded rows; the refresh path runs the real bounded probe against scratch
 * git repositories.
 *
 * @task T12513
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NEXUS_FLEET_SCHEMA_VERSION, type NexusProjectsFleetResult } from '@cleocode/contracts';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetDeviceIdCacheForTests } from '../../llm/stable-device-id.js';
import { getCleoHome } from '../../paths.js';
import { awaitBackgroundOps } from '../../store/background-ops.js';
import {
  devices,
  type NewProjectGitStateRow,
  projectGitState,
  projectLocations,
  projectRegistry,
} from '../../store/schema/nexus-schema.js';
import { resetDbState } from '../../store/sqlite.js';
import { FLEET_DEFAULTS, listFleetStatus } from '../fleet-status.js';
import { runProjectsGitStatus } from '../git-state.js';
import { NexusDeviceNotFoundError } from '../registry-errors.js';

let testDir: string;
const saved: Record<string, string | undefined> = {};
const NOW = new Date('2026-09-29T12:00:00.000Z');
const FRESH = '2026-09-29T11:00:00.000Z';
const OLD = '2026-09-01T00:00:00.000Z';

beforeEach(async () => {
  testDir = realpathSync(await mkdtemp(join(tmpdir(), 'cleo-fleet-T12513-')));
  saved['CLEO_HOME'] = process.env['CLEO_HOME'];
  process.env['CLEO_HOME'] = join(testDir, 'cleo-home');
  mkdirSync(process.env['CLEO_HOME'], { recursive: true });
  _resetDeviceIdCacheForTests();
});

afterEach(async () => {
  await awaitBackgroundOps();
  resetDbState();
  const { resetNexusDbState } = await import('../../store/nexus-sqlite.js');
  resetNexusDbState();
  _resetDeviceIdCacheForTests();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

async function registry(): Promise<NodeSQLiteDatabase> {
  const { getNexusRegistryDb } = await import('../../store/nexus-sqlite.js');
  return getNexusRegistryDb(getCleoHome());
}

function addProject(db: NodeSQLiteDatabase, projectId: string, name: string): void {
  db.insert(projectRegistry)
    .values({ projectId, name, projectHash: `h-${projectId}`, projectPath: `/p/${projectId}` })
    .run();
}

function addDevice(db: NodeSQLiteDatabase, deviceId: string, hostname: string, beat: string): void {
  db.insert(devices)
    .values({
      deviceId,
      hostname,
      os: 'linux',
      arch: 'x64',
      cleoVersion: '2026.9.23',
      firstSeen: beat,
      lastHeartbeatAt: beat,
    })
    .run();
}

function addLocation(
  db: NodeSQLiteDatabase,
  projectId: string,
  deviceId: string,
  path: string,
  git: Omit<NewProjectGitStateRow, 'projectId' | 'deviceId' | 'path'> | null,
  state: 'live' | 'missing' | 'superseded' = 'live',
): void {
  db.insert(projectLocations).values({ projectId, deviceId, path, state, lastSeen: FRESH }).run();
  if (git !== null)
    db.insert(projectGitState)
      .values({ projectId, deviceId, path, ...git })
      .run();
}

/** Clean, fresh, in sync with a fresh fetch. */
const clean = {
  branch: 'main',
  headSha: 'a'.repeat(40),
  dirtyCount: 0,
  untrackedCount: 0,
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  remoteName: 'origin',
  remoteUrl: 'https://example.com/r.git',
  remoteHeadSha: 'a'.repeat(40),
  remoteFetchedAt: FRESH,
  probedAt: FRESH,
};

/**
 * Fleet: devices `desk` (current) and `lap`; projects:
 * - alpha: clean on desk, dirty+behind on lap
 * - beta: missing on desk
 * - gamma: never probed on lap, superseded (hidden) on desk
 * - delta: clean on desk but fetched long ago (stale remote)
 * - omega: no location at all
 */
function seedFleet(db: NodeSQLiteDatabase): void {
  addDevice(db, 'dev-desk', 'desk', FRESH);
  addDevice(db, 'dev-lap', 'Lap', OLD);
  for (const [id, name] of [
    ['p-alpha', 'alpha'],
    ['p-beta', 'beta'],
    ['p-gamma', 'gamma'],
    ['p-delta', 'delta'],
    ['p-omega', 'omega'],
  ] as const) {
    addProject(db, id, name);
  }
  addLocation(db, 'p-alpha', 'dev-desk', '/desk/alpha', clean);
  addLocation(db, 'p-alpha', 'dev-lap', '/lap/alpha', {
    ...clean,
    dirtyCount: 2,
    untrackedCount: 1,
    behind: 3,
    ahead: 1,
  });
  addLocation(
    db,
    'p-beta',
    'dev-desk',
    '/desk/beta',
    {
      probedAt: FRESH,
      probeErrorCode: 'E_PATH_MISSING',
      probeError: 'directory does not exist: /desk/beta',
    },
    'missing',
  );
  addLocation(db, 'p-gamma', 'dev-lap', '/lap/gamma', null);
  addLocation(db, 'p-gamma', 'dev-desk', '/desk/old-gamma', clean, 'superseded');
  addLocation(db, 'p-delta', 'dev-desk', '/desk/delta', { ...clean, remoteFetchedAt: OLD });
}

function names(view: NexusProjectsFleetResult): string[] {
  return view.projects.map((p) => p.name);
}

describe('AC1 — every project with per-device location, git summary and freshness', () => {
  it('lists every project, locations per device, remote as of last fetch', async () => {
    const db = await registry();
    seedFleet(db);
    const view = listFleetStatus(db, {}, { deviceId: 'dev-desk', now: NOW });

    expect(view).toMatchObject({ total: 5, matched: 5, returned: 5, offset: 0, hasMore: false });
    expect(names(view)).toEqual(['alpha', 'beta', 'delta', 'gamma', 'omega']);

    const alpha = view.projects[0];
    expect(alpha?.deviceCount).toBe(2);
    expect(alpha?.flags).toEqual(['dirty', 'behind', 'ahead']);
    expect(alpha?.locations.map((l) => [l.hostname, l.path, l.current])).toEqual([
      ['desk', '/desk/alpha', true],
      ['Lap', '/lap/alpha', false],
    ]);
    const lap = alpha?.locations[1];
    expect(lap?.git).toMatchObject({
      branch: 'main',
      dirtyCount: 2,
      untrackedCount: 1,
      probedAt: FRESH,
      probeStale: false,
      remote: { upstream: 'origin/main', ahead: 1, behind: 3, fetchedAt: FRESH, stale: false },
    });
    // Probe and fetch are fresh; the lap's OLD heartbeat shows on the device list only.
    expect(lap?.flags).toEqual(['dirty', 'behind', 'ahead']);

    const beta = view.projects[1];
    expect(beta?.locations[0]).toMatchObject({ state: 'missing', flags: ['missing', 'errored'] });

    const delta = view.projects[2];
    expect(delta?.locations[0]?.git?.remote).toMatchObject({ fetchedAt: OLD, stale: true });
    expect(delta?.flags).toEqual(['stale']);

    const gamma = view.projects[3];
    expect(gamma?.locations).toHaveLength(1); // the superseded path is history, not presence
    expect(gamma?.locations[0]).toMatchObject({ git: null, flags: ['stale', 'unprobed'] });

    expect(view.projects[4]).toMatchObject({ name: 'omega', deviceCount: 0, locations: [] });
  });

  it('counts come first: fleet summary and per-device counts', async () => {
    const db = await registry();
    seedFleet(db);
    const view = listFleetStatus(db, {}, { deviceId: 'dev-desk', now: NOW });
    expect(Object.keys(view).slice(0, 3)).toEqual(['total', 'matched', 'returned']);
    expect(view.summary).toEqual({
      located: 4,
      locations: 5,
      missing: 1,
      dirty: 1,
      behind: 1,
      ahead: 1,
      stale: 2, // delta (old fetch), gamma (never probed)
      errored: 1,
      unprobed: 1,
    });
    const desk = view.devices.find((d) => d.deviceId === 'dev-desk');
    const lap = view.devices.find((d) => d.deviceId === 'dev-lap');
    expect(desk).toMatchObject({ current: true, heartbeatStale: false, locations: 3, missing: 1 });
    expect(lap).toMatchObject({
      current: false,
      heartbeatStale: true,
      locations: 2,
      dirty: 1,
      stale: 1,
    });
    expect(view.devices[0]?.deviceId).toBe('dev-desk');
  });
});

describe('AC3 — filters for missing, dirty, behind and stale (plus ahead, errored, device)', () => {
  it('each filter keeps exactly the projects with a matching location', async () => {
    const db = await registry();
    seedFleet(db);
    const at = (p: Parameters<typeof listFleetStatus>[1]) =>
      names(listFleetStatus(db, p, { deviceId: 'dev-desk', now: NOW }));
    expect(at({ missing: true })).toEqual(['beta']);
    expect(at({ dirty: true })).toEqual(['alpha']);
    expect(at({ behind: true })).toEqual(['alpha']);
    expect(at({ ahead: true })).toEqual(['alpha']);
    expect(at({ errored: true })).toEqual(['beta']);
    expect(at({ stale: true })).toEqual(['delta', 'gamma']);
  });

  it('filters combine with AND on one location, and scope to a device', async () => {
    const db = await registry();
    seedFleet(db);
    const view = (p: Parameters<typeof listFleetStatus>[1]) =>
      listFleetStatus(db, p, { deviceId: 'dev-desk', now: NOW });
    const both = view({ dirty: true, behind: true });
    expect(names(both)).toEqual(['alpha']);
    // summary and devices are scoped by device only, never by the flag filters.
    const all = view({});
    expect(both.summary).toEqual(all.summary);
    expect(both.devices).toEqual(all.devices);
    expect(both.matched).toBe(1);
    expect(names(view({ dirty: true, missing: true }))).toEqual([]);
    // Dirty only on the lap: scoped to the desk nothing is dirty.
    expect(names(view({ dirty: true, device: 'current' }))).toEqual([]);
    // Hostname match is case-insensitive; locations are scoped to the device.
    const lap = view({ device: 'lap' });
    expect(names(lap)).toEqual(['alpha', 'gamma']);
    expect(lap.projects.flatMap((p) => p.locations.map((l) => l.deviceId))).toEqual([
      'dev-lap',
      'dev-lap',
    ]);
    expect(lap.summary.locations).toBe(2);
    expect(names(view({ device: 'dev-desk' }))).toEqual(['alpha', 'beta', 'delta']);
  });

  it('an unknown device is a typed error, never an empty page', async () => {
    const db = await registry();
    seedFleet(db);
    expect(() => listFleetStatus(db, { device: 'nope' }, { now: NOW })).toThrow(
      NexusDeviceNotFoundError,
    );
    try {
      listFleetStatus(db, { device: 'nope' }, { now: NOW });
    } catch (e) {
      expect((e as NexusDeviceNotFoundError).codeName).toBe('E_NEXUS_DEVICE_NOT_FOUND');
    }
  });

  it('the stale window is honoured for probes and fetches', async () => {
    const db = await registry();
    seedFleet(db);
    // A 60-day window makes delta's fetch fresh; gamma is still never probed.
    const wide = listFleetStatus(
      db,
      { stale: true, staleAfterMs: 60 * 86_400_000 },
      { deviceId: 'dev-desk', now: NOW },
    );
    expect(names(wide)).toEqual(['gamma']);
    // A 1-minute window makes every probe stale.
    const narrow = listFleetStatus(
      db,
      { stale: true, staleAfterMs: 60_000 },
      { deviceId: 'dev-desk', now: NOW },
    );
    expect(names(narrow)).toEqual(['alpha', 'beta', 'delta', 'gamma']);
  });
});

describe('AC2 — SQL LIMIT/OFFSET paging, benchmark under 200 ms at 500 rows', () => {
  it('pages by name with matched/hasMore; limit 0 returns every match; limit is capped', async () => {
    const db = await registry();
    seedFleet(db);
    const p1 = listFleetStatus(db, { limit: 2 }, { deviceId: 'dev-desk', now: NOW });
    expect(p1).toMatchObject({ matched: 5, returned: 2, limit: 2, offset: 0, hasMore: true });
    expect(names(p1)).toEqual(['alpha', 'beta']);
    const p3 = listFleetStatus(db, { limit: 2, offset: 4 }, { deviceId: 'dev-desk', now: NOW });
    expect(p3).toMatchObject({ returned: 1, hasMore: false });
    expect(names(p3)).toEqual(['omega']);
    const all = listFleetStatus(db, { limit: 0 }, { deviceId: 'dev-desk', now: NOW });
    expect(all).toMatchObject({ returned: 5, limit: 0, hasMore: false });
    const capped = listFleetStatus(db, { limit: 10_000 }, { now: NOW });
    expect(capped.limit).toBe(FLEET_DEFAULTS.maxLimit);
    const page = listFleetStatus(db, { stale: true, limit: 1, offset: 1 }, { now: NOW });
    expect(page).toMatchObject({ matched: 2, returned: 1, hasMore: false });
  });

  it('reads 500 projects on 2 devices in under 200 ms (default page, full page, filtered)', async () => {
    const db = await registry();
    addDevice(db, 'dev-a', 'a', FRESH);
    addDevice(db, 'dev-b', 'b', FRESH);
    db.transaction((tx) => {
      for (let i = 0; i < 500; i++) {
        const id = `p${String(i).padStart(4, '0')}`;
        tx.insert(projectRegistry)
          .values({ projectId: id, name: id, projectHash: `h${id}`, projectPath: `/a/${id}` })
          .run();
        for (const dev of ['dev-a', 'dev-b']) {
          const path = `/${dev}/${id}`;
          tx.insert(projectLocations).values({ projectId: id, deviceId: dev, path }).run();
          tx.insert(projectGitState)
            .values({
              projectId: id,
              deviceId: dev,
              path,
              ...clean,
              dirtyCount: i % 7 === 0 ? 1 : 0,
              behind: i % 11 === 0 ? 2 : 0,
              probedAt: i % 5 === 0 ? OLD : FRESH,
            })
            .run();
        }
      }
    });
    // Warm the statement cache once, then measure.
    listFleetStatus(db, {}, { deviceId: 'dev-a', now: NOW });
    const timed = (
      p: Parameters<typeof listFleetStatus>[1],
    ): [number, NexusProjectsFleetResult] => {
      const t0 = performance.now();
      const v = listFleetStatus(db, p, { deviceId: 'dev-a', now: NOW });
      return [performance.now() - t0, v];
    };
    const [msDefault, def] = timed({});
    const [msFull, full] = timed({ limit: 500 });
    const [msFiltered, filtered] = timed({ dirty: true, behind: true, device: 'b' });
    expect(def).toMatchObject({ total: 500, matched: 500, returned: 50 });
    expect(full.returned).toBe(500);
    expect(full.projects.every((p) => p.locations.length === 2)).toBe(true);
    expect(full.summary).toMatchObject({ located: 500, locations: 1000, stale: 100 });
    expect(filtered.matched).toBe(Math.floor(499 / 77) + 1); // i % 77 === 0
    expect(msDefault).toBeLessThan(200);
    expect(msFull).toBeLessThan(200);
    expect(msFiltered).toBeLessThan(200);
  });
});

describe('refresh — the bounded probe writes rows the fleet view then reads', () => {
  const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: 'pipe' }).trim();

  it('local and remote state appear with timestamps; last_probed_at moves, last_opened_at does not', async () => {
    const seed = join(testDir, 'seed');
    mkdirSync(seed);
    git(seed, 'init', '-q', '-b', 'main');
    writeFileSync(join(seed, 'a.txt'), 'a\n');
    git(seed, 'add', 'a.txt');
    git(seed, 'commit', '-q', '-m', 'one');
    const remote = join(testDir, 'r.git');
    git(testDir, 'clone', '-q', '--bare', seed, remote);
    const clone = join(testDir, 'clone');
    git(testDir, 'clone', '-q', remote, clone);
    // Upstream advances; the clone learns of it only by fetching.
    writeFileSync(join(seed, 'b.txt'), 'b\n');
    git(seed, 'add', 'b.txt');
    git(seed, 'commit', '-q', '-m', 'two');
    git(seed, 'push', '-q', remote, 'main');
    writeFileSync(join(clone, 'dirty.txt'), 'x\n');

    const db = await registry();
    addProject(db, 'p-clone', 'clone');
    db.insert(projectLocations)
      .values({ projectId: 'p-clone', deviceId: 'dev-a', path: clone })
      .run();

    const before = listFleetStatus(db, {}, { deviceId: 'dev-a' });
    expect(before.projects[0]?.flags).toEqual(['stale', 'unprobed']);

    // No fetch: behind reads 0 from the tracking ref, but the clone never
    // fetched, so the remote side is reported stale rather than "up to date".
    await runProjectsGitStatus(db, {}, { deviceId: 'dev-a' });
    const noFetch = listFleetStatus(db, {}, { deviceId: 'dev-a' });
    const loc = noFetch.projects[0]?.locations[0];
    expect(loc?.git).toMatchObject({ branch: 'main', untrackedCount: 1, probeStale: false });
    expect(loc?.git?.remote).toMatchObject({
      upstream: 'origin/main',
      behind: 0,
      fetchedAt: null,
      stale: true,
    });
    expect(loc?.flags).toEqual(['dirty', 'stale']);
    // T12721: HEAD's commit instant, no replica id yet, a presence schema version.
    expect(loc?.git?.headCommittedAt).toBe(
      new Date(git(clone, 'log', '-1', '--format=%cI')).toISOString(),
    );
    expect(loc?.replicaId).toBeNull();
    expect(noFetch.schemaVersion).toBe(NEXUS_FLEET_SCHEMA_VERSION);

    // Fetch: behind is now 1, with a fresh fetchedAt.
    await runProjectsGitStatus(db, { fetch: true }, { deviceId: 'dev-a' });
    const fetched = listFleetStatus(db, { behind: true }, { deviceId: 'dev-a' });
    expect(fetched.matched).toBe(1);
    const remoteView = fetched.projects[0]?.locations[0]?.git?.remote;
    expect(remoteView?.behind).toBe(1);
    expect(remoteView?.fetchedAt).not.toBeNull();
    expect(remoteView?.stale).toBe(false);

    expect(fetched.projects[0]?.lastProbedAt).not.toBeNull();
    expect(fetched.projects[0]?.lastOpenedAt).toBeNull();
  });
});

describe('human render', () => {
  it('prints counts first, then one block per project with a line per device', async () => {
    const { renderNexusProjectsFleet } = await import('../../render/nexus/index.js');
    const db = await registry();
    seedFleet(db);
    const view = listFleetStatus(db, { limit: 2 }, { deviceId: 'dev-desk', now: NOW });
    const out = renderNexusProjectsFleet({ ...view }, false);
    expect(out.split('\n')[0]).toBe(
      '[nexus] Fleet: 5/5 project(s) match; showing 2 from offset 0 (more: raise --offset)',
    );
    expect(out).toContain('alpha  (p-alpha)  devices=2');
    expect(out).toMatch(/Lap\s+main\s+~2 \+1\s+↑1 ↓3/);
    expect(out).toContain('[missing,errored]');
    expect(renderNexusProjectsFleet({ ...view }, true)).toBe('');
  });
});
