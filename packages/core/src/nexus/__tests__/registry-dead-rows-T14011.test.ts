/**
 * Dead registry rows (T14011): `summarizeRegistryHealth` counts rows by
 * recorded health and names the dry-run clean command, and
 * `projects clean --unhealthy` matches rows recorded unreachable whose path no
 * longer answers. Before, it matched `healthStatus === 'unhealthy'`, a value
 * the registry never stores.
 *
 * Each case redirects `CLEO_HOME` to a tmp dir, so no real registry is touched.
 *
 * @task T14011
 */

import { mkdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NexusHealthStatus } from '../registry.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'cleo-registry-dead-rows-T14011-'));
  process.env['CLEO_HOME'] = join(testDir, 'cleo-home');
  await mkdir(process.env['CLEO_HOME'], { recursive: true });
});

afterEach(async () => {
  const { resetDbState } = await import('../../store/sqlite.js');
  resetDbState();
  const { resetNexusDbState } = await import('../../store/nexus-sqlite.js');
  resetNexusDbState();
  delete process.env['CLEO_HOME'];
  await rm(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

/** Insert a registry row with a recorded health status. */
async function seedRow(
  projectId: string,
  projectPath: string,
  healthStatus: NexusHealthStatus,
): Promise<void> {
  const { getNexusRegistryDb } = await import('../../store/nexus-sqlite.js');
  const { getCleoHome } = await import('../../paths.js');
  const { projectRegistry } = await import('../../store/schema/nexus-schema.js');
  const db = await getNexusRegistryDb(getCleoHome());
  const now = new Date().toISOString();
  db.insert(projectRegistry)
    .values({
      projectId,
      projectHash: projectId.padEnd(12, '0').slice(0, 12),
      projectPath,
      name: projectId,
      registeredAt: now,
      lastSeen: now,
      healthStatus,
      healthLastCheck: null,
      permissions: 'read',
      lastSync: now,
      taskCount: 0,
      labelsJson: '[]',
      brainDbPath: join(projectPath, '.cleo', 'cleo.db'),
      tasksDbPath: join(projectPath, '.cleo', 'cleo.db'),
      lastIndexed: null,
    })
    .run();
}

/** Seed one healthy live row, one unreachable gone row, one unreachable live row. */
async function seedRegistry(): Promise<{ gone: string; stillThere: string }> {
  const live = join(testDir, 'live');
  mkdirSync(join(live, '.cleo'), { recursive: true });
  const stillThere = join(testDir, 'still-there');
  mkdirSync(join(stillThere, '.cleo'), { recursive: true });
  const gone = join(testDir, 'gone');
  await seedRow('live-id', live, 'healthy');
  await seedRow('gone-id', gone, 'unreachable');
  await seedRow('still-there-id', stillThere, 'unreachable');
  return { gone, stillThere };
}

describe('dead registry rows (T14011)', () => {
  it('summarizes rows by recorded health and names the dry-run clean command', async () => {
    await seedRegistry();
    const { summarizeRegistryHealth } = await import('../registry.js');

    const summary = await summarizeRegistryHealth();

    expect(summary).toEqual({
      total: 3,
      byStatus: { unknown: 0, healthy: 1, degraded: 0, unreachable: 2 },
      unreachable: 2,
      otherHost: 0,
      cleanCommand: 'cleo nexus projects clean --orphans --dry-run',
    });
  });

  it('omits the clean command when no row is unreachable', async () => {
    const live = join(testDir, 'live');
    mkdirSync(join(live, '.cleo'), { recursive: true });
    await seedRow('live-id', live, 'healthy');
    const { summarizeRegistryHealth } = await import('../registry.js');

    const summary = await summarizeRegistryHealth();

    expect(summary.unreachable).toBe(0);
    expect(summary.cleanCommand).toBeUndefined();
  });

  it('--unhealthy matches an unreachable row whose path is gone, never one that answers', async () => {
    const { gone } = await seedRegistry();
    const { cleanProjects } = await import('../projects-clean.js');

    const preview = await cleanProjects({ dryRun: true, matchUnhealthy: true });

    expect(preview.matched).toBe(1);
    expect(preview.sample).toEqual([gone]);
    expect(preview.matchedByReason).toEqual({ unhealthy: 1 });
    expect(preview.purged).toBe(0);
  });

  it('keeps and reports rows that live on another machine (T14013)', async () => {
    const { gone } = await seedRegistry();
    const fedora = join(testDir, 'fedora-only');
    await seedRow('fedora-id', fedora, 'unreachable');
    await seedRow('legacy-id', '/zz-cleo-no-such-root/projects/app', 'unreachable');
    const { getNexusRegistryDb } = await import('../../store/nexus-sqlite.js');
    const { getCleoHome } = await import('../../paths.js');
    const { projectLocations } = await import('../../store/schema/nexus-schema.js');
    const { currentDeviceId } = await import('../path-map.js');
    const db = await getNexusRegistryDb(getCleoHome());
    db.insert(projectLocations)
      .values([
        { projectId: 'fedora-id', deviceId: 'fedora-device', path: fedora },
        { projectId: 'gone-id', deviceId: currentDeviceId(), path: gone },
      ])
      .run();
    const { cleanProjects } = await import('../projects-clean.js');

    const preview = await cleanProjects({ dryRun: true, matchOrphaned: true });

    expect(preview.sample).toEqual([gone]);
    expect(preview.otherHost).toEqual([
      {
        projectId: 'fedora-id',
        projectPath: fedora,
        host: 'other-host',
        devices: ['fedora-device'],
      },
      {
        projectId: 'legacy-id',
        projectPath: '/zz-cleo-no-such-root/projects/app',
        host: 'foreign-root',
        devices: [],
      },
    ]);
    const { summarizeRegistryHealth } = await import('../registry.js');
    const summary = await summarizeRegistryHealth();
    expect(summary.otherHost).toBe(2);
    expect(summary.unreachable).toBe(2);
  });
});
