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

/** Resolve the best available transport for a credential. */
export function resolveTransport(credential: AgentCredential): Transport {
  // Priority: Local (SQLite) > WebSocket > SSE > HTTP polling
  if (LocalTransport.isAvailable()) {
    return new LocalTransport();
  }
  if (credential.transportConfig.wsUrl) {
    // WsTransport — fall through to SSE/HTTP for now
  }
  if (credential.transportConfig.sseEndpoint) {
    return new SseTransport();
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
