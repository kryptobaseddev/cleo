/**
 * @cleocode/runtime — Long-running process layer for CLEO.
 *
 * Provides background services: agent polling, SSE connections,
 * heartbeat intervals, and credential rotation.
 *
 * @module runtime
 */
import { conduit } from '@cleocode/core';
const { resolveTransport } = conduit;
import { AgentPoller } from './services/agent-poller.js';
import { HeartbeatService } from './services/heartbeat.js';
import { KeyRotationService } from './services/key-rotation.js';
import { SseConnectionService } from './services/sse-connection.js';
export { AgentPoller } from './services/agent-poller.js';
export { HeartbeatService } from './services/heartbeat.js';
export { KeyRotationService } from './services/key-rotation.js';
export { SseConnectionService } from './services/sse-connection.js';
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
export async function createRuntime(registry, config) {
    const credential = config?.agentId
        ? await registry.get(config.agentId)
        : await registry.getActive();
    if (!credential) {
        throw new Error('No agent credential found. Run: cleo agent register --id <id> --api-key <key>');
    }
    // Resolve transport: caller-provided > auto-detected (Local > SSE > HTTP)
    const transport = config?.transport ?? resolveTransport(credential);
    await transport.connect({
        agentId: credential.agentId,
        apiKey: credential.apiKey,
        apiBaseUrl: credential.apiBaseUrl,
        ...credential.transportConfig,
    });
    const pollerConfig = {
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
    let heartbeat = null;
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
    let keyRotation = null;
    if (config?.maxKeyAgeMs !== 0) {
        keyRotation = new KeyRotationService({
            agentId: credential.agentId,
            registry,
            maxKeyAgeMs: config?.maxKeyAgeMs,
        });
        keyRotation.start();
    }
    // SSE connection service (enabled when sseEndpoint + transport factory provided)
    let sseConnection = null;
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
//# sourceMappingURL=index.js.map