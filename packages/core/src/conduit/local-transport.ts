/**
 * LocalTransport — In-process SQLite transport for fully offline agent messaging.
 *
 * Reads and writes messages directly to conduit.db via node:sqlite.
 * No network calls. Works fully offline. Messages are stored in the
 * project-local conduit.db (ADR-037), keeping agent messaging isolated
 * from the global-identity signaldock.db.
 *
 * Priority: LocalTransport is preferred over HttpTransport when
 * conduit.db is available (see factory.ts).
 *
 * @see docs/specs/SIGNALDOCK-UNIFIED-AGENT-REGISTRY.md Section 4.4
 * @task T213
 * @task T356
 * @epic T310
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import type {
  ConduitMessage,
  ConduitTopicPublishOptions,
  ConduitTopicSubscribeOptions,
  ConduitUnsubscribe,
  Transport,
  TransportConnectConfig,
} from '@cleocode/contracts';
import { getConduitDbPath } from '../store/conduit-sqlite.js';

const _require = createRequire(import.meta.url);
const { DatabaseSync: DatabaseSyncClass } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof DatabaseSync>) => DatabaseSync;
};

/**
 * Parse an A2A topic name into its epic_id and optional wave_id components.
 *
 * Supported formats:
 * - `"epic-T1149.wave-2"` → `{ epicId: "T1149", waveId: 2 }`
 * - `"epic-T1149.coordination"` → `{ epicId: "T1149", waveId: undefined }`
 * - `"T1149.wave-2"` → `{ epicId: "T1149", waveId: 2 }` (short form)
 * - `"some-topic"` → `{ epicId: "some-topic", waveId: undefined }` (fallback)
 *
 * @param topicName - Raw topic name string.
 * @returns Parsed epic ID and optional integer wave ID.
 * @task T1252
 */
function parseTopicName(topicName: string): { epicId: string; waveId: number | undefined } {
  // Match "epic-T<id>.wave-<n>" or "T<id>.wave-<n>"
  const epicWaveMatch = topicName.match(/(?:epic-)?([A-Z]\d+)\.wave-(\d+)/);
  if (epicWaveMatch) {
    return { epicId: epicWaveMatch[1] ?? topicName, waveId: parseInt(epicWaveMatch[2] ?? '0', 10) };
  }
  // Match "epic-T<id>.coordination" or "epic-T<id>.<anything>"
  const epicMatch = topicName.match(/(?:epic-)?([A-Z]\d+)\./);
  if (epicMatch) {
    return { epicId: epicMatch[1] ?? topicName, waveId: undefined };
  }
  // Fallback: use the whole name as epicId
  return { epicId: topicName, waveId: undefined };
}

/** Internal state for an active local transport connection. */
interface LocalTransportState {
  agentId: string;
  db: DatabaseSync;
  dbPath: string;
  subscribers: Set<(message: ConduitMessage) => void>;
  /** Per-topic real-time handlers. Key is topic name, value is set of handlers. */
  topicHandlers: Map<string, Set<(message: ConduitMessage) => void>>;
  pollTimer: ReturnType<typeof setInterval> | null;
  /** Poll timer for cross-process topic message delivery. */
  topicPollTimer: ReturnType<typeof setInterval> | null;
  /** Tracks the highest `created_at` unix timestamp seen per topic for incremental polling. */
  topicLastSeen: Map<string, number>;
}

/** In-process SQLite transport for fully offline agent messaging. */
export class LocalTransport implements Transport {
  readonly name = 'local';
  private state: LocalTransportState | null = null;

  /**
   * Connect to conduit.db for in-process messaging.
   *
   * Opens the database, sets WAL mode pragmas, and verifies
   * the messages table exists. Throws if conduit.db is missing
   * or uninitialized (run `cleo init` first).
   *
   * @task T356
   * @epic T310
   */
  async connect(config: TransportConnectConfig): Promise<void> {
    const dbPath = getConduitDbPath(process.cwd());

    if (!existsSync(dbPath)) {
      throw new Error(`LocalTransport: conduit.db not found at ${dbPath}. Run: cleo init`);
    }

    const db = new DatabaseSyncClass(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');

    // Verify the messages table exists
    const hasMessages = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'")
      .get() as { name: string } | undefined;

    if (!hasMessages) {
      db.close();
      throw new Error(
        'LocalTransport: conduit.db exists but messages table missing — run cleo init or allow auto-migration (T358)',
      );
    }

    this.state = {
      agentId: config.agentId,
      db,
      dbPath,
      subscribers: new Set(),
      topicHandlers: new Map(),
      pollTimer: null,
      topicPollTimer: null,
      topicLastSeen: new Map(),
    };
  }

  /** Close the database connection and stop any subscriber polling. */
  async disconnect(): Promise<void> {
    if (!this.state) return;

    if (this.state.pollTimer) {
      clearInterval(this.state.pollTimer);
    }
    if (this.state.topicPollTimer) {
      clearInterval(this.state.topicPollTimer);
    }
    this.state.subscribers.clear();
    this.state.topicHandlers.clear();
    this.state.topicLastSeen.clear();
    this.state.db.close();
    this.state = null;
  }

  /**
   * Store a message in conduit.db.
   *
   * Inserts into the messages table with status 'pending'.
   * For conversation messages, also links via conversation_participants
   * if not already present.
   */
  async push(
    to: string,
    content: string,
    options?: { conversationId?: string; replyTo?: string },
  ): Promise<{ messageId: string }> {
    this.ensureConnected();
    const { db, agentId } = this.state!;
    const messageId = randomUUID();
    const nowUnix = Math.floor(Date.now() / 1000);

    if (options?.conversationId) {
      db.prepare(
        `INSERT INTO messages (id, conversation_id, from_agent_id, to_agent_id, content, content_type, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'text', 'pending', ?)`,
      ).run(messageId, options.conversationId, agentId, to, content, nowUnix);
    } else {
      // Direct message — create or reuse a DM conversation
      const convId = this.ensureDmConversation(agentId, to);
      db.prepare(
        `INSERT INTO messages (id, conversation_id, from_agent_id, to_agent_id, content, content_type, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'text', 'pending', ?)`,
      ).run(messageId, convId, agentId, to, content, nowUnix);
    }

    // Notify local subscribers
    this.notifySubscribers({
      id: messageId,
      from: agentId,
      content,
      threadId: options?.conversationId,
      timestamp: new Date(nowUnix * 1000).toISOString(),
    });

    return { messageId };
  }

  /**
   * Poll for messages addressed to this agent.
   *
   * Returns messages with status 'pending' where to_agent_id matches
   * the connected agent. Messages are returned oldest-first.
   */
  async poll(options?: { limit?: number; since?: string }): Promise<ConduitMessage[]> {
    this.ensureConnected();
    const { db, agentId } = this.state!;
    const limit = options?.limit ?? 50;

    let query: string;
    let params: (string | number)[];

    if (options?.since) {
      query = `SELECT id, from_agent_id, content, conversation_id, created_at
               FROM messages
               WHERE to_agent_id = ? AND status = 'pending' AND created_at > ?
               ORDER BY created_at ASC
               LIMIT ?`;
      params = [agentId, options.since, limit];
    } else {
      query = `SELECT id, from_agent_id, content, conversation_id, created_at
               FROM messages
               WHERE to_agent_id = ? AND status = 'pending'
               ORDER BY created_at ASC
               LIMIT ?`;
      params = [agentId, limit];
    }

    const rows = db.prepare(query).all(...params) as Array<{
      id: string;
      from_agent_id: string;
      content: string;
      conversation_id: string | null;
      created_at: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      from: r.from_agent_id,
      content: r.content,
      threadId: r.conversation_id ?? undefined,
      timestamp: new Date(r.created_at * 1000).toISOString(),
    }));
  }

  /**
   * Acknowledge messages by marking them as 'delivered'.
   *
   * Updates the status and delivered_at timestamp for each message ID.
   */
  async ack(messageIds: string[]): Promise<void> {
    this.ensureConnected();
    if (messageIds.length === 0) return;

    const { db } = this.state!;
    const nowUnix = Math.floor(Date.now() / 1000);

    const placeholders = messageIds.map(() => '?').join(', ');
    db.prepare(
      `UPDATE messages SET status = 'delivered', delivered_at = ? WHERE id IN (${placeholders})`,
    ).run(nowUnix, ...messageIds);
  }

  /**
   * Subscribe to real-time local messages.
   *
   * Since this is in-process, subscribers are notified synchronously
   * when push() is called. Additionally, a polling interval checks
   * for messages inserted by other processes (e.g., Rust CLI).
   *
   * @returns Unsubscribe function.
   */
  subscribe(handler: (message: ConduitMessage) => void): () => void {
    this.ensureConnected();
    this.state!.subscribers.add(handler);

    // Start cross-process polling if not already running
    if (!this.state!.pollTimer && this.state!.subscribers.size === 1) {
      this.state!.pollTimer = setInterval(() => {
        void this.pollAndNotify();
      }, 1000);
    }

    return () => {
      this.state?.subscribers.delete(handler);
      if (this.state?.subscribers.size === 0 && this.state.pollTimer) {
        clearInterval(this.state.pollTimer);
        this.state.pollTimer = null;
      }
    };
  }

  // ── A2A Topic Operations (T1252) ─────────────────────────────────────────

  /**
   * Subscribe this agent to a named topic in conduit.db.
   *
   * Creates the topic row if it does not exist (idempotent via ON CONFLICT DO NOTHING).
   * Inserts a `topic_subscriptions` row linking this agent to the topic.
   *
   * Topic name convention: `<epicId>.<waveId>` or `<epicId>.coordination`.
   *
   * @param topicName - Topic name, e.g. `"epic-T1149.wave-2"`.
   * @param _options  - Reserved for future filter support (not stored in DB yet).
   * @task T1252
   */
  async subscribeTopic(topicName: string, _options?: ConduitTopicSubscribeOptions): Promise<void> {
    this.ensureConnected();
    const { db, agentId } = this.state!;
    const nowUnix = Math.floor(Date.now() / 1000);

    // Derive epic_id / wave_id from the topic name (e.g. "epic-T1149.wave-2" or "epic-T1149.coordination")
    const { epicId, waveId } = parseTopicName(topicName);
    const topicId = randomUUID();

    // Create topic if absent
    db.prepare(
      `INSERT INTO topics (id, name, epic_id, wave_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO NOTHING`,
    ).run(topicId, topicName, epicId, waveId ?? null, agentId, nowUnix);

    // Resolve the actual topic id (might have been inserted above or pre-existing)
    const topic = db.prepare('SELECT id FROM topics WHERE name = ?').get(topicName) as
      | { id: string }
      | undefined;
    if (!topic) return; // Should not happen; inserted above

    db.prepare(
      `INSERT INTO topic_subscriptions (topic_id, agent_id, subscribed_at)
       VALUES (?, ?, ?)
       ON CONFLICT(topic_id, agent_id) DO NOTHING`,
    ).run(topic.id, agentId, nowUnix);
  }

  /**
   * Publish a message to a named topic in conduit.db.
   *
   * The message is broadcast to all current subscribers via the in-process
   * handler map (`topicHandlers`). Cross-process subscribers receive it via
   * the periodic poll timer started by `onTopic()`.
   *
   * The topic must already exist (via a prior `subscribeTopic()` call), or
   * this method creates it automatically with a synthetic creator.
   *
   * @param topicName - Target topic name.
   * @param content   - Human-readable message content.
   * @param options   - Message kind and optional structured payload.
   * @returns Object containing the assigned `messageId`.
   * @task T1252
   */
  async publishToTopic(
    topicName: string,
    content: string,
    options?: ConduitTopicPublishOptions,
  ): Promise<{ messageId: string }> {
    this.ensureConnected();
    const { db, agentId } = this.state!;
    const nowUnix = Math.floor(Date.now() / 1000);
    const messageId = randomUUID();
    const kind = options?.kind ?? 'message';

    // Ensure topic exists (auto-create if publisher subscribes lazily)
    const { epicId, waveId } = parseTopicName(topicName);
    const topicInsertId = randomUUID();
    db.prepare(
      `INSERT INTO topics (id, name, epic_id, wave_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO NOTHING`,
    ).run(topicInsertId, topicName, epicId, waveId ?? null, agentId, nowUnix);

    const topic = db.prepare('SELECT id FROM topics WHERE name = ?').get(topicName) as
      | { id: string }
      | undefined;
    if (!topic) {
      throw new Error(`LocalTransport.publishToTopic: could not resolve topic "${topicName}"`);
    }

    db.prepare(
      `INSERT INTO topic_messages (id, topic_id, from_agent_id, kind, content, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      messageId,
      topic.id,
      agentId,
      kind,
      content,
      options?.payload != null ? JSON.stringify(options.payload) : null,
      nowUnix,
    );

    // Notify in-process topic handlers immediately
    this.notifyTopicHandlers(topicName, {
      id: messageId,
      from: agentId,
      fromPeerId: agentId,
      toPeerId: null,
      content,
      kind,
      threadId: topicName,
      payload: options?.payload,
      timestamp: new Date(nowUnix * 1000).toISOString(),
    });

    return { messageId };
  }

  /**
   * Register a real-time handler for messages on a named topic.
   *
   * In-process publishers notify the handler synchronously via `publishToTopic()`.
   * Cross-process publishers are picked up via a 1-second polling interval
   * that is started on the first `onTopic()` call and stopped when all
   * topic handlers are removed.
   *
   * @param topicName - Topic name to watch.
   * @param handler   - Callback invoked for each incoming message.
   * @returns Unsubscribe function that removes this handler.
   * @task T1252
   */
  onTopic(topicName: string, handler: (message: ConduitMessage) => void): ConduitUnsubscribe {
    this.ensureConnected();
    const state = this.state!;

    if (!state.topicHandlers.has(topicName)) {
      state.topicHandlers.set(topicName, new Set());
    }
    state.topicHandlers.get(topicName)!.add(handler);

    // Start cross-process topic poll if not running
    if (!state.topicPollTimer) {
      state.topicPollTimer = setInterval(() => {
        void this.pollAndNotifyTopics();
      }, 1000);
    }

    return () => {
      const handlers = state.topicHandlers.get(topicName);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          state.topicHandlers.delete(topicName);
          state.topicLastSeen.delete(topicName);
        }
      }
      // Stop timer when no topics are watched
      if (state.topicHandlers.size === 0 && state.topicPollTimer) {
        clearInterval(state.topicPollTimer);
        state.topicPollTimer = null;
      }
    };
  }

  /**
   * Unsubscribe this agent from a named topic.
   *
   * Removes the `topic_subscriptions` row; does not delete the topic or messages.
   * In-process `onTopic` handlers are NOT automatically removed — callers should
   * call the unsubscribe function returned by `onTopic()` before `unsubscribeTopic()`.
   *
   * @param topicName - Topic name to leave.
   * @task T1252
   */
  async unsubscribeTopic(topicName: string): Promise<void> {
    this.ensureConnected();
    const { db, agentId } = this.state!;

    const topic = db.prepare('SELECT id FROM topics WHERE name = ?').get(topicName) as
      | { id: string }
      | undefined;
    if (!topic) return; // Topic doesn't exist — nothing to do

    db.prepare('DELETE FROM topic_subscriptions WHERE topic_id = ? AND agent_id = ?').run(
      topic.id,
      agentId,
    );
  }

  /**
   * Poll for new topic messages and deliver to registered handlers.
   *
   * Queries each topic with registered handlers for messages newer than
   * `topicLastSeen`. Updates `topicLastSeen` after each poll. Called
   * periodically by the `topicPollTimer`.
   *
   * @task T1252
   */
  async pollTopic(
    topicName: string,
    options?: { limit?: number; since?: number },
  ): Promise<ConduitMessage[]> {
    this.ensureConnected();
    const { db } = this.state!;
    const limit = options?.limit ?? 50;
    const since = options?.since ?? 0;

    const topic = db.prepare('SELECT id FROM topics WHERE name = ?').get(topicName) as
      | { id: string }
      | undefined;
    if (!topic) return [];

    const rows = db
      .prepare(
        `SELECT id, from_agent_id, kind, content, payload, created_at
         FROM topic_messages
         WHERE topic_id = ? AND created_at > ?
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(topic.id, since, limit) as Array<{
      id: string;
      from_agent_id: string;
      kind: string;
      content: string;
      payload: string | null;
      created_at: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      from: r.from_agent_id,
      fromPeerId: r.from_agent_id,
      toPeerId: null,
      content: r.content,
      kind: r.kind as ConduitMessage['kind'],
      threadId: topicName,
      payload: r.payload != null ? (JSON.parse(r.payload) as Record<string, unknown>) : undefined,
      timestamp: new Date(r.created_at * 1000).toISOString(),
    }));
  }

  /**
   * Check whether conduit.db is available for local transport.
   *
   * Used by factory.ts to decide whether to use LocalTransport.
   *
   * @task T356
   * @epic T310
   * @param cwd - Optional working directory override (defaults to process.cwd()).
   * @returns `true` if conduit.db exists at the expected path.
   */
  static isAvailable(cwd?: string): boolean {
    const dbPath = getConduitDbPath(cwd ?? process.cwd());
    return existsSync(dbPath);
  }

  /** Poll for new messages and notify subscribers (cross-process sync). */
  private async pollAndNotify(): Promise<void> {
    if (!this.state || this.state.subscribers.size === 0) return;

    const messages = await this.poll({ limit: 20 });
    for (const msg of messages) {
      this.notifySubscribers(msg);
    }
    if (messages.length > 0) {
      await this.ack(messages.map((m) => m.id));
    }
  }

  /** Poll all watched topics for new messages and notify in-process handlers. */
  private async pollAndNotifyTopics(): Promise<void> {
    if (!this.state || this.state.topicHandlers.size === 0) return;

    for (const [topicName] of this.state.topicHandlers) {
      const since = this.state.topicLastSeen.get(topicName) ?? 0;
      const messages = await this.pollTopic(topicName, { limit: 50, since });
      if (messages.length > 0) {
        // Advance the watermark
        const lastTs = messages[messages.length - 1];
        if (lastTs) {
          this.state.topicLastSeen.set(
            topicName,
            Math.floor(new Date(lastTs.timestamp).getTime() / 1000),
          );
        }
        for (const msg of messages) {
          this.notifyTopicHandlers(topicName, msg);
        }
      }
    }
  }

  /** Notify all handlers registered for a specific topic. */
  private notifyTopicHandlers(topicName: string, message: ConduitMessage): void {
    if (!this.state) return;
    const handlers = this.state.topicHandlers.get(topicName);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(message);
      } catch {
        // Handler errors must not crash the transport
      }
    }
  }

  /** Notify all active subscribers of a new message. */
  private notifySubscribers(message: ConduitMessage): void {
    if (!this.state) return;
    for (const handler of this.state.subscribers) {
      try {
        handler(message);
      } catch {
        // Subscriber errors must not break the transport
      }
    }
  }

  /**
   * Ensure a DM conversation exists between two agents.
   *
   * Conversations store participants as a comma-separated TEXT field.
   * We search for existing private conversations containing both agents.
   *
   * @returns The conversation ID.
   */
  private ensureDmConversation(fromAgentId: string, toAgentId: string): string {
    const { db } = this.state!;

    // Participants are stored as comma-separated text, sorted alphabetically
    const sortedParticipants = [fromAgentId, toAgentId].sort().join(',');

    // Check for existing DM conversation with these exact participants
    const existing = db
      .prepare(
        `SELECT id FROM conversations
         WHERE visibility = 'private' AND participants = ?
         LIMIT 1`,
      )
      .get(sortedParticipants) as { id: string } | undefined;

    if (existing) return existing.id;

    // Create new DM conversation
    const convId = randomUUID();
    const nowUnix = Math.floor(Date.now() / 1000);

    db.prepare(
      `INSERT INTO conversations (id, participants, visibility, message_count, created_at, updated_at)
       VALUES (?, ?, 'private', 0, ?, ?)`,
    ).run(convId, sortedParticipants, nowUnix, nowUnix);

    return convId;
  }

  /** Throw if not connected. */
  private ensureConnected(): void {
    if (!this.state) {
      throw new Error('LocalTransport not connected. Call connect() first.');
    }
  }
}
