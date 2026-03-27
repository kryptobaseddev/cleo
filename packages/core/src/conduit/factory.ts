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

/** Resolve the best available transport for a credential. */
function resolveTransport(credential: AgentCredential): Transport {
  // Priority: Local (napi-rs) > WebSocket > SSE > HTTP polling
  // LocalTransport and SseTransport are future — stubs not yet implemented
  if (credential.transportConfig.wsUrl) {
    // WsTransport stub — fall through to HTTP for now
  }
  if (credential.transportConfig.sseEndpoint) {
    // SseTransport stub — fall through to HTTP for now
  }
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
