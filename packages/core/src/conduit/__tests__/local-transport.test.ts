/**
 * LocalTransport test suite.
 *
 * Tests the in-process SQLite transport for fully offline agent messaging.
 * Uses a temporary conduit.db created via ensureConduitDb().
 *
 * @see packages/core/src/conduit/local-transport.ts
 * @task T213
 * @task T356
 * @epic T310
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureConduitDb } from '../../store/conduit-sqlite.js';
import { LocalTransport } from '../local-transport.js';

// ============================================================================
// Test helpers
// ============================================================================

let testDir: string;
let originalCwd: string;

/** Create a temporary directory with a valid conduit.db for testing. */
function setupTestDb(): string {
  const dir = join(
    tmpdir(),
    `local-transport-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(dir, '.cleo'), { recursive: true });
  ensureConduitDb(dir);
  return dir;
}

/** Standard connect config for tests. */
function testConfig(agentId = 'test-agent') {
  return {
    agentId,
    apiKey: 'sk_test_fake',
    apiBaseUrl: 'http://localhost:4000',
  };
}

// ============================================================================
// Test suite
// ============================================================================

describe('LocalTransport', () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = setupTestDb();
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // Connection
  // --------------------------------------------------------------------------

  describe('connect', () => {
    it('connects when conduit.db exists', async () => {
      const transport = new LocalTransport();
      await transport.connect(testConfig());
      await transport.disconnect();
    });

    it('throws when conduit.db is missing', async () => {
      const emptyDir = join(tmpdir(), `empty-${Date.now()}`);
      mkdirSync(join(emptyDir, '.cleo'), { recursive: true });
      process.chdir(emptyDir);

      const transport = new LocalTransport();
      await expect(transport.connect(testConfig())).rejects.toThrow('conduit.db not found');

      rmSync(emptyDir, { recursive: true, force: true });
    });

    it('has name "local"', () => {
      const transport = new LocalTransport();
      expect(transport.name).toBe('local');
    });
  });

  // --------------------------------------------------------------------------
  // Push
  // --------------------------------------------------------------------------

  describe('push', () => {
    it('stores a direct message and returns a message ID', async () => {
      const transport = new LocalTransport();
      await transport.connect(testConfig('sender'));

      const result = await transport.push('receiver', 'hello from sender');
      expect(result.messageId).toBeDefined();
      expect(typeof result.messageId).toBe('string');
      expect(result.messageId.length).toBeGreaterThan(0);

      await transport.disconnect();
    });

    it('stores a message in a conversation', async () => {
      const sender = new LocalTransport();
      const receiver = new LocalTransport();
      await sender.connect(testConfig('sender'));
      await receiver.connect(testConfig('receiver'));

      // First push creates a DM conversation, then use that ID
      const dm = await sender.push('receiver', 'setup');
      const messages = await receiver.poll();
      expect(messages).toHaveLength(1);
      const convId = messages[0].threadId;
      expect(convId).toBeDefined();

      // Now send within that conversation
      const result = await sender.push('receiver', 'group msg', {
        conversationId: convId,
      });
      expect(result.messageId).toBeDefined();

      await sender.disconnect();
      await receiver.disconnect();
    });

    it('throws when not connected', async () => {
      const transport = new LocalTransport();
      await expect(transport.push('to', 'content')).rejects.toThrow('not connected');
    });
  });

  // --------------------------------------------------------------------------
  // Poll
  // --------------------------------------------------------------------------

  describe('poll', () => {
    it('returns messages addressed to the connected agent', async () => {
      const sender = new LocalTransport();
      const receiver = new LocalTransport();

      await sender.connect(testConfig('sender'));
      await receiver.connect(testConfig('receiver'));

      await sender.push('receiver', 'message 1');
      await sender.push('receiver', 'message 2');

      const messages = await receiver.poll();
      expect(messages).toHaveLength(2);
      expect(messages[0].from).toBe('sender');
      expect(messages[0].content).toBe('message 1');
      expect(messages[1].content).toBe('message 2');

      await sender.disconnect();
      await receiver.disconnect();
    });

    it('returns empty array when no messages', async () => {
      const transport = new LocalTransport();
      await transport.connect(testConfig('lonely'));

      const messages = await transport.poll();
      expect(messages).toHaveLength(0);

      await transport.disconnect();
    });

    it('respects limit parameter', async () => {
      const sender = new LocalTransport();
      const receiver = new LocalTransport();

      await sender.connect(testConfig('sender'));
      await receiver.connect(testConfig('receiver'));

      for (let i = 0; i < 5; i++) {
        await sender.push('receiver', `msg ${i}`);
      }

      const messages = await receiver.poll({ limit: 2 });
      expect(messages).toHaveLength(2);

      await sender.disconnect();
      await receiver.disconnect();
    });

    it('returns messages oldest first', async () => {
      const sender = new LocalTransport();
      const receiver = new LocalTransport();

      await sender.connect(testConfig('sender'));
      await receiver.connect(testConfig('receiver'));

      await sender.push('receiver', 'first');
      await sender.push('receiver', 'second');
      await sender.push('receiver', 'third');

      const messages = await receiver.poll();
      expect(messages[0].content).toBe('first');
      expect(messages[2].content).toBe('third');

      await sender.disconnect();
      await receiver.disconnect();
    });
  });

  // --------------------------------------------------------------------------
  // Ack
  // --------------------------------------------------------------------------

  describe('ack', () => {
    it('marks messages as delivered so they are not re-polled', async () => {
      const sender = new LocalTransport();
      const receiver = new LocalTransport();

      await sender.connect(testConfig('sender'));
      await receiver.connect(testConfig('receiver'));

      await sender.push('receiver', 'ack me');
      const before = await receiver.poll();
      expect(before).toHaveLength(1);

      await receiver.ack([before[0].id]);

      const after = await receiver.poll();
      expect(after).toHaveLength(0);

      await sender.disconnect();
      await receiver.disconnect();
    });

    it('handles empty messageIds array', async () => {
      const transport = new LocalTransport();
      await transport.connect(testConfig());
      await transport.ack([]);
      await transport.disconnect();
    });
  });

  // --------------------------------------------------------------------------
  // Subscribe
  // --------------------------------------------------------------------------

  describe('subscribe', () => {
    it('notifies subscribers on push', async () => {
      const transport = new LocalTransport();
      await transport.connect(testConfig('agent'));

      const received: string[] = [];
      const unsub = transport.subscribe((msg) => {
        received.push(msg.content);
      });

      await transport.push('someone', 'hello');
      expect(received).toContain('hello');

      unsub();
      await transport.disconnect();
    });

    it('returns unsubscribe function that stops notifications', async () => {
      const transport = new LocalTransport();
      await transport.connect(testConfig('agent'));

      const received: string[] = [];
      const unsub = transport.subscribe((msg) => {
        received.push(msg.content);
      });

      await transport.push('someone', 'before');
      unsub();
      await transport.push('someone', 'after');

      expect(received).toContain('before');
      expect(received).not.toContain('after');

      await transport.disconnect();
    });
  });

  // --------------------------------------------------------------------------
  // Disconnect
  // --------------------------------------------------------------------------

  describe('disconnect', () => {
    it('clears state and is safe to call twice', async () => {
      const transport = new LocalTransport();
      await transport.connect(testConfig());
      await transport.disconnect();
      await transport.disconnect(); // Should not throw
    });

    it('makes subsequent operations throw', async () => {
      const transport = new LocalTransport();
      await transport.connect(testConfig());
      await transport.disconnect();
      await expect(transport.poll()).rejects.toThrow('not connected');
    });
  });

  // --------------------------------------------------------------------------
  // Concurrent writes (DB locking regression)
  // --------------------------------------------------------------------------

  describe('concurrent writes', () => {
    it('handles parallel pushes from multiple transports without locking', async () => {
      const agents = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
      const transports: LocalTransport[] = [];

      for (const id of agents) {
        const t = new LocalTransport();
        await t.connect(testConfig(id));
        transports.push(t);
      }

      // All 5 agents send messages to each other simultaneously
      const sends = agents.flatMap((sender, i) =>
        agents
          .filter((_, j) => i !== j)
          .map((receiver) => transports[i].push(receiver, `msg from ${sender} to ${receiver}`)),
      );

      // 20 concurrent sends (5 agents * 4 targets each)
      const results = await Promise.all(sends);
      expect(results).toHaveLength(20);
      for (const r of results) {
        expect(r.messageId).toBeDefined();
      }

      // Each agent should have 4 pending messages
      for (let i = 0; i < agents.length; i++) {
        const messages = await transports[i].poll();
        expect(messages).toHaveLength(4);
      }

      for (const t of transports) await t.disconnect();
    });

    it('handles rapid sequential push+poll+ack cycles without locking', async () => {
      const sender = new LocalTransport();
      const receiver = new LocalTransport();
      await sender.connect(testConfig('rapid-sender'));
      await receiver.connect(testConfig('rapid-receiver'));

      // 50 rapid cycles of push → poll → ack
      for (let i = 0; i < 50; i++) {
        await sender.push('rapid-receiver', `cycle-${i}`);
        const msgs = await receiver.poll({ limit: 1 });
        expect(msgs).toHaveLength(1);
        expect(msgs[0].content).toBe(`cycle-${i}`);
        await receiver.ack([msgs[0].id]);
      }

      // Queue should be empty
      const remaining = await receiver.poll();
      expect(remaining).toHaveLength(0);

      await sender.disconnect();
      await receiver.disconnect();
    });

    it('handles concurrent push and poll from different transports', async () => {
      const writer = new LocalTransport();
      const reader = new LocalTransport();
      await writer.connect(testConfig('writer'));
      await reader.connect(testConfig('reader'));

      // Push 100 messages as fast as possible
      const pushPromises = Array.from({ length: 100 }, (_, i) =>
        writer.push('reader', `burst-${i}`),
      );
      await Promise.all(pushPromises);

      // Poll all at once
      const messages = await reader.poll({ limit: 100 });
      expect(messages).toHaveLength(100);

      // Ack all at once
      await reader.ack(messages.map((m) => m.id));

      // Should be empty now
      const remaining = await reader.poll();
      expect(remaining).toHaveLength(0);

      await writer.disconnect();
      await reader.disconnect();
    });

    it('handles simultaneous push and poll operations (race condition test)', async () => {
      const a = new LocalTransport();
      const b = new LocalTransport();
      await a.connect(testConfig('agent-a'));
      await b.connect(testConfig('agent-b'));

      // Simultaneously: A sends to B, B sends to A, both poll
      const [sendAB, sendBA, pollA, pollB] = await Promise.allSettled([
        a.push('agent-b', 'a-to-b'),
        b.push('agent-a', 'b-to-a'),
        a.poll(),
        b.poll(),
      ]);

      // All operations should succeed (no DB locking errors)
      expect(sendAB.status).toBe('fulfilled');
      expect(sendBA.status).toBe('fulfilled');
      expect(pollA.status).toBe('fulfilled');
      expect(pollB.status).toBe('fulfilled');

      await a.disconnect();
      await b.disconnect();
    });
  });

  // --------------------------------------------------------------------------
  // Multi-agent communication (daemon scenario)
  // --------------------------------------------------------------------------

  describe('multi-agent communication', () => {
    it('simulates full daemon message flow: prime → agents → prime', async () => {
      const prime = new LocalTransport();
      const core = new LocalTransport();
      const dev = new LocalTransport();
      await prime.connect(testConfig('cleo-prime'));
      await core.connect(testConfig('signaldock-core'));
      await dev.connect(testConfig('cleo-dev'));

      // Prime sends task assignments to both agents
      await prime.push('signaldock-core', '/action #task-assignment T001');
      await prime.push('cleo-dev', '/action #task-assignment T002');

      // Both agents receive their assignments
      const coreMessages = await core.poll();
      const devMessages = await dev.poll();
      expect(coreMessages).toHaveLength(1);
      expect(devMessages).toHaveLength(1);
      expect(coreMessages[0].content).toContain('T001');
      expect(devMessages[0].content).toContain('T002');

      // Agents ack and respond
      await core.ack([coreMessages[0].id]);
      await dev.ack([devMessages[0].id]);
      await core.push('cleo-prime', 'T001 complete');
      await dev.push('cleo-prime', 'T002 complete');

      // Prime collects results
      const results = await prime.poll();
      expect(results).toHaveLength(2);
      expect(results.map((m) => m.content).sort()).toEqual(['T001 complete', 'T002 complete']);

      // Prime acks
      await prime.ack(results.map((m) => m.id));
      const empty = await prime.poll();
      expect(empty).toHaveLength(0);

      await prime.disconnect();
      await core.disconnect();
      await dev.disconnect();
    });

    it('group conversation: multiple agents in one thread', async () => {
      const prime = new LocalTransport();
      const agent1 = new LocalTransport();
      const agent2 = new LocalTransport();
      await prime.connect(testConfig('prime'));
      await agent1.connect(testConfig('agent-1'));
      await agent2.connect(testConfig('agent-2'));

      // Prime sends to agent-1 to establish a conversation
      await prime.push('agent-1', 'all-hands meeting');
      const a1msgs = await agent1.poll();
      const convId = a1msgs[0].threadId!;

      // Now all agents can post to the same conversation
      await prime.push('agent-1', 'status check', { conversationId: convId });
      await prime.push('agent-2', 'status check', { conversationId: convId });

      const a1status = await agent1.poll();
      const a2status = await agent2.poll();
      // agent-1 gets the second message (first was acked conceptually by reading convId)
      expect(a1status.length).toBeGreaterThanOrEqual(1);
      expect(a2status).toHaveLength(1);
      expect(a2status[0].content).toBe('status check');

      await prime.disconnect();
      await agent1.disconnect();
      await agent2.disconnect();
    });
  });

  // --------------------------------------------------------------------------
  // Static
  // --------------------------------------------------------------------------

  describe('isAvailable', () => {
    it('returns true when conduit.db exists', () => {
      expect(LocalTransport.isAvailable(testDir)).toBe(true);
    });

    it('returns false when conduit.db is missing', () => {
      const emptyDir = join(tmpdir(), `no-db-${Date.now()}`);
      mkdirSync(emptyDir, { recursive: true });
      expect(LocalTransport.isAvailable(emptyDir)).toBe(false);
      rmSync(emptyDir, { recursive: true, force: true });
    });
  });
});
