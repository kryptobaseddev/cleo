/**
 * /api/health endpoint smoke tests.
 *
 * Verifies the T990 audit fix: version is read from `package.json`
 * at runtime (no longer hardcoded `2026.4.47`), response includes
 * `checkedAt` + `uptime`, and each database report has the new
 * `available` / `rowCount` / `schemaVersion` / `path` shape.
 *
 * Connections module is mocked so these run in any sandbox.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface DbReport {
  available: boolean;
  rowCount: number | null;
  schemaVersion: string | null;
  path: string;
}

interface HealthEnvelope {
  ok: boolean;
  service: string;
  version: string;
  checkedAt: string;
  uptime: number;
  databases: Record<string, DbReport>;
}

// -------------------------------------------------------------------------
// Mock db/connections
// -------------------------------------------------------------------------

vi.mock('$lib/server/db/connections.js', () => ({
  getDbStatus: vi.fn(() => ({
    nexus: true,
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
  getConduitDb: vi.fn(() => null),
  getSignaldockDb: vi.fn(() => null),
}));

interface PartialEvent {
  locals: { projectCtx: unknown };
}

function asEvent<Fn extends (ctx: never) => unknown>(partial: PartialEvent): Parameters<Fn>[0] {
  return partial as unknown as Parameters<Fn>[0];
}

async function importHealth(): Promise<typeof import('../+server.js')> {
  return import('../+server.js');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/health', () => {
  it('returns the Studio package.json version (not the hardcoded string)', async () => {
    const { GET } = await importHealth();
    const res = await GET(asEvent<typeof GET>({ locals: { projectCtx: {} } }));
    const body = (await (res as Response).json()) as HealthEnvelope;

    // Read the real version out of package.json for comparison.
    const pkgPath = path.resolve(
      fileURLToPath(new URL('../../../../../package.json', import.meta.url)),
    );
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };

    expect(body.version).toBe(pkg.version);
    expect(body.version).not.toBe('2026.4.47');
  });

  it('includes checkedAt + uptime fields', async () => {
    const { GET } = await importHealth();
    const res = await GET(asEvent<typeof GET>({ locals: { projectCtx: {} } }));
    const body = (await (res as Response).json()) as HealthEnvelope;

    expect(typeof body.checkedAt).toBe('string');
    expect(body.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(typeof body.uptime).toBe('number');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it('exposes the expanded database report shape', async () => {
    const { GET } = await importHealth();
    const res = await GET(asEvent<typeof GET>({ locals: { projectCtx: {} } }));
    const body = (await (res as Response).json()) as HealthEnvelope;

    for (const key of ['nexus', 'brain', 'tasks', 'conduit', 'signaldock']) {
      const report = body.databases[key];
      expect(report).toBeDefined();
      expect(typeof report?.available).toBe('boolean');
      expect(typeof report?.path).toBe('string');
      // rowCount / schemaVersion may be null when the DB is missing
      expect(report).toHaveProperty('rowCount');
      expect(report).toHaveProperty('schemaVersion');
    }
  });

  it('ok is always true (endpoint only fails on 500)', async () => {
    const { GET } = await importHealth();
    const res = await GET(asEvent<typeof GET>({ locals: { projectCtx: {} } }));
    const body = (await (res as Response).json()) as HealthEnvelope;
    expect(body.ok).toBe(true);
    expect(body.service).toBe('cleo-studio');
  });
});
