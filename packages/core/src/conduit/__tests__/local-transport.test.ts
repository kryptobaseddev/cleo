/**
 * LocalTransport test suite.
 *
 * Tests the in-process SQLite transport for fully offline agent messaging.
 * Uses a temporary signaldock.db created via ensureSignaldockDb().
 *
 * @see packages/core/src/conduit/local-transport.ts
 * @task T213
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalTransport } from '../local-transport.js';
import { ensureSignaldockDb } from '../../store/signaldock-sqlite.js';

// ============================================================================
// Test helpers
// ============================================================================

let testDir: string;
let originalCwd: string;

/** Create a temporary directory with a valid signaldock.db for testing. */
async function setupTestDb(): Promise<string> {
  const dir = join(tmpdir(), `local-transport-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, '.cleo'), { recursive: true });
  await ensureSignaldockDb(dir);
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
  beforeEach(async () => {
    originalCwd = process.cwd();
    testDir = await setupTestDb();
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
    it('connects when signaldock.db exists', async () => {
      const transport = new LocalTransport();
      await transport.connect(testConfig());
      await transport.disconnect();
    });

    it('throws when signaldock.db is missing', async () => {
      const emptyDir = join(tmpdir(), `empty-${Date.now()}`);
      mkdirSync(join(emptyDir, '.cleo'), { recursive: true });
      process.chdir(emptyDir);

      const transport = new LocalTransport();
      await expect(transport.connect(testConfig())).rejects.toThrow('signaldock.db not found');

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
  // Static
  // --------------------------------------------------------------------------

  describe('isAvailable', () => {
    it('returns true when signaldock.db exists', () => {
      expect(LocalTransport.isAvailable(testDir)).toBe(true);
    });

    it('returns false when signaldock.db is missing', () => {
      const emptyDir = join(tmpdir(), `no-db-${Date.now()}`);
      mkdirSync(emptyDir, { recursive: true });
      expect(LocalTransport.isAvailable(emptyDir)).toBe(false);
      rmSync(emptyDir, { recursive: true, force: true });
    });
  });
});
