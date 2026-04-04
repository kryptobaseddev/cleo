/**
 * Conduit Domain Handler — Agent messaging via dispatch.
 *
 * Replaces standalone clawmsgr scripts with dispatch-native operations:
 *   conduit.status  (query)  — connection status + unread count
 *   conduit.peek    (query)  — one-shot poll for messages
 *   conduit.start   (mutate) — start continuous polling
 *   conduit.stop    (mutate) — stop polling
 *   conduit.send    (mutate) — send a message
 *
 * All operations use AgentRegistryAccessor for credentials and
 * @cleocode/runtime AgentPoller for polling lifecycle.
 *
 * @task T183
 */

import type { DispatchResponse, DomainHandler } from '../types.js';
import { errorResult, unsupportedOp, wrapResult } from './_base.js';

/** Singleton poller state — shared across dispatch calls within a session. */
let activePoller: import('@cleocode/runtime').AgentPoller | null = null;
let activeAgentId: string | null = null;

/** Conduit dispatch handler for agent messaging operations. */
export class ConduitHandler implements DomainHandler {
  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    try {
      switch (operation) {
        case 'status': {
          const result = await this.getStatus(params?.agentId as string | undefined);
          return wrapResult(result, 'query', 'conduit', operation, startTime);
        }
        case 'peek': {
          const result = await this.peek(
            params?.agentId as string | undefined,
            params?.limit as number | undefined,
          );
          return wrapResult(result, 'query', 'conduit', operation, startTime);
        }
        default:
          return unsupportedOp('query', 'conduit', operation, startTime);
      }
    } catch (error) {
      return errorResult(
        'query',
        'conduit',
        operation,
        'E_CONDUIT',
        error instanceof Error ? error.message : String(error),
        startTime,
      );
    }
  }

  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    try {
      switch (operation) {
        case 'start': {
          const result = await this.startPolling(
            params?.agentId as string | undefined,
            params?.pollIntervalMs as number | undefined,
            params?.groupConversationIds as string[] | undefined,
          );
          return wrapResult(result, 'mutate', 'conduit', operation, startTime);
        }
        case 'stop': {
          const result = this.stopPolling();
          return wrapResult(result, 'mutate', 'conduit', operation, startTime);
        }
        case 'send': {
          const result = await this.sendMessage(
            params?.content as string,
            params?.to as string | undefined,
            params?.conversationId as string | undefined,
            params?.agentId as string | undefined,
          );
          return wrapResult(result, 'mutate', 'conduit', operation, startTime);
        }
        default:
          return unsupportedOp('mutate', 'conduit', operation, startTime);
      }
    } catch (error) {
      return errorResult(
        'mutate',
        'conduit',
        operation,
        'E_CONDUIT',
        error instanceof Error ? error.message : String(error),
        startTime,
      );
    }
  }

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: ['status', 'peek'],
      mutate: ['start', 'stop', 'send'],
    };
  }

  // ---------------------------------------------------------------------------
  // Internal implementations
  // ---------------------------------------------------------------------------

  /** Resolve agent credential from the registry. */
  private async resolveCredential(agentId?: string) {
    const { AgentRegistryAccessor, getDb } = await import('@cleocode/core/internal');
    await getDb(); // Ensure DB initialized before registry access
    const registry = new AgentRegistryAccessor(process.cwd());
    const credential = agentId ? await registry.get(agentId) : await registry.getActive();
    if (!credential) {
      throw new Error(
        'No agent credential found. Run: cleo agent register --id <id> --api-key <key>',
      );
    }
    return credential;
  }

  /** Get connection status and unread count. */
  private async getStatus(agentId?: string) {
    const credential = await this.resolveCredential(agentId);

    const response = await fetch(`${credential.apiBaseUrl}/agents/${credential.agentId}/inbox`, {
      headers: {
        Authorization: `Bearer ${credential.apiKey}`,
        'X-Agent-Id': credential.agentId,
      },
    });

    if (!response.ok) {
      return {
        success: true,
        data: {
          agentId: credential.agentId,
          connected: false,
          pollerRunning: activePoller !== null && activeAgentId === credential.agentId,
          error: `API returned ${response.status}`,
        },
      };
    }

    const body = (await response.json()) as {
      data?: { unreadTotal?: number; actionItems?: unknown[] };
    };

    return {
      success: true,
      data: {
        agentId: credential.agentId,
        connected: true,
        pollerRunning: activePoller !== null && activeAgentId === credential.agentId,
        unreadTotal: body.data?.unreadTotal ?? 0,
        actionItems: body.data?.actionItems?.length ?? 0,
      },
    };
  }

  /** One-shot peek for messages. */
  private async peek(agentId?: string, limit?: number) {
    const credential = await this.resolveCredential(agentId);
    const params = new URLSearchParams();
    params.set('mentioned', credential.agentId);
    params.set('limit', String(limit ?? 20));

    const response = await fetch(`${credential.apiBaseUrl}/messages/peek?${params}`, {
      headers: {
        Authorization: `Bearer ${credential.apiKey}`,
        'X-Agent-Id': credential.agentId,
      },
    });

    if (!response.ok) {
      return { success: true, data: { agentId: credential.agentId, messages: [] } };
    }

    const body = (await response.json()) as {
      data?: {
        messages?: Array<{
          id: string;
          senderAgentId?: string;
          content?: string;
          conversationId?: string;
          createdAt?: string;
        }>;
      };
    };

    return {
      success: true,
      data: {
        agentId: credential.agentId,
        messages: (body.data?.messages ?? []).map((m) => ({
          id: m.id,
          from: m.senderAgentId ?? 'unknown',
          content: m.content ?? '',
          conversationId: m.conversationId,
          timestamp: m.createdAt,
        })),
      },
    };
  }

  /** Start continuous polling via @cleocode/runtime AgentPoller. */
  private async startPolling(
    agentId?: string,
    pollIntervalMs?: number,
    groupConversationIds?: string[],
  ) {
    if (activePoller) {
      return {
        success: true,
        data: {
          agentId: activeAgentId,
          message: 'Poller already running. Use conduit.stop first.',
          alreadyRunning: true,
        },
      };
    }

    const credential = await this.resolveCredential(agentId);
    const { AgentPoller } = await import('@cleocode/runtime');

    activePoller = new AgentPoller({
      agentId: credential.agentId,
      apiKey: credential.apiKey,
      apiBaseUrl: credential.apiBaseUrl,
      pollIntervalMs: pollIntervalMs ?? 5000,
      groupConversationIds,
    });
    activeAgentId = credential.agentId;

    activePoller.start();

    return {
      success: true,
      data: {
        agentId: credential.agentId,
        pollIntervalMs: pollIntervalMs ?? 5000,
        groupConversationIds: groupConversationIds ?? [],
        message: 'Polling started.',
      },
    };
  }

  /** Stop the active polling loop. */
  private stopPolling() {
    if (!activePoller) {
      return {
        success: true,
        data: { message: 'No active poller to stop.' },
      };
    }

    const stoppedAgent = activeAgentId;
    activePoller.stop();
    activePoller = null;
    activeAgentId = null;

    return {
      success: true,
      data: {
        agentId: stoppedAgent,
        message: 'Polling stopped.',
      },
    };
  }

  /** Send a message to an agent or conversation. */
  private async sendMessage(
    content: string,
    to?: string,
    conversationId?: string,
    agentId?: string,
  ) {
    if (!to && !conversationId) {
      return {
        success: false,
        error: { code: 'E_ARGS', message: 'Must specify "to" (agent ID) or "conversationId"' },
      };
    }

    const credential = await this.resolveCredential(agentId);

    let url: string;
    const body: Record<string, string> = { content };

    if (conversationId) {
      url = `${credential.apiBaseUrl}/conversations/${conversationId}/messages`;
    } else {
      url = `${credential.apiBaseUrl}/messages`;
      body['toAgentId'] = to!;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credential.apiKey}`,
        'X-Agent-Id': credential.agentId,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        success: false,
        error: { code: 'E_SEND', message: `Send failed: ${response.status} ${text}` },
      };
    }

    const data = (await response.json()) as {
      data?: { message?: { id?: string } };
    };

    return {
      success: true,
      data: {
        messageId: data.data?.message?.id ?? 'unknown',
        from: credential.agentId,
        to: to ?? conversationId,
        sentAt: new Date().toISOString(),
      },
    };
  }
}
