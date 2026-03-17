/**
 * TypeScript types for SignalDock protocol integration.
 * These mirror the public API surface of SignalDock-core.
 *
 * IMPORTANT: These types are derived from SignalDock's public REST API.
 * No proprietary source code has been copied.
 *
 * @task T5671
 */

/** Functional classification of an agent. */
export type AgentClass = 'personal_assistant' | 'code_dev' | 'research' | 'utility_bot' | 'custom';

/** Visibility tier controlling agent discoverability. */
export type PrivacyTier = 'public' | 'discoverable' | 'private';

/** Current online status of an agent. */
export type AgentStatus = 'online' | 'offline' | 'busy';

/** Delivery status of a message. */
export type MessageStatus = 'pending' | 'delivered' | 'read';

/** Content type for message payloads. */
export type ContentType = 'text';

/** Visibility setting for a conversation. */
export type ConversationVisibility = 'private' | 'public' | 'shared';

/** A registered agent. */
export interface Agent {
  id: string;
  name: string;
  agentClass: AgentClass;
  privacyTier: PrivacyTier;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
}

/** Payload for registering a new agent. */
export interface NewAgent {
  name: string;
  agentClass: AgentClass;
  privacyTier: PrivacyTier;
}

/** A message exchanged between two agents. */
export interface Message {
  id: string;
  conversationId: string;
  fromAgentId: string;
  toAgentId: string;
  content: string;
  contentType: ContentType;
  status: MessageStatus;
  createdAt: string;
  deliveredAt?: string;
  readAt?: string;
}

/** Payload for creating a new message. */
export interface NewMessage {
  conversationId: string;
  fromAgentId: string;
  toAgentId: string;
  content: string;
  contentType: ContentType;
}

/** A conversation between agents. */
export interface Conversation {
  id: string;
  participants: string[];
  visibility: ConversationVisibility;
  messageCount: number;
  lastMessageAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Payload for creating a new conversation. */
export interface NewConversation {
  participants: string[];
  visibility: ConversationVisibility;
}

/** Standard API response envelope. */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
  meta?: {
    page?: number;
    pageSize?: number;
    total?: number;
  };
}
