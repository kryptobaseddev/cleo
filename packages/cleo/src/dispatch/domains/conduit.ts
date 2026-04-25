/**
 * Conduit Domain Handler — Agent messaging via dispatch.
 *
 * Replaces standalone clawmsgr scripts with dispatch-native operations:
 *   conduit.status    (query)  — connection status + unread count
 *   conduit.peek      (query)  — one-shot poll for messages
 *   conduit.listen    (query)  — one-shot poll for topic messages (A2A, T1252)
 *   conduit.start     (mutate) — start continuous polling
 *   conduit.stop      (mutate) — stop polling
 *   conduit.send      (mutate) — send a message
 *   conduit.subscribe (mutate) — subscribe agent to a topic (A2A, T1252)
 *   conduit.publish   (mutate) — publish message to a topic (A2A, T1252)
 *
 * Param extraction is type-safe via TypedDomainHandler<ConduitOps> inferred from
 * local Core-shaped function signatures (T1422 Wave D typed-dispatch migration + T1435
 * Wave 1 OpsFromCore refactor). Zero `as any` / `as X` param casts at call sites.
 *
 * @task T183
 * @task T1252
 * @task T1422 — Typed-dispatch migration (T975 follow-on)
 * @task T1435-W1 — Conduit dispatch refactor (OpsFromCore inference, T1436 helper)
 */

import type { LafsEnvelope } from '@cleocode/contracts';
import { defineTypedHandler, OpsFromCore, typedDispatch } from '../adapters/typed.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { handleErrorResult, unsupportedOp, wrapResult } from './_base.js';

// ---------------------------------------------------------------------------
// Singleton poller state — shared across dispatch calls within a session
// ---------------------------------------------------------------------------

let activePoller: import('@cleocode/runtime').AgentPoller | null = null;
let activeAgentId: string | null = null;

// ---------------------------------------------------------------------------
// Local Core-shaped operation functions (T1435 Wave 1)
//
// These functions are defined locally in the dispatch file but shaped like Core
// operations: they accept a single params object and return LafsEnvelope<Result>.
// The coreOps record references them directly, enabling OpsFromCore<typeof coreOps>
// to infer the typed operation record from their signatures.
//
// This pattern eliminates the drift class where contracts and dispatch had to be
// manually kept in sync. Every function signature IS the source of truth.
// ---------------------------------------------------------------------------

/** Resolve agent credential from the registry. */
async function _resolveCredential(agentId?: string) {
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

/**
 * Get connection status and unread count.
 * Shaped like a Core operation: single params arg, returns LafsEnvelope.
 */
async function conduitStatus(params: {
  agentId?: string;
}): Promise<LafsEnvelope<{
  agentId: string;
  connected: boolean;
  transport: string;
  pollerRunning: boolean;
  unreadTotal?: number;
  actionItems?: number;
  error?: string;
}>> {
  try {
    const credential = await _resolveCredential(params.agentId);
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
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_CONDUIT',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * One-shot peek for messages.
 * Shaped like a Core operation: single params arg, returns LafsEnvelope.
 */
async function conduitPeek(params: {
  agentId?: string;
  limit?: number;
}): Promise<
  LafsEnvelope<{
    agentId: string;
    messages: Array<{
      id: string;
      from: string;
      content: string;
      conversationId?: string;
      timestamp?: string;
    }>;
  }>
> {
  try {
    const credential = await _resolveCredential(params.agentId);

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
        const messages = await transport.poll({ limit: params.limit ?? 20 });
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
    const urlParams = new URLSearchParams();
    urlParams.set('mentioned', credential.agentId);
    urlParams.set('limit', String(params.limit ?? 20));

    const response = await fetch(`${credential.apiBaseUrl}/messages/peek?${urlParams}`, {
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
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_CONDUIT',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * One-shot poll for topic messages.
 * Shaped like a Core operation: single params arg, returns LafsEnvelope.
 */
async function conduitListen(params: {
  topicName: string;
  agentId?: string;
  limit?: number;
  since?: string;
}): Promise<
  LafsEnvelope<{
    topicName: string;
    messages: Array<{
      id: string;
      from: string;
      content: string;
      conversationId?: string;
      timestamp?: string;
    }>;
    listenedForMs: number;
  }>
> {
  try {
    if (!params.topicName) {
      return {
        success: false,
        error: { code: 'E_ARGS', message: 'Must specify "topicName"' },
      };
    }

    const startMs = Date.now();
    const credential = await _resolveCredential(params.agentId);

    const { LocalTransport } = await import('@cleocode/core/conduit');
    if (!LocalTransport.isAvailable(process.cwd())) {
      return {
        success: false,
        error: { code: 'E_CONDUIT', message: 'conduit.db not found — run: cleo init' },
      };
    }

    const transport = new LocalTransport();
    await transport.connect({
      agentId: credential.agentId,
      apiKey: credential.apiKey,
      apiBaseUrl: credential.apiBaseUrl,
    });

    try {
      // Convert ISO since to unix timestamp for pollTopic
      const sinceUnix = params.since ? Math.floor(new Date(params.since).getTime() / 1000) : 0;
      const messages = await transport.pollTopic(params.topicName, {
        limit: params.limit ?? 50,
        since: sinceUnix,
      });
      return {
        success: true,
        data: {
          topicName: params.topicName,
          messages: messages.map((m) => ({
            id: m.id,
            from: m.from,
            content: m.content,
            conversationId: m.threadId,
            timestamp: m.timestamp,
          })),
          listenedForMs: Date.now() - startMs,
        },
      };
    } finally {
      await transport.disconnect();
    }
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_CONDUIT',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Start continuous polling via AgentPoller.
 * Shaped like a Core operation: single params arg, returns LafsEnvelope.
 */
async function conduitStart(params: {
  agentId?: string;
  pollIntervalMs?: number;
  groupConversationIds?: string[];
}): Promise<
  LafsEnvelope<{
    agentId: string;
    pollIntervalMs: number;
    groupConversationIds: string[];
    transport: string;
    message: string;
    alreadyRunning?: boolean;
  }>
> {
  try {
    if (activePoller) {
      return {
        success: true,
        data: {
          agentId: activeAgentId ?? 'unknown',
          message: 'Poller already running. Use conduit.stop first.',
          alreadyRunning: true,
          pollIntervalMs: params.pollIntervalMs ?? 5000,
          groupConversationIds: params.groupConversationIds ?? [],
          transport: 'http',
        },
      };
    }

    const credential = await _resolveCredential(params.agentId);
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
      pollIntervalMs: params.pollIntervalMs ?? 5000,
      groupConversationIds: params.groupConversationIds,
      transport,
    });
    activeAgentId = credential.agentId;

    activePoller.start();

    return {
      success: true,
      data: {
        agentId: credential.agentId,
        pollIntervalMs: params.pollIntervalMs ?? 5000,
        groupConversationIds: params.groupConversationIds ?? [],
        transport: transportName,
        message: 'Polling started.',
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_CONDUIT',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Stop the active polling loop.
 * Shaped like a Core operation: single params arg, returns LafsEnvelope.
 */
async function conduitStop(
  _params: Record<string, never>,
): Promise<LafsEnvelope<{ agentId: string | null; message: string }>> {
  try {
    if (!activePoller) {
      return { success: true, data: { agentId: null, message: 'No active poller to stop.' } };
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
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_CONDUIT',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Send a message to an agent or conversation.
 * Shaped like a Core operation: single params arg, returns LafsEnvelope.
 */
async function conduitSend(params: {
  content: string;
  to?: string;
  conversationId?: string;
  agentId?: string;
}): Promise<
  LafsEnvelope<{
    messageId: string;
    from: string;
    to: string;
    transport: string;
    sentAt: string;
  }>
> {
  try {
    if (!params.to && !params.conversationId) {
      return {
        success: false,
        error: { code: 'E_ARGS', message: 'Must specify "to" (agent ID) or "conversationId"' },
      };
    }

    const credential = await _resolveCredential(params.agentId);

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
        const recipient = params.to ?? params.conversationId ?? '';
        const result = await transport.push(recipient, params.content, {
          conversationId: params.conversationId,
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
    const body: Record<string, string> = { content: params.content };

    if (params.conversationId) {
      url = `${credential.apiBaseUrl}/conversations/${params.conversationId}/messages`;
    } else {
      url = `${credential.apiBaseUrl}/messages`;
      body['toAgentId'] = params.to!;
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
        to: params.to ?? params.conversationId!,
        transport: 'http',
        sentAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_CONDUIT',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Subscribe agent to a named topic.
 * Shaped like a Core operation: single params arg, returns LafsEnvelope.
 */
async function conduitSubscribe(params: {
  topicName: string;
  agentId?: string;
  filter?: { kind?: string[]; event?: string[] };
}): Promise<
  LafsEnvelope<{
    agentId: string;
    topicName: string;
    message: string;
  }>
> {
  try {
    if (!params.topicName) {
      return {
        success: false,
        error: { code: 'E_ARGS', message: 'Must specify "topicName"' },
      };
    }

    const credential = await _resolveCredential(params.agentId);
    const { LocalTransport } = await import('@cleocode/core/conduit');

    if (!LocalTransport.isAvailable(process.cwd())) {
      return {
        success: false,
        error: { code: 'E_CONDUIT', message: 'conduit.db not found — run: cleo init' },
      };
    }

    const transport = new LocalTransport();
    await transport.connect({
      agentId: credential.agentId,
      apiKey: credential.apiKey,
      apiBaseUrl: credential.apiBaseUrl,
    });

    try {
      await transport.subscribeTopic(params.topicName);
      return {
        success: true,
        data: {
          agentId: credential.agentId,
          topicName: params.topicName,
          message: `Subscribed to topic: ${params.topicName}`,
        },
      };
    } finally {
      await transport.disconnect();
    }
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_CONDUIT',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Publish a message to a named topic.
 * Shaped like a Core operation: single params arg, returns LafsEnvelope.
 */
async function conduitPublish(params: {
  topicName: string;
  content: string;
  kind?: 'message' | 'request' | 'notify' | 'subscribe';
  payload?: Record<string, unknown>;
  agentId?: string;
}): Promise<
  LafsEnvelope<{
    messageId: string;
    from: string;
    topicName: string;
    transport: string;
    publishedAt: string;
  }>
> {
  try {
    if (!params.topicName) {
      return {
        success: false,
        error: { code: 'E_ARGS', message: 'Must specify "topicName"' },
      };
    }
    if (!params.content) {
      return {
        success: false,
        error: { code: 'E_ARGS', message: 'Must specify "content"' },
      };
    }

    const credential = await _resolveCredential(params.agentId);
    const { LocalTransport } = await import('@cleocode/core/conduit');

    if (!LocalTransport.isAvailable(process.cwd())) {
      return {
        success: false,
        error: { code: 'E_CONDUIT', message: 'conduit.db not found — run: cleo init' },
      };
    }

    const transport = new LocalTransport();
    await transport.connect({
      agentId: credential.agentId,
      apiKey: credential.apiKey,
      apiBaseUrl: credential.apiBaseUrl,
    });

    try {
      const result = await transport.publishToTopic(params.topicName, params.content, {
        kind: params.kind,
        payload: params.payload,
      });
      return {
        success: true,
        data: {
          messageId: result.messageId,
          from: credential.agentId,
          topicName: params.topicName,
          transport: 'local',
          publishedAt: new Date().toISOString(),
        },
      };
    } finally {
      await transport.disconnect();
    }
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_CONDUIT',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Core Operations Record & Type Inference (T1435 Wave 1 — OpsFromCore)
//
// The coreOps record maps operation names to the Core-shaped functions above.
// OpsFromCore<typeof coreOps> infers the typed operation record from their
// signatures, eliminating the drift class where contracts and dispatch had to
// be manually kept in sync.
// ---------------------------------------------------------------------------

const coreOps = {
  status: conduitStatus,
  peek: conduitPeek,
  listen: conduitListen,
  start: conduitStart,
  stop: conduitStop,
  send: conduitSend,
  subscribe: conduitSubscribe,
  publish: conduitPublish,
} as const;

/** Typed operation record inferred from Core-shaped function signatures. */
type ConduitOps = OpsFromCore<typeof coreOps>;

// ---------------------------------------------------------------------------
// Typed inner handler (Wave D · T1422)
//
// The typed handler holds all per-op logic with fully-narrowed params.
// The outer DomainHandler class delegates to it so the registry sees the
// expected query/mutate interface while every param access is type-safe.
// ---------------------------------------------------------------------------

const _conduitTypedHandler = defineTypedHandler<ConduitOps>('conduit', {
  status: conduitStatus,
  peek: conduitPeek,
  listen: conduitListen,
  start: conduitStart,
  stop: conduitStop,
  send: conduitSend,
  subscribe: conduitSubscribe,
  publish: conduitPublish,
});

// ---------------------------------------------------------------------------
// Op sets — validated before dispatch to prevent unsupported-op errors
// ---------------------------------------------------------------------------

const QUERY_OPS = new Set<string>(['status', 'peek', 'listen']);
const MUTATE_OPS = new Set<string>(['start', 'stop', 'send', 'subscribe', 'publish']);

// ---------------------------------------------------------------------------
// ConduitHandler — DomainHandler-compatible wrapper for the registry
// ---------------------------------------------------------------------------

/**
 * Domain handler for the `conduit` domain.
 *
 * Delegates all per-op logic to the typed inner handler
 * `_conduitTypedHandler` (a `TypedDomainHandler<ConduitOps>`). This
 * satisfies the registry's `DomainHandler` interface while keeping every
 * param access fully type-safe via the T1422 Wave D adapter.
 *
 * @task T1422 — Typed-dispatch migration (T975 follow-on)
 * @task T1435-W1 — OpsFromCore refactor (T1436 helper)
 */
export class ConduitHandler implements DomainHandler {
  /**
   * Execute a read-only conduit query operation.
   *
   * @param operation - The conduit query op name (e.g. 'status', 'peek', 'listen').
   * @param params - Raw params from the dispatcher (narrowed internally).
   */
  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    if (!QUERY_OPS.has(operation)) {
      return unsupportedOp('query', 'conduit', operation, startTime);
    }

    try {
      // operation is validated above — cast to the typed key is safe.
      // This is the single documented trust boundary: the registry guarantees
      // `operation` is a valid conduit query op name at this point.
      const envelope = await typedDispatch(
        _conduitTypedHandler,
        operation as keyof ConduitOps & string,
        params ?? {},
      );
      return wrapResult(envelopeToEngineResult(envelope), 'query', 'conduit', operation, startTime);
    } catch (error) {
      return handleErrorResult('query', 'conduit', operation, error, startTime);
    }
  }

  /**
   * Execute a state-modifying conduit mutation operation.
   *
   * @param operation - The conduit mutate op name (e.g. 'start', 'send', 'publish').
   * @param params - Raw params from the dispatcher (narrowed internally).
   */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    if (!MUTATE_OPS.has(operation)) {
      return unsupportedOp('mutate', 'conduit', operation, startTime);
    }

    try {
      // operation is validated above — cast to the typed key is safe.
      // This is the single documented trust boundary: the registry guarantees
      // `operation` is a valid conduit mutate op name at this point.
      const envelope = await typedDispatch(
        _conduitTypedHandler,
        operation as keyof ConduitOps & string,
        params ?? {},
      );
      return wrapResult(
        envelopeToEngineResult(envelope),
        'mutate',
        'conduit',
        operation,
        startTime,
      );
    } catch (error) {
      return handleErrorResult('mutate', 'conduit', operation, error, startTime);
    }
  }

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: ['status', 'peek', 'listen'],
      mutate: ['start', 'stop', 'send', 'subscribe', 'publish'],
    };
  }
}

// ---------------------------------------------------------------------------
// Envelope-to-EngineResult adapter
//
// Converts a LafsEnvelope into the minimal EngineResult shape accepted by
// wrapResult. The error.code is coerced to string since LafsErrorDetail.code
// is typed as `number | string` but EngineResult.error.code requires string.
// ---------------------------------------------------------------------------

/**
 * Convert a LAFS envelope into the minimal EngineResult shape expected by
 * {@link wrapResult}.
 *
 * @param envelope - The LAFS envelope returned by the typed op function.
 * @returns An object compatible with the `EngineResult` type in `_base.ts`.
 *
 * @internal
 */
function envelopeToEngineResult(envelope: {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code: string | number; readonly message: string };
}): { success: boolean; data?: unknown; error?: { code: string; message: string } } {
  if (envelope.success) {
    return { success: true, data: envelope.data };
  }
  return {
    success: false,
    error: {
      code: envelope.error?.code !== undefined ? String(envelope.error.code) : 'E_INTERNAL',
      message: envelope.error?.message ?? 'Unknown error',
    },
  };
}
