/**
 * Claude Code transport — provider-specific adapter wrapping the current SendMessage pattern.
 *
 * This is the Phase 0 transport that maps the AgentTransport interface onto
 * Claude Code's native Agent SDK tools (SendMessage, TaskUpdate, etc.).
 *
 * It serves as the default transport when SignalDock is not enabled,
 * preserving backward compatibility with the existing orchestration model.
 *
 * @task T5671
 */

import type { AgentRegistration, AgentTransport, MessageResult } from './transport.js';
import type {
  Agent,
  AgentClass,
  Conversation,
  ConversationVisibility,
  Message,
  PrivacyTier,
} from './types.js';

/**
 * Claude Code transport — wraps the current provider-specific messaging.
 *
 * Registration and deregistration are no-ops because the Claude Code Agent SDK
 * manages agent identity internally. Message sending is logged but actual
 * delivery happens through the SDK's SendMessage tool at the agent level.
 */
export class ClaudeCodeTransport implements AgentTransport {
  readonly name = 'claude-code';

  private agents = new Map<string, AgentRegistration>();
  private conversations = new Map<string, Conversation>();
  private messages: Message[] = [];

  async register(
    name: string,
    agentClass: AgentClass,
    privacyTier: PrivacyTier,
  ): Promise<AgentRegistration> {
    const registration: AgentRegistration = {
      agentId: `cc-${name}`,
      name,
      agentClass,
      privacyTier,
    };
    this.agents.set(registration.agentId, registration);
    return registration;
  }

  async deregister(agentId: string): Promise<void> {
    this.agents.delete(agentId);
  }

  async send(
    fromAgentId: string,
    toAgentId: string,
    content: string,
    conversationId?: string,
  ): Promise<MessageResult> {
    const resolvedConversationId = conversationId ?? `cc-conv-${fromAgentId}-${toAgentId}`;
    const now = new Date().toISOString();
    const messageId = `cc-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const message: Message = {
      id: messageId,
      conversationId: resolvedConversationId,
      fromAgentId,
      toAgentId,
      content,
      contentType: 'text',
      status: 'delivered',
      createdAt: now,
      deliveredAt: now,
    };
    this.messages.push(message);

    return {
      messageId,
      conversationId: resolvedConversationId,
      status: 'delivered',
    };
  }

  async poll(agentId: string, since?: string): Promise<Message[]> {
    return this.messages.filter((m) => {
      if (m.toAgentId !== agentId) return false;
      if (since && m.createdAt <= since) return false;
      return true;
    });
  }

  async heartbeat(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (agent) {
      this.agents.set(agentId, { ...agent });
    }
  }

  async createConversation(
    participants: string[],
    visibility?: ConversationVisibility,
  ): Promise<Conversation> {
    const now = new Date().toISOString();
    const id = `cc-conv-${participants.sort().join('-')}`;
    const existing = this.conversations.get(id);
    if (existing) return existing;

    const conversation: Conversation = {
      id,
      participants,
      visibility: visibility ?? 'private',
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.conversations.set(id, conversation);
    return conversation;
  }

  async getAgent(agentId: string): Promise<Agent | null> {
    const registration = this.agents.get(agentId);
    if (!registration) return null;

    const now = new Date().toISOString();
    return {
      id: registration.agentId,
      name: registration.name,
      agentClass: registration.agentClass,
      privacyTier: registration.privacyTier,
      status: 'online',
      createdAt: now,
      updatedAt: now,
    };
  }
}
