/**
 * Unit tests for the T657 project admin API endpoints:
 *
 *   DELETE /api/project/[id]          — cleo nexus projects remove <id> --json
 *   POST   /api/project/[id]/index    — cleo nexus analyze <path> --json
 *   POST   /api/project/[id]/reindex  — cleo nexus analyze <path> --json (same)
 *   POST   /api/project/clean         — cleo nexus projects clean --json [flags]
 *   POST   /api/project/scan          — cleo nexus projects scan --json [flags]
 *
 * All child_process.spawn calls are mocked; no real CLI is invoked.
 * All listRegisteredProjects calls are mocked for index/reindex.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock spawn-cli module
// ---------------------------------------------------------------------------

vi.mock('$lib/server/spawn-cli.js', () => ({
  runCleoCli: vi.fn(),
}));

import { runCleoCli as mockRunCleoCli } from '$lib/server/spawn-cli.js';

const runCleoCli = mockRunCleoCli as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Mock project-context module (only for index/reindex handlers)
// ---------------------------------------------------------------------------

vi.mock('$lib/server/project-context.js', () => ({
  listRegisteredProjects: vi.fn(),
}));

import { listRegisteredProjects as mockListProjects } from '$lib/server/project-context.js';

const listRegisteredProjects = mockListProjects as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Successful LAFS envelope. */
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

/** Failed CLI result (non-zero exit). */
function failResult(stderr = 'CLI error'): {
  ok: boolean;
  envelope: null;
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  return { ok: false, envelope: null, stdout: '', stderr, exitCode: 1 };
}

/** Minimal registered project fixture. */
const TEST_PROJECT = {
  projectId: 'proj-abc123',
  name: 'my-project',
  projectPath: '/home/user/code/my-project',
  brainDbPath: null,
  tasksDbPath: null,
  lastIndexed: null,
  taskCount: 0,
  nodeCount: 0,
  relationCount: 0,
  fileCount: 0,
  lastSeen: '2026-04-15T00:00:00.000Z',
  healthStatus: 'healthy',
};

// ---------------------------------------------------------------------------
// Handler import helpers — dynamic import after mocks are registered
// ---------------------------------------------------------------------------

async function importDelete(): Promise<{
  DELETE: (ctx: { params: { id: string } }) => Promise<Response>;
}> {
  return import('../[id]/+server.js') as Promise<{
    DELETE: (ctx: { params: { id: string } }) => Promise<Response>;
  }>;
}

async function importIndex(): Promise<{
  POST: (ctx: { params: { id: string } }) => Promise<Response>;
}> {
  return import('../[id]/index/+server.js') as Promise<{
    POST: (ctx: { params: { id: string } }) => Promise<Response>;
  }>;
}

async function importReindex(): Promise<{
  POST: (ctx: { params: { id: string } }) => Promise<Response>;
}> {
  return import('../[id]/reindex/+server.js') as Promise<{
    POST: (ctx: { params: { id: string } }) => Promise<Response>;
  }>;
}

async function importClean(): Promise<{
  POST: (ctx: { request: Request }) => Promise<Response>;
}> {
  return import('../clean/+server.js') as Promise<{
    POST: (ctx: { request: Request }) => Promise<Response>;
  }>;
}

async function importScan(): Promise<{
  POST: (ctx: { request: Request }) => Promise<Response>;
}> {
  return import('../scan/+server.js') as Promise<{
    POST: (ctx: { request: Request }) => Promise<Response>;
  }>;
}

function makeRequest(body: unknown = null): Request {
  if (body === null) {
    return new Request('http://localhost/', { method: 'POST' });
  }
  return new Request('http://localhost/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  listRegisteredProjects.mockReturnValue([TEST_PROJECT]);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// DELETE /api/project/[id]
// ===========================================================================

describe('DELETE /api/project/[id]', () => {
  it('calls cleo nexus projects remove <id> --json', async () => {
    runCleoCli.mockResolvedValue(okEnvelope());
    const { DELETE } = await importDelete();

    const res = await DELETE({ params: { id: 'proj-abc123' } });
    expect(res.status).toBe(200);

    expect(runCleoCli).toHaveBeenCalledWith([
      'nexus',
      'projects',
      'remove',
      'proj-abc123',
      '--json',
    ]);
  });

  it('returns success envelope on ok result', async () => {
    runCleoCli.mockResolvedValue(okEnvelope({ removed: true }));
    const { DELETE } = await importDelete();

    const res = await DELETE({ params: { id: 'proj-abc123' } });
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });

  it('returns 502 when CLI fails', async () => {
    runCleoCli.mockResolvedValue(failResult('no such project'));
    const { DELETE } = await importDelete();

    const res = await DELETE({ params: { id: 'proj-abc123' } });
    expect(res.status).toBe(502);

    const body = (await res.json()) as { success: boolean; error: { message: string } };
    expect(body.success).toBe(false);
    expect(body.error.message).toContain('no such project');
  });

  it('returns 400 for empty project id', async () => {
    const { DELETE } = await importDelete();

    const res = await DELETE({ params: { id: '' } });
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// POST /api/project/[id]/index
// ===========================================================================

describe('POST /api/project/[id]/index', () => {
  it('calls cleo nexus analyze <projectPath> --json', async () => {
    runCleoCli.mockResolvedValue(okEnvelope());
    const { POST } = await importIndex();

    await POST({ params: { id: 'proj-abc123' } });

    expect(runCleoCli).toHaveBeenCalledWith([
      'nexus',
      'analyze',
      '/home/user/code/my-project',
      '--json',
    ]);
  });

  it('returns 404 when project is not in registry', async () => {
    listRegisteredProjects.mockReturnValue([]);
    const { POST } = await importIndex();

    const res = await POST({ params: { id: 'proj-missing' } });
    expect(res.status).toBe(404);
  });

  it('returns 502 when CLI fails', async () => {
    runCleoCli.mockResolvedValue(failResult('analyze error'));
    const { POST } = await importIndex();

    const res = await POST({ params: { id: 'proj-abc123' } });
    expect(res.status).toBe(502);

    const body = (await res.json()) as { success: boolean; error: { message: string } };
    expect(body.success).toBe(false);
    expect(body.error.message).toContain('analyze error');
  });

  it('returns success envelope on ok result', async () => {
    runCleoCli.mockResolvedValue(okEnvelope({ filesIndexed: 42 }));
    const { POST } = await importIndex();

    const res = await POST({ params: { id: 'proj-abc123' } });
    const body = (await res.json()) as { success: boolean };
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });
});

// ===========================================================================
// POST /api/project/[id]/reindex
// ===========================================================================

describe('POST /api/project/[id]/reindex', () => {
  it('calls cleo nexus analyze <projectPath> --json (same as index)', async () => {
    runCleoCli.mockResolvedValue(okEnvelope());
    const { POST } = await importReindex();

    await POST({ params: { id: 'proj-abc123' } });

    expect(runCleoCli).toHaveBeenCalledWith([
      'nexus',
      'analyze',
      '/home/user/code/my-project',
      '--json',
    ]);
  });

  it('returns 404 when project is not in registry', async () => {
    listRegisteredProjects.mockReturnValue([]);
    const { POST } = await importReindex();

    const res = await POST({ params: { id: 'proj-missing' } });
    expect(res.status).toBe(404);
  });

  it('returns 502 when CLI fails', async () => {
    runCleoCli.mockResolvedValue(failResult('reindex error'));
    const { POST } = await importReindex();

    const res = await POST({ params: { id: 'proj-abc123' } });
    expect(res.status).toBe(502);
  });
});

// ===========================================================================
// POST /api/project/clean
// ===========================================================================

describe('POST /api/project/clean', () => {
  it('defaults to --dry-run when dryRun is omitted', async () => {
    runCleoCli.mockResolvedValue(okEnvelope());
    const { POST } = await importClean();

    await POST({ request: makeRequest({}) });

    const args: string[] = runCleoCli.mock.calls[0][0];
    expect(args).toContain('--dry-run');
    expect(args).not.toContain('--yes');
  });

  it('defaults to --dry-run when no body is provided', async () => {
    runCleoCli.mockResolvedValue(okEnvelope());
    const { POST } = await importClean();

    await POST({ request: makeRequest(null) });

    const args: string[] = runCleoCli.mock.calls[0][0];
    expect(args).toContain('--dry-run');
  });

  it('uses --yes (no --dry-run) when dryRun is explicitly false', async () => {
    runCleoCli.mockResolvedValue(okEnvelope());
    const { POST } = await importClean();

    await POST({ request: makeRequest({ dryRun: false }) });

    const args: string[] = runCleoCli.mock.calls[0][0];
    expect(args).toContain('--yes');
    expect(args).not.toContain('--dry-run');
  });

  it('passes --include-temp when includeTemp is true', async () => {
    runCleoCli.mockResolvedValue(okEnvelope());
    const { POST } = await importClean();

    await POST({ request: makeRequest({ includeTemp: true }) });

    const args: string[] = runCleoCli.mock.calls[0][0];
    expect(args).toContain('--include-temp');
  });

  it('passes --include-tests when includeTests is true', async () => {
    runCleoCli.mockResolvedValue(okEnvelope());
    const { POST } = await importClean();

    await POST({ request: makeRequest({ includeTests: true }) });

    const args: string[] = runCleoCli.mock.calls[0][0];
    expect(args).toContain('--include-tests');
  });

  it('passes --unhealthy when includeUnhealthy is true', async () => {
    runCleoCli.mockResolvedValue(okEnvelope());
    const { POST } = await importClean();

    await POST({ request: makeRequest({ includeUnhealthy: true }) });

    const args: string[] = runCleoCli.mock.calls[0][0];
    expect(args).toContain('--unhealthy');
  });

  it('passes --never-indexed when includeNeverIndexed is true', async () => {
    runCleoCli.mockResolvedValue(okEnvelope());
    const { POST } = await importClean();

    await POST({ request: makeRequest({ includeNeverIndexed: true }) });

    const args: string[] = runCleoCli.mock.calls[0][0];
    expect(args).toContain('--never-indexed');
  });

  it('passes --pattern <value> when pattern is provided', async () => {
    runCleoCli.mockResolvedValue(okEnvelope());
    const { POST } = await importClean();

    await POST({ request: makeRequest({ pattern: '/tmp/' }) });

    const args: string[] = runCleoCli.mock.calls[0][0];
    const patternIdx = args.indexOf('--pattern');
    expect(patternIdx).toBeGreaterThan(-1);
    expect(args[patternIdx + 1]).toBe('/tmp/');
  });

  it('does NOT pass --pattern when pattern is empty string', async () => {
    runCleoCli.mockResolvedValue(okEnvelope());
    const { POST } = await importClean();

    await POST({ request: makeRequest({ pattern: '   ' }) });

    const args: string[] = runCleoCli.mock.calls[0][0];
    expect(args).not.toContain('--pattern');
  });

  it('returns 502 when CLI fails', async () => {
    runCleoCli.mockResolvedValue(failResult('clean failed'));
    const { POST } = await importClean();

    const res = await POST({ request: makeRequest({}) });
    expect(res.status).toBe(502);

    const body = (await res.json()) as { success: boolean; error: { message: string } };
    expect(body.success).toBe(false);
    expect(body.error.message).toContain('clean failed');
  });

  it('constructs base args correctly: nexus projects clean --json --dry-run', async () => {
    runCleoCli.mockResolvedValue(okEnvelope());
    const { POST } = await importClean();

    await POST({ request: makeRequest({}) });

    const args: string[] = runCleoCli.mock.calls[0][0];
    expect(args[0]).toBe('nexus');
    expect(args[1]).toBe('projects');
    expect(args[2]).toBe('clean');
    expect(args[3]).toBe('--json');
  });
});

// ===========================================================================
// POST /api/project/scan
// ===========================================================================

describe('POST /api/project/scan', () => {
  it('constructs base args: nexus projects scan --json', async () => {
    runCleoCli.mockResolvedValue(okEnvelope());
    const { POST } = await importScan();

    await POST({ request: makeRequest({}) });

    const args: string[] = runCleoCli.mock.calls[0][0];
    expect(args[0]).toBe('nexus');
    expect(args[1]).toBe('projects');
    expect(args[2]).toBe('scan');
    expect(args[3]).toBe('--json');
  });

  it('passes --roots <value> when roots is provided', async () => {
    runCleoCli.mockResolvedValue(okEnvelope());
    const { POST } = await importScan();

    await POST({ request: makeRequest({ roots: '~/code,~/projects' }) });

    const args: string[] = runCleoCli.mock.calls[0][0];
    const rootsIdx = args.indexOf('--roots');
    expect(rootsIdx).toBeGreaterThan(-1);
    expect(args[rootsIdx + 1]).toBe('~/code,~/projects');
  });

  it('passes --max-depth <n> when maxDepth is a positive integer', async () => {
    runCleoCli.mockResolvedValue(okEnvelope());
    const { POST } = await importScan();

    await POST({ request: makeRequest({ maxDepth: 4 }) });

    const args: string[] = runCleoCli.mock.calls[0][0];
    const depthIdx = args.indexOf('--max-depth');
    expect(depthIdx).toBeGreaterThan(-1);
    expect(args[depthIdx + 1]).toBe('4');
  });

  it('passes --auto-register when autoRegister is true', async () => {
    runCleoCli.mockResolvedValue(okEnvelope());
    const { POST } = await importScan();

    await POST({ request: makeRequest({ autoRegister: true }) });

    const args: string[] = runCleoCli.mock.calls[0][0];
    expect(args).toContain('--auto-register');
  });

  it('does NOT pass --auto-register when omitted', async () => {
    runCleoCli.mockResolvedValue(okEnvelope());
    const { POST } = await importScan();

    await POST({ request: makeRequest({}) });

    const args: string[] = runCleoCli.mock.calls[0][0];
    expect(args).not.toContain('--auto-register');
  });

  it('does NOT pass --max-depth when maxDepth is 0 or missing', async () => {
    runCleoCli.mockResolvedValue(okEnvelope());
    const { POST } = await importScan();

    await POST({ request: makeRequest({ maxDepth: 0 }) });

    const args: string[] = runCleoCli.mock.calls[0][0];
    expect(args).not.toContain('--max-depth');
  });

  it('returns 502 when CLI fails', async () => {
    runCleoCli.mockResolvedValue(failResult('scan error'));
    const { POST } = await importScan();

    const res = await POST({ request: makeRequest({}) });
    expect(res.status).toBe(502);

    const body = (await res.json()) as { success: boolean; error: { message: string } };
    expect(body.success).toBe(false);
    expect(body.error.message).toContain('scan error');
  });

  it('returns success envelope on ok result', async () => {
    runCleoCli.mockResolvedValue(okEnvelope({ found: 10, registered: 3 }));
    const { POST } = await importScan();

    const res = await POST({ request: makeRequest({}) });
    const body = (await res.json()) as { success: boolean };
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('handles empty body gracefully (no body = default args only)', async () => {
    runCleoCli.mockResolvedValue(okEnvelope());
    const { POST } = await importScan();

    await POST({ request: makeRequest(null) });

    const args: string[] = runCleoCli.mock.calls[0][0];
    // No extra flags beyond the base command
    expect(args).toEqual(['nexus', 'projects', 'scan', '--json']);
  });
});
