/**
 * KeyRotationService — Automatic API key rotation based on credential age.
 *
 * Monitors the age of the agent's API key and triggers rotation when
 * the key exceeds the configured threshold. Uses the AgentRegistryAPI
 * to perform the actual rotation (which calls the cloud API and
 * re-encrypts the new key locally).
 *
 * @task T218
 */
/** Default check interval: 1 hour. */
const DEFAULT_CHECK_INTERVAL_MS = 3_600_000;
/** Default max key age: 30 days. */
const DEFAULT_MAX_KEY_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** KeyRotationService monitors credential age and auto-rotates when threshold is exceeded. */
export class KeyRotationService {
    config;
    timer = null;
    running = false;
    lastRotationAt = null;
    constructor(config) {
        this.config = config;
    }
    /** Start monitoring key age at the configured interval. */
    start() {
        if (this.running)
            return;
        this.running = true;
        const intervalMs = this.config.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
        // Initial check after a short delay (don't rotate immediately on startup)
        setTimeout(() => {
            void this.checkAndRotate();
        }, 5000);
        this.timer = setInterval(() => {
            void this.checkAndRotate();
        }, intervalMs);
    }
    /** Stop monitoring. */
    stop() {
        this.running = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    /** Get rotation service status. */
    status() {
        return {
            running: this.running,
            lastRotationAt: this.lastRotationAt,
        };
    }
    /** Check credential age and rotate if needed. */
    async checkAndRotate() {
        try {
            const credential = await this.config.registry.get(this.config.agentId);
            if (!credential)
                return;
            const maxAge = this.config.maxKeyAgeMs ?? DEFAULT_MAX_KEY_AGE_MS;
            const credentialAge = Date.now() - new Date(credential.updatedAt).getTime();
            if (credentialAge > maxAge) {
                await this.config.registry.rotateKey(this.config.agentId);
                this.lastRotationAt = new Date().toISOString();
            }
        }
        catch {
            // Rotation failure is non-fatal — will retry next interval
        }
    }
}
//# sourceMappingURL=key-rotation.js.map