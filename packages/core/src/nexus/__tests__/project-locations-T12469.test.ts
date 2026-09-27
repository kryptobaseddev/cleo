/**
 * Registry keyed by project_id alone, with per-device locations (T12469).
 *
 * - A project seen at two paths on two devices has ONE registry row and TWO
 *   location rows; one device never marks another device's path missing.
 * - A path that now holds a different project registers that project (no
 *   UNIQUE path) and supersedes the old project's location instead of failing.
 * - Rows the migration backfilled under the `local` sentinel are adopted by
 *   this device's stable id.
 *
 * Every case runs against a temp `CLEO_HOME`.
 *
 * @task T12469
 */

import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCleoHome, recordProjectEncounter } from '../../paths.js';
import { awaitBackgroundOps } from '../../store/background-ops.js';
import { resetDbState } from '../../store/sqlite.js';
import {
  currentDeviceId,
  LOCAL_DEVICE_SENTINEL,
  listProjectCheckouts,
  recordProjectCheckout,
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

describe('a path that now holds another project (T12469)', () => {
  it('registers the new id at the same path and supersedes the old location', async () => {
    const dir = makeProject(join(testDir, 'reused'), 'old-T12469');
    await recordProjectEncounter(dir);
    writeFileSync(
      join(dir, '.cleo', 'project-info.json'),
      JSON.stringify({ projectId: 'new-T12469' }),
    );
    expect(await recordProjectEncounter(dir)).toBe('recorded');

    const { db, projectRegistry, projectLocations } = await registryDb();
    const atPath = db
      .select({ projectId: projectRegistry.projectId })
      .from(projectRegistry)
      .where(eq(projectRegistry.projectPath, dir))
      .all()
      .map((r) => r.projectId)
      .sort();
    expect(atPath).toEqual(['new-T12469', 'old-T12469']);

    const stateOf = (projectId: string) =>
      db
        .select({ state: projectLocations.state })
        .from(projectLocations)
        .where(and(eq(projectLocations.projectId, projectId), eq(projectLocations.path, dir)))
        .get()?.state;
    expect(stateOf('old-T12469')).toBe('superseded');
    expect(stateOf('new-T12469')).toBe('live');

    // The id-drift check prefers the row naming the caller's id.
    const { validateProjectIdConsistency } = await import('../../store/open-cleo-db.js');
    const { getDbSyncConstructor } = await import('../../store/sqlite-native.js');
    const { getNexusRegistryDbPath } = await import('../../store/nexus-sqlite.js');
    const Ctor = getDbSyncConstructor();
    const native = new Ctor(getNexusRegistryDbPath(getCleoHome()));
    try {
      expect(() => validateProjectIdConsistency('global', native, dir)).not.toThrow();
    } finally {
      native.close();
    }
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
