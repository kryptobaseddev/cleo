/**
 * SignalDock HTTP transport — provider-neutral agent messaging via SignalDock REST API.
 *
 * This transport enables CLEO agents to communicate through SignalDock's
 * infrastructure regardless of which AI coding tool hosts them.
 *
 * IMPORTANT: This is a TypeScript HTTP client. No SignalDock source code
 * has been copied. All interactions use the public REST API.
 *
 * @task T5671
 */

import type { AgentRegistration, AgentTransport, MessageResult } from './transport.js';
import type {
  Agent,
  AgentClass,
  ApiResponse,
  Conversation,
  ConversationVisibility,
  Message,
  NewAgent,
  NewConversation,
  NewMessage,
  PrivacyTier,
} from './types.js';

/** Configuration for SignalDockTransport. */
export interface SignalDockTransportConfig {
  /** Base URL of the SignalDock API server. */
  endpoint: string;
  /** Prefix for agent names (e.g., "cleo-" -> "cleo-orchestrator"). */
  agentPrefix: string;
  /** Default privacy tier for registered agents. */
  privacyTier: PrivacyTier;
}

/**
 * SignalDock HTTP transport implementation.
 *
 * Communicates with a SignalDock server via its REST API to provide
 * provider-neutral inter-agent messaging with delivery guarantees.
 */
export class SignalDockTransport implements AgentTransport {
  readonly name = 'signaldock';
  private readonly config: SignalDockTransportConfig;

  constructor(config: SignalDockTransportConfig) {
    this.config = config;
  }

  async register(
    name: string,
    agentClass: AgentClass,
    privacyTier: PrivacyTier,
  ): Promise<AgentRegistration> {
    const prefixedName = `${this.config.agentPrefix}${name}`;
    const body: NewAgent = {
      name: prefixedName,
      agentClass,
      privacyTier,
    };

    const response = await this.request<Agent>('POST', '/agents', body);

    return {
      agentId: response.id,
      name: response.name,
      agentClass: response.agentClass,
      privacyTier: response.privacyTier,
    };
  }

  async deregister(agentId: string): Promise<void> {
    await this.request<void>('DELETE', `/agents/${encodeURIComponent(agentId)}`);
  }

  async send(
    fromAgentId: string,
    toAgentId: string,
    content: string,
    conversationId?: string,
  ): Promise<MessageResult> {
    let convId = conversationId;

    if (!convId) {
      const conversation = await this.createConversation([fromAgentId, toAgentId], 'private');
      convId = conversation.id;
    }

    const body: NewMessage = {
      conversationId: convId,
      fromAgentId,
      toAgentId,
      content,
      contentType: 'text',
    };

    const message = await this.request<Message>('POST', '/messages', body, fromAgentId);

    return {
      messageId: message.id,
      conversationId: message.conversationId,
      status: message.status === 'delivered' ? 'delivered' : 'pending',
    };
  }

  async poll(agentId: string, _since?: string): Promise<Message[]> {
    const messages = await this.request<Message[]>('GET', '/messages/poll/new', undefined, agentId);
    return messages;
  }

  async heartbeat(agentId: string): Promise<void> {
    await this.request<void>(
      'POST',
      `/agents/${encodeURIComponent(agentId)}/heartbeat`,
      undefined,
      agentId,
    );
  }

  async createConversation(
    participants: string[],
    visibility: ConversationVisibility = 'private',
  ): Promise<Conversation> {
    const body: NewConversation = {
      participants: [...participants].sort(),
      visibility,
    };

    return this.request<Conversation>('POST', '/conversations', body);
  }

  async getAgent(agentId: string): Promise<Agent | null> {
    try {
      return await this.request<Agent>('GET', `/agents/${encodeURIComponent(agentId)}`);
    } catch {
      return null;
    }
  }

  /**
   * Make an HTTP request to the SignalDock API.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    agentId?: string,
  ): Promise<T> {
    const url = `${this.config.endpoint}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    if (agentId) {
      headers['X-Agent-Id'] = agentId;
    }

    const init: RequestInit = {
      method,
      headers,
    };

    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    const response = await fetch(url, init);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `SignalDock API error: ${method} ${path} returned ${response.status}: ${text}`,
      );
    }

    // DELETE may return no content
    if (response.status === 204) {
      return undefined as T;
    }

    const envelope = (await response.json()) as ApiResponse<T>;

    if (!envelope.success && envelope.error) {
      throw new Error(`SignalDock error [${envelope.error.code}]: ${envelope.error.message}`);
    }

    return envelope.data as T;
  }
}
