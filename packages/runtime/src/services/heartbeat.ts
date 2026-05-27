/**
 * HeartbeatService — Periodic online status heartbeat.
 *
 * Sends a heartbeat to the SignalDock API at a configurable interval
 * to maintain the agent's online status. If the heartbeat fails,
 * it retries silently — the agent continues operating regardless.
 *
 * @task T218
 */

/** Heartbeat service configuration. */
export interface HeartbeatConfig {
  /** Agent ID to send heartbeats for. */
  agentId: string;
  /** API key for authentication. */
  apiKey: string;
  /** API base URL. */
  apiBaseUrl: string;
  /** Heartbeat interval in milliseconds. Default: 30000 (30s). */
  intervalMs?: number;
}

/** Default heartbeat interval: 30 seconds. */
const DEFAULT_INTERVAL_MS = 30_000;

/** HeartbeatService sends periodic online status to the cloud API. */
export class HeartbeatService {
  private config: HeartbeatConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private consecutiveFailures = 0;

  constructor(config: HeartbeatConfig) {
    this.config = config;
  }

  /** Start sending heartbeats at the configured interval. */
  start(): void {
    if (this.running) return;
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
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Get heartbeat service status. */
  status(): { running: boolean; consecutiveFailures: number } {
    return {
      running: this.running,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  /** Send a single heartbeat to the cloud API. */
  private async sendHeartbeat(): Promise<void> {
    try {
      const response = await fetch(
        `${this.config.apiBaseUrl}/agents/${this.config.agentId}/heartbeat`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.apiKey}`,
            'X-Agent-Id': this.config.agentId,
          },
          body: JSON.stringify({ status: 'online' }),
          signal: AbortSignal.timeout(10_000),
        },
      );

      if (response.ok) {
        this.consecutiveFailures = 0;
      } else {
        this.consecutiveFailures++;
      }
    } catch {
      this.consecutiveFailures++;
    }
  }
}
