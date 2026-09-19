/**
 * Tests for project context propagation via hooks.server.ts.
 *
 * Verifies that:
 * - When no cookie is set, locals.projectCtx falls back to the default context.
 * - When a valid project cookie is set, locals.projectCtx is resolved from the registry.
 * - When an invalid/unknown project cookie is set, locals.projectCtx falls back to default.
 *
 * Hook propagation uses mocks; modern-store resolution uses disposable canonical
 * stores and real source accessors to test project ownership and path policy.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTaskAccessor } from '@cleocode/core/store/data-accessor';
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
} from '@cleocode/core/store/dual-scope-db';
import { nexusProjectRegistry } from '@cleocode/core/store/schema/cleo-global/nexus';
import { closeAllDatabases } from '@cleocode/core/store/sqlite';
import { listTasks } from '@cleocode/core/tasks/list';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — hoisted before imports
// ---------------------------------------------------------------------------

vi.mock('$lib/server/project-context.js', () => ({
  getActiveProjectId: vi.fn(),
  resolveProjectContext: vi.fn(),
  resolveDefaultProjectContext: vi.fn(),
  PROJECT_COOKIE: 'cleo_project_id',
}));

import {
  getActiveProjectId as mockGetActiveProjectId,
  resolveDefaultProjectContext as mockResolveDefaultProjectContext,
  resolveProjectContext as mockResolveProjectContext,
} from '$lib/server/project-context.js';

const getActiveProjectId = mockGetActiveProjectId as ReturnType<typeof vi.fn>;
const resolveProjectContext = mockResolveProjectContext as ReturnType<typeof vi.fn>;
const resolveDefaultProjectContext = mockResolveDefaultProjectContext as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Default project context returned when no cookie or invalid cookie. */
const DEFAULT_CTX = {
  projectId: '',
  name: 'cleocode',
  projectPath: '/mnt/projects/cleocode',
  brainDbPath: '/mnt/projects/cleocode/.cleo/brain.db',
  tasksDbPath: '/mnt/projects/cleocode/.cleo/tasks.db',
  brainDbExists: true,
  tasksDbExists: true,
} as const;

/** Alternative project context returned for a valid cookie. */
const OTHER_CTX = {
  projectId: 'proj-abc',
  name: 'other-project',
  projectPath: '/mnt/projects/other',
  brainDbPath: '/mnt/projects/other/.cleo/brain.db',
  tasksDbPath: '/mnt/projects/other/.cleo/tasks.db',
  brainDbExists: true,
  tasksDbExists: true,
} as const;

// ---------------------------------------------------------------------------
// Hook handler import
// ---------------------------------------------------------------------------

interface StubEvent {
  cookies: {
    get: (name: string) => string | undefined;
    set: (name: string, value: string, opts: Record<string, unknown>) => void;
  };
  locals: Record<string, unknown>;
  url: URL;
  request: Request;
}

type HandleFn = (args: { event: StubEvent; resolve: () => Promise<Response> }) => Promise<Response>;

async function importHandle(): Promise<{ handle: HandleFn }> {
  return import('../../../hooks.server.js') as unknown as Promise<{ handle: HandleFn }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal event object the hook consumes:
 *   - cookies.get returns the supplied cookie value
 *   - cookies.set is a no-op stub (required by refreshCsrfToken in Wave 1E)
 *   - url + request are benign GETs to a non-guarded path
 */
function makeEvent(cookieValue: string | undefined): StubEvent {
  return {
    cookies: {
      get: () => cookieValue,
      set: () => undefined,
    },
    locals: {},
    url: new URL('http://localhost:3456/'),
    request: new Request('http://localhost:3456/', { method: 'GET' }),
  };
}

/** Stub resolve function that returns a plain 200 response. */
async function resolve(): Promise<Response> {
  return new Response(null, { status: 200 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('hooks.server.ts — project context propagation', () => {
  beforeEach(() => {
    resolveDefaultProjectContext.mockReturnValue(DEFAULT_CTX);
    resolveProjectContext.mockReturnValue(null);
    getActiveProjectId.mockReturnValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sets locals.projectCtx to the default context when no cookie is present', async () => {
    getActiveProjectId.mockReturnValue(null);

    const { handle } = await importHandle();
    const event = makeEvent(undefined);

    await handle({ event, resolve });

    expect(event.locals['projectCtx']).toEqual(DEFAULT_CTX);
    expect(resolveProjectContext).not.toHaveBeenCalled();
    expect(resolveDefaultProjectContext).toHaveBeenCalledOnce();
  });

  it('sets locals.projectCtx from resolveProjectContext when a valid cookie is present', async () => {
    getActiveProjectId.mockReturnValue('proj-abc');
    resolveProjectContext.mockReturnValue(OTHER_CTX);

    const { handle } = await importHandle();
    const event = makeEvent('proj-abc');

    await handle({ event, resolve });

    expect(event.locals['projectCtx']).toEqual(OTHER_CTX);
    expect(resolveProjectContext).toHaveBeenCalledWith('proj-abc');
    expect(resolveDefaultProjectContext).not.toHaveBeenCalled();
  });

  it('falls back to the default context when the cookie contains an unknown project ID', async () => {
    getActiveProjectId.mockReturnValue('unknown-project-xyz');
    // resolveProjectContext returns null for unknown IDs
    resolveProjectContext.mockReturnValue(null);

    const { handle } = await importHandle();
    const event = makeEvent('unknown-project-xyz');

    await handle({ event, resolve });

    expect(event.locals['projectCtx']).toEqual(DEFAULT_CTX);
    expect(resolveProjectContext).toHaveBeenCalledWith('unknown-project-xyz');
    expect(resolveDefaultProjectContext).toHaveBeenCalledOnce();
  });

  it('returns the resolved response from the resolve function', async () => {
    getActiveProjectId.mockReturnValue(null);

    const { handle } = await importHandle();
    const event = makeEvent(undefined);

    const response = await handle({ event, resolve });

    expect(response.status).toBe(200);
  });
});

describe('actual modern-store context resolution', () => {
  let root: string;
  let projectA: string;
  let projectB: string;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'studio-modern-context-'));
    projectA = join(root, 'a');
    projectB = join(root, 'b');
    const globalHome = join(root, 'cleo');
    mkdirSync(globalHome);
    vi.stubEnv('CLEO_HOME', globalHome);
    vi.stubEnv('CLEO_ROOT', projectA);
    vi.stubEnv('CLEO_DIR', join(projectA, '.cleo'));
    const registry = await openDualScopeDbAtPath('global', join(globalHome, 'cleo.db'));
    for (const [projectPath, projectId, title] of [
      [projectA, 'aaaaaaaaaaaa', 'Task A'],
      [projectB, 'bbbbbbbbbbbb', 'Task B'],
    ]) {
      mkdirSync(join(projectPath, '.cleo'), { recursive: true });
      writeFileSync(
        join(projectPath, '.cleo/project-info.json'),
        JSON.stringify({ projectId, projectHash: projectId }),
      );
      registry.db
        .insert(nexusProjectRegistry)
        .values({
          projectId,
          projectHash: projectId,
          projectPath,
          name: title,
          brainDbPath: join(projectPath, '.cleo/brain.db'),
          tasksDbPath: join(projectPath, '.cleo/tasks.db'),
        })
        .run();
      const accessor = await getTaskAccessor(projectPath);
      await accessor.upsertSingleTask({
        id: 'T001',
        title,
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      });
      expect(existsSync(join(projectPath, '.cleo/cleo.db'))).toBe(true);
      expect(existsSync(join(projectPath, '.cleo/tasks.db'))).toBe(false);
      expect(existsSync(join(projectPath, '.cleo/brain.db'))).toBe(false);
    }
  });
  afterEach(async () => {
    await closeAllDatabases();
    _resetDualScopeDbCache();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('recognizes the default consolidated store and persisted project identity', async () => {
    const actual =
      await vi.importActual<typeof import('../project-context.js')>('../project-context.js');
    const context = actual.resolveDefaultProjectContext();
    expect(context).toMatchObject({
      projectId: 'aaaaaaaaaaaa',
      projectPath: projectA,
      tasksDbPath: join(projectA, '.cleo/cleo.db'),
      brainDbPath: join(projectA, '.cleo/cleo.db'),
      tasksDbExists: true,
      brainDbExists: true,
    });
    expect((await listTasks({}, context.projectPath)).tasks.map((task) => task.title)).toEqual([
      'Task A',
    ]);
  });

  it('switches registered projects without trusting retired paths or ambient pins', async () => {
    const actual =
      await vi.importActual<typeof import('../project-context.js')>('../project-context.js');
    for (const [projectId, projectPath, title] of [
      ['bbbbbbbbbbbb', projectB, 'Task B'],
      ['aaaaaaaaaaaa', projectA, 'Task A'],
    ]) {
      const context = actual.resolveProjectContext(projectId);
      expect(context).toMatchObject({
        projectId,
        projectPath,
        tasksDbPath: join(projectPath, '.cleo/cleo.db'),
        brainDbPath: join(projectPath, '.cleo/cleo.db'),
        tasksDbExists: true,
        brainDbExists: true,
      });
      expect((await listTasks({}, context!.projectPath)).tasks.map((task) => task.title)).toEqual([
        title,
      ]);
    }
    expect(
      actual
        .listRegisteredProjects()
        .map((project) => project.tasksDbPath)
        .sort(),
    ).toEqual([join(projectA, '.cleo/cleo.db'), join(projectB, '.cleo/cleo.db')]);
  });

  it('resolves an explicit CLEO_ROOT without requiring CLEO_DIR or matching cwd', async () => {
    const actual =
      await vi.importActual<typeof import('../project-context.js')>('../project-context.js');
    vi.stubEnv('CLEO_DIR', undefined);
    vi.stubEnv('CLEO_ROOT', projectB);
    const context = actual.resolveDefaultProjectContext();
    expect(context).toMatchObject({
      projectId: 'bbbbbbbbbbbb',
      projectPath: projectB,
      tasksDbPath: join(projectB, '.cleo/cleo.db'),
      tasksDbExists: true,
    });
  });

  it('distinguishes an unknown project from an unreadable registry', async () => {
    const actual =
      await vi.importActual<typeof import('../project-context.js')>('../project-context.js');
    expect(actual.resolveProjectContext('missing-project')).toBeNull();
    const registry = await openDualScopeDbAtPath('global', join(root, 'cleo/cleo.db'));
    getDualScopeNativeDb(registry).exec(
      'ALTER TABLE nexus_project_registry RENAME TO unavailable_registry',
    );
    expect(() => actual.resolveProjectContext('aaaaaaaaaaaa')).toThrow(/nexus_project_registry/);
    expect(() => actual.listRegisteredProjects()).toThrow(/nexus_project_registry/);
  });

  it('does not replace unreadable persisted identity with an empty identity', async () => {
    const actual =
      await vi.importActual<typeof import('../project-context.js')>('../project-context.js');
    writeFileSync(join(projectA, '.cleo/project-info.json'), '{corrupted');
    expect(() => actual.resolveDefaultProjectContext()).toThrow(/identity/);
  });

  it('resolves global domain paths to the canonical global store', async () => {
    const paths = await import('../cleo-home.js');
    expect(paths.getNexusDbPath()).toBe(join(root, 'cleo/cleo.db'));
    expect(paths.getAgentRegistryDbPath()).toBe(join(root, 'cleo/cleo.db'));
    expect(paths.getTasksDbPath()).toBe(join(projectA, '.cleo/cleo.db'));
    expect(paths.getBrainDbPath()).toBe(join(projectA, '.cleo/cleo.db'));
    expect(paths.getConduitDbPath()).toBe(join(projectA, '.cleo/cleo.db'));
  });
});
