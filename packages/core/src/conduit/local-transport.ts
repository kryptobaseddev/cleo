/**
 * LocalTransport — In-process SQLite transport for fully offline agent messaging.
 *
 * Reads and writes messages directly to signaldock.db via node:sqlite.
 * No network calls. Works fully offline. Messages are stored in the
 * same schema that the Rust signaldock-storage crate manages, so both
 * the local CLI and the cloud backend see the same data.
 *
 * Priority: LocalTransport is preferred over HttpTransport when
 * signaldock.db is available (see factory.ts).
 *
 * @see docs/specs/SIGNALDOCK-UNIFIED-AGENT-REGISTRY.md Section 4.4
 * @task T213
 */

import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import type { ConduitMessage, Transport, TransportConnectConfig } from '@cleocode/contracts';
import { getSignaldockDbPath } from '../store/signaldock-sqlite.js';
import { existsSync } from 'node:fs';

const _require = createRequire(import.meta.url);
const { DatabaseSync: DatabaseSyncClass } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof DatabaseSync>) => DatabaseSync;
};

/** Internal state for an active local transport connection. */
interface LocalTransportState {
  agentId: string;
  db: DatabaseSync;
  dbPath: string;
  subscribers: Set<(message: ConduitMessage) => void>;
  pollTimer: ReturnType<typeof setInterval> | null;
}

/**
 * Generate a UUID v4 for message IDs.
 * Uses crypto.randomUUID when available, falls back to manual generation.
 */
function generateId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  // Fallback: manual v4 UUID
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** In-process SQLite transport for fully offline agent messaging. */
export class LocalTransport implements Transport {
  readonly name = 'local';
  private state: LocalTransportState | null = null;

  /**
   * Connect to signaldock.db for in-process messaging.
   *
   * Opens the database, sets WAL mode pragmas, and verifies
   * the messages table exists. Throws if signaldock.db is missing
   * or uninitialized (run `cleo init` first).
   */
  async connect(config: TransportConnectConfig): Promise<void> {
    const dbPath = getSignaldockDbPath();

    if (!existsSync(dbPath)) {
      throw new Error(
        `LocalTransport: signaldock.db not found at ${dbPath}. Run: cleo init`,
      );
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
        'LocalTransport: signaldock.db exists but messages table missing. Run: cleo upgrade',
      );
    }

    this.state = {
      agentId: config.agentId,
      db,
      dbPath,
      subscribers: new Set(),
      pollTimer: null,
    };
  }

  /** Close the database connection and stop any subscriber polling. */
  async disconnect(): Promise<void> {
    if (!this.state) return;

    if (this.state.pollTimer) {
      clearInterval(this.state.pollTimer);
    }
    this.state.subscribers.clear();
    this.state.db.close();
    this.state = null;
  }

  /**
   * Store a message in signaldock.db.
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
    const messageId = generateId();
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

  /**
   * Check whether signaldock.db is available for local transport.
   *
   * Used by factory.ts to decide whether to use LocalTransport.
   */
  static isAvailable(cwd?: string): boolean {
    const dbPath = getSignaldockDbPath(cwd);
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
    const convId = generateId();
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
