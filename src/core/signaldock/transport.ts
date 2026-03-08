/**
 * AgentTransport interface — provider-neutral abstraction for inter-agent communication.
 *
 * This interface enables CLEO's multi-tier orchestration to work with any
 * agent messaging backend: SignalDock (provider-neutral), Claude Code SDK
 * (provider-specific), or future Conduit implementations.
 *
 * @task T5671
 */

import type {
  Agent,
  AgentClass,
  Conversation,
  ConversationVisibility,
  Message,
  PrivacyTier,
} from './types.js';

/** Result of agent registration. */
export interface AgentRegistration {
  agentId: string;
  name: string;
  agentClass: AgentClass;
  privacyTier: PrivacyTier;
}

/** Result of sending a message. */
export interface MessageResult {
  messageId: string;
  conversationId: string;
  status: 'pending' | 'delivered';
}

/**
 * Provider-neutral interface for inter-agent communication.
 *
 * Implementations:
 * - SignalDockTransport: HTTP client for SignalDock REST API (provider-neutral)
 * - ClaudeCodeTransport: Wrapper around Claude Code SDK SendMessage (provider-specific)
 */
export interface AgentTransport {
  /** Transport name for logging and diagnostics. */
  readonly name: string;

  /** Register an agent with the transport layer. */
  register(
    name: string,
    agentClass: AgentClass,
    privacyTier: PrivacyTier,
  ): Promise<AgentRegistration>;

  /** Deregister an agent from the transport layer. */
  deregister(agentId: string): Promise<void>;

  /** Send a message to another agent. */
  send(
    fromAgentId: string,
    toAgentId: string,
    content: string,
    conversationId?: string,
  ): Promise<MessageResult>;

  /** Poll for new messages addressed to this agent. */
  poll(agentId: string, since?: string): Promise<Message[]>;

  /** Send a heartbeat to keep the agent connection alive. */
  heartbeat(agentId: string): Promise<void>;

  /** Create a conversation between agents. */
  createConversation(
    participants: string[],
    visibility?: ConversationVisibility,
  ): Promise<Conversation>;

  /** Get agent info by ID. */
  getAgent(agentId: string): Promise<Agent | null>;
}
