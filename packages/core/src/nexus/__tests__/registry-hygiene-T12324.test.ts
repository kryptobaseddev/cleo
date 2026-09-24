/**
 * Registry hygiene (T12324):
 *   - ephemeral-path classification and the encounter auto-register policy;
 *   - registry rows report the live store (`.cleo/cleo.db`), including rows
 *     written before the fix that still name `tasks.db` / `brain.db`;
 *   - `cleanProjects` classifies every row, removes matched rows together with
 *     their aliases and an audit receipt in one transaction, and VACUUMs the
 *     GLOBAL store under `CLEO_HOME`.
 *
 * Each case redirects `CLEO_HOME` to a tmp dir, so no real registry is touched.
 *
 * @task T12324
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCleoDirAbsolute } from '../../paths.js';
import { awaitBackgroundOps, pendingBackgroundOpCount } from '../../store/background-ops.js';
import { resetDbState } from '../../store/sqlite.js';
import { cleanProjects } from '../projects-clean.js';
import {
  isEphemeralPath,
  normalizeRegistryStorePath,
  registryStorePath,
  shouldAutoRegisterProject,
} from '../registry-hygiene.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'cleo-registry-hygiene-T12324-'));
  process.env['CLEO_HOME'] = join(testDir, 'cleo-home');
  await mkdir(process.env['CLEO_HOME'], { recursive: true });
});

afterEach(async () => {
  resetDbState();
  const { resetNexusDbState } = await import('../../store/nexus-sqlite.js');
  resetNexusDbState();
  delete process.env['CLEO_HOME'];
  await rm(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

/** Open the GLOBAL registry store the way `cleanProjects` does. */
async function registryDb() {
  const { getNexusRegistryDb } = await import('../../store/nexus-sqlite.js');
  const { getCleoHome } = await import('../../paths.js');
  return getNexusRegistryDb(getCleoHome());
}

/** Insert a registry row with the legacy per-domain store paths. */
async function seedRow(projectId: string, projectPath: string): Promise<void> {
  const { projectRegistry } = await import('../../store/schema/nexus-schema.js');
  const db = await registryDb();
  const now = new Date().toISOString();
  db.insert(projectRegistry)
    .values({
      projectId,
      projectHash: projectId.padEnd(12, '0').slice(0, 12),
      projectPath,
      name: projectId,
      registeredAt: now,
      lastSeen: now,
      healthStatus: 'unknown',
      healthLastCheck: null,
      permissions: 'read',
      lastSync: now,
      taskCount: 0,
      labelsJson: '[]',
      brainDbPath: join(projectPath, '.cleo', 'brain.db'),
      tasksDbPath: join(projectPath, '.cleo', 'tasks.db'),
      lastIndexed: null,
    })
    .run();
}

/** Insert an alias row. */
async function seedAlias(legacyId: string, canonicalId: string): Promise<void> {
  const { projectIdAliases } = await import('../../store/schema/nexus-schema.js');
  const db = await registryDb();
  db.insert(projectIdAliases).values({ legacyId, canonicalId }).run();
}

describe('registry-hygiene primitives', () => {
  it('classifies OS-temp descendants as ephemeral and a non-temp path as not', () => {
    expect(isEphemeralPath(join(tmpdir(), 'scratch', 'repo'))).toBe(true);
    expect(isEphemeralPath('/home/someone/projects/real')).toBe(false);
  });

  it('refuses auto-registration only for a temp project into a persistent home', () => {
    const tempProject = join(tmpdir(), 'fixture');
    expect(shouldAutoRegisterProject(tempProject, '/home/someone/.local/share/cleo')).toBe(false);
    expect(shouldAutoRegisterProject(tempProject, join(tmpdir(), 'sandbox-home'))).toBe(true);
    expect(shouldAutoRegisterProject('/home/someone/projects/real', '/home/x/.cleo')).toBe(true);
  });

  it('maps legacy store paths to the live cleo.db and leaves others alone', () => {
    expect(normalizeRegistryStorePath('/p/.cleo/tasks.db')).toBe(join('/p', '.cleo', 'cleo.db'));
    expect(normalizeRegistryStorePath('/p/.cleo/brain.db')).toBe(join('/p', '.cleo', 'cleo.db'));
    expect(normalizeRegistryStorePath('/custom/store.db')).toBe('/custom/store.db');
    expect(normalizeRegistryStorePath(null)).toBeNull();
    expect(registryStorePath('/p')).toBe(join('/p', '.cleo', 'cleo.db'));
  });
});

describe('encounter auto-registration policy is wired', () => {
  it('schedules no registration of a temp project into a persistent home', async () => {
    const projectRoot = join(testDir, 'encountered');
    mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
    mkdirSync(join(projectRoot, '.git'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.cleo', 'project-info.json'),
      JSON.stringify({ projectId: 'encounter-T12324' }),
    );
    const saved = {
      home: process.env['CLEO_HOME'],
      root: process.env['CLEO_ROOT'],
      dir: process.env['CLEO_DIR'],
    };
    delete process.env['CLEO_ROOT'];
    delete process.env['CLEO_DIR'];
    // A non-temp home that is never created: any scheduled registration would
    // show up as a pending background op (and try to create it).
    const persistentHome = '/nonexistent-cleo-home-T12324';
    try {
      await awaitBackgroundOps();
      process.env['CLEO_HOME'] = persistentHome;
      getCleoDirAbsolute(projectRoot);
      expect(pendingBackgroundOpCount()).toBe(0);
      expect(existsSync(persistentHome)).toBe(false);

      // Positive control: the same encounter against the sandboxed temp home
      // does schedule registration.
      process.env['CLEO_HOME'] = saved.home;
      getCleoDirAbsolute(projectRoot);
      expect(pendingBackgroundOpCount()).toBeGreaterThan(0);
      await awaitBackgroundOps();
    } finally {
      process.env['CLEO_HOME'] = saved.home;
      if (saved.root !== undefined) process.env['CLEO_ROOT'] = saved.root;
      if (saved.dir !== undefined) process.env['CLEO_DIR'] = saved.dir;
    }
  });
});

describe('registry rows report the live store', () => {
  it('nexusList normalizes a legacy row and nexusRegister writes cleo.db', async () => {
    const { nexusInit, nexusList, nexusRegister } = await import('../registry.js');
    await nexusInit();
    const legacy = join(testDir, 'legacy-project');
    await seedRow('legacy-id', legacy);

    const fresh = join(testDir, 'fresh-project');
    await mkdir(join(fresh, '.cleo'), { recursive: true });
    await nexusRegister(fresh, 'fresh-project');

    const projects = await nexusList();
    const byPath = new Map(projects.map((p) => [p.path, p]));
    expect(byPath.get(legacy)?.tasksDbPath).toBe(join(legacy, '.cleo', 'cleo.db'));
    expect(byPath.get(legacy)?.brainDbPath).toBe(join(legacy, '.cleo', 'cleo.db'));
    expect(byPath.get(fresh)?.tasksDbPath).toBe(join(fresh, '.cleo', 'cleo.db'));

    // The stored column itself is written with the live path for new rows.
    const { projectRegistry } = await import('../../store/schema/nexus-schema.js');
    const db = await registryDb();
    const stored = db
      .select({ tasksDbPath: projectRegistry.tasksDbPath })
      .from(projectRegistry)
      .where(eq(projectRegistry.projectPath, fresh))
      .get();
    expect(stored?.tasksDbPath).toBe(join(fresh, '.cleo', 'cleo.db'));
  });
});

describe('cleanProjects — T12324 classification, aliases, receipt, global vacuum', () => {
  /** Seed: one live non-temp-shaped project, one missing path, one test-shaped dir. */
  async function seedRegistry(): Promise<{ live: string; ghost: string; fixture: string }> {
    const { nexusInit } = await import('../registry.js');
    await nexusInit();
    const live = join(testDir, 'live');
    const ghost = join(testDir, 'ghost-missing');
    const fixture = join(testDir, 'fixture', 'proj');
    await mkdir(live, { recursive: true });
    await mkdir(fixture, { recursive: true });
    await seedRow('live-id', live);
    await seedRow('ghost-id', ghost);
    await seedRow('fixture-id', fixture);
    await seedAlias('ghost-legacy', 'ghost-id');
    await seedAlias('ghost-id', 'ghost-id');
    await seedAlias('fixture-legacy', 'fixture-id');
    await seedAlias('live-legacy', 'live-id');
    // Left behind by a pre-T12324 clean: points at a row that no longer exists.
    await seedAlias('stale-legacy', 'long-gone-id');
    return { live, ghost, fixture };
  }

  it('dry-run classifies every row and reports orphan aliases without deleting', async () => {
    const { ghost } = await seedRegistry();

    const preview = await cleanProjects({ dryRun: true, matchOrphaned: true });

    expect(preview.matched).toBe(1);
    expect(preview.sample).toEqual([ghost]);
    expect(preview.matchedByReason).toEqual({ 'missing-path': 1 });
    expect(preview.receipt).toBeUndefined();
    expect(preview.classification).toMatchObject({
      total: 3,
      missingPath: 1,
      // testDir lives under the fork's `<sandbox>/tmp`, so every row is both
      // temp-shaped and carries a `tmp` segment here.
      tempPath: 3,
      testPath: 3,
      stale: 3,
      retained: 0,
      aliases: 5,
      orphanAliases: 1,
    });

    const { projectRegistry } = await import('../../store/schema/nexus-schema.js');
    const db = await registryDb();
    expect(db.select().from(projectRegistry).all()).toHaveLength(3);
  });

  it('apply removes rows with their aliases and writes one audit receipt', async () => {
    await seedRegistry();

    const result = await cleanProjects({
      dryRun: false,
      matchOrphaned: true,
      // includeTests would match every row inside the fork's `tmp` sandbox.
      pattern: '/fixture/',
      vacuum: true,
    });

    expect(result.purged).toBe(2);
    expect(result.remaining).toBe(1);
    const receipt = result.receipt;
    expect(receipt).toBeDefined();
    if (!receipt) return;
    expect(receipt.removed.map((r) => r.projectId).sort()).toEqual(['fixture-id', 'ghost-id']);
    expect(receipt.removed.find((r) => r.projectId === 'fixture-id')?.reasons).toEqual(['pattern']);
    expect(receipt.aliasesRemoved).toBe(3);
    expect(receipt.orphanAliasesRemoved).toBe(1);

    const { getNexusRegistryDbPath } = await import('../../store/nexus-sqlite.js');
    expect(receipt.storePath).toBe(getNexusRegistryDbPath());
    expect(receipt.storePath).toBe(join(testDir, 'cleo-home', 'cleo.db'));
    expect(receipt.vacuum).toBeDefined();
    expect(receipt.vacuum?.afterBytes).toBeLessThanOrEqual(receipt.vacuum?.beforeBytes ?? 0);

    const { projectIdAliases, projectRegistry, nexusAuditLog } = await import(
      '../../store/schema/nexus-schema.js'
    );
    const db = await registryDb();
    expect(
      db
        .select({ id: projectRegistry.projectId })
        .from(projectRegistry)
        .all()
        .map((r) => r.id),
    ).toEqual(['live-id']);
    expect(
      db
        .select({ legacyId: projectIdAliases.legacyId })
        .from(projectIdAliases)
        .all()
        .map((r) => r.legacyId),
    ).toEqual(['live-legacy']);

    const audit = db
      .select()
      .from(nexusAuditLog)
      .where(eq(nexusAuditLog.id, receipt.auditId))
      .get();
    expect(audit?.action).toBe('projects.clean');
    const details = JSON.parse(audit?.detailsJson ?? '{}') as {
      removed?: Array<{ projectId: string }>;
    };
    expect(details.removed?.map((r) => r.projectId).sort()).toEqual(['fixture-id', 'ghost-id']);
  });
});
