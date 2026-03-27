/**
 * @cleocode/runtime — Long-running process layer for CLEO.
 *
 * Provides background services: agent polling, SSE connections,
 * heartbeat intervals, and credential rotation.
 *
 * @module runtime
 */

import type { AgentRegistryAPI } from '@cleocode/contracts';
import { AgentPoller } from './services/agent-poller.js';
import type { AgentPollerConfig, MessageHandler } from './services/agent-poller.js';

export { AgentPoller } from './services/agent-poller.js';
export type { AgentPollerConfig, MessageHandler } from './services/agent-poller.js';

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
}

/** Handle returned by createRuntime(). */
export interface RuntimeHandle {
  /** The AgentPoller instance. */
  poller: AgentPoller;
  /** The agent ID the poller is running as. */
  agentId: string;
  /** Stop the runtime and clean up. */
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

  const pollerConfig: AgentPollerConfig = {
    agentId: credential.agentId,
    apiKey: credential.apiKey,
    apiBaseUrl: credential.apiBaseUrl,
    pollIntervalMs: config?.pollIntervalMs ?? credential.transportConfig.pollIntervalMs ?? 5000,
    groupConversationIds: config?.groupConversationIds,
    groupPollLimit: config?.groupPollLimit,
  };

  const poller = new AgentPoller(pollerConfig);

  return {
    poller,
    agentId: credential.agentId,
    stop: () => poller.stop(),
  };
}
