/**
 * SseConnectionService — Persistent SSE connection manager.
 *
 * Maintains a persistent SSE connection to the SignalDock API for
 * real-time message delivery. Wraps SseTransport with lifecycle
 * management: start, stop, reconnect, and message forwarding.
 *
 * When SSE is available, messages arrive in real-time. When it falls
 * back to HTTP polling (managed by SseTransport internally), the
 * service continues operating transparently.
 *
 * @task T218
 */
/** SseConnectionService manages a persistent transport with subscribe() support. */
export class SseConnectionService {
    config;
    handler = null;
    unsubscribe = null;
    running = false;
    constructor(config) {
        this.config = config;
    }
    /** Register a message handler for incoming messages. */
    onMessage(handler) {
        this.handler = handler;
    }
    /** Start the SSE connection. */
    async start() {
        if (this.running)
            return;
        this.running = true;
        await this.config.transport.connect({
            agentId: this.config.agentId,
            apiKey: this.config.apiKey,
            apiBaseUrl: this.config.apiBaseUrl,
            sseEndpoint: this.config.sseEndpoint,
        });
        // Subscribe to incoming messages if transport supports it
        if (this.handler && this.config.transport.subscribe) {
            this.unsubscribe = this.config.transport.subscribe(this.handler);
        }
    }
    /** Stop the connection and clean up. */
    async stop() {
        this.running = false;
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
        await this.config.transport.disconnect();
    }
    /** Get connection service status. */
    status() {
        return {
            running: this.running,
            transportName: this.config.transport.name,
        };
    }
}
//# sourceMappingURL=sse-connection.js.map