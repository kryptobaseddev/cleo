/**
 * Transport factory — selects the appropriate AgentTransport based on configuration.
 *
 * @task T5671
 */

import { ClaudeCodeTransport } from './claude-code-transport.js';
import type { SignalDockTransportConfig } from './signaldock-transport.js';
import { SignalDockTransport } from './signaldock-transport.js';
import type { AgentTransport } from './transport.js';

/** Configuration for transport selection. */
export interface TransportFactoryConfig {
  enabled: boolean;
  mode: 'http' | 'native';
  endpoint: string;
  agentPrefix: string;
  privacyTier: 'public' | 'discoverable' | 'private';
}

/**
 * Create an AgentTransport instance based on configuration.
 *
 * Returns SignalDockTransport if signaldock is enabled,
 * otherwise returns ClaudeCodeTransport as the default.
 */
export function createTransport(config?: TransportFactoryConfig): AgentTransport {
  if (!config?.enabled) {
    return new ClaudeCodeTransport();
  }

  const sdConfig: SignalDockTransportConfig = {
    endpoint: config.endpoint,
    agentPrefix: config.agentPrefix,
    privacyTier: config.privacyTier,
  };

  return new SignalDockTransport(sdConfig);
}
