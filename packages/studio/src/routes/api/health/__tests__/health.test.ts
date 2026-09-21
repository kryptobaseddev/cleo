/** Health probes use actual isolated modern stores, never host databases. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { KnowledgeCoverageStatus } from '@cleocode/contracts';
import { getTaskAccessor } from '@cleocode/core/store/data-accessor';
import {
  _resetDualScopeDbCache,
  type DualScope,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
} from '@cleocode/core/store/dual-scope-db';
import * as snapshots from '@cleocode/core/store/open-cleo-db';
import { closeAllDatabases } from '@cleocode/core/store/sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withStudioReadSnapshot } from '$lib/server/db/connections.js';
import type { ProjectContext } from '$lib/server/project-context.js';
import { version } from '../../../../../package.json';
import { GET } from '../+server.js';

interface DbReport {
  available: boolean;
  rowCount: number | null;
  schemaVersion: string | null;
  path: string;
  scope: DualScope;
  projectId: string | null;
  coverage: KnowledgeCoverageStatus;
  errors: string[];
  observedPragmas: Record<string, string | number | null>;
}

interface HealthEnvelope {
  ok: boolean;
  service: string;
  version: string;
  checkedAt: string;
  uptime: number;
  databases: Record<string, DbReport>;
  coverage: {
    status: KnowledgeCoverageStatus;
    observedRealms: string[];
    unobservedRealms: string[];
  };
}

async function health(projectCtx: ProjectContext): Promise<HealthEnvelope> {
  const response = await GET({ locals: { projectCtx } } as Parameters<typeof GET>[0]);
  return response.json() as Promise<HealthEnvelope>;
}

describe('GET /api/health canonical scope and ownership', () => {
  let root: string;
  let a: ProjectContext;
  let b: ProjectContext;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'studio-health-'));
    vi.stubEnv('CLEO_HOME', join(root, 'global'));
    const global = await openDualScopeDbAtPath('global', join(root, 'global/cleo.db'));
    getDualScopeNativeDb(global).exec(
      "INSERT INTO nexus_project_registry(project_id,project_hash,project_path,name) VALUES ('registered','registered','/synthetic/registered','Registered')",
    );
    const contexts: ProjectContext[] = [];
    for (const [name, count] of [
      ['a', 2],
      ['b', 3],
    ] as const) {
      const projectPath = join(root, name);
      mkdirSync(join(projectPath, '.cleo'), { recursive: true });
      writeFileSync(
        join(projectPath, '.cleo/project-info.json'),
        JSON.stringify({ projectId: name, projectHash: name }),
      );
      const accessor = await getTaskAccessor(projectPath);
      for (let i = 0; i < count; i++) {
        await accessor.upsertSingleTask({
          id: `T${i}`,
          title: `${name}-${i}`,
          status: 'pending',
          priority: 'medium',
          createdAt: '2026-09-19T00:00:00Z',
        });
      }
      const dbPath = join(projectPath, '.cleo/cleo.db');
      const handle = await openDualScopeDbAtPath('project', dbPath);
      const native = getDualScopeNativeDb(handle);
      native.exec('CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY)');
      for (let i = 0; i < count - 1; i++) {
        native.exec(
          `INSERT INTO nexus_nodes(id,kind,label) VALUES ('${name}-node-${i}','file','${name} graph')`,
        );
      }
      contexts.push({
        projectId: name,
        name,
        projectPath,
        tasksDbPath: dbPath,
        brainDbPath: dbPath,
        tasksDbExists: true,
        brainDbExists: true,
      });
    }
    [a, b] = contexts as [ProjectContext, ProjectContext];
    vi.stubEnv('CLEO_ROOT', a.projectPath);
    vi.stubEnv('CLEO_DIR', join(a.projectPath, '.cleo'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeAllDatabases();
    _resetDualScopeDbCache();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('counts actual prefixed tasks and separates selected project graph from global registry', async () => {
    for (const [context, count] of [
      [a, 2],
      [b, 3],
      [a, 2],
    ] as const) {
      const body = await health(context);
      expect(body.databases.tasks).toMatchObject({
        rowCount: count,
        path: context.tasksDbPath,
        scope: 'project',
        projectId: context.projectId,
        coverage: 'current',
      });
      expect(body.databases.nexus).toMatchObject({
        rowCount: count - 1,
        path: context.tasksDbPath,
        scope: 'project',
        projectId: context.projectId,
      });
      expect(body.databases['project-registry']).toMatchObject({
        rowCount: 1,
        path: join(root, 'global/cleo.db'),
        scope: 'global',
        projectId: null,
      });
      expect(body.ok).toBe(true);
    }
  });

  it('reports missing stores as incomplete without inventing healthy zeros', async () => {
    const missing = {
      ...a,
      projectPath: join(root, 'missing'),
      tasksDbPath: join(root, 'missing/.cleo/cleo.db'),
      brainDbPath: join(root, 'missing/.cleo/cleo.db'),
      tasksDbExists: false,
      brainDbExists: false,
    };
    const body = await health(missing);
    expect(body.ok).toBe(false);
    expect(body.databases.tasks).toMatchObject({
      available: false,
      rowCount: null,
      coverage: 'missing',
    });
    expect(body.coverage.status).toBe('partial');
  });

  it('reports schema failures and closes every owned snapshot without closing caller handles', async () => {
    const caller = await openDualScopeDbAtPath('project', a.tasksDbPath);
    getDualScopeNativeDb(caller).exec('ALTER TABLE tasks_tasks RENAME TO unavailable_tasks');
    const opened: DatabaseSync[] = [];
    const original = snapshots.openCleoDbSnapshot;
    vi.spyOn(snapshots, 'openCleoDbSnapshot').mockImplementation((...args) => {
      const snapshot = original(...args);
      opened.push(snapshot.db);
      return snapshot;
    });
    const body = await health(a);
    expect(body.ok).toBe(false);
    expect(body.databases.tasks).toMatchObject({
      available: true,
      rowCount: null,
      coverage: 'failed',
    });
    expect(body.databases.tasks!.errors.join(' ')).toMatch(/tasks_tasks/);
    expect(opened.length).toBeGreaterThan(0);
    expect(opened.every((db) => !db.isOpen)).toBe(true);
    expect(caller.isOpen).toBe(true);
    expect(
      getDualScopeNativeDb(caller).prepare('SELECT COUNT(*) AS count FROM unavailable_tasks').get(),
    ).toEqual({ count: 2 });
  });

  it('uses read-only snapshots and reports actual connection pragmas', async () => {
    expect(() =>
      withStudioReadSnapshot(a.tasksDbPath, (db) => {
        db.exec("INSERT INTO tasks(id) VALUES ('forbidden-health-write')");
      }),
    ).toThrow(/readonly|read-only/i);
    const body = await health(a);
    expect(body.databases.tasks!.observedPragmas.busy_timeout).toEqual(expect.any(Number));
    expect(body.databases.tasks!.observedPragmas.foreign_keys).toEqual(expect.any(Number));
    expect(body.databases.tasks!.observedPragmas.journal_mode).toEqual(expect.any(String));
    expect(
      withStudioReadSnapshot(a.tasksDbPath, (db) =>
        db.prepare('SELECT COUNT(*) AS count FROM tasks').get(),
      ),
    ).toEqual({ count: 0 });
  });

  it('retains package identity and timestamps while disclosing unobserved realms', async () => {
    const body = await health(a);
    expect(body.version).toBe(version);
    expect(body.version).not.toBe('unknown');
    expect(body.service).toBe('cleo-studio');
    expect(body.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(body.coverage.status).toBe('partial');
    expect(body.coverage.observedRealms).toContain('studio-main');
    expect(body.coverage.unobservedRealms).toContain('core-workers');
    for (const key of [
      'nexus',
      'project-registry',
      'brain',
      'tasks',
      'conduit',
      'agent-registry',
    ]) {
      expect(body.databases[key]).toHaveProperty('schemaVersion');
      expect(body.databases[key]).toHaveProperty('path');
    }
  });
});
