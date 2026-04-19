/**
 * Smoke tests for the T990 Wave 1E admin endpoints:
 *
 *   POST /api/project/doctor        — wraps `cleo nexus doctor`
 *   GET  /api/project/backup        — lists snapshots (filesystem only)
 *   POST /api/project/backup        — wraps `cleo backup add`
 *   GET  /api/project/migrate       — read-only schema report
 *   POST /api/project/gc            — wraps `cleo nexus gc`
 *   POST /api/project/reindex-all   — fans out `cleo nexus analyze`
 *   GET  /api/project/audit         — reads studio-actions.jsonl
 *
 * Runs in vitest node environment. All spawn-cli / fs calls are mocked
 * so no real CLI executes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// -------------------------------------------------------------------------
// Mocks
// -------------------------------------------------------------------------

vi.mock('$lib/server/spawn-cli.js', () => ({
  runCleoCli: vi.fn(),
}));

vi.mock('$lib/server/audit-log.js', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/audit-log.js')>(
    '$lib/server/audit-log.js',
  );
  return {
    ...actual,
    recordAudit: vi.fn(),
    readAuditLog: vi.fn(() => []),
  };
});

vi.mock('$lib/server/project-context.js', () => ({
  listRegisteredProjects: vi.fn(() => []),
}));

vi.mock('$lib/server/db/connections.js', () => ({
  getDbStatus: vi.fn(() => ({
    nexus: false,
    brain: false,
    tasks: false,
    conduit: false,
    signaldock: false,
    nexusPath: '/tmp/nexus.db',
    brainPath: '/tmp/brain.db',
    tasksPath: '/tmp/tasks.db',
    conduitPath: '/tmp/conduit.db',
    signaldockPath: '/tmp/signaldock.db',
  })),
  getNexusDb: vi.fn(() => null),
  getBrainDb: vi.fn(() => null),
  getTasksDb: vi.fn(() => null),
}));

import { readAuditLog as mockReadAuditLog } from '$lib/server/audit-log.js';
import { listRegisteredProjects as mockListRegistered } from '$lib/server/project-context.js';
import { runCleoCli as mockRunCleoCli } from '$lib/server/spawn-cli.js';

const runCleoCli = mockRunCleoCli as ReturnType<typeof vi.fn>;
const readAuditLog = mockReadAuditLog as ReturnType<typeof vi.fn>;
const listRegisteredProjects = mockListRegistered as ReturnType<typeof vi.fn>;

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

interface ProjectCtx {
  projectId: string;
  name: string;
  projectPath: string;
  brainDbPath: string;
  tasksDbPath: string;
  brainDbExists: boolean;
  tasksDbExists: boolean;
}

function okEnvelope(data: Record<string, unknown> = {}): {
  ok: boolean;
  envelope: Record<string, unknown>;
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  return {
    ok: true,
    envelope: { success: true, data },
    stdout: JSON.stringify({ success: true, data }),
    stderr: '',
    exitCode: 0,
  };
}

const TEST_CTX: ProjectCtx = {
  projectId: 'proj-abc',
  name: 'my-project',
  projectPath: '/tmp/test-project',
  brainDbPath: '/tmp/test-project/.cleo/brain.db',
  tasksDbPath: '/tmp/test-project/.cleo/tasks.db',
  brainDbExists: false,
  tasksDbExists: false,
};

function makeRequest(body: unknown = null, method = 'POST'): Request {
  if (body === null) {
    return new Request('http://localhost/', { method });
  }
  return new Request('http://localhost/', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * The RequestEvent shape SvelteKit threads into `+server.ts` handlers
 * is route-param typed and requires cookies/fetch/params/… that our
 * handlers do not touch. We expose a bridge that produces the minimal
 * structural subtype our handlers actually read, and accepts it
 * positionally via parameterized `Parameters<T>[0]`.
 */
interface PartialEvent {
  request?: Request;
  url?: URL;
  locals: { projectCtx: ProjectCtx };
}

function asEvent<Fn extends (ctx: never) => unknown>(partial: PartialEvent): Parameters<Fn>[0] {
  return partial as unknown as Parameters<Fn>[0];
}

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  readAuditLog.mockReturnValue([]);
  listRegisteredProjects.mockReturnValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/project/doctor', () => {
  it('calls `cleo nexus doctor --json`', async () => {
    runCleoCli.mockResolvedValue(okEnvelope({ schemaVersion: '7' }));
    const { POST } = await import('../doctor/+server.js');

    const res = await POST(
      asEvent<typeof POST>({ request: makeRequest({}), locals: { projectCtx: TEST_CTX } }),
    );
    expect(res.status).toBe(200);

    const args: string[] = runCleoCli.mock.calls[0][0];
    expect(args[0]).toBe('nexus');
    expect(args[1]).toBe('doctor');
    expect(args).toContain('--json');
  });

  it('forwards --project when projectId is supplied', async () => {
    runCleoCli.mockResolvedValue(okEnvelope());
    const { POST } = await import('../doctor/+server.js');

    await POST(
      asEvent<typeof POST>({
        request: makeRequest({ projectId: 'proj-xyz' }),
        locals: { projectCtx: TEST_CTX },
      }),
    );
    const args: string[] = runCleoCli.mock.calls[0][0];
    const idx = args.indexOf('--project');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('proj-xyz');
  });
});

describe('GET /api/project/backup', () => {
  it('returns an empty list when the backups dir is missing', async () => {
    const { GET } = await import('../backup/+server.js');
    const res = await GET(asEvent<typeof GET>({ locals: { projectCtx: TEST_CTX } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { backups: unknown[]; dir: string };
    };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.backups)).toBe(true);
    expect(body.data.dir).toContain('backups/sqlite');
  });
});

describe('POST /api/project/backup', () => {
  it('calls `cleo backup add --json`', async () => {
    runCleoCli.mockResolvedValue(okEnvelope({ filename: 'tasks-20260419.db' }));
    const { POST } = await import('../backup/+server.js');
    const res = await POST(
      asEvent<typeof POST>({
        request: makeRequest({ note: 'hello' }),
        locals: { projectCtx: TEST_CTX },
      }),
    );
    expect(res.status).toBe(200);
    const args: string[] = runCleoCli.mock.calls[0][0];
    expect(args.slice(0, 3)).toEqual(['backup', 'add', '--json']);
    expect(args).toContain('--note');
    expect(args).toContain('hello');
  });
});

describe('GET /api/project/migrate', () => {
  it('returns a read-only schema status envelope', async () => {
    const { GET } = await import('../migrate/+server.js');
    const res = await GET(asEvent<typeof GET>({ locals: { projectCtx: TEST_CTX } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: {
        databases: { nexus: unknown; brain: unknown; tasks: unknown };
        note: string;
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.databases).toHaveProperty('nexus');
    expect(body.data.databases).toHaveProperty('brain');
    expect(body.data.databases).toHaveProperty('tasks');
    expect(typeof body.data.note).toBe('string');
  });
});

describe('POST /api/project/gc', () => {
  it('defaults to --dry-run', async () => {
    runCleoCli.mockResolvedValue(okEnvelope());
    const { POST } = await import('../gc/+server.js');
    await POST(
      asEvent<typeof POST>({ request: makeRequest({}), locals: { projectCtx: TEST_CTX } }),
    );
    const args: string[] = runCleoCli.mock.calls[0][0];
    expect(args).toContain('--dry-run');
    expect(args).not.toContain('--yes');
  });

  it('uses --yes when dryRun is explicitly false', async () => {
    runCleoCli.mockResolvedValue(okEnvelope());
    const { POST } = await import('../gc/+server.js');
    await POST(
      asEvent<typeof POST>({
        request: makeRequest({ dryRun: false }),
        locals: { projectCtx: TEST_CTX },
      }),
    );
    const args: string[] = runCleoCli.mock.calls[0][0];
    expect(args).toContain('--yes');
    expect(args).not.toContain('--dry-run');
  });
});

describe('POST /api/project/reindex-all', () => {
  it('returns a summary for zero registered projects', async () => {
    listRegisteredProjects.mockReturnValue([]);
    const { POST } = await import('../reindex-all/+server.js');
    const res = await POST(
      asEvent<typeof POST>({ request: makeRequest({}), locals: { projectCtx: TEST_CTX } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { total: number; succeeded: number; failed: number; skipped: number };
    };
    expect(body.success).toBe(true);
    expect(body.data.total).toBe(0);
    expect(body.data.succeeded).toBe(0);
    expect(body.data.failed).toBe(0);
  });

  it('runs `cleo nexus analyze` per project and reports success', async () => {
    listRegisteredProjects.mockReturnValue([
      {
        projectId: 'p1',
        name: 'one',
        projectPath: '/a',
        lastIndexed: null,
        taskCount: 0,
        nodeCount: 0,
        relationCount: 0,
        fileCount: 0,
        lastSeen: '2026-04-19',
        healthStatus: 'healthy',
      },
    ]);
    runCleoCli.mockResolvedValue(okEnvelope({ filesIndexed: 10 }));
    const { POST } = await import('../reindex-all/+server.js');
    const res = await POST(
      asEvent<typeof POST>({ request: makeRequest({}), locals: { projectCtx: TEST_CTX } }),
    );
    const body = (await res.json()) as {
      success: boolean;
      data: { total: number; succeeded: number; failed: number };
    };
    expect(body.success).toBe(true);
    expect(body.data.total).toBe(1);
    expect(body.data.succeeded).toBe(1);
    expect(body.data.failed).toBe(0);
  });

  it('skips non-stale projects when onlyStale is true', async () => {
    const recent = new Date().toISOString();
    listRegisteredProjects.mockReturnValue([
      {
        projectId: 'p1',
        name: 'one',
        projectPath: '/a',
        lastIndexed: recent,
        taskCount: 0,
        nodeCount: 0,
        relationCount: 0,
        fileCount: 0,
        lastSeen: '2026-04-19',
        healthStatus: 'healthy',
      },
    ]);
    runCleoCli.mockResolvedValue(okEnvelope());
    const { POST } = await import('../reindex-all/+server.js');
    const res = await POST(
      asEvent<typeof POST>({
        request: makeRequest({ onlyStale: true, staleDays: 7 }),
        locals: { projectCtx: TEST_CTX },
      }),
    );
    const body = (await res.json()) as {
      data: { skipped: number; succeeded: number };
    };
    expect(body.data.skipped).toBe(1);
    expect(body.data.succeeded).toBe(0);
    expect(runCleoCli).not.toHaveBeenCalled();
  });
});

describe('GET /api/project/audit', () => {
  it('returns the trailing N entries (default 50)', async () => {
    readAuditLog.mockReturnValue([
      {
        timestamp: '2026-04-19T10:00:00Z',
        actor: 'studio-admin',
        action: 'project.scan',
        target: null,
        result: 'success',
      },
    ]);
    const { GET } = await import('../audit/+server.js');
    const res = await GET(
      asEvent<typeof GET>({
        url: new URL('http://localhost/api/project/audit'),
        locals: { projectCtx: TEST_CTX },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { entries: unknown[]; projectPath: string };
    };
    expect(body.success).toBe(true);
    expect(body.data.entries.length).toBe(1);
    expect(body.data.projectPath).toBe(TEST_CTX.projectPath);
  });

  it('caps limit to 500', async () => {
    readAuditLog.mockReturnValue([]);
    const { GET } = await import('../audit/+server.js');
    await GET(
      asEvent<typeof GET>({
        url: new URL('http://localhost/api/project/audit?limit=99999'),
        locals: { projectCtx: TEST_CTX },
      }),
    );
    const call = readAuditLog.mock.calls[0];
    expect(call[1]).toBe(500);
  });
});
