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
 * Priority (highest to lowest):
 *   1. LocalTransport — when conduit.db exists in the project's .cleo/ dir.
 *      Local delivery is always preferred for inter-agent messaging within
 *      the same project, even when the agent also has cloud credentials.
 *   2. SseTransport — when the credential includes an SSE endpoint URL.
 *   3. HttpTransport — fallback for cloud-only or no conduit.db.
 *
 * Note: LocalTransport and cloud credentials are not mutually exclusive.
 * Agents registered with a remote apiBaseUrl still use LocalTransport when
 * conduit.db is available, since local delivery does not require a network.
 */
export function resolveTransport(credential: AgentCredential): Transport {
  // Prefer LocalTransport when conduit.db exists — works offline and for
  // same-project agent-to-agent messaging without any cloud round-trip.
  if (LocalTransport.isAvailable()) {
    return new LocalTransport();
  }

  const isCloudBacked =
    credential.apiBaseUrl &&
    credential.apiBaseUrl !== 'local' &&
    credential.apiBaseUrl.startsWith('http');

  // Cloud-backed agents without local conduit.db: prefer SSE over HTTP polling
  if (isCloudBacked && credential.transportConfig.sseEndpoint) {
    return new SseTransport();
  }

  // Fallback to HTTP (cloud polling or no other option)
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
