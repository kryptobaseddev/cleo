/**
 * AgentPoller — Polls for messages via HttpTransport AND group conversations.
 *
 * Fixes the group @mention blind spot: the peek endpoint only matches
 * to_agent_id (DMs). This poller ALSO checks known group conversation
 * messages for @agentId content matches.
 *
 * @task T183
 */
/** Tracks seen message IDs for dedup. */
const DEFAULT_POLL_INTERVAL = 5000;
const DEFAULT_GROUP_POLL_LIMIT = 15;
/**
 * AgentPoller service — polls peek endpoint AND group conversations.
 * Deduplicates messages by ID across both sources.
 */
export class AgentPoller {
    config;
    handler = null;
    interval = null;
    seenMessageIds = new Set();
    running = false;
    constructor(config) {
        this.config = config;
    }
    /** Register a message handler. */
    onMessage(handler) {
        this.handler = handler;
    }
    /** Start the polling loop. */
    start() {
        if (this.running)
            return;
        this.running = true;
        const intervalMs = this.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL;
        // Initial poll immediately
        void this.pollCycle();
        this.interval = setInterval(() => {
            void this.pollCycle();
        }, intervalMs);
    }
    /** Stop the polling loop. */
    stop() {
        this.running = false;
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }
    /** Get poller status. */
    status() {
        return {
            running: this.running,
            seenCount: this.seenMessageIds.size,
        };
    }
    /** Single poll cycle — peek + group conversations. */
    async pollCycle() {
        if (!this.handler)
            return;
        const newMessages = [];
        // Track 1: Standard peek endpoint (catches DMs)
        try {
            const peekMessages = await this.peekMessages();
            for (const msg of peekMessages) {
                if (!this.seenMessageIds.has(msg.id)) {
                    this.seenMessageIds.add(msg.id);
                    newMessages.push(msg);
                }
            }
        }
        catch {
            // Best-effort — don't crash the loop
        }
        // Track 2: Group conversation polling (catches @mentions in group messages)
        const groupIds = this.config.groupConversationIds ?? [];
        for (const convId of groupIds) {
            try {
                const groupMessages = await this.pollGroupConversation(convId);
                for (const msg of groupMessages) {
                    if (!this.seenMessageIds.has(msg.id)) {
                        this.seenMessageIds.add(msg.id);
                        newMessages.push(msg);
                    }
                }
            }
            catch {
                // Best-effort per conversation
            }
        }
        // Deliver new messages to handler
        for (const msg of newMessages) {
            this.handler(msg);
        }
        // Prevent unbounded growth of seen set (keep last 5000)
        if (this.seenMessageIds.size > 5000) {
            const entries = [...this.seenMessageIds];
            this.seenMessageIds = new Set(entries.slice(-3000));
        }
    }
    /** Peek for messages mentioning this agent. Delegates to transport when available. */
    async peekMessages() {
        if (this.config.transport) {
            return this.config.transport.poll({ limit: 50 });
        }
        // Fallback: raw HTTP when no transport injected
        const params = new URLSearchParams();
        params.set('mentioned', this.config.agentId);
        params.set('limit', '50');
        const url = `${this.config.apiBaseUrl}/messages/peek?${params}`;
        const response = await fetch(url, {
            method: 'GET',
            headers: this.headers(),
        });
        if (!response.ok)
            return [];
        const data = (await response.json());
        return (data.data?.messages ?? []).map((m) => ({
            id: m.id,
            from: m.fromAgentId ?? 'unknown',
            content: m.content ?? '',
            threadId: m.conversationId,
            timestamp: m.createdAt ?? new Date().toISOString(),
        }));
    }
    /**
     * Poll a group conversation for recent messages that @mention this agent.
     * This is the fix for the group @mention blind spot.
     */
    async pollGroupConversation(conversationId) {
        const limit = this.config.groupPollLimit ?? DEFAULT_GROUP_POLL_LIMIT;
        const url = `${this.config.apiBaseUrl}/conversations/${conversationId}/messages?sort=desc&limit=${limit}`;
        const response = await fetch(url, {
            method: 'GET',
            headers: this.headers(),
        });
        if (!response.ok)
            return [];
        const data = (await response.json());
        const mentionPattern = new RegExp(`@${this.config.agentId}\\b|@all\\b`, 'i');
        return (data.data?.messages ?? [])
            .filter((m) => {
            // Only deliver messages that mention us or @all
            const content = m.content ?? '';
            return mentionPattern.test(content) && m.fromAgentId !== this.config.agentId;
        })
            .map((m) => ({
            id: m.id,
            from: m.fromAgentId ?? 'unknown',
            content: m.content ?? '',
            threadId: m.conversationId ?? conversationId,
            timestamp: m.createdAt ?? new Date().toISOString(),
        }));
    }
    /** Build auth headers. */
    headers() {
        return {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.apiKey}`,
            'X-Agent-Id': this.config.agentId,
        };
    }
}
//# sourceMappingURL=agent-poller.js.map