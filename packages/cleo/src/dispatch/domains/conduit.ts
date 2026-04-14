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

  /** Get connection status and unread count. Uses LocalTransport when conduit.db is available. */
  private async getStatus(agentId?: string) {
    const credential = await this.resolveCredential(agentId);
    const pollerRunning = activePoller !== null && activeAgentId === credential.agentId;

    // Check local conduit.db unread count when available
    const { LocalTransport } = await import('@cleocode/core/conduit');
    if (LocalTransport.isAvailable(process.cwd())) {
      const transport = new LocalTransport();
      await transport.connect({
        agentId: credential.agentId,
        apiKey: credential.apiKey,
        apiBaseUrl: credential.apiBaseUrl,
      });
      try {
        const pending = await transport.poll({ limit: 1000 });
        return {
          success: true,
          data: {
            agentId: credential.agentId,
            connected: true,
            transport: 'local',
            pollerRunning,
            unreadTotal: pending.length,
            actionItems: 0,
          },
        };
      } finally {
        await transport.disconnect();
      }
    }

    // Fallback: HTTP inbox endpoint for cloud-only agents
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
          transport: 'http',
          pollerRunning,
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
        transport: 'http',
        pollerRunning,
        unreadTotal: body.data?.unreadTotal ?? 0,
        actionItems: body.data?.actionItems?.length ?? 0,
      },
    };
  }

  /** One-shot peek for messages. Uses LocalTransport when conduit.db is available. */
  private async peek(agentId?: string, limit?: number) {
    const credential = await this.resolveCredential(agentId);

    // Prefer LocalTransport when conduit.db is present — no network round-trip needed.
    const { LocalTransport } = await import('@cleocode/core/conduit');
    if (LocalTransport.isAvailable(process.cwd())) {
      const transport = new LocalTransport();
      await transport.connect({
        agentId: credential.agentId,
        apiKey: credential.apiKey,
        apiBaseUrl: credential.apiBaseUrl,
      });
      try {
        const messages = await transport.poll({ limit: limit ?? 20 });
        if (messages.length > 0) {
          await transport.ack(messages.map((m) => m.id));
        }
        return {
          success: true,
          data: {
            agentId: credential.agentId,
            messages: messages.map((m) => ({
              id: m.id,
              from: m.from,
              content: m.content,
              conversationId: m.threadId,
              timestamp: m.timestamp,
            })),
          },
        };
      } finally {
        await transport.disconnect();
      }
    }

    // Fallback: HTTP peek endpoint for cloud-only agents
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

  /** Start continuous polling via @cleocode/runtime AgentPoller. Uses LocalTransport when conduit.db is available. */
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
    const { LocalTransport } = await import('@cleocode/core/conduit');

    // Prefer LocalTransport when conduit.db exists — delivers messages written
    // by other agents in the same project without any cloud round-trip.
    let transport: import('@cleocode/contracts').Transport | undefined;
    let transportName = 'http';

    if (LocalTransport.isAvailable(process.cwd())) {
      const local = new LocalTransport();
      await local.connect({
        agentId: credential.agentId,
        apiKey: credential.apiKey,
        apiBaseUrl: credential.apiBaseUrl,
      });
      transport = local;
      transportName = 'local';
    }

    activePoller = new AgentPoller({
      agentId: credential.agentId,
      apiKey: credential.apiKey,
      apiBaseUrl: credential.apiBaseUrl,
      pollIntervalMs: pollIntervalMs ?? 5000,
      groupConversationIds,
      transport,
    });
    activeAgentId = credential.agentId;

    activePoller.start();

    return {
      success: true,
      data: {
        agentId: credential.agentId,
        pollIntervalMs: pollIntervalMs ?? 5000,
        groupConversationIds: groupConversationIds ?? [],
        transport: transportName,
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

  /** Send a message to an agent or conversation. Uses LocalTransport when conduit.db is available. */
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

    // Prefer LocalTransport when conduit.db is present — message written directly
    // to the SQLite store without network, available for immediate local polling.
    const { LocalTransport } = await import('@cleocode/core/conduit');
    if (LocalTransport.isAvailable(process.cwd())) {
      const transport = new LocalTransport();
      await transport.connect({
        agentId: credential.agentId,
        apiKey: credential.apiKey,
        apiBaseUrl: credential.apiBaseUrl,
      });
      try {
        const recipient = to ?? conversationId ?? '';
        const result = await transport.push(recipient, content, {
          conversationId,
        });
        return {
          success: true,
          data: {
            messageId: result.messageId,
            from: credential.agentId,
            to: recipient,
            transport: 'local',
            sentAt: new Date().toISOString(),
          },
        };
      } finally {
        await transport.disconnect();
      }
    }

    // Fallback: HTTP send for cloud-only agents
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
        transport: 'http',
        sentAt: new Date().toISOString(),
      },
    };
  }
}
