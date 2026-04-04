/**
 * @cleocode/runtime — Long-running process layer for CLEO.
 *
 * Provides background services: agent polling, SSE connections,
 * heartbeat intervals, and credential rotation.
 *
 * @module runtime
 */

import type { AgentRegistryAPI, Transport } from '@cleocode/contracts';
import { conduit } from '@cleocode/core';

const { resolveTransport } = conduit;

import type { AgentPollerConfig } from './services/agent-poller.js';
import { AgentPoller } from './services/agent-poller.js';
import { HeartbeatService } from './services/heartbeat.js';
import { KeyRotationService } from './services/key-rotation.js';
import { SseConnectionService } from './services/sse-connection.js';

export type { AgentPollerConfig, MessageHandler } from './services/agent-poller.js';
export { AgentPoller } from './services/agent-poller.js';
export type { HeartbeatConfig } from './services/heartbeat.js';
export { HeartbeatService } from './services/heartbeat.js';
export type { KeyRotationConfig } from './services/key-rotation.js';
export { KeyRotationService } from './services/key-rotation.js';
export type { SseConnectionConfig, SseMessageHandler } from './services/sse-connection.js';
export { SseConnectionService } from './services/sse-connection.js';

/** Configuration for createRuntime(). */
export interface RuntimeConfig {
  /** Agent ID to run as. If omitted, uses the most recently used active agent. */
  agentId?: string;
  /** Poll interval in milliseconds. Default: 5000. */
  pollIntervalMs?: number;
  /** Known group conversation IDs to monitor for @mentions. */
  groupConversationIds?: string[];
  /** Max messages per group conversation poll. Default: 15. */
  groupPollLimit?: number;
  /** Heartbeat interval in milliseconds. Default: 30000. Set to 0 to disable. */
  heartbeatIntervalMs?: number;
  /** Max key age in milliseconds before rotation. Default: 30 days. Set to 0 to disable. */
  maxKeyAgeMs?: number;
  /** SSE endpoint URL. If set, enables persistent SSE connection. */
  sseEndpoint?: string;
  /** Transport factory for SSE connection. Caller provides to avoid circular deps. */
  createSseTransport?: () => import('@cleocode/contracts').Transport;
  /**
   * Pre-created transport instance. When provided, bypasses auto-resolution.
   * The transport must NOT be connected yet — createRuntime handles connection.
   */
  transport?: Transport;
}

/** Handle returned by createRuntime(). */
export interface RuntimeHandle {
  /** The AgentPoller instance. */
  poller: AgentPoller;
  /** The HeartbeatService instance (null if disabled). */
  heartbeat: HeartbeatService | null;
  /** The KeyRotationService instance (null if disabled). */
  keyRotation: KeyRotationService | null;
  /** The SseConnectionService instance (null if no SSE endpoint). */
  sseConnection: SseConnectionService | null;
  /** The resolved transport (local, sse, or http). */
  transport: Transport;
  /** The agent ID the runtime is running as. */
  agentId: string;
  /** Stop all runtime services and clean up. */
  stop: () => void;
}

/**
 * Create and start a runtime from the agent registry.
 *
 * Resolves the agent credential, configures the poller, and starts polling.
 * Returns a handle to register message handlers and stop the runtime.
 *
 * @param registry - AgentRegistryAPI instance for credential lookup.
 * @param config - Optional runtime configuration overrides.
 * @returns A RuntimeHandle with the poller, agentId, and stop function.
 */
export async function createRuntime(
  registry: AgentRegistryAPI,
  config?: RuntimeConfig,
): Promise<RuntimeHandle> {
  const credential = config?.agentId
    ? await registry.get(config.agentId)
    : await registry.getActive();

  if (!credential) {
    throw new Error(
      'No agent credential found. Run: cleo agent register --id <id> --api-key <key>',
    );
  }

  // Resolve transport: caller-provided > auto-detected (Local > SSE > HTTP)
  const transport = config?.transport ?? resolveTransport(credential);
  await transport.connect({
    agentId: credential.agentId,
    apiKey: credential.apiKey,
    apiBaseUrl: credential.apiBaseUrl,
    ...credential.transportConfig,
  });

  const pollerConfig: AgentPollerConfig = {
    agentId: credential.agentId,
    apiKey: credential.apiKey,
    apiBaseUrl: credential.apiBaseUrl,
    pollIntervalMs: config?.pollIntervalMs ?? credential.transportConfig.pollIntervalMs ?? 5000,
    groupConversationIds: config?.groupConversationIds,
    groupPollLimit: config?.groupPollLimit,
    transport,
  };

  const poller = new AgentPoller(pollerConfig);

  // Heartbeat service (disabled when intervalMs is 0)
  let heartbeat: HeartbeatService | null = null;
  if (config?.heartbeatIntervalMs !== 0) {
    heartbeat = new HeartbeatService({
      agentId: credential.agentId,
      apiKey: credential.apiKey,
      apiBaseUrl: credential.apiBaseUrl,
      intervalMs: config?.heartbeatIntervalMs,
    });
    heartbeat.start();
  }

  // Key rotation service (disabled when maxKeyAgeMs is 0)
  let keyRotation: KeyRotationService | null = null;
  if (config?.maxKeyAgeMs !== 0) {
    keyRotation = new KeyRotationService({
      agentId: credential.agentId,
      registry,
      maxKeyAgeMs: config?.maxKeyAgeMs,
    });
    keyRotation.start();
  }

  // SSE connection service (enabled when sseEndpoint + transport factory provided)
  let sseConnection: SseConnectionService | null = null;
  const sseEndpoint = config?.sseEndpoint ?? credential.transportConfig.sseEndpoint;
  if (sseEndpoint && config?.createSseTransport) {
    sseConnection = new SseConnectionService({
      agentId: credential.agentId,
      apiKey: credential.apiKey,
      apiBaseUrl: credential.apiBaseUrl,
      sseEndpoint,
      transport: config.createSseTransport(),
    });
    // Start is async but we don't block createRuntime on it
    void sseConnection.start();
  }

  return {
    poller,
    heartbeat,
    keyRotation,
    sseConnection,
    transport,
    agentId: credential.agentId,
    stop: () => {
      poller.stop();
      heartbeat?.stop();
      keyRotation?.stop();
      void sseConnection?.stop();
      void transport.disconnect();
    },
  };
}
