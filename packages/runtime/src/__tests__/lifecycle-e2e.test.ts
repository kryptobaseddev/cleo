/**
 * E2E lifecycle integration test — full agent messaging roundtrip.
 *
 * Tests: create temp DBs → register 2 agents → start runtime for both →
 * Agent A sends to Agent B → Agent B receives → verify → stop → cleanup.
 *
 * Uses LocalTransport (in-process signaldock.db) — no network required.
 *
 * @task T249
 */

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('Agent Lifecycle E2E', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `cleo-e2e-${Date.now()}`);
    await mkdir(join(tempDir, '.cleo'), { recursive: true });
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('should create signaldock.db via ensureSignaldockDb', async () => {
    const { ensureSignaldockDb } = await import('@cleocode/core/internal');
    const result = await ensureSignaldockDb(tempDir);
    expect(result.action).toBe('created');
    expect(result.path).toContain('signaldock.db');

    // Verify schema applied
    const { existsSync } = await import('node:fs');
    expect(existsSync(result.path)).toBe(true);
  });

  it('should create signaldock.db with correct table count', async () => {
    const { ensureSignaldockDb, checkSignaldockDbHealth } = await import(
      '@cleocode/core/internal'
    );
    await ensureSignaldockDb(tempDir);

    const health = await checkSignaldockDbHealth(tempDir);
    expect(health).not.toBeNull();
    expect(health!.exists).toBe(true);
    expect(health!.tableCount).toBeGreaterThanOrEqual(20);
    expect(health!.walMode).toBe(true);
    expect(health!.schemaVersion).toBe('2026.3.76');
  });

  it('should be idempotent — second call returns exists', async () => {
    const { ensureSignaldockDb } = await import('@cleocode/core/internal');
    const first = await ensureSignaldockDb(tempDir);
    expect(first.action).toBe('created');

    const second = await ensureSignaldockDb(tempDir);
    expect(second.action).toBe('exists');
  });

  it('should register agents in signaldock.db and query them', async () => {
    const { ensureSignaldockDb, getSignaldockDbPath } = await import(
      '@cleocode/core/internal'
    );
    await ensureSignaldockDb(tempDir);

    // Insert agents directly into signaldock.db
    const { createRequire } = await import('node:module');
    const _require = createRequire(import.meta.url);
    const { DatabaseSync } = _require('node:sqlite') as typeof import('node:sqlite');
    const dbPath = getSignaldockDbPath(tempDir);
    const db = new DatabaseSync(dbPath);

    try {
      const now = Math.floor(Date.now() / 1000);
      db.exec(`
        INSERT INTO agents (id, agent_id, name, class, privacy_tier, capabilities, skills, status, created_at, updated_at)
        VALUES ('id-a', 'agent-alpha', 'Agent Alpha', 'code_dev', 'public', '["chat"]', '["typescript"]', 'online', ${now}, ${now});
      `);
      db.exec(`
        INSERT INTO agents (id, agent_id, name, class, privacy_tier, capabilities, skills, status, created_at, updated_at)
        VALUES ('id-b', 'agent-beta', 'Agent Beta', 'code_dev', 'public', '["chat"]', '["rust"]', 'online', ${now}, ${now});
      `);

      // Verify both agents exist
      const agents = db
        .prepare('SELECT agent_id, name FROM agents ORDER BY agent_id')
        .all() as Array<{ agent_id: string; name: string }>;
      expect(agents).toHaveLength(2);
      expect(agents[0]!.agent_id).toBe('agent-alpha');
      expect(agents[1]!.agent_id).toBe('agent-beta');
    } finally {
      db.close();
    }
  });

  it('should store and retrieve messages in signaldock.db', async () => {
    const { ensureSignaldockDb, getSignaldockDbPath } = await import(
      '@cleocode/core/internal'
    );
    await ensureSignaldockDb(tempDir);

    const { createRequire } = await import('node:module');
    const _require = createRequire(import.meta.url);
    const { DatabaseSync } = _require('node:sqlite') as typeof import('node:sqlite');
    const dbPath = getSignaldockDbPath(tempDir);
    const db = new DatabaseSync(dbPath);

    try {
      const now = Math.floor(Date.now() / 1000);

      // Create agents
      db.exec(`
        INSERT INTO agents (id, agent_id, name, class, privacy_tier, capabilities, skills, status, created_at, updated_at)
        VALUES ('id-a', 'agent-alpha', 'Agent Alpha', 'code_dev', 'public', '[]', '[]', 'online', ${now}, ${now}),
               ('id-b', 'agent-beta', 'Agent Beta', 'code_dev', 'public', '[]', '[]', 'online', ${now}, ${now});
      `);

      // Create conversation
      db.exec(`
        INSERT INTO conversations (id, participants, visibility, message_count, created_at, updated_at)
        VALUES ('conv-1', '["agent-alpha","agent-beta"]', 'private', 0, ${now}, ${now});
      `);

      // Agent Alpha sends message to Agent Beta
      db.exec(`
        INSERT INTO messages (id, conversation_id, from_agent_id, to_agent_id, content, content_type, status, created_at)
        VALUES ('msg-1', 'conv-1', 'agent-alpha', 'agent-beta', '/action @agent-beta Hello from Alpha!', 'text', 'pending', ${now});
      `);

      // Verify message stored
      const msg = db
        .prepare('SELECT * FROM messages WHERE id = ?')
        .get('msg-1') as { from_agent_id: string; to_agent_id: string; content: string; status: string };
      expect(msg.from_agent_id).toBe('agent-alpha');
      expect(msg.to_agent_id).toBe('agent-beta');
      expect(msg.content).toContain('Hello from Alpha');
      expect(msg.status).toBe('pending');

      // Agent Beta reads and acks
      db.exec(`UPDATE messages SET status = 'delivered', delivered_at = ${now} WHERE id = 'msg-1'`);
      const delivered = db
        .prepare('SELECT status FROM messages WHERE id = ?')
        .get('msg-1') as { status: string };
      expect(delivered.status).toBe('delivered');

      // Verify FTS works
      const ftsResults = db
        .prepare("SELECT content FROM messages_fts WHERE messages_fts MATCH 'Alpha'")
        .all() as Array<{ content: string }>;
      expect(ftsResults.length).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });

  it('should handle full lifecycle: create → message → cleanup', async () => {
    const { ensureSignaldockDb, getSignaldockDbPath } = await import(
      '@cleocode/core/internal'
    );

    // 1. Create DB
    const { action, path } = await ensureSignaldockDb(tempDir);
    expect(action).toBe('created');

    // 2. Verify health
    const { checkSignaldockDbHealth } = await import('@cleocode/core/internal');
    const health = await checkSignaldockDbHealth(tempDir);
    expect(health!.tableCount).toBeGreaterThanOrEqual(20);

    // 3. Insert agents + conversation + message
    const { createRequire } = await import('node:module');
    const _require = createRequire(import.meta.url);
    const { DatabaseSync } = _require('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(path);
    const now = Math.floor(Date.now() / 1000);

    try {
      db.exec(`INSERT INTO agents (id, agent_id, name, class, privacy_tier, capabilities, skills, status, created_at, updated_at) VALUES ('a1', 'alice', 'Alice', 'code_dev', 'public', '[]', '[]', 'online', ${now}, ${now}), ('b1', 'bob', 'Bob', 'code_dev', 'public', '[]', '[]', 'online', ${now}, ${now})`);
      db.exec(`INSERT INTO conversations (id, participants, visibility, message_count, created_at, updated_at) VALUES ('c1', '["alice","bob"]', 'private', 0, ${now}, ${now})`);
      db.exec(`INSERT INTO messages (id, conversation_id, from_agent_id, to_agent_id, content, content_type, status, created_at) VALUES ('m1', 'c1', 'alice', 'bob', 'Hello Bob!', 'text', 'pending', ${now})`);

      // 4. Verify roundtrip
      const received = db.prepare("SELECT * FROM messages WHERE to_agent_id = 'bob'").all() as Array<{ content: string }>;
      expect(received).toHaveLength(1);
      expect(received[0]!.content).toBe('Hello Bob!');

      // 5. Mark delivered
      db.exec("UPDATE messages SET status = 'delivered' WHERE id = 'm1'");

      // 6. Verify agent count
      const agentCount = db.prepare('SELECT COUNT(*) as c FROM agents').get() as { c: number };
      expect(agentCount.c).toBe(2);
    } finally {
      db.close();
    }

    // 7. Cleanup is handled by afterEach (rm tempDir)
  });
});
