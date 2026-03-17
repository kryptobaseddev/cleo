/**
 * SignalDock integration module — provider-neutral agent transport layer.
 *
 * @task T5671
 */

export { ClaudeCodeTransport } from './claude-code-transport.js';
export type { TransportFactoryConfig } from './factory.js';
export { createTransport } from './factory.js';
export type { SignalDockTransportConfig } from './signaldock-transport.js';
export { SignalDockTransport } from './signaldock-transport.js';
export type { AgentRegistration, AgentTransport, MessageResult } from './transport.js';

export type {
  Agent,
  AgentClass,
  AgentStatus,
  ApiResponse,
  ContentType,
  Conversation,
  ConversationVisibility,
  Message,
  MessageStatus,
  NewAgent,
  NewConversation,
  NewMessage,
  PrivacyTier,
} from './types.js';
