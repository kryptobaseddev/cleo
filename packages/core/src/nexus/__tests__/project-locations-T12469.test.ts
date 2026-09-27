/**
 * Registry keyed by project_id alone, with per-device locations (T12469).
 *
 * - A project seen at two paths on two devices has ONE registry row and TWO
 *   location rows; one device never marks another device's path missing.
 * - A path that now holds a different project registers that project and
 *   supersedes the old project's location instead of failing; the old registry
 *   row is moved off the path so older binaries never see two rows at one path.
 * - Rows the migration backfilled under the `local` sentinel are adopted by
 *   this device's stable id.
 *
 * Every case runs against a temp `CLEO_HOME`.
 *
 * @task T12469
 */

import { cpSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCleoHome, recordProjectEncounter } from '../../paths.js';
import { awaitBackgroundOps } from '../../store/background-ops.js';
import { getNexusRegistryDbPath } from '../../store/nexus-sqlite.js';
import { validateProjectIdConsistency } from '../../store/open-cleo-db.js';
import { resetDbState } from '../../store/sqlite.js';
import { getDbSyncConstructor } from '../../store/sqlite-native.js';
import { generateProjectHash } from '../hash.js';
import {
  currentDeviceId,
  LOCAL_DEVICE_SENTINEL,
  listProjectCheckouts,
  recordProjectCheckout,
  supersededRegistryPath,
} from '../path-map.js';

let testDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  // Canonical (realpath) form: registry writers store resolved paths, and
  // macOS /tmp is a symlink to /private/tmp.
  testDir = realpathSync(await mkdtemp(join(tmpdir(), 'cleo-locations-T12469-')));
  saved['CLEO_HOME'] = process.env['CLEO_HOME'];
  process.env['CLEO_HOME'] = join(testDir, 'cleo-home');
  mkdirSync(process.env['CLEO_HOME'], { recursive: true });
});

afterEach(async () => {
  await awaitBackgroundOps();
  resetDbState();
  const { resetNexusDbState } = await import('../../store/nexus-sqlite.js');
  resetNexusDbState();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

/** Create an initialised-looking project with an immutable id. */
function makeProject(root: string, projectId: string): string {
  mkdirSync(join(root, '.cleo'), { recursive: true });
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.cleo', 'project-info.json'), JSON.stringify({ projectId }));
  return root;
}

async function registryDb() {
  const { getNexusRegistryDb } = await import('../../store/nexus-sqlite.js');
  const schema = await import('../../store/schema/nexus-schema.js');
  return { db: await getNexusRegistryDb(getCleoHome()), ...schema };
}

describe('one project on two devices (T12469)', () => {
  it('keeps one registry row and one location per device', async () => {
    const here = makeProject(join(testDir, 'here'), 'roam-T12469');
    expect(await recordProjectEncounter(here)).toBe('recorded');

    const { db, projectRegistry, projectLocations } = await registryDb();
    // The same project seen on another device at another (absent here) path.
    const elsewhere = '/Volumes/other-device/roam';
    db.transaction((tx) =>
      recordProjectCheckout(tx, {
        projectId: 'roam-T12469',
        projectPath: elsewhere,
        now: new Date().toISOString(),
        deviceId: 'device-2',
      }),
    );
    // Back on this device: the other device's path is not checked, so it
    // must not be marked missing from here.
    db.transaction((tx) =>
      recordProjectCheckout(tx, {
        projectId: 'roam-T12469',
        projectPath: here,
        now: new Date().toISOString(),
      }),
    );

    const rows = db
      .select()
      .from(projectRegistry)
      .where(eq(projectRegistry.projectId, 'roam-T12469'))
      .all();
    expect(rows).toHaveLength(1);

    const locations = db
      .select()
      .from(projectLocations)
      .where(eq(projectLocations.projectId, 'roam-T12469'))
      .all()
      .map((r) => ({ deviceId: r.deviceId, path: r.path, state: r.state }))
      .sort((a, b) => a.path.localeCompare(b.path));
    expect(locations).toEqual(
      [
        { deviceId: 'device-2', path: elsewhere, state: 'live' },
        { deviceId: currentDeviceId(), path: here, state: 'live' },
      ].sort((a, b) => a.path.localeCompare(b.path)),
    );

    expect((await listProjectCheckouts('roam-T12469')).map((c) => c.projectPath)).toEqual([here]);
    const everywhere = await listProjectCheckouts('roam-T12469', { allDevices: true });
    expect(everywhere).toHaveLength(2);
    expect(everywhere.find((c) => c.deviceId === 'device-2')?.exists).toBe(false);
  });
});

/**
 * What an OLDER binary sharing this global store sees at `path`: its drift
 * check (`WHERE project_path = ? LIMIT 1`, no ORDER BY), its registration owner
 * filter (path OR hash OR id), and its path-map fast path.
 */
function olderBinaryView(
  path: string,
  projectId: string,
): { driftRow?: string; owners: string[]; mapped?: string } {
  const Ctor = getDbSyncConstructor();
  const native = new Ctor(getNexusRegistryDbPath(getCleoHome()));
  try {
    const driftRow = native
      .prepare(
        'SELECT project_id, project_path FROM nexus_project_registry WHERE project_path = ? LIMIT 1',
      )
      .get(path) as { project_id: string } | undefined;
    const owners = (
      native
        .prepare(
          'SELECT project_id FROM nexus_project_registry WHERE project_path = ? OR project_hash = ? OR project_id = ?',
        )
        .all(path, generateProjectHash(path), projectId) as Array<{ project_id: string }>
    ).map((r) => r.project_id);
    const mapped = native
      .prepare('SELECT project_id FROM nexus_project_paths WHERE project_path = ?')
      .get(path) as { project_id: string } | undefined;
    return { driftRow: driftRow?.project_id, owners, mapped: mapped?.project_id };
  } finally {
    native.close();
  }
}

/** Whether the current drift check accepts `dir`. */
function driftCheckPasses(dir: string): boolean {
  const Ctor = getDbSyncConstructor();
  const native = new Ctor(getNexusRegistryDbPath(getCleoHome()));
  try {
    validateProjectIdConsistency('global', native, dir);
    return true;
  } catch {
    return false;
  } finally {
    native.close();
  }
}

describe('a path that now holds another project (T12469)', () => {
  it('registers the new id and moves the old row off the path to a sentinel', async () => {
    const dir = makeProject(join(testDir, 'reused'), 'old-T12469');
    await recordProjectEncounter(dir);
    writeFileSync(
      join(dir, '.cleo', 'project-info.json'),
      JSON.stringify({ projectId: 'new-T12469' }),
    );
    expect(await recordProjectEncounter(dir)).toBe('recorded');

    const { db, projectRegistry, projectLocations } = await registryDb();
    // Never two registry rows at one real path.
    const atPath = db
      .select({ projectId: projectRegistry.projectId })
      .from(projectRegistry)
      .where(eq(projectRegistry.projectPath, dir))
      .all()
      .map((r) => r.projectId);
    expect(atPath).toEqual(['new-T12469']);
    // The old project had no other live location: non-path sentinel.
    const old = db
      .select()
      .from(projectRegistry)
      .where(eq(projectRegistry.projectId, 'old-T12469'))
      .get();
    expect(old?.projectPath).toBe(supersededRegistryPath('old-T12469'));
    expect(old?.projectHash).toBe(generateProjectHash(supersededRegistryPath('old-T12469')));

    const stateOf = (projectId: string) =>
      db
        .select({ state: projectLocations.state })
        .from(projectLocations)
        .where(and(eq(projectLocations.projectId, projectId), eq(projectLocations.path, dir)))
        .get()?.state;
    expect(stateOf('old-T12469')).toBe('superseded');
    expect(stateOf('new-T12469')).toBe('live');

    // Older binaries: drift query, owner filter and path map all see only the new id.
    expect(olderBinaryView(dir, 'new-T12469')).toEqual({
      driftRow: 'new-T12469',
      owners: ['new-T12469'],
      mapped: 'new-T12469',
    });
    expect(driftCheckPasses(dir)).toBe(true);
  });

  it('re-homes the old row to its most recent other live checkout', async () => {
    const first = makeProject(join(testDir, 'first'), 'moved-T12469');
    await recordProjectEncounter(first);
    const second = join(testDir, 'second');
    cpSync(first, second, { recursive: true });
    await recordProjectEncounter(second);
    // `second` now changes hands.
    writeFileSync(
      join(second, '.cleo', 'project-info.json'),
      JSON.stringify({ projectId: 'taker-T12469' }),
    );
    expect(await recordProjectEncounter(second)).toBe('recorded');

    const { db, projectRegistry } = await registryDb();
    const moved = db
      .select()
      .from(projectRegistry)
      .where(eq(projectRegistry.projectId, 'moved-T12469'))
      .get();
    expect(moved?.projectPath).toBe(first);
    expect(moved?.projectHash).toBe(generateProjectHash(first));

    expect(olderBinaryView(second, 'taker-T12469')).toEqual({
      driftRow: 'taker-T12469',
      owners: ['taker-T12469'],
      mapped: 'taker-T12469',
    });
    expect(olderBinaryView(first, 'moved-T12469').driftRow).toBe('moved-T12469');
    expect(driftCheckPasses(second)).toBe(true);
    expect(driftCheckPasses(first)).toBe(true);
  });
});

describe('migration-backfilled locations (T12469)', () => {
  it('are adopted by this device on the next write', async () => {
    const dir = makeProject(join(testDir, 'adopt'), 'adopt-T12469');
    await recordProjectEncounter(dir);
    const { db, projectLocations } = await registryDb();
    const gone = join(testDir, 'gone');
    db.insert(projectLocations)
      .values({
        projectId: 'adopt-T12469',
        deviceId: LOCAL_DEVICE_SENTINEL,
        path: gone,
        firstSeen: '2026-01-01T00:00:00.000Z',
        lastSeen: '2026-01-01T00:00:00.000Z',
        state: 'live',
      })
      .run();

    db.transaction((tx) =>
      recordProjectCheckout(tx, {
        projectId: 'adopt-T12469',
        projectPath: dir,
        now: new Date().toISOString(),
      }),
    );

    const rows = db
      .select()
      .from(projectLocations)
      .where(eq(projectLocations.projectId, 'adopt-T12469'))
      .all();
    expect(rows.some((r) => r.deviceId === LOCAL_DEVICE_SENTINEL)).toBe(false);
    const adopted = rows.find((r) => r.path === gone);
    expect(adopted?.deviceId).toBe(currentDeviceId());
    // Adopted, then found vanished: kept as missing, never deleted.
    expect(adopted?.state).toBe('missing');
    expect(adopted?.firstSeen).toBe('2026-01-01T00:00:00.000Z');
  });
});
