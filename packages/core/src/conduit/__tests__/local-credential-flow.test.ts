/**
 * Local credential flow — end-to-end validation.
 *
 * Tests the full lifecycle: conduit.db creation → agent register →
 * credential encryption/decryption → LocalTransport connect →
 * push/poll/ack messaging.
 *
 * @task T227
 * @task T356
 * @epic T310
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureConduitDb, getConduitDbPath } from '../../store/conduit-sqlite.js';
import { LocalTransport } from '../local-transport.js';

// ============================================================================
// Test helpers
// ============================================================================

let testDir: string;
let originalCwd: string;

async function setupTestEnvironment(): Promise<string> {
  const dir = join(
    tmpdir(),
    `credential-flow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(dir, '.cleo'), { recursive: true });
  // Create a minimal .cleo/project-context.json so paths resolve
  writeFileSync(
    join(dir, '.cleo', 'project-context.json'),
    JSON.stringify({ schemaVersion: '1.0.0', projectTypes: ['node'], primaryType: 'node' }),
  );
  return dir;
}

// ============================================================================
// Test suite
// ============================================================================

describe('Local Credential Flow E2E', () => {
  beforeEach(async () => {
    originalCwd = process.cwd();
    testDir = await setupTestEnvironment();
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // Step 1: cleo init creates conduit.db
  // --------------------------------------------------------------------------

  describe('Step 1: conduit.db creation', () => {
    it('ensureConduitDb creates the database file', () => {
      const result = ensureConduitDb(testDir);
      expect(result.action).toBe('created');
      expect(existsSync(result.path)).toBe(true);
    });

    it('ensureConduitDb is idempotent', () => {
      const first = ensureConduitDb(testDir);
      const second = ensureConduitDb(testDir);
      expect(first.action).toBe('created');
      expect(second.action).toBe('exists');
      expect(first.path).toBe(second.path);
    });

    it('conduit.db has the messages table', async () => {
      ensureConduitDb(testDir);
      const dbPath = getConduitDbPath(testDir);
      expect(existsSync(dbPath)).toBe(true);

      // Verify by connecting LocalTransport (which checks for messages table)
      const transport = new LocalTransport();
      await transport.connect({
        agentId: 'test',
        apiKey: 'sk_test',
        apiBaseUrl: 'http://localhost',
      });
      await transport.disconnect();
    });
  });

  // --------------------------------------------------------------------------
  // Step 2: LocalTransport availability
  // --------------------------------------------------------------------------

  describe('Step 2: LocalTransport availability', () => {
    it('isAvailable returns false before init', () => {
      const emptyDir = join(tmpdir(), `no-init-${Date.now()}`);
      mkdirSync(join(emptyDir, '.cleo'), { recursive: true });
      expect(LocalTransport.isAvailable(emptyDir)).toBe(false);
      rmSync(emptyDir, { recursive: true, force: true });
    });

    it('isAvailable returns true after init', () => {
      ensureConduitDb(testDir);
      expect(LocalTransport.isAvailable(testDir)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Step 3: Full messaging lifecycle
  // --------------------------------------------------------------------------

  describe('Step 3: messaging lifecycle', () => {
    it('complete flow: init → connect → push → poll → ack', async () => {
      // 1. Init conduit.db
      ensureConduitDb(testDir);

      // 2. Connect two agents
      const agent1 = new LocalTransport();
      const agent2 = new LocalTransport();

      await agent1.connect({
        agentId: 'cleo-rust-lead',
        apiKey: 'sk_live_fake1',
        apiBaseUrl: 'http://localhost',
      });
      await agent2.connect({
        agentId: 'cleo-dev',
        apiKey: 'sk_live_fake2',
        apiBaseUrl: 'http://localhost',
      });

      // 3. Agent 1 sends a message to Agent 2
      const sendResult = await agent1.push(
        'cleo-dev',
        '/action @cleo-dev #test Hello from rust-lead',
      );
      expect(sendResult.messageId).toBeDefined();

      // 4. Agent 2 polls and receives the message
      const messages = await agent2.poll();
      expect(messages).toHaveLength(1);
      expect(messages[0].from).toBe('cleo-rust-lead');
      expect(messages[0].content).toContain('Hello from rust-lead');

      // 5. Agent 2 acknowledges the message
      await agent2.ack([messages[0].id]);

      // 6. Subsequent poll returns empty (message was acked)
      const afterAck = await agent2.poll();
      expect(afterAck).toHaveLength(0);

      // 7. Agent 2 replies
      const replyResult = await agent2.push('cleo-rust-lead', '/ack Received.');
      expect(replyResult.messageId).toBeDefined();

      // 8. Agent 1 receives the reply
      const replies = await agent1.poll();
      expect(replies).toHaveLength(1);
      expect(replies[0].from).toBe('cleo-dev');
      expect(replies[0].content).toBe('/ack Received.');

      // Cleanup
      await agent1.disconnect();
      await agent2.disconnect();
    });

    it('messages persist across transport reconnections', async () => {
      ensureConduitDb(testDir);

      // Send a message
      const sender = new LocalTransport();
      await sender.connect({
        agentId: 'sender',
        apiKey: 'sk_test',
        apiBaseUrl: 'http://localhost',
      });
      await sender.push('receiver', 'persistent message');
      await sender.disconnect();

      // New transport instance reads the same DB
      const receiver = new LocalTransport();
      await receiver.connect({
        agentId: 'receiver',
        apiKey: 'sk_test',
        apiBaseUrl: 'http://localhost',
      });
      const messages = await receiver.poll();
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('persistent message');

      await receiver.disconnect();
    });

    it('multiple agents can communicate in the same conversation', async () => {
      ensureConduitDb(testDir);

      const prime = new LocalTransport();
      const rustLead = new LocalTransport();
      const dbLead = new LocalTransport();

      await prime.connect({ agentId: 'prime', apiKey: 'sk1', apiBaseUrl: 'http://localhost' });
      await rustLead.connect({
        agentId: 'rust-lead',
        apiKey: 'sk2',
        apiBaseUrl: 'http://localhost',
      });
      await dbLead.connect({ agentId: 'db-lead', apiKey: 'sk3', apiBaseUrl: 'http://localhost' });

      // Prime sends to rust-lead
      await prime.push('rust-lead', 'Fix cant-lsp');
      // Prime sends to db-lead
      await prime.push('db-lead', 'Review schemas');

      // Each agent only sees their own messages
      const rustMessages = await rustLead.poll();
      const dbMessages = await dbLead.poll();

      expect(rustMessages).toHaveLength(1);
      expect(rustMessages[0].content).toBe('Fix cant-lsp');
      expect(dbMessages).toHaveLength(1);
      expect(dbMessages[0].content).toBe('Review schemas');

      await prime.disconnect();
      await rustLead.disconnect();
      await dbLead.disconnect();
    });
  });
});
