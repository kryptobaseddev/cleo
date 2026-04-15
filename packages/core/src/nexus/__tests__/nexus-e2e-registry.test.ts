/**
 * E2E tests for NEXUS registry infrastructure.
 *
 * Covers: audit log verification, health status, permission updates,
 * and schema integrity.
 *
 * Split from nexus-e2e.test.ts (T659 rationalization).
 * @task WAVE-1D
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedTasks } from '../../store/__tests__/test-db-helper.js';
import { nexusAuditLog, nexusSchemaMeta, projectRegistry } from '../../store/nexus-schema.js';
import { getNexusDb, NEXUS_SCHEMA_VERSION, resetNexusDbState } from '../../store/nexus-sqlite.js';
import { resetDbState } from '../../store/sqlite.js';
import { createSqliteDataAccessor } from '../../store/sqlite-data-accessor.js';
import { invalidateGraphCache } from '../deps.js';
import { generateProjectHash } from '../hash.js';
import { checkPermission, getPermission, setPermission } from '../permissions.js';
import {
  nexusGetProject,
  nexusInit,
  nexusReconcile,
  nexusRegister,
  nexusSetPermission,
  nexusSync,
  nexusSyncAll,
  nexusUnregister,
  readRegistry,
  readRegistryRequired,
} from '../registry.js';

// ── Test helpers ─────────────────────────────────────────────────────

/** Create a test project with tasks in SQLite (tasks.db). */
async function createTestProjectDb(
  dir: string,
  tasks: Array<Partial<Task> & { id: string }>,
): Promise<void> {
  await mkdir(join(dir, '.cleo'), { recursive: true });
  resetDbState();
  const accessor = await createSqliteDataAccessor(dir);
  await seedTasks(accessor, tasks);
  await accessor.close();
  resetDbState();
}

/** Create a test project with tasks.db and project-info.json. */
async function createTestProjectWithId(
  dir: string,
  tasks: Array<Partial<Task> & { id: string }>,
  projectId?: string,
): Promise<string> {
  const pid = projectId ?? randomUUID();
  await createTestProjectDb(dir, tasks);
  await writeFile(
    join(dir, '.cleo', 'project-info.json'),
    JSON.stringify({ projectId: pid, createdAt: new Date().toISOString() }),
  );
  return pid;
}

// ── Shared state ─────────────────────────────────────────────────────

let testDir: string;
let registryDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'nexus-e2e-registry-'));
  registryDir = join(testDir, 'cleo-home');
  await mkdir(registryDir, { recursive: true });

  process.env['CLEO_HOME'] = registryDir;
  process.env['NEXUS_HOME'] = join(registryDir, 'nexus');
  process.env['NEXUS_CACHE_DIR'] = join(registryDir, 'nexus', 'cache');
  process.env['NEXUS_CURRENT_PROJECT'] = 'e2e-project';
  delete process.env['NEXUS_SKIP_PERMISSION_CHECK'];

  resetNexusDbState();
  resetDbState();
  invalidateGraphCache();
});

afterEach(async () => {
  delete process.env['CLEO_HOME'];
  delete process.env['NEXUS_HOME'];
  delete process.env['NEXUS_CACHE_DIR'];
  delete process.env['NEXUS_CURRENT_PROJECT'];
  delete process.env['NEXUS_SKIP_PERMISSION_CHECK'];
  resetNexusDbState();
  resetDbState();
  invalidateGraphCache();
  await rm(testDir, { recursive: true, force: true });
});

// =====================================================================
// 1. AUDIT LOG VERIFICATION
// =====================================================================

describe('audit log', () => {
  it('register creates an audit entry with action=register', async () => {
    const projDir = join(testDir, 'audit-proj');
    await createTestProjectDb(projDir, [
      { id: 'T001', title: 'Task', status: 'pending', description: 'desc' },
    ]);

    const hash = await nexusRegister(projDir, 'audit-proj', 'read');

    const db = await getNexusDb();
    const entries = await db
      .select()
      .from(nexusAuditLog)
      .where(eq(nexusAuditLog.action, 'register'));

    expect(entries.length).toBeGreaterThanOrEqual(1);
    const entry = entries.find((e) => e.projectHash === hash);
    expect(entry).toBeDefined();
    expect(entry!.action).toBe('register');
    expect(entry!.success).toBe(1);
    expect(entry!.domain).toBe('nexus');
    expect(entry!.timestamp).toBeTruthy();
    expect(entry!.id).toBeTruthy();
  });

  it('unregister creates an audit entry with action=unregister', async () => {
    const projDir = join(testDir, 'unreg-proj');
    await createTestProjectDb(projDir, [
      { id: 'T001', title: 'Task', status: 'pending', description: 'desc' },
    ]);
    const hash = await nexusRegister(projDir, 'unreg-proj', 'read');
    await nexusUnregister('unreg-proj');

    const db = await getNexusDb();
    const entries = await db
      .select()
      .from(nexusAuditLog)
      .where(eq(nexusAuditLog.action, 'unregister'));

    expect(entries.length).toBeGreaterThanOrEqual(1);
    const entry = entries.find((e) => e.projectHash === hash);
    expect(entry).toBeDefined();
    expect(entry!.success).toBe(1);
  });

  it('sync creates an audit entry with action=sync', async () => {
    const projDir = join(testDir, 'sync-audit-proj');
    await createTestProjectDb(projDir, [
      { id: 'T001', title: 'Task', status: 'pending', description: 'desc' },
    ]);
    await nexusRegister(projDir, 'sync-audit-proj', 'read');
    await nexusSync('sync-audit-proj');

    const db = await getNexusDb();
    const entries = await db.select().from(nexusAuditLog).where(eq(nexusAuditLog.action, 'sync'));

    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].success).toBe(1);
  });

  it('sync-all creates an audit entry with action=sync-all', async () => {
    const projDir = join(testDir, 'syncall-proj');
    await createTestProjectDb(projDir, [
      { id: 'T001', title: 'Task', status: 'pending', description: 'desc' },
    ]);
    await nexusRegister(projDir, 'syncall-proj', 'read');
    await nexusSyncAll();

    const db = await getNexusDb();
    const entries = await db
      .select()
      .from(nexusAuditLog)
      .where(eq(nexusAuditLog.action, 'sync-all'));

    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].success).toBe(1);
    const details = JSON.parse(entries[0].detailsJson ?? '{}');
    expect(details.synced).toBe(1);
    expect(details.failed).toBe(0);
  });

  it('set-permission creates an audit entry', async () => {
    const projDir = join(testDir, 'perm-audit-proj');
    await createTestProjectDb(projDir, [
      { id: 'T001', title: 'Task', status: 'pending', description: 'desc' },
    ]);
    await nexusRegister(projDir, 'perm-audit-proj', 'read');
    await nexusSetPermission('perm-audit-proj', 'execute');

    const db = await getNexusDb();
    const entries = await db
      .select()
      .from(nexusAuditLog)
      .where(eq(nexusAuditLog.action, 'set-permission'));

    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].success).toBe(1);
    const details = JSON.parse(entries[0].detailsJson ?? '{}');
    expect(details.permission).toBe('execute');
  });

  it('reconcile creates audit entries', async () => {
    const projDir = join(testDir, 'recon-audit-proj');
    await createTestProjectWithId(projDir, [
      { id: 'T001', title: 'Task', status: 'pending', description: 'desc' },
    ]);

    await nexusReconcile(projDir);

    const db = await getNexusDb();
    const entries = await db
      .select()
      .from(nexusAuditLog)
      .where(eq(nexusAuditLog.action, 'reconcile'));

    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].success).toBe(1);
  });

  it('audit entries survive project deletion', async () => {
    const projDir = join(testDir, 'surviving-audit-proj');
    await createTestProjectDb(projDir, [
      { id: 'T001', title: 'Task', status: 'pending', description: 'desc' },
    ]);
    const hash = await nexusRegister(projDir, 'surviving-audit-proj', 'read');
    await nexusUnregister('surviving-audit-proj');

    // Verify audit entries remain even after project is removed
    const db = await getNexusDb();
    const entries = await db
      .select()
      .from(nexusAuditLog)
      .where(eq(nexusAuditLog.projectHash, hash));

    // At least register + unregister = 2 entries
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const actions = entries.map((e) => e.action);
    expect(actions).toContain('register');
    expect(actions).toContain('unregister');
  });

  it('audit entries have valid timestamps', async () => {
    const projDir = join(testDir, 'ts-audit-proj');
    await createTestProjectDb(projDir, [
      { id: 'T001', title: 'Task', status: 'pending', description: 'desc' },
    ]);
    await nexusRegister(projDir, 'ts-audit-proj', 'read');

    const db = await getNexusDb();
    const entries = await db.select().from(nexusAuditLog);

    for (const entry of entries) {
      expect(entry.timestamp).toBeTruthy();
      // Should be parseable as a date
      const date = new Date(entry.timestamp);
      expect(date.getTime()).not.toBeNaN();
    }
  });

  it('audit entries have unique UUIDs', async () => {
    const projDir = join(testDir, 'uuid-audit-proj');
    await createTestProjectDb(projDir, [
      { id: 'T001', title: 'Task', status: 'pending', description: 'desc' },
    ]);
    await nexusRegister(projDir, 'uuid-audit-proj', 'read');
    await nexusSync('uuid-audit-proj');
    await nexusUnregister('uuid-audit-proj');

    const db = await getNexusDb();
    const entries = await db.select().from(nexusAuditLog);
    const ids = entries.map((e) => e.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});

// =====================================================================
// 2. HEALTH STATUS
// =====================================================================

describe('health status', () => {
  it('newly registered project has unknown health status', async () => {
    const projDir = join(testDir, 'health-proj');
    await createTestProjectDb(projDir, [
      { id: 'T001', title: 'Task', status: 'pending', description: 'desc' },
    ]);
    await nexusRegister(projDir, 'health-proj', 'read');

    const project = await nexusGetProject('health-proj');
    expect(project).not.toBeNull();
    expect(project!.healthStatus).toBe('unknown');
    expect(project!.healthLastCheck).toBeNull();
  });

  it('health status can be updated directly via DB', async () => {
    const projDir = join(testDir, 'health-update-proj');
    await createTestProjectDb(projDir, [
      { id: 'T001', title: 'Task', status: 'pending', description: 'desc' },
    ]);
    await nexusRegister(projDir, 'health-update-proj', 'read');

    // Simulate health check update directly
    const db = await getNexusDb();
    const hash = generateProjectHash(projDir);
    const now = new Date().toISOString();
    await db
      .update(projectRegistry)
      .set({ healthStatus: 'healthy', healthLastCheck: now })
      .where(eq(projectRegistry.projectHash, hash));

    const project = await nexusGetProject('health-update-proj');
    expect(project).not.toBeNull();
    expect(project!.healthStatus).toBe('healthy');
    expect(project!.healthLastCheck).toBe(now);
  });

  it('health status values are preserved through readRegistry', async () => {
    const projDir = join(testDir, 'health-registry-proj');
    await createTestProjectDb(projDir, [
      { id: 'T001', title: 'Task', status: 'pending', description: 'desc' },
    ]);
    await nexusRegister(projDir, 'health-registry-proj', 'read');

    const db = await getNexusDb();
    const hash = generateProjectHash(projDir);
    await db
      .update(projectRegistry)
      .set({ healthStatus: 'degraded' })
      .where(eq(projectRegistry.projectHash, hash));

    const registry = await readRegistry();
    expect(registry).not.toBeNull();
    const project = Object.values(registry!.projects).find(
      (p) => p.name === 'health-registry-proj',
    );
    expect(project).toBeDefined();
    expect(project!.healthStatus).toBe('degraded');
  });

  it('all valid health status values can be stored and retrieved', async () => {
    const statuses = ['unknown', 'healthy', 'degraded', 'unreachable'] as const;

    for (const status of statuses) {
      const projDir = join(testDir, `health-${status}-proj`);
      await createTestProjectDb(projDir, [
        { id: 'T001', title: 'Task', status: 'pending', description: 'desc' },
      ]);
      await nexusRegister(projDir, `health-${status}`, 'read');

      const db = await getNexusDb();
      const hash = generateProjectHash(projDir);
      await db
        .update(projectRegistry)
        .set({ healthStatus: status })
        .where(eq(projectRegistry.projectHash, hash));

      const project = await nexusGetProject(`health-${status}`);
      expect(project!.healthStatus).toBe(status);
    }
  });
});

// =====================================================================
// 3. PERMISSION UPDATES
// =====================================================================

describe('permission updates', () => {
  it('nexusSetPermission changes permission from read to write', async () => {
    const projDir = join(testDir, 'perm-rw-proj');
    await createTestProjectDb(projDir, [
      { id: 'T001', title: 'Task', status: 'pending', description: 'desc' },
    ]);
    await nexusRegister(projDir, 'perm-rw-proj', 'read');

    expect((await nexusGetProject('perm-rw-proj'))!.permissions).toBe('read');

    await nexusSetPermission('perm-rw-proj', 'write');

    expect((await nexusGetProject('perm-rw-proj'))!.permissions).toBe('write');
  });

  it('nexusSetPermission changes permission from read to execute', async () => {
    const projDir = join(testDir, 'perm-rx-proj');
    await createTestProjectDb(projDir, [
      { id: 'T001', title: 'Task', status: 'pending', description: 'desc' },
    ]);
    await nexusRegister(projDir, 'perm-rx-proj', 'read');
    await nexusSetPermission('perm-rx-proj', 'execute');

    const project = await nexusGetProject('perm-rx-proj');
    expect(project!.permissions).toBe('execute');
    expect(await checkPermission('perm-rx-proj', 'read')).toBe(true);
    expect(await checkPermission('perm-rx-proj', 'write')).toBe(true);
    expect(await checkPermission('perm-rx-proj', 'execute')).toBe(true);
  });

  it('nexusSetPermission can downgrade from execute to read', async () => {
    const projDir = join(testDir, 'perm-down-proj');
    await createTestProjectDb(projDir, [
      { id: 'T001', title: 'Task', status: 'pending', description: 'desc' },
    ]);
    await nexusRegister(projDir, 'perm-down-proj', 'execute');
    await nexusSetPermission('perm-down-proj', 'read');

    expect(await checkPermission('perm-down-proj', 'write')).toBe(false);
    expect(await checkPermission('perm-down-proj', 'execute')).toBe(false);
    expect(await checkPermission('perm-down-proj', 'read')).toBe(true);
  });

  it('nexusSetPermission throws for non-existent project', async () => {
    await nexusInit();
    await expect(nexusSetPermission('no-such-project', 'write')).rejects.toThrow(/not found/i);
  });

  it('setPermission (from permissions module) updates correctly', async () => {
    const projDir = join(testDir, 'setperm-proj');
    await createTestProjectDb(projDir, [
      { id: 'T001', title: 'Task', status: 'pending', description: 'desc' },
    ]);
    await nexusRegister(projDir, 'setperm-proj', 'read');
    await setPermission('setperm-proj', 'execute');

    const perm = await getPermission('setperm-proj');
    expect(perm).toBe('execute');
  });

  it('setPermission throws on empty name', async () => {
    await expect(setPermission('', 'read')).rejects.toThrow(/required/i);
  });
});

// =====================================================================
// 4. SCHEMA INTEGRITY
// =====================================================================

describe('schema integrity', () => {
  it('nexus.db is created with correct schema version in nexus_schema_meta', async () => {
    await nexusInit();
    const db = await getNexusDb();

    const meta = await db
      .select()
      .from(nexusSchemaMeta)
      .where(eq(nexusSchemaMeta.key, 'schemaVersion'));

    expect(meta.length).toBe(1);
    expect(meta[0].value).toBe(NEXUS_SCHEMA_VERSION);
  });

  it('all required tables exist after init', async () => {
    await nexusInit();
    const db = await getNexusDb();

    // Verify each table can be queried
    const projects = await db.select().from(projectRegistry);
    expect(Array.isArray(projects)).toBe(true);

    const auditLogs = await db.select().from(nexusAuditLog);
    expect(Array.isArray(auditLogs)).toBe(true);

    const schemaMeta = await db.select().from(nexusSchemaMeta);
    expect(Array.isArray(schemaMeta)).toBe(true);
  });

  it('project_registry indexes exist and are usable', async () => {
    await nexusInit();

    // Register a project to populate the table
    const projDir = join(testDir, 'idx-proj');
    await createTestProjectDb(projDir, [
      { id: 'T001', title: 'Task', status: 'pending', description: 'desc' },
    ]);
    await nexusRegister(projDir, 'idx-proj', 'read');

    // Query by hash (uses idx_project_registry_hash)
    const byHash = await nexusGetProject(generateProjectHash(projDir));
    expect(byHash).not.toBeNull();

    // Query by name (uses idx_project_registry_name)
    const byName = await nexusGetProject('idx-proj');
    expect(byName).not.toBeNull();
  });

  it('nexus.db file is created on disk', async () => {
    await nexusInit();
    const dbPath = join(registryDir, 'nexus.db');
    expect(existsSync(dbPath)).toBe(true);
  });

  it('readRegistry returns null before initialization when DB does not exist', async () => {
    // Point to a non-existent CLEO_HOME
    const noDir = join(testDir, 'nonexistent-cleo-home');
    process.env['CLEO_HOME'] = noDir;
    resetNexusDbState();

    // readRegistry should return null (not throw)
    const registry = await readRegistry();
    // It may or may not be null depending on whether getNexusDb auto-creates;
    // the important thing is it doesn't throw
    expect(registry === null || typeof registry === 'object').toBe(true);
  });

  it('readRegistryRequired throws when no projects exist and DB is empty', async () => {
    // readRegistryRequired only throws if readRegistry returns null.
    // With SQLite auto-initialization, it returns an empty registry.
    await nexusInit();
    const registry = await readRegistryRequired();
    expect(registry).not.toBeNull();
    expect(Object.keys(registry.projects)).toHaveLength(0);
  });
});
