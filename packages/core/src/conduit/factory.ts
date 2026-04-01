/**
 * Conduit factory — creates a Conduit instance from the agent registry.
 *
 * Auto-selects the appropriate Transport based on the agent's credential
 * configuration. Priority: Local (napi-rs) > WebSocket > SSE > HTTP polling.
 *
 * @see docs/specs/SIGNALDOCK-UNIFIED-AGENT-REGISTRY.md Section 4.5
 * @task T177
 */

import type { AgentCredential, AgentRegistryAPI, Conduit, Transport } from '@cleocode/contracts';
import { ConduitClient } from './conduit-client.js';
import { HttpTransport } from './http-transport.js';
import { LocalTransport } from './local-transport.js';
import { SseTransport } from './sse-transport.js';

/**
 * Resolve the best available transport for a credential.
 *
 * Cloud-backed agents (apiBaseUrl is a remote URL) use HttpTransport
 * so they can receive messages from the SignalDock cloud relay.
 * LocalTransport is only used when the agent is explicitly local-only
 * (apiBaseUrl is 'local' or absent), since local signaldock.db doesn't
 * sync with the cloud.
 */
export function resolveTransport(credential: AgentCredential): Transport {
  const isCloudBacked =
    credential.apiBaseUrl &&
    credential.apiBaseUrl !== 'local' &&
    credential.apiBaseUrl.startsWith('http');

  // Cloud-backed agents must use network transports to receive cloud messages
  if (isCloudBacked) {
    if (credential.transportConfig.sseEndpoint) {
      return new SseTransport();
    }
    return new HttpTransport();
  }

  // Local-only agents use LocalTransport when signaldock.db is available
  if (LocalTransport.isAvailable()) {
    return new LocalTransport();
  }

  // Fallback to HTTP
  return new HttpTransport();
}

/** Create a Conduit instance from the agent registry. */
export async function createConduit(
  registry: AgentRegistryAPI,
  agentId?: string,
): Promise<Conduit> {
  const credential = agentId ? await registry.get(agentId) : await registry.getActive();

  if (!credential) {
    throw new Error(
      'No agent credential found. Run: cleo agent register --id <id> --api-key <key>',
    );
  }

  const transport = resolveTransport(credential);
  const conduit = new ConduitClient(transport, credential);
  await conduit.connect();
  return conduit;
}
