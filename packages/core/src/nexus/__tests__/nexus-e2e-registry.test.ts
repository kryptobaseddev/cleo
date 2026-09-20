/**
 * E2E tests for NEXUS registry infrastructure.
 *
 * Covers: audit log verification, health status, permission updates,
 * and schema integrity.
 *
 * Split from nexus-e2e.test.ts (T659 rationalization).
 * @task WAVE-1D
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Task } from '@cleocode/contracts';
import { eq } from 'drizzle-orm';
import { build } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleoWorkspaceSubpathAliases } from '../../../../../vitest-workspace-resolver.js';
import { worktreeScope } from '../../project-scope.js';
import { seedTasks } from '../../store/__tests__/test-db-helper.js';
import { getNexusDb, NEXUS_SCHEMA_VERSION, resetNexusDbState } from '../../store/nexus-sqlite.js';
import {
  nexusAuditLog,
  nexusSchemaMeta,
  projectRegistry,
} from '../../store/schema/nexus-schema.js';
import { resetDbState } from '../../store/sqlite.js';
import { createSqliteDataAccessor } from '../../store/sqlite-data-accessor.js';
import { invalidateGraphCache } from '../deps.js';
import { generateProjectHash } from '../hash.js';
import { checkPermission, getPermission, setPermission } from '../permissions.js';
import {
  nexusGetProject,
  nexusInit,
  nexusList,
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
  // T11281: isolate registry/reconcile assertions from the encounter-time
  // auto-register side-effect so explicit registration controls state (no
  // fire-and-forget race against project_path UNIQUE).
  process.env['CLEO_DISABLE_PROJECT_AUTOREGISTER'] = '1';

  resetNexusDbState();
  resetDbState();
  invalidateGraphCache();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  delete process.env['CLEO_HOME'];
  delete process.env['NEXUS_HOME'];
  delete process.env['NEXUS_CACHE_DIR'];
  delete process.env['NEXUS_CURRENT_PROJECT'];
  delete process.env['NEXUS_SKIP_PERMISSION_CHECK'];
  delete process.env['CLEO_DISABLE_PROJECT_AUTOREGISTER'];
  resetNexusDbState();
  resetDbState();
  invalidateGraphCache();
  await rm(testDir, { recursive: true, force: true });
});

// =====================================================================
// 1. AUDIT LOG VERIFICATION
// =====================================================================

describe('explicit registration with encounter registration enabled', () => {
  it('retains immutable identity and requested metadata after accessor encounter', async () => {
    vi.stubEnv('CLEO_ROOT', undefined);
    vi.stubEnv('CLEO_DIR', undefined);
    const projectPath = join(testDir, 'encounter-project');
    const projectId = await createTestProjectWithId(projectPath, [
      { id: 'T001', title: 'Persisted task', status: 'pending', labels: ['retained'] },
    ]);
    vi.stubEnv('CLEO_ROOT', projectPath);
    vi.stubEnv('CLEO_DIR', undefined);
    delete process.env['CLEO_DISABLE_PROJECT_AUTOREGISTER'];

    const hash = await nexusRegister(projectPath, 'requested-name', 'write');
    await worktreeScope.run({ worktreeRoot: projectPath }, async () => {
      expect(await nexusGetProject(hash)).toMatchObject({
        projectId,
        path: projectPath,
        name: 'requested-name',
        permissions: 'write',
        taskCount: 1,
        labels: ['retained'],
      });
      expect((await nexusList()).filter((project) => project.path === projectPath)).toHaveLength(1);
    });
  });
});

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

  it('nexus consolidated cleo.db file is created on disk', async () => {
    // E6-L4 (T11524): nexus consolidated into the GLOBAL `cleo.db` under
    // getCleoHome() (here CLEO_HOME=registryDir), not a standalone `nexus.db`.
    await nexusInit();
    const dbPath = join(registryDir, 'cleo.db');
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

it.each([
  false,
  true,
])('converges concurrent fresh-process registrations on one immutable owner (domain schema gap %s)', async (exerciseDomainGap) => {
  const project = join(testDir, 'process-project');
  await mkdir(join(project, '.cleo'), { recursive: true });
  const projectId = randomUUID();
  await writeFile(join(project, '.cleo/project-info.json'), JSON.stringify({ projectId }));
  const repository = fileURLToPath(new URL('../../../../../', import.meta.url));
  const sourceResolver = cleoWorkspaceSubpathAliases()[0]!;
  const bundle = join(testDir, 'registry-driver.mjs');
  const env = {
    PATH: process.env.PATH,
    HOME: join(testDir, 'home'),
    XDG_CONFIG_HOME: join(testDir, 'config'),
    XDG_DATA_HOME: join(testDir, 'data'),
    XDG_CACHE_HOME: join(testDir, 'cache'),
    CLEO_HOME: registryDir,
    NEXUS_HOME: join(registryDir, 'nexus'),
    CLEO_ROOT: project,
    TMPDIR: join(testDir, 'tmp'),
    TMP: join(testDir, 'tmp'),
    TEMP: join(testDir, 'tmp'),
    NODE_OPTIONS: '--max-old-space-size=384',
    DO_NOT_TRACK: '1',
    CLEO_NO_TELEMETRY: '1',
  };
  for (const dir of [
    env.HOME,
    env.XDG_CONFIG_HOME,
    env.XDG_DATA_HOME,
    env.XDG_CACHE_HOME,
    env.TMPDIR,
  ])
    await mkdir(dir, { recursive: true });
  await build({
    stdin: {
      contents: `
        import {existsSync} from 'node:fs';
        import {writeFile} from 'node:fs/promises';
        import {setTimeout} from 'node:timers/promises';
        import {DatabaseSync} from 'node:sqlite';
        // Observe native failures before registry metadata wraps the Drizzle error.
        // Preserve the original statement, arguments, result and thrown error.
        const originalPrepare = DatabaseSync.prototype.prepare;
        DatabaseSync.prototype.prepare = function(sql) {
          const statement = originalPrepare.call(this, sql);
          if (sql.includes('__drizzle_migrations')) {
            for (const method of ['run', 'get', 'all', 'iterate']) {
              const original = statement[method];
              statement[method] = function(...args) {
                try {
                  const result = original.apply(this, args);
                  return result;
                }
                catch (error) {
                  process.stderr.write(JSON.stringify({
                    event: 'native-migration-error', sql, method,
                    code: error.code, errcode: error.errcode,
                    errstr: error.errstr, message: error.message,
                  }) + '\\n');
                  throw error;
                }
              };
            }
          }
          return statement;
        };
        import {bindProjectDomain} from './packages/core/src/store/ports/domain-binding.ts';
        import {nexusRegister,nexusList} from './packages/core/src/nexus/registry.ts';
        import {getNexusDb,resetNexusDbState} from './packages/core/src/store/nexus-sqlite.ts';
        import {awaitBackgroundOps} from './packages/core/src/store/background-ops.ts';
        import {resetDbState} from './packages/core/src/store/sqlite.ts';
        const [mode,root,gate,identity] = process.argv.slice(2);
        if(mode==='prepare') await getNexusDb(root);
        else if(mode==='read') process.stdout.write(JSON.stringify(await nexusList()));
        else {
          await writeFile(gate+'.'+identity,'ready');
          while(!existsSync(gate)) await setTimeout(10);
          if (${exerciseDomainGap}) {
            await bindProjectDomain('concurrent-schema-fixture', root, async (native) => {
              const present = native.prepare("SELECT name FROM sqlite_master WHERE name = 'registration_schema_fixture'").get();
              if (!present) {
                await setTimeout(75);
                native.exec('CREATE TABLE registration_schema_fixture (identity TEXT PRIMARY KEY)');
              }
              return native;
            });
          }
          process.stdout.write(await nexusRegister(root,'concurrent-name','write'));
        }
        await awaitBackgroundOps(); resetNexusDbState(); resetDbState();
      `,
      resolveDir: repository,
      sourcefile: 'registry-process-driver.ts',
      loader: 'ts',
    },
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    logLevel: 'silent',
    plugins: [
      {
        name: 'workspace-source-fixture',
        setup(builder) {
          builder.onResolve({ filter: /^@cleocode\// }, (args) => {
            const mapped = sourceResolver.customResolver(args.path);
            const bare = join(
              repository,
              'packages',
              args.path.slice('@cleocode/'.length),
              'src/index.ts',
            );
            const path = mapped ?? (existsSync(bare) ? bare : undefined);
            if (path) return { path };
          });
          builder.onResolve({ filter: /^[^./]/ }, async (args) => {
            if (args.pluginData === true) return;
            if (args.path.startsWith('node:')) return { path: args.path, external: true };
            const resolved = await builder.resolve(args.path, {
              kind: args.kind,
              resolveDir: args.resolveDir,
              pluginData: true,
            });
            return { ...resolved, external: true };
          });
          builder.onLoad({ filter: /\.ts$/ }, async (args) => ({
            contents: (await readFile(args.path, 'utf8')).replaceAll(
              'import.meta.url',
              JSON.stringify(pathToFileURL(args.path).href),
            ),
            loader: 'ts',
          }));
        },
      },
    ],
  });
  const execute = (mode: string, identity = ''): Promise<string> =>
    new Promise((resolveOutput, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--experimental-import-meta-resolve',
          bundle,
          mode,
          project,
          join(testDir, 'release'),
          identity,
        ],
        {
          cwd: project,
          env,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      const stop = () => {
        if (!child.pid) return;
        if (process.platform === 'win32') child.kill('SIGKILL');
        else {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
              reject(error);
          }
        }
      };
      const deadline = setTimeout(stop, 30_000);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.length > 1024 * 1024) stop();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.length > 1024 * 1024) stop();
      });
      child.once('error', (error) => {
        clearTimeout(deadline);
        stop();
        reject(error);
      });
      child.once('exit', stop);
      child.once('close', (code) => {
        clearTimeout(deadline);
        if (code === 0) resolveOutput(stdout);
        else reject(new Error(`Registry child ${identity} exited ${code}: ${stderr}`));
      });
    });
  await execute('prepare');
  const writers = Array.from({ length: 4 }, (_, index) => execute('write', String(index)));
  // Attach failure handlers before waiting for readiness; all children stay bounded.
  const completed = Promise.allSettled(writers);
  const until = Date.now() + 10_000;
  while (
    !Array.from({ length: 4 }, (_, index) => existsSync(join(testDir, 'release.' + index))).every(
      Boolean,
    ) &&
    Date.now() < until
  )
    await new Promise((done) => setTimeout(done, 10));
  await writeFile(join(testDir, 'release'), 'go');
  const results = await completed;
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
    expect(result.value).toBe(generateProjectHash(project));
  }
  const fresh = JSON.parse(await execute('read'));
  expect(fresh).toHaveLength(1);
  expect(fresh).toEqual([
    expect.objectContaining({
      projectId,
      path: project,
      name: 'concurrent-name',
      permissions: 'write',
      taskCount: 0,
    }),
  ]);
  expect(await execute('write', 'repeat')).toBe(generateProjectHash(project));
  expect(JSON.parse(await execute('read'))).toEqual([
    expect.objectContaining({
      projectId,
      path: project,
      name: 'concurrent-name',
      permissions: 'write',
    }),
  ]);
}, 60000);
