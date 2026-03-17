/**
 * Integration tests for SignalDock transport against a live daemon.
 *
 * These tests require the SignalDock daemon running on localhost:4000.
 * If the daemon is not available, all tests skip gracefully.
 *
 * @task T5671
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SignalDockTransportConfig } from '../../src/core/signaldock/signaldock-transport.js';
import { SignalDockTransport } from '../../src/core/signaldock/signaldock-transport.js';

const DAEMON_URL = 'http://localhost:4000';

async function isDaemonRunning(): Promise<boolean> {
  try {
    const resp = await fetch(`${DAEMON_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return resp.ok;
  } catch {
    return false;
  }
}

function makeConfig(): SignalDockTransportConfig {
  return {
    endpoint: DAEMON_URL,
    agentPrefix: 'cleo-test-',
    privacyTier: 'private',
  };
}

describe('SignalDock Integration (live daemon)', async () => {
  const daemonAvailable = await isDaemonRunning();

  // Track agent IDs for cleanup
  const createdAgentIds: string[] = [];

  beforeAll(() => {
    if (!daemonAvailable) {
      console.log('SignalDock daemon not running on port 4000 — skipping integration tests');
    }
  });

  afterAll(async () => {
    if (!daemonAvailable) return;
    const transport = new SignalDockTransport(makeConfig());
    for (const id of createdAgentIds) {
      try {
        await transport.deregister(id);
      } catch {
        // Best-effort cleanup
      }
    }
  });

  it.skipIf(!daemonAvailable)('registers an agent and gets an ID back', async () => {
    const transport = new SignalDockTransport(makeConfig());
    const suffix = `int-${Date.now()}`;
    const result = await transport.register(suffix, 'code_dev', 'private');

    expect(result.agentId).toBeTruthy();
    expect(typeof result.agentId).toBe('string');
    expect(result.name).toContain(suffix);
    createdAgentIds.push(result.agentId);
  });

  it.skipIf(!daemonAvailable)('retrieves a registered agent by ID', async () => {
    const transport = new SignalDockTransport(makeConfig());
    const suffix = `get-${Date.now()}`;
    const reg = await transport.register(suffix, 'code_dev', 'private');
    createdAgentIds.push(reg.agentId);

    const agent = await transport.getAgent(reg.agentId);
    expect(agent).not.toBeNull();
    expect(agent!.id).toBe(reg.agentId);
  });

  it.skipIf(!daemonAvailable)('sends a heartbeat for a registered agent', async () => {
    const transport = new SignalDockTransport(makeConfig());
    const suffix = `hb-${Date.now()}`;
    const reg = await transport.register(suffix, 'code_dev', 'private');
    createdAgentIds.push(reg.agentId);

    // Heartbeat should not throw
    await expect(transport.heartbeat(reg.agentId)).resolves.toBeUndefined();
  });

  it.skipIf(!daemonAvailable)('creates a conversation between two agents', async () => {
    const transport = new SignalDockTransport(makeConfig());
    const ts = Date.now();
    const a = await transport.register(`conv-a-${ts}`, 'code_dev', 'private');
    const b = await transport.register(`conv-b-${ts}`, 'code_dev', 'private');
    createdAgentIds.push(a.agentId, b.agentId);

    const conv = await transport.createConversation([a.agentId, b.agentId], 'private');

    expect(conv.id).toBeTruthy();
    expect(conv.participants).toBeDefined();
  });

  it.skipIf(!daemonAvailable)('sends a message between two agents and polls it', async () => {
    const transport = new SignalDockTransport(makeConfig());
    const ts = Date.now();
    const sender = await transport.register(`sender-${ts}`, 'code_dev', 'private');
    const receiver = await transport.register(`receiver-${ts}`, 'code_dev', 'private');
    createdAgentIds.push(sender.agentId, receiver.agentId);

    const conv = await transport.createConversation([sender.agentId, receiver.agentId], 'private');

    const result = await transport.send(
      sender.agentId,
      receiver.agentId,
      'Integration test message',
      conv.id,
    );

    expect(result.messageId).toBeTruthy();
    expect(result.conversationId).toBe(conv.id);

    // Poll for the message
    const messages = await transport.poll(receiver.agentId);
    // May or may not have messages depending on daemon timing, but should not throw
    expect(Array.isArray(messages)).toBe(true);
  });

  it.skipIf(!daemonAvailable)('deregisters an agent', async () => {
    const transport = new SignalDockTransport(makeConfig());
    const suffix = `dereg-${Date.now()}`;
    const reg = await transport.register(suffix, 'code_dev', 'private');

    await expect(transport.deregister(reg.agentId)).resolves.toBeUndefined();
    // Don't add to createdAgentIds since we just cleaned it up
  });

  it.skipIf(!daemonAvailable)('returns null for non-existent agent', async () => {
    const transport = new SignalDockTransport(makeConfig());
    const agent = await transport.getAgent('nonexistent-uuid-12345');
    expect(agent).toBeNull();
  });
});
