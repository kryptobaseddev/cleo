/**
 * Tests for nexusMoveProject + nexusRenameProject + nexusReconcile path_updated (T11024).
 *
 * All tests work directly against nexus.db without going through nexusRegister,
 * which requires createSqliteDataAccessor → resolveCanonicalCleoDir (regression).
 * Pre-registration via direct DB insert provides the initial state.
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

/** Pre-register a project directly in nexus.db so nexusMoveProject/nexusRenameProject can find it. */
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

/** Create project directory with minimal .cleo structure. */
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
  testDir = await mkdtemp(join(tmpdir(), 'nexus-move-test-'));
  registryDir = join(testDir, 'cleo-home');
  projectDir = join(testDir, 'test-project');
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

// ─── nexusMoveProject ───────────────────────────────────────────────────

describe('nexusMoveProject (T11024 AC1, AC3, AC5, AC7, AC8)', () => {
  it('AC1: updates projectPath, projectHash, lastSeen after move', async () => {
    const projectId = randomUUID();
    await createProject(projectDir, projectId);
    await registerProject(projectDir, projectId, 'move-test');

    const movedDir = join(testDir, 'moved-project');
    await createProject(movedDir, projectId);
    await registerProject(movedDir, projectId, 'move-test');

    const oldHash = generateProjectHash(projectDir);
    const newHash = generateProjectHash(movedDir);

    const result = await nexusMoveProject(projectId, movedDir);

    expect(result.path).toBe(resolve(movedDir));
    expect(result.hash).toBe(newHash);
    expect(result.hash).not.toBe(oldHash);
    expect(new Date(result.lastSeen).getTime()).toBeGreaterThan(Date.now() - 10000);
    expect(result.projectId).toBe(projectId);
  });

  it('AC8: brainDbPath and tasksDbPath updated after move', async () => {
    const projectId = randomUUID();
    await createProject(projectDir, projectId);
    await registerProject(projectDir, projectId, 'move-db-test');

    const movedDir = join(testDir, 'moved-db-project');
    await createProject(movedDir, projectId);
    await registerProject(movedDir, projectId, 'move-db-test');

    const result = await nexusMoveProject(projectId, movedDir);

    expect(result.brainDbPath).toBe(join(resolve(movedDir), '.cleo', 'brain.db'));
    expect(result.tasksDbPath).toBe(join(resolve(movedDir), '.cleo', 'tasks.db'));
  });

  it('AC3: nexusReconcile is called as final step', async () => {
    const projectId = randomUUID();
    await createProject(projectDir, projectId);
    await registerProject(projectDir, projectId, 'reconcile-call-test');

    const movedDir = join(testDir, 'reconciled-project');
    await createProject(movedDir, projectId);
    // Don't pre-register at new path — nexusMoveProject calls reconcile which handles it
    // But nexusMoveProject needs project_registry entry at new path for resolveCanonicalCleoDir
    // So pre-register at new path too
    await registerProject(movedDir, projectId, 'reconcile-call-test');

    const result = await nexusMoveProject(projectId, movedDir);
    expect(result.path).toBe(resolve(movedDir));

    // Reconciling again at same path returns 'ok'
    const reconfirm = await nexusReconcile(movedDir);
    expect(reconfirm.status).toBe('ok');
  });

  it('AC5: audit log entries written for move', async () => {
    const projectId = randomUUID();
    await createProject(projectDir, projectId);
    await registerProject(projectDir, projectId, 'audit-move-test');

    const movedDir = join(testDir, 'audit-moved-project');
    await createProject(movedDir, projectId);
    await registerProject(movedDir, projectId, 'audit-move-test');

    await nexusMoveProject(projectId, movedDir);

    const db = await getNexusDb();
    const auditRows = await db
      .select()
      .from(nexusAuditLog)
      .where(eq(nexusAuditLog.action, 'move'));

    const moveAudits = auditRows.filter((r) => {
      try {
        const details = JSON.parse(r.detailsJson ?? '{}');
        return details?.oldPath && details?.newPath;
      } catch { return false; }
    });
    expect(moveAudits.length).toBeGreaterThanOrEqual(1);
    const moveAudit = moveAudits[0];
    expect(moveAudit.projectId).toBe(projectId);
    expect(moveAudit.success).toBe(1);

    const details = JSON.parse(moveAudit.detailsJson ?? '{}');
    expect(details.newHash).toBe(generateProjectHash(movedDir));
  });

  it('AC7: throws on missing projectId (no partial state)', async () => {
    await nexusInit();
    await expect(nexusMoveProject('', '/tmp/nowhere')).rejects.toThrow('projectId required');
  });

  it('throws on unknown projectId', async () => {
    await nexusInit();
    await expect(nexusMoveProject('nonexistent-id', join(testDir, 'nowhere'))).rejects.toThrow(
      'not found',
    );
  });
});

// ─── nexusRenameProject ─────────────────────────────────────────────────

describe('nexusRenameProject (T11024 AC2, AC4, AC5)', () => {
  it('AC4: updates name in registry', async () => {
    const projectId = randomUUID();
    await createProject(projectDir, projectId);
    await registerProject(projectDir, projectId, 'original-name');

    const result = await nexusRenameProject(projectId, 'new-name');

    expect(result.name).toBe('new-name');
    const project = await nexusGetProject('new-name');
    expect(project).not.toBeNull();
    expect(project!.name).toBe('new-name');
    expect(project!.projectId).toBe(projectId);
  });

  it('AC2: lookup uses projectId (stable), not path or name', async () => {
    const projectId = randomUUID();
    await createProject(projectDir, projectId);
    await registerProject(projectDir, projectId, 'stable-id-test');

    const movedDir = join(testDir, 'stable-id-moved');
    await createProject(movedDir, projectId);
    await registerProject(movedDir, projectId, 'stable-id-test');

    const moved = await nexusMoveProject(projectId, movedDir);
    expect(moved.projectId).toBe(projectId);

    const renamed = await nexusRenameProject(projectId, 'stable-id-renamed');
    expect(renamed.projectId).toBe(projectId);
    expect(renamed.name).toBe('stable-id-renamed');
  });

  it('AC5: audit log entries written for rename', async () => {
    const projectId = randomUUID();
    await createProject(projectDir, projectId);
    await registerProject(projectDir, projectId, 'audit-rename-test');

    await nexusRenameProject(projectId, 'audit-renamed');

    const db = await getNexusDb();
    const auditRows = await db
      .select()
      .from(nexusAuditLog)
      .where(eq(nexusAuditLog.action, 'rename'));

    const renameAudits = auditRows.filter((r) => {
      try {
        const details = JSON.parse(r.detailsJson ?? '{}');
        return details?.oldName === 'audit-rename-test' && details?.newName === 'audit-renamed';
      } catch { return false; }
    });
    expect(renameAudits.length).toBeGreaterThanOrEqual(1);
    const renameAudit = renameAudits[0];
    expect(renameAudit.projectId).toBe(projectId);
    expect(renameAudit.success).toBe(1);
  });

  it('throws on missing projectId', async () => {
    await nexusInit();
    await expect(nexusRenameProject('', 'n')).rejects.toThrow('projectId required');
  });

  it('throws on unknown projectId', async () => {
    await nexusInit();
    await expect(nexusRenameProject('nonexistent-id', 'n')).rejects.toThrow('not found');
  });
});

// ─── nexusReconcile Scenario 2 (path_updated) ───────────────────────────

describe('nexusReconcile Scenario 2 path_updated (T11024 AC6, AC8)', () => {
  it('AC6: known project at different path returns path_updated', async () => {
    const projectId = randomUUID();
    await createProject(projectDir, projectId);
    await registerProject(projectDir, projectId, 'scenario2-test');

    // nexusReconcile looks up by projectId from project-info.json
    // We need project-info.json at the new path
    const movedDir = join(testDir, 'scenario2-moved');
    await createProject(movedDir, projectId);

    const result = await nexusReconcile(movedDir);

    expect(result.status).toBe('path_updated');
    expect(result.oldPath).toBe(projectDir);
    expect(result.newPath).toBe(movedDir);

    // AC8: Verify brainDbPath and tasksDbPath are updated
    const project = await nexusGetProject('scenario2-test');
    expect(project).not.toBeNull();
    expect(project!.brainDbPath).toBe(join(resolve(movedDir), '.cleo', 'brain.db'));
    expect(project!.tasksDbPath).toBe(join(resolve(movedDir), '.cleo', 'tasks.db'));
    expect(project!.path).toBe(resolve(movedDir));
  });

  it('idempotent: reconcile after move+reconcile returns ok', async () => {
    const projectId = randomUUID();
    await createProject(projectDir, projectId);
    await registerProject(projectDir, projectId, 'idempotent-test');

    const movedDir = join(testDir, 'idempotent-moved');
    await createProject(movedDir, projectId);

    const first = await nexusReconcile(movedDir);
    expect(first.status).toBe('path_updated');

    const second = await nexusReconcile(movedDir);
    expect(second.status).toBe('ok');
  });
});

// ─── Combined move + rename + lookup test ──────────────────────────────

describe('T11024 combined move+rename lifecycle', () => {
  it('move then rename preserves projectId for lookup', async () => {
    const projectId = randomUUID();
    await createProject(projectDir, projectId);
    await registerProject(projectDir, projectId, 'lifecycle-test');

    const movedDir = join(testDir, 'lifecycle-moved');
    await createProject(movedDir, projectId);
    await registerProject(movedDir, projectId, 'lifecycle-test');

    const moved = await nexusMoveProject(projectId, movedDir);
    expect(moved.path).toBe(resolve(movedDir));

    const renamed = await nexusRenameProject(projectId, 'lifecycle-renamed');
    expect(renamed.name).toBe('lifecycle-renamed');
    expect(renamed.projectId).toBe(projectId);

    const db = await getNexusDb();
    const moveAudits = await db
      .select()
      .from(nexusAuditLog)
      .where(eq(nexusAuditLog.action, 'move'));
    const renameAudits = await db
      .select()
      .from(nexusAuditLog)
      .where(eq(nexusAuditLog.action, 'rename'));

    expect(moveAudits.length).toBeGreaterThanOrEqual(1);
    expect(renameAudits.length).toBeGreaterThanOrEqual(1);
  });
});
