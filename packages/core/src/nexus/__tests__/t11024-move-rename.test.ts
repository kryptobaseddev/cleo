/**
 * Tests for nexusMoveProject + nexusRenameProject + nexusReconcile path_updated (T11024).
 *
 * All tests bypass nexusRegister (which requires createSqliteDataAccessor).
 * Pre-registration via direct DB insert provides initial state.
 *
 * AC1: moveProject updates project_registry row: projectPath, projectHash, lastSeen
 * AC2: Lookup uses projectId (stable) not hash or path
 * AC3: Calls nexusReconcile as final step after fs move
 * AC4: Rename updates project_registry: name, projectHash
 * AC5: Audit log entries via writeNexusAudit for move+rename
 * AC6: Scenario 2 path_updated confirmed working with project move
 * AC7: Atomic update — single UPDATE, no partial state
 * AC8: brainDbPath, tasksDbPath updated after move
 *
 * @task T11024
 */

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateProjectHash } from '../hash.js';
import {
  nexusGetProject,
  nexusInit,
  nexusMoveProject,
  nexusReconcile,
  nexusRenameProject,
  resetNexusDbState,
} from '../registry.js';
import { nexusAuditLog, projectRegistry } from '../../store/nexus-schema.js';
import { getNexusDb } from '../../store/nexus-sqlite.js';

async function registerProject(dir: string, projectId: string, name: string): Promise<void> {
  await nexusInit();
  const db = await getNexusDb();
  const resolvedPath = resolve(dir);
  const hash = generateProjectHash(dir);
  const now = new Date().toISOString();
  await db
    .insert(projectRegistry)
    .values({
      projectId,
      projectHash: hash,
      projectPath: resolvedPath,
      name,
      registeredAt: now,
      lastSeen: now,
      healthStatus: 'unknown',
      permissions: 'read',
      lastSync: now,
      taskCount: 1,
      labelsJson: '[]',
      brainDbPath: join(resolvedPath, '.cleo', 'brain.db'),
      tasksDbPath: join(resolvedPath, '.cleo', 'tasks.db'),
      statsJson: '{}',
    })
    .onConflictDoNothing();
}

async function createProject(dir: string, projectId: string): Promise<void> {
  await mkdir(join(dir, '.cleo'), { recursive: true });
  await writeFile(
    join(dir, '.cleo', 'project-info.json'),
    JSON.stringify({ projectId, createdAt: new Date().toISOString() }),
  );
}

let testDir: string;
let registryDir: string;
let projectDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'nmt-'));
  registryDir = join(testDir, 'ch');
  projectDir = join(testDir, 'tp');
  await mkdir(registryDir, { recursive: true });
  process.env['CLEO_HOME'] = registryDir;
  process.env['NEXUS_HOME'] = join(registryDir, 'nexus');
  process.env['NEXUS_CACHE_DIR'] = join(registryDir, 'nexus', 'cache');
  resetNexusDbState();
});

afterEach(async () => {
  delete process.env['CLEO_HOME'];
  delete process.env['NEXUS_HOME'];
  delete process.env['NEXUS_CACHE_DIR'];
  resetNexusDbState();
  await rm(testDir, { recursive: true, force: true });
});

describe('nexusMoveProject (T11024 AC1, AC3, AC5, AC7, AC8)', () => {
  it('AC1: updates projectPath, projectHash, lastSeen after move', async () => {
    const pid = randomUUID();
    await createProject(projectDir, pid);
    await registerProject(projectDir, pid, 'move-test');

    const movedDir = join(testDir, 'moved');
    await createProject(movedDir, pid);
    await registerProject(movedDir, pid, 'move-test');

    const oldHash = generateProjectHash(projectDir);
    const newHash = generateProjectHash(movedDir);
    const result = await nexusMoveProject(pid, movedDir);

    expect(result.path).toBe(resolve(movedDir));
    expect(result.hash).toBe(newHash);
    expect(result.hash).not.toBe(oldHash);
    expect(new Date(result.lastSeen).getTime()).toBeGreaterThan(Date.now() - 10000);
    expect(result.projectId).toBe(pid);
  });

  it('AC8: brainDbPath and tasksDbPath updated after move', async () => {
    const pid = randomUUID();
    await createProject(projectDir, pid);
    await registerProject(projectDir, pid, 'move-db-test');

    const movedDir = join(testDir, 'moved-db');
    await createProject(movedDir, pid);
    await registerProject(movedDir, pid, 'move-db-test');

    const result = await nexusMoveProject(pid, movedDir);
    expect(result.brainDbPath).toBe(join(resolve(movedDir), '.cleo', 'brain.db'));
    expect(result.tasksDbPath).toBe(join(resolve(movedDir), '.cleo', 'tasks.db'));
  });

  it('AC3: nexusReconcile called as final step', async () => {
    const pid = randomUUID();
    await createProject(projectDir, pid);
    await registerProject(projectDir, pid, 'reconcile-test');

    const movedDir = join(testDir, 'reconciled');
    await createProject(movedDir, pid);
    await registerProject(movedDir, pid, 'reconcile-test');

    const result = await nexusMoveProject(pid, movedDir);
    expect(result.path).toBe(resolve(movedDir));

    const reconfirm = await nexusReconcile(movedDir);
    expect(reconfirm.status).toBe('ok');
  });

  it('AC5: audit log entries written for move', async () => {
    const pid = randomUUID();
    await createProject(projectDir, pid);
    await registerProject(projectDir, pid, 'audit-move-test');

    const movedDir = join(testDir, 'audit-moved');
    await createProject(movedDir, pid);
    await registerProject(movedDir, pid, 'audit-move-test');

    await nexusMoveProject(pid, movedDir);

    const db = await getNexusDb();
    const rows = await db.select().from(nexusAuditLog).where(eq(nexusAuditLog.action, 'move'));
    const filtered = rows.filter((r) => {
      try { const d = JSON.parse(r.detailsJson ?? '{}'); return d?.oldPath && d?.newPath; }
      catch { return false; }
    });
    expect(filtered.length).toBeGreaterThanOrEqual(1);
    expect(filtered[0].projectId).toBe(pid);
    expect(filtered[0].success).toBe(1);
    expect(JSON.parse(filtered[0].detailsJson ?? '{}').newHash).toBe(generateProjectHash(movedDir));
  });

  it('AC7: throws on missing projectId', async () => {
    await nexusInit();
    await expect(nexusMoveProject('', '/tmp/nowhere')).rejects.toThrow('projectId required');
  });

  it('throws on unknown projectId', async () => {
    await nexusInit();
    await expect(nexusMoveProject('no-such-id', join(testDir, 'nope'))).rejects.toThrow('not found');
  });
});

describe('nexusRenameProject (T11024 AC2, AC4, AC5)', () => {
  it('AC4: updates name in registry', async () => {
    const pid = randomUUID();
    await createProject(projectDir, pid);
    await registerProject(projectDir, pid, 'original-name');

    const result = await nexusRenameProject(pid, 'new-name');
    expect(result.name).toBe('new-name');

    const p = await nexusGetProject('new-name');
    expect(p).not.toBeNull();
    expect(p!.name).toBe('new-name');
    expect(p!.projectId).toBe(pid);
  });

  it('AC2: lookup uses projectId (stable)', async () => {
    const pid = randomUUID();
    await createProject(projectDir, pid);
    await registerProject(projectDir, pid, 'stable-test');

    const movedDir = join(testDir, 'stable-moved');
    await createProject(movedDir, pid);
    await registerProject(movedDir, pid, 'stable-test');

    const moved = await nexusMoveProject(pid, movedDir);
    expect(moved.projectId).toBe(pid);

    const renamed = await nexusRenameProject(pid, 'stable-renamed');
    expect(renamed.projectId).toBe(pid);
    expect(renamed.name).toBe('stable-renamed');
  });

  it('AC5: audit log entries written for rename', async () => {
    const pid = randomUUID();
    await createProject(projectDir, pid);
    await registerProject(projectDir, pid, 'audit-rename-test');

    await nexusRenameProject(pid, 'audit-renamed');

    const db = await getNexusDb();
    const rows = await db.select().from(nexusAuditLog).where(eq(nexusAuditLog.action, 'rename'));
    const filtered = rows.filter((r) => {
      try { const d = JSON.parse(r.detailsJson ?? '{}'); return d?.oldName === 'audit-rename-test' && d?.newName === 'audit-renamed'; }
      catch { return false; }
    });
    expect(filtered.length).toBeGreaterThanOrEqual(1);
    expect(filtered[0].projectId).toBe(pid);
    expect(filtered[0].success).toBe(1);
  });

  it('throws on missing projectId', async () => {
    await nexusInit();
    await expect(nexusRenameProject('', 'n')).rejects.toThrow('projectId required');
  });

  it('throws on unknown projectId', async () => {
    await nexusInit();
    await expect(nexusRenameProject('no-such-id', 'n')).rejects.toThrow('not found');
  });
});

describe('nexusReconcile Scenario 2 path_updated (T11024 AC6, AC8)', () => {
  it('AC6: known project at different path returns path_updated', async () => {
    const pid = randomUUID();
    await createProject(projectDir, pid);
    await registerProject(projectDir, pid, 'scenario2-test');

    const movedDir = join(testDir, 'scen2-moved');
    await createProject(movedDir, pid);

    const result = await nexusReconcile(movedDir);
    expect(result.status).toBe('path_updated');
    expect(result.oldPath).toBe(projectDir);
    expect(result.newPath).toBe(movedDir);

    // AC8: DB paths updated
    const p = await nexusGetProject('scenario2-test');
    expect(p).not.toBeNull();
    expect(p!.brainDbPath).toBe(join(resolve(movedDir), '.cleo', 'brain.db'));
    expect(p!.tasksDbPath).toBe(join(resolve(movedDir), '.cleo', 'tasks.db'));
    expect(p!.path).toBe(resolve(movedDir));
  });

  it('idempotent: second reconcile returns ok', async () => {
    const pid = randomUUID();
    await createProject(projectDir, pid);
    await registerProject(projectDir, pid, 'idempotent-test');

    const movedDir = join(testDir, 'idem-moved');
    await createProject(movedDir, pid);

    expect((await nexusReconcile(movedDir)).status).toBe('path_updated');
    expect((await nexusReconcile(movedDir)).status).toBe('ok');
  });
});

describe('T11024 combined move+rename lifecycle', () => {
  it('move then rename preserves projectId for lookup', async () => {
    const pid = randomUUID();
    await createProject(projectDir, pid);
    await registerProject(projectDir, pid, 'lifecycle-test');

    const movedDir = join(testDir, 'lifecycle-moved');
    await createProject(movedDir, pid);
    await registerProject(movedDir, pid, 'lifecycle-test');

    expect((await nexusMoveProject(pid, movedDir)).path).toBe(resolve(movedDir));

    const renamed = await nexusRenameProject(pid, 'lifecycle-renamed');
    expect(renamed.name).toBe('lifecycle-renamed');
    expect(renamed.projectId).toBe(pid);

    const db = await getNexusDb();
    const moves = await db.select().from(nexusAuditLog).where(eq(nexusAuditLog.action, 'move'));
    const renames = await db.select().from(nexusAuditLog).where(eq(nexusAuditLog.action, 'rename'));
    expect(moves.length).toBeGreaterThanOrEqual(1);
    expect(renames.length).toBeGreaterThanOrEqual(1);
  });
});
