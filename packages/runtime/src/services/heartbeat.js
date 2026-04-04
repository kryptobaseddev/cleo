/**
 * HeartbeatService — Periodic online status heartbeat.
 *
 * Sends a heartbeat to the SignalDock API at a configurable interval
 * to maintain the agent's online status. If the heartbeat fails,
 * it retries silently — the agent continues operating regardless.
 *
 * @task T218
 */
/** Default heartbeat interval: 30 seconds. */
const DEFAULT_INTERVAL_MS = 30_000;
/** HeartbeatService sends periodic online status to the cloud API. */
export class HeartbeatService {
    config;
    timer = null;
    running = false;
    consecutiveFailures = 0;
    constructor(config) {
        this.config = config;
    }
    /** Start sending heartbeats at the configured interval. */
    start() {
        if (this.running)
            return;
        this.running = true;
        this.consecutiveFailures = 0;
        const intervalMs = this.config.intervalMs ?? DEFAULT_INTERVAL_MS;
        // Send initial heartbeat immediately
        void this.sendHeartbeat();
        this.timer = setInterval(() => {
            void this.sendHeartbeat();
        }, intervalMs);
    }
    /** Stop sending heartbeats. */
    stop() {
        this.running = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    /** Get heartbeat service status. */
    status() {
        return {
            running: this.running,
            consecutiveFailures: this.consecutiveFailures,
        };
    }
    /** Send a single heartbeat to the cloud API. */
    async sendHeartbeat() {
        try {
            const response = await fetch(`${this.config.apiBaseUrl}/agents/${this.config.agentId}/heartbeat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this.config.apiKey}`,
                    'X-Agent-Id': this.config.agentId,
                },
                body: JSON.stringify({ status: 'online' }),
                signal: AbortSignal.timeout(10_000),
            });
            if (response.ok) {
                this.consecutiveFailures = 0;
            }
            else {
                this.consecutiveFailures++;
            }
        }
        catch {
            this.consecutiveFailures++;
        }
    }
}
//# sourceMappingURL=heartbeat.js.map