/**
 * Unit tests for ClaudeCodeTransport — the fallback in-memory adapter.
 *
 * @task T5671
 */

import { describe, expect, it } from 'vitest';
import { ClaudeCodeTransport } from '../claude-code-transport.js';

describe('ClaudeCodeTransport', () => {
  it('has name "claude-code"', () => {
    const transport = new ClaudeCodeTransport();
    expect(transport.name).toBe('claude-code');
  });

  describe('register', () => {
    it('registers an agent with cc- prefixed ID', async () => {
      const transport = new ClaudeCodeTransport();
      const result = await transport.register('orchestrator', 'code_dev', 'private');

      expect(result).toEqual({
        agentId: 'cc-orchestrator',
        name: 'orchestrator',
        agentClass: 'code_dev',
        privacyTier: 'private',
      });
    });

    it('can register multiple agents', async () => {
      const transport = new ClaudeCodeTransport();
      const a = await transport.register('a', 'code_dev', 'private');
      const b = await transport.register('b', 'research', 'public');

      expect(a.agentId).toBe('cc-a');
      expect(b.agentId).toBe('cc-b');
      expect(b.agentClass).toBe('research');
      expect(b.privacyTier).toBe('public');
    });
  });

  describe('deregister', () => {
    it('removes agent from internal map', async () => {
      const transport = new ClaudeCodeTransport();
      await transport.register('test', 'code_dev', 'private');

      await transport.deregister('cc-test');

      const agent = await transport.getAgent('cc-test');
      expect(agent).toBeNull();
    });

    it('does not throw when deregistering unknown agent', async () => {
      const transport = new ClaudeCodeTransport();
      await expect(transport.deregister('nonexistent')).resolves.toBeUndefined();
    });
  });

  describe('send', () => {
    it('sends a message and returns delivered status', async () => {
      const transport = new ClaudeCodeTransport();
      const result = await transport.send('from-agent', 'to-agent', 'hello', 'conv-1');

      expect(result.messageId).toMatch(/^cc-msg-/);
      expect(result.conversationId).toBe('conv-1');
      expect(result.status).toBe('delivered');
    });

    it('generates a default conversationId when not provided', async () => {
      const transport = new ClaudeCodeTransport();
      const result = await transport.send('from', 'to', 'test');

      expect(result.conversationId).toBe('cc-conv-from-to');
    });

    it('stores message for subsequent poll', async () => {
      const transport = new ClaudeCodeTransport();
      await transport.send('from', 'to', 'hello');

      const messages = await transport.poll('to');
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('hello');
    });
  });

  describe('poll', () => {
    it('filters messages by toAgentId', async () => {
      const transport = new ClaudeCodeTransport();
      await transport.send('a', 'b', 'for-b');
      await transport.send('a', 'c', 'for-c');

      const bMessages = await transport.poll('b');
      const cMessages = await transport.poll('c');

      expect(bMessages).toHaveLength(1);
      expect(bMessages[0].content).toBe('for-b');
      expect(cMessages).toHaveLength(1);
      expect(cMessages[0].content).toBe('for-c');
    });

    it('filters by since timestamp', async () => {
      const transport = new ClaudeCodeTransport();
      await transport.send('a', 'b', 'old');

      // Wait a tick so timestamps differ
      const sinceTime = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 5));
      await transport.send('a', 'b', 'new');

      const messages = await transport.poll('b', sinceTime);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('new');
    });

    it('returns empty array when no matching messages', async () => {
      const transport = new ClaudeCodeTransport();
      const messages = await transport.poll('nobody');
      expect(messages).toEqual([]);
    });
  });

  describe('heartbeat', () => {
    it('succeeds for registered agent (no-op)', async () => {
      const transport = new ClaudeCodeTransport();
      await transport.register('test', 'code_dev', 'private');

      await expect(transport.heartbeat('cc-test')).resolves.toBeUndefined();
    });

    it('succeeds for unregistered agent (no error)', async () => {
      const transport = new ClaudeCodeTransport();
      await expect(transport.heartbeat('unknown')).resolves.toBeUndefined();
    });
  });

  describe('createConversation', () => {
    it('creates a conversation with deterministic ID', async () => {
      const transport = new ClaudeCodeTransport();
      const conv = await transport.createConversation(['b', 'a'], 'private');

      expect(conv.id).toBe('cc-conv-a-b');
      expect(conv.participants).toEqual(['a', 'b']);
      expect(conv.visibility).toBe('private');
      expect(conv.messageCount).toBe(0);
    });

    it('returns existing conversation for same participants', async () => {
      const transport = new ClaudeCodeTransport();
      const first = await transport.createConversation(['a', 'b']);
      const second = await transport.createConversation(['b', 'a']);

      expect(first.id).toBe(second.id);
      expect(first.createdAt).toBe(second.createdAt);
    });

    it('defaults visibility to private', async () => {
      const transport = new ClaudeCodeTransport();
      const conv = await transport.createConversation(['a', 'b']);
      expect(conv.visibility).toBe('private');
    });
  });

  describe('getAgent', () => {
    it('returns agent info for registered agent', async () => {
      const transport = new ClaudeCodeTransport();
      await transport.register('test', 'code_dev', 'private');

      const agent = await transport.getAgent('cc-test');
      expect(agent).not.toBeNull();
      expect(agent!.id).toBe('cc-test');
      expect(agent!.name).toBe('test');
      expect(agent!.status).toBe('online');
    });

    it('returns null for unregistered agent', async () => {
      const transport = new ClaudeCodeTransport();
      const agent = await transport.getAgent('nonexistent');
      expect(agent).toBeNull();
    });
  });
});
