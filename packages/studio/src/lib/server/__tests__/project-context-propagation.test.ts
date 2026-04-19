/**
 * Tests for project context propagation via hooks.server.ts.
 *
 * Verifies that:
 * - When no cookie is set, locals.projectCtx falls back to the default context.
 * - When a valid project cookie is set, locals.projectCtx is resolved from the registry.
 * - When an invalid/unknown project cookie is set, locals.projectCtx falls back to default.
 *
 * All nexus.db reads are mocked so no real databases are required.
 */

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
