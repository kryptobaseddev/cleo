/**
 * Devices (T12510): throttled heartbeat, stable device id, and name-lookup
 * ambiguity in the project registry.
 *
 * Every case runs against a temp `CLEO_HOME`.
 *
 * @task T12510
 */

import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetDeviceIdCacheForTests, getStableDeviceId } from '../../llm/stable-device-id.js';
import { getCleoHome } from '../../paths.js';
import { awaitBackgroundOps } from '../../store/background-ops.js';
import { devices, projectRegistry } from '../../store/schema/nexus-schema.js';
import { resetDbState } from '../../store/sqlite.js';
import {
  DEVICE_HEARTBEAT_INTERVAL_MS,
  DEVICE_HEARTBEAT_STAMP,
  heartbeatThisDevice,
  listNexusDevices,
  recordDeviceHeartbeat,
} from '../devices.js';
import { NexusProjectAmbiguityError, nexusGetProject, nexusProjectsList } from '../registry.js';

let testDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  testDir = realpathSync(await mkdtemp(join(tmpdir(), 'cleo-devices-T12510-')));
  saved['CLEO_HOME'] = process.env['CLEO_HOME'];
  saved['CLEO_DISABLE_DEVICE_HEARTBEAT'] = process.env['CLEO_DISABLE_DEVICE_HEARTBEAT'];
  delete process.env['CLEO_DISABLE_DEVICE_HEARTBEAT'];
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

async function registryDb() {
  const { getNexusRegistryDb } = await import('../../store/nexus-sqlite.js');
  return getNexusRegistryDb(getCleoHome());
}

const facts = { hostname: 'box', os: 'linux', arch: 'x64', cleoVersion: '1.0.0' };

describe('stable device id (T12510)', () => {
  it('is persisted once and identical across runs', () => {
    const first = getStableDeviceId();
    const file = join(getCleoHome(), 'device-id');
    expect(readFileSync(file, 'utf8').trim()).toBe(first);
    // A new process: the in-memory cache is gone, the file is the truth.
    _resetDeviceIdCacheForTests();
    expect(getStableDeviceId()).toBe(first);
    _resetDeviceIdCacheForTests();
    expect(getStableDeviceId()).toBe(first);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('recordDeviceHeartbeat (T12510)', () => {
  it('writes once, throttles inside the interval, refreshes after it', async () => {
    const db = await registryDb();
    const t0 = new Date('2026-09-27T10:00:00.000Z');
    expect(await recordDeviceHeartbeat(db, t0, facts)).toBe('written');
    const inside = new Date(t0.getTime() + DEVICE_HEARTBEAT_INTERVAL_MS - 1);
    expect(await recordDeviceHeartbeat(db, inside, { ...facts, cleoVersion: '9.9.9' })).toBe(
      'throttled',
    );
    let rows = db.select().from(devices).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      deviceId: getStableDeviceId(),
      hostname: 'box',
      cleoVersion: '1.0.0',
      firstSeen: t0.toISOString(),
      lastHeartbeatAt: t0.toISOString(),
    });

    const after = new Date(t0.getTime() + DEVICE_HEARTBEAT_INTERVAL_MS + 1);
    expect(await recordDeviceHeartbeat(db, after, { ...facts, cleoVersion: '2.0.0' })).toBe(
      'written',
    );
    rows = db.select().from(devices).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      cleoVersion: '2.0.0',
      firstSeen: t0.toISOString(),
      lastHeartbeatAt: after.toISOString(),
    });
  });

  it('lists devices newest heartbeat first and marks the current one', async () => {
    const db = await registryDb();
    await recordDeviceHeartbeat(db, new Date('2026-09-27T09:00:00.000Z'), {
      ...facts,
      deviceId: 'other-device',
      hostname: 'far',
    });
    await recordDeviceHeartbeat(db, new Date('2026-09-27T10:00:00.000Z'), facts);
    const listed = listNexusDevices(db);
    expect(listed.map((d) => [d.hostname, d.current])).toEqual([
      ['box', true],
      ['far', false],
    ]);
  });
});

describe('heartbeatThisDevice (CLI start, T12510)', () => {
  it('never creates the store, then writes at most once per interval', async () => {
    const home = getCleoHome();
    const t0 = new Date('2026-09-27T10:00:00.000Z');
    expect(await heartbeatThisDevice({ cleoHome: home, now: t0 })).toBe('no-store');

    const db = await registryDb();
    expect(await heartbeatThisDevice({ cleoHome: home, now: t0 })).toBe('written');
    expect(existsSync(join(home, DEVICE_HEARTBEAT_STAMP))).toBe(true);
    // Inside the interval the stamp answers without touching the database.
    expect(
      await heartbeatThisDevice({ cleoHome: home, now: new Date(t0.getTime() + 30_000) }),
    ).toBe('throttled');
    expect(
      await heartbeatThisDevice({
        cleoHome: home,
        now: new Date(t0.getTime() + DEVICE_HEARTBEAT_INTERVAL_MS + 1),
      }),
    ).toBe('written');
    const rows = db.select().from(devices).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deviceId).toBe(getStableDeviceId());
    expect(rows[0]?.os).toBe(process.platform);
  });

  it('is disabled by CLEO_DISABLE_DEVICE_HEARTBEAT=1', async () => {
    process.env['CLEO_DISABLE_DEVICE_HEARTBEAT'] = '1';
    expect(await heartbeatThisDevice()).toBe('disabled');
  });

  it('surfaces devices in nexus.projects.list', async () => {
    const db = await registryDb();
    await recordDeviceHeartbeat(db, new Date(), facts);
    const result = await nexusProjectsList();
    expect(result.success).toBe(true);
    const data = result.data as { devices: Array<{ hostname: string; current: boolean }> };
    expect(data.devices).toEqual([expect.objectContaining({ hostname: 'box', current: true })]);
  });
});

describe('registry lookup by name (T12510)', () => {
  async function seed(): Promise<void> {
    const db = await registryDb();
    const row = (projectId: string, hash: string, path: string, lastSeen: string) => ({
      projectId,
      projectHash: hash,
      projectPath: path,
      name: 'shared-name',
      lastSeen,
    });
    db.insert(projectRegistry)
      .values([
        row('id-older', 'hash-older', '/w/older', '2026-09-01T00:00:00.000Z'),
        row('id-newer', 'hash-newer', '/w/newer', '2026-09-02T00:00:00.000Z'),
      ])
      .run();
    db.insert(projectRegistry)
      .values({
        projectId: 'id-solo',
        projectHash: 'hash-solo',
        projectPath: '/w/solo',
        name: 'solo',
      })
      .run();
  }

  it('throws a typed ambiguity error listing every candidate id', async () => {
    await seed();
    const err = await nexusGetProject('', { name: 'shared-name' }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(NexusProjectAmbiguityError);
    const ambiguity = err as NexusProjectAmbiguityError;
    expect(ambiguity.codeName).toBe('E_NEXUS_PROJECT_AMBIGUOUS');
    expect(ambiguity.candidates.map((c) => c.projectId)).toEqual(['id-newer', 'id-older']);
    expect(ambiguity.message).toContain('id-newer');
    expect(ambiguity.message).toContain('id-older');
  });

  it('resolves a unique name, an id and a hash unchanged', async () => {
    await seed();
    expect((await nexusGetProject('', { name: 'solo' }))?.projectId).toBe('id-solo');
    expect((await nexusGetProject('', { name: 'id-older' }))?.projectId).toBe('id-older');
    expect((await nexusGetProject('', { name: 'hash-newer' }))?.projectId).toBe('id-newer');
    expect(await nexusGetProject('', { name: 'nope' })).toBeNull();
  });

  it('maps ambiguity to a typed engine error in nexus.show', async () => {
    await seed();
    const { nexusShowProject } = await import('../registry.js');
    const result = await nexusShowProject('shared-name');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_NEXUS_PROJECT_AMBIGUOUS');
    const details = result.error?.details as { candidates: Array<{ projectId: string }> };
    expect(details.candidates.map((c) => c.projectId)).toEqual(['id-newer', 'id-older']);
  });
});
