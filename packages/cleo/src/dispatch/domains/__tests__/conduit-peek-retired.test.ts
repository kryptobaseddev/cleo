/**
 * `conduit.peek` never acks or consumes, and `conduit.status` / `peek` /
 * `send` never call a retired SignalDock host (T13169).
 *
 * The peek case runs against a real project conduit store: a message that
 * peek returned must still be pending afterwards, so a second peek and the
 * recipient's own poll both see it again.
 *
 * @task T13169
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentCredential } from '@cleocode/contracts';
import { LocalTransport } from '@cleocode/core/conduit';
import { ensureConduitDb } from '@cleocode/core/store/conduit-sqlite.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConduitHandler } from '../conduit.js';

const AGENT = 'peek-agent';

const state: { apiBaseUrl: string } = { apiBaseUrl: 'local' };

function credential(): AgentCredential {
  return {
    agentId: AGENT,
    displayName: 'Peek Agent',
    apiKey: 'sk_test_key',
    apiBaseUrl: state.apiBaseUrl,
    privacyTier: 'public',
    capabilities: [],
    skills: [],
    transportType: 'http',
    transportConfig: {},
    isActive: true,
    createdAt: '2026-10-04T00:00:00.000Z',
    updatedAt: '2026-10-04T00:00:00.000Z',
  };
}

// The conduit domain reads its credential from the agent registry; this test
// is about message handling, not the registry store.
vi.mock('@cleocode/core/internal', () => ({
  getDb: async () => undefined,
  AgentRegistryAccessor: class {
    async get(): Promise<AgentCredential> {
      return credential();
    }
    async getActive(): Promise<AgentCredential> {
      return credential();
    }
  },
}));

let testDir: string;
let originalCwd: string;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
  state.apiBaseUrl = 'local';
  originalCwd = process.cwd();
  testDir = join(tmpdir(), `conduit-peek-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(testDir, '.cleo'), { recursive: true });
  writeFileSync(
    join(testDir, '.cleo', 'project-info.json'),
    JSON.stringify({ projectId: 'conduit-peek-fixture' }),
  );
  process.chdir(testDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe('conduit.peek (T13169)', () => {
  it('returns a pending message without acking it: peek twice, then the recipient still sees it', async () => {
    await ensureConduitDb(testDir);
    const sender = new LocalTransport();
    await sender.connect({ agentId: 'sender', apiKey: 'k', apiBaseUrl: 'local' });
    await sender.push(AGENT, 'hello from sender');
    await sender.disconnect();

    const handler = new ConduitHandler();
    for (const round of [1, 2]) {
      const result = await handler.query('peek', { agentId: AGENT });
      expect(result.success, `peek round ${round}`).toBe(true);
      expect(JSON.stringify(result.data)).toContain('hello from sender');
    }

    const recipient = new LocalTransport();
    await recipient.connect({ agentId: AGENT, apiKey: 'k', apiBaseUrl: 'local' });
    try {
      const pending = await recipient.poll();
      expect(pending.map((m) => m.content)).toEqual(['hello from sender']);
    } finally {
      await recipient.disconnect();
    }
  });
});

describe('a SignalDock agent without a conduit store (T13169)', () => {
  beforeEach(() => {
    state.apiBaseUrl = 'https://api.signaldock.io';
  });

  it('status reports it disconnected and calls nothing', async () => {
    const result = await new ConduitHandler().query('status', { agentId: AGENT });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ connected: false });
    expect(JSON.stringify(result.data)).toContain('SignalDock is retired');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('peek and send fail with E_SIGNALDOCK_RETIRED and call nothing', async () => {
    const handler = new ConduitHandler();
    const peek = await handler.query('peek', { agentId: AGENT });
    const send = await handler.mutate('send', { agentId: AGENT, to: 'other', content: 'hi' });
    expect(peek.success).toBe(false);
    expect(peek.error?.code).toBe('E_SIGNALDOCK_RETIRED');
    expect(send.success).toBe(false);
    expect(send.error?.code).toBe('E_SIGNALDOCK_RETIRED');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
