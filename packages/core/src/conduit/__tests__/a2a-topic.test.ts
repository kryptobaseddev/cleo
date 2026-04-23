/**
 * A2A (Agent-to-Agent) Topic Pub-Sub test suite — T1252 CONDUIT Wave 9.
 *
 * Tests the topic-based coordination layer introduced in T1252:
 * - LocalTransport: subscribeTopic, publishToTopic, onTopic, unsubscribeTopic, pollTopic
 * - ConduitClient: topic method delegation + error when transport lacks support
 * - E2E: two concurrent subagents exchange messages via conduit and complete
 *   a coordinated task (atom 5 of T1149 parent).
 *
 * All tests use an in-process temporary conduit.db to avoid any network I/O.
 *
 * @task T1252
 * @epic T1149
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentCredential, ConduitMessage, Transport } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureConduitDb } from '../../store/conduit-sqlite.js';
import { ConduitClient } from '../conduit-client.js';
import { LocalTransport } from '../local-transport.js';

// ============================================================================
// Test helpers
// ============================================================================

let testDir: string;
let originalCwd: string;

/** Create a temporary directory with a valid conduit.db for testing. */
function setupTestDb(): string {
  const dir = join(tmpdir(), `a2a-topic-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, '.cleo'), { recursive: true });
  ensureConduitDb(dir);
  return dir;
}

/** Standard connect config for tests. */
function testConfig(agentId: string) {
  return {
    agentId,
    apiKey: 'sk_test_fake',
    apiBaseUrl: 'http://localhost:4000',
  };
}

/** Minimal AgentCredential for ConduitClient tests. */
function makeCredential(agentId: string): AgentCredential {
  return {
    agentId,
    displayName: agentId,
    apiKey: 'sk_test_fake',
    apiBaseUrl: 'http://localhost:4000',
    privacyTier: 'private',
    capabilities: [],
    skills: [],
    transportType: 'local',
    transportConfig: { pollIntervalMs: 5000 },
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

// ============================================================================
// LocalTransport topic tests
// ============================================================================

describe('LocalTransport — A2A Topic Operations (T1252)', () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = setupTestDb();
    process.chdir(testDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // subscribeTopic
  // --------------------------------------------------------------------------

  describe('subscribeTopic', () => {
    it('subscribes to a new topic (idempotent)', async () => {
      const transport = new LocalTransport();
      await transport.connect(testConfig('lead-1'));

      await expect(transport.subscribeTopic('epic-T1149.wave-2')).resolves.toBeUndefined();
      // Second call is idempotent (ON CONFLICT DO NOTHING)
      await expect(transport.subscribeTopic('epic-T1149.wave-2')).resolves.toBeUndefined();

      await transport.disconnect();
    });

    it('handles coordination topic naming', async () => {
      const transport = new LocalTransport();
      await transport.connect(testConfig('orchestrator'));

      await expect(transport.subscribeTopic('epic-T1149.coordination')).resolves.toBeUndefined();

      await transport.disconnect();
    });

    it('throws when not connected', async () => {
      const transport = new LocalTransport();
      await expect(transport.subscribeTopic('epic-T1149.wave-2')).rejects.toThrow(
        'LocalTransport not connected',
      );
    });
  });

  // --------------------------------------------------------------------------
  // publishToTopic
  // --------------------------------------------------------------------------

  describe('publishToTopic', () => {
    it('publishes a message and returns a messageId', async () => {
      const transport = new LocalTransport();
      await transport.connect(testConfig('lead-2'));
      await transport.subscribeTopic('epic-T1149.wave-2');

      const result = await transport.publishToTopic('epic-T1149.wave-2', 'Wave 2 findings ready', {
        kind: 'notify',
        payload: { event: 'work-complete', waveId: 2 },
      });

      expect(result).toMatchObject({ messageId: expect.any(String) });
      await transport.disconnect();
    });

    it('auto-creates topic when it does not exist (publisher-first flow)', async () => {
      const transport = new LocalTransport();
      await transport.connect(testConfig('lead-2'));

      // publish without prior subscribe — topic should be created
      const result = await transport.publishToTopic('epic-T1149.wave-3', 'Early publish', {
        kind: 'message',
      });

      expect(result.messageId).toBeTruthy();
      await transport.disconnect();
    });

    it('stores payload as JSON', async () => {
      const transport = new LocalTransport();
      await transport.connect(testConfig('lead-2'));
      await transport.subscribeTopic('epic-T1149.wave-2');

      const payload = { event: 'work-complete', findings: ['insight-a', 'insight-b'] };
      const { messageId } = await transport.publishToTopic('epic-T1149.wave-2', 'findings', {
        kind: 'notify',
        payload,
      });

      // Retrieve via pollTopic and verify payload is round-tripped
      const messages = await transport.pollTopic('epic-T1149.wave-2');
      const found = messages.find((m) => m.id === messageId);
      expect(found?.payload).toEqual(payload);

      await transport.disconnect();
    });
  });

  // --------------------------------------------------------------------------
  // pollTopic
  // --------------------------------------------------------------------------

  describe('pollTopic', () => {
    it('returns an empty array when no messages', async () => {
      const transport = new LocalTransport();
      await transport.connect(testConfig('lead-1'));
      await transport.subscribeTopic('epic-T1149.wave-2');

      const messages = await transport.pollTopic('epic-T1149.wave-2');
      expect(messages).toEqual([]);

      await transport.disconnect();
    });

    it('returns published messages with correct fields', async () => {
      const transport = new LocalTransport();
      await transport.connect(testConfig('lead-1'));
      await transport.subscribeTopic('epic-T1149.wave-2');

      await transport.publishToTopic('epic-T1149.wave-2', 'hello', { kind: 'notify' });
      const messages = await transport.pollTopic('epic-T1149.wave-2');

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        from: 'lead-1',
        fromPeerId: 'lead-1',
        toPeerId: null,
        content: 'hello',
        kind: 'notify',
        threadId: 'epic-T1149.wave-2',
      });
      expect(messages[0]?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('respects the since watermark', async () => {
      const transport = new LocalTransport();
      await transport.connect(testConfig('lead-1'));
      await transport.subscribeTopic('epic-T1149.wave-2');

      // Record a point-in-time before any messages are published
      const beforeAny = Math.floor(Date.now() / 1000) - 1;

      // Publish two messages
      await transport.publishToTopic('epic-T1149.wave-2', 'msg-1', { kind: 'notify' });
      await transport.publishToTopic('epic-T1149.wave-2', 'msg-2', { kind: 'notify' });

      // Without since: returns all messages
      const all = await transport.pollTopic('epic-T1149.wave-2');
      expect(all.length).toBeGreaterThanOrEqual(2);

      // With since = a future time: returns nothing
      const afterAll = Math.floor(Date.now() / 1000) + 9999;
      const none = await transport.pollTopic('epic-T1149.wave-2', { since: afterAll });
      expect(none).toHaveLength(0);

      // With since = beforeAny (before test started): returns both messages
      const fromStart = await transport.pollTopic('epic-T1149.wave-2', { since: beforeAny });
      expect(fromStart.length).toBeGreaterThanOrEqual(2);

      await transport.disconnect();
    });

    it('returns empty for unknown topic', async () => {
      const transport = new LocalTransport();
      await transport.connect(testConfig('lead-1'));

      const messages = await transport.pollTopic('epic-T1149.nonexistent');
      expect(messages).toEqual([]);

      await transport.disconnect();
    });
  });

  // --------------------------------------------------------------------------
  // onTopic — in-process handler
  // --------------------------------------------------------------------------

  describe('onTopic', () => {
    it('receives messages published in-process', async () => {
      const transport = new LocalTransport();
      await transport.connect(testConfig('lead-1'));
      await transport.subscribeTopic('epic-T1149.wave-2');

      const received: ConduitMessage[] = [];
      const unsub = transport.onTopic('epic-T1149.wave-2', (msg) => received.push(msg));

      await transport.publishToTopic('epic-T1149.wave-2', 'ping', { kind: 'request' });

      // In-process delivery is synchronous via notifyTopicHandlers
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ content: 'ping', kind: 'request' });

      unsub();
      await transport.disconnect();
    });

    it('unsubscribing stops further delivery', async () => {
      const transport = new LocalTransport();
      await transport.connect(testConfig('lead-1'));
      await transport.subscribeTopic('epic-T1149.wave-2');

      const received: ConduitMessage[] = [];
      const unsub = transport.onTopic('epic-T1149.wave-2', (msg) => received.push(msg));

      unsub();

      await transport.publishToTopic('epic-T1149.wave-2', 'after-unsub', { kind: 'notify' });

      expect(received).toHaveLength(0);
      await transport.disconnect();
    });
  });

  // --------------------------------------------------------------------------
  // unsubscribeTopic
  // --------------------------------------------------------------------------

  describe('unsubscribeTopic', () => {
    it('removes subscription row from conduit.db', async () => {
      const transport = new LocalTransport();
      await transport.connect(testConfig('lead-1'));
      await transport.subscribeTopic('epic-T1149.wave-2');
      await expect(transport.unsubscribeTopic('epic-T1149.wave-2')).resolves.toBeUndefined();
      await transport.disconnect();
    });

    it('is a no-op for non-existent topics', async () => {
      const transport = new LocalTransport();
      await transport.connect(testConfig('lead-1'));
      await expect(transport.unsubscribeTopic('epic-T1149.phantom')).resolves.toBeUndefined();
      await transport.disconnect();
    });
  });
});

// ============================================================================
// ConduitClient — topic delegation tests
// ============================================================================

describe('ConduitClient — A2A Topic Delegation (T1252)', () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = setupTestDb();
    process.chdir(testDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('delegates subscribeTopic to LocalTransport', async () => {
    const transport = new LocalTransport();
    const client = new ConduitClient(transport, makeCredential('lead-1'));
    await client.connect();

    await expect(client.subscribeTopic('epic-T1149.wave-2')).resolves.toBeUndefined();
    await client.disconnect();
  });

  it('delegates publishToTopic to LocalTransport', async () => {
    const transport = new LocalTransport();
    const client = new ConduitClient(transport, makeCredential('lead-2'));
    await client.connect();
    await client.subscribeTopic('epic-T1149.wave-2');

    const result = await client.publishToTopic('epic-T1149.wave-2', 'findings ready', {
      kind: 'notify',
      payload: { event: 'work-complete' },
    });

    expect(result).toMatchObject({
      messageId: expect.any(String),
      deliveredAt: expect.any(String),
    });

    await client.disconnect();
  });

  it('delegates onTopic to LocalTransport', async () => {
    const transport = new LocalTransport();
    const client = new ConduitClient(transport, makeCredential('lead-1'));
    await client.connect();
    await client.subscribeTopic('epic-T1149.wave-2');

    const received: ConduitMessage[] = [];
    const unsub = client.onTopic('epic-T1149.wave-2', (msg) => received.push(msg));

    // Publish via the same transport (in-process)
    await transport.publishToTopic('epic-T1149.wave-2', 'hello', { kind: 'notify' });

    expect(received).toHaveLength(1);
    unsub();
    await client.disconnect();
  });

  it('delegates unsubscribeTopic to LocalTransport', async () => {
    const transport = new LocalTransport();
    const client = new ConduitClient(transport, makeCredential('lead-1'));
    await client.connect();
    await client.subscribeTopic('epic-T1149.wave-2');

    await expect(client.unsubscribeTopic('epic-T1149.wave-2')).resolves.toBeUndefined();
    await client.disconnect();
  });

  it('throws subscribeTopic when transport lacks the method', async () => {
    const mockTransport: Transport = {
      name: 'mock-no-topics',
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      push: vi.fn().mockResolvedValue({ messageId: 'x' }),
      poll: vi.fn().mockResolvedValue([]),
      ack: vi.fn().mockResolvedValue(undefined),
    };
    const client = new ConduitClient(mockTransport, makeCredential('test'));

    await expect(client.subscribeTopic('epic-T.wave-1')).rejects.toThrow(
      'does not support topic subscriptions',
    );
  });

  it('throws publishToTopic when transport lacks the method', async () => {
    const mockTransport: Transport = {
      name: 'mock-no-topics',
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      push: vi.fn().mockResolvedValue({ messageId: 'x' }),
      poll: vi.fn().mockResolvedValue([]),
      ack: vi.fn().mockResolvedValue(undefined),
    };
    const client = new ConduitClient(mockTransport, makeCredential('test'));

    await expect(client.publishToTopic('epic-T.wave-1', 'msg')).rejects.toThrow(
      'does not support topic publishing',
    );
  });
});

// ============================================================================
// E2E: Two concurrent subagents coordinate via CONDUIT topics
// ============================================================================

describe('E2E — Two subagents coordinate via CONDUIT topics (T1149 atom 5)', () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = setupTestDb();
    process.chdir(testDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  /**
   * Scenario (mirrors T1149 acceptance criteria):
   *
   * 1. Lead A and Lead B both subscribe to the wave topic `epic-T1149.wave-2`.
   * 2. Lead A subscribes to the coordination topic too.
   * 3. Lead B finishes its work and publishes to the wave topic (kind: notify).
   * 4. Lead A's `onTopic` handler fires and receives Lead B's notification.
   * 5. The orchestrator publishes a `wave-complete` teardown to the coordination topic.
   * 6. Lead A receives the teardown signal and records it.
   * 7. Both agents unsubscribe and disconnect cleanly.
   */
  it('exchanges wave-completion signals between two leads', async () => {
    const WAVE_TOPIC = 'epic-T1149.wave-2';
    const COORD_TOPIC = 'epic-T1149.coordination';

    // ── Setup: two agents share the same conduit.db ──────────────────────
    const transportA = new LocalTransport();
    const transportB = new LocalTransport();
    const transportOrch = new LocalTransport();

    await transportA.connect(testConfig('lead-A'));
    await transportB.connect(testConfig('lead-B'));
    await transportOrch.connect(testConfig('orchestrator'));

    // ── Step 1: Subscribe both leads to the wave topic ───────────────────
    await transportA.subscribeTopic(WAVE_TOPIC);
    await transportB.subscribeTopic(WAVE_TOPIC);

    // Lead A also subscribes to the coordination topic
    await transportA.subscribeTopic(COORD_TOPIC);

    // ── Step 2: Lead A registers onTopic handlers ────────────────────────
    const leadAWaveMessages: ConduitMessage[] = [];
    const leadACoordMessages: ConduitMessage[] = [];

    const unsubWave = transportA.onTopic(WAVE_TOPIC, (msg) => leadAWaveMessages.push(msg));
    const unsubCoord = transportA.onTopic(COORD_TOPIC, (msg) => leadACoordMessages.push(msg));

    // ── Step 3: Lead B completes and publishes findings ──────────────────
    const { messageId: leadBMsgId } = await transportB.publishToTopic(
      WAVE_TOPIC,
      'Lead B work complete',
      {
        kind: 'notify',
        payload: { event: 'work-complete', peerId: 'lead-B', findings: ['finding-1'] },
      },
    );

    expect(leadBMsgId).toBeTruthy();

    // ── Step 4: Lead A receives Lead B's notification in-process ─────────
    // Note: in-process delivery happens when publishToTopic notifies handlers
    // on the SAME transport instance. For cross-process delivery you'd use the
    // poll timer (tested below via pollTopic). Here Lead A's onTopic was
    // registered on transportA, not transportB, so we verify via pollTopic.
    const waveMsgs = await transportA.pollTopic(WAVE_TOPIC);
    expect(waveMsgs).toHaveLength(1);
    expect(waveMsgs[0]).toMatchObject({
      content: 'Lead B work complete',
      kind: 'notify',
      from: 'lead-B',
      fromPeerId: 'lead-B',
      toPeerId: null,
      threadId: WAVE_TOPIC,
    });
    expect(waveMsgs[0]?.payload).toEqual({
      event: 'work-complete',
      peerId: 'lead-B',
      findings: ['finding-1'],
    });

    // ── Step 5: Orchestrator publishes wave-complete teardown ─────────────
    const { messageId: orchMsgId } = await transportOrch.publishToTopic(
      COORD_TOPIC,
      'Wave 2 complete',
      {
        kind: 'notify',
        payload: { event: 'teardown', waveId: 2, nextWave: 3 },
      },
    );

    expect(orchMsgId).toBeTruthy();

    // ── Step 6: Lead A polls coordination topic and receives teardown ─────
    const coordMsgs = await transportA.pollTopic(COORD_TOPIC);
    expect(coordMsgs).toHaveLength(1);
    expect(coordMsgs[0]).toMatchObject({
      kind: 'notify',
      from: 'orchestrator',
      fromPeerId: 'orchestrator',
      threadId: COORD_TOPIC,
    });
    expect(coordMsgs[0]?.payload).toMatchObject({ event: 'teardown', waveId: 2 });

    // ── Step 7: Clean teardown ────────────────────────────────────────────
    unsubWave();
    unsubCoord();

    await transportA.unsubscribeTopic(WAVE_TOPIC);
    await transportA.unsubscribeTopic(COORD_TOPIC);
    await transportB.unsubscribeTopic(WAVE_TOPIC);

    await transportA.disconnect();
    await transportB.disconnect();
    await transportOrch.disconnect();

    // Verify all messages were stored durably in the shared conduit.db
    // by opening a fresh transport after disconnect and re-polling.
    const verifyTransport = new LocalTransport();
    await verifyTransport.connect(testConfig('verifier'));

    const allWaveMsgs = await verifyTransport.pollTopic(WAVE_TOPIC);
    const allCoordMsgs = await verifyTransport.pollTopic(COORD_TOPIC);

    expect(allWaveMsgs).toHaveLength(1);
    expect(allCoordMsgs).toHaveLength(1);

    await verifyTransport.disconnect();
  });

  it('supports multiple subscribers receiving the same topic message', async () => {
    const TOPIC = 'epic-T1149.wave-2';

    const tA = new LocalTransport();
    const tB = new LocalTransport();
    const tPub = new LocalTransport();

    await tA.connect(testConfig('agent-a'));
    await tB.connect(testConfig('agent-b'));
    await tPub.connect(testConfig('publisher'));

    await tA.subscribeTopic(TOPIC);
    await tB.subscribeTopic(TOPIC);

    // Publisher broadcasts a message
    await tPub.publishToTopic(TOPIC, 'broadcast', { kind: 'notify' });

    // Both agents can independently retrieve the message
    const msgsA = await tA.pollTopic(TOPIC);
    const msgsB = await tB.pollTopic(TOPIC);

    expect(msgsA).toHaveLength(1);
    expect(msgsB).toHaveLength(1);
    expect(msgsA[0]?.id).toBe(msgsB[0]?.id); // Same message, delivered to both

    await tA.disconnect();
    await tB.disconnect();
    await tPub.disconnect();
  });
});
