/**
 * E2E lifecycle integration test — full agent messaging roundtrip.
 *
 * Tests: create temp conduit.db → insert project_agent_refs → open
 * conversation → exchange messages → mark delivered → verify FTS → cleanup.
 *
 * Uses the project-tier conduit.db (T310/T344). Global agent identity lives
 * in global-tier signaldock.db and is not exercised here.
 *
 * @task T249
 * @task T344 — migrated from ensureSignaldockDb(cwd) (project-tier) to
 *               ensureConduitDb(cwd) after T310 moved messaging to conduit.db.
 */

import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('Agent Lifecycle E2E', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `cleo-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(join(tempDir, '.cleo'), { recursive: true });
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');
  });

  afterEach(async () => {
    // Always close the conduit singleton so successive tests start clean.
    const { closeConduitDb } = await import('@cleocode/core/internal');
    closeConduitDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('should create conduit.db via ensureConduitDb', async () => {
    const { ensureConduitDb } = await import('@cleocode/core/internal');
    const result = ensureConduitDb(tempDir);
    expect(result.action).toBe('created');
    expect(result.path).toContain('conduit.db');

    // Verify file was written to disk
    const { existsSync } = await import('node:fs');
    expect(existsSync(result.path)).toBe(true);
  });

  it('should create conduit.db with the expected schema', async () => {
    const { ensureConduitDb, checkConduitDbHealth, CONDUIT_SCHEMA_VERSION } = await import(
      '@cleocode/core/internal'
    );
    ensureConduitDb(tempDir);

    const health = checkConduitDbHealth(tempDir);
    expect(health.exists).toBe(true);
    // conduit.db ships with 13 project-tier tables (conversations, messages,
    // delivery_jobs, dead_letters, message_pins, attachments, attachment_versions,
    // attachment_approvals, attachment_contributors, project_agent_refs,
    // _conduit_meta, _conduit_migrations) plus the messages_fts virtual table
    // and its shadow tables — SQLite counts each shadow table too.
    expect(health.tableCount).toBeGreaterThanOrEqual(13);
    expect(health.walMode).toBe(true);
    expect(health.foreignKeysEnabled).toBe(true);
    expect(health.schemaVersion).toBe(CONDUIT_SCHEMA_VERSION);
  });

  it('should be idempotent — second call returns exists', async () => {
    const { ensureConduitDb } = await import('@cleocode/core/internal');
    const first = ensureConduitDb(tempDir);
    expect(first.action).toBe('created');

    const second = ensureConduitDb(tempDir);
    expect(second.action).toBe('exists');
    expect(second.path).toBe(first.path);
  });

  it('should register project_agent_refs and query them back', async () => {
    const { ensureConduitDb, getConduitDbPath } = await import('@cleocode/core/internal');
    ensureConduitDb(tempDir);

    // Insert agent refs directly into conduit.db. The `agents` table lives in
    // global-tier signaldock.db (T346); project-tier only stores soft FKs.
    const { createRequire } = await import('node:module');
    const _require = createRequire(import.meta.url);
    const { DatabaseSync } = _require('node:sqlite') as typeof import('node:sqlite');
    const dbPath = getConduitDbPath(tempDir);
    const db = new DatabaseSync(dbPath);

    try {
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO project_agent_refs (agent_id, attached_at, role, enabled) VALUES (?, ?, ?, 1)',
      ).run('agent-alpha', now, 'worker');
      db.prepare(
        'INSERT INTO project_agent_refs (agent_id, attached_at, role, enabled) VALUES (?, ?, ?, 1)',
      ).run('agent-beta', now, 'worker');

      const refs = db
        .prepare(
          'SELECT agent_id, role FROM project_agent_refs WHERE enabled = 1 ORDER BY agent_id',
        )
        .all() as Array<{ agent_id: string; role: string }>;
      expect(refs).toHaveLength(2);
      expect(refs[0]?.agent_id).toBe('agent-alpha');
      expect(refs[1]?.agent_id).toBe('agent-beta');
    } finally {
      db.close();
    }
  });

  it('should store and retrieve messages through conduit.db', async () => {
    const { ensureConduitDb, getConduitDbPath } = await import('@cleocode/core/internal');
    ensureConduitDb(tempDir);

    const { createRequire } = await import('node:module');
    const _require = createRequire(import.meta.url);
    const { DatabaseSync } = _require('node:sqlite') as typeof import('node:sqlite');
    const dbPath = getConduitDbPath(tempDir);
    const db = new DatabaseSync(dbPath);

    try {
      const now = Math.floor(Date.now() / 1000);

      // Create conversation. Messaging tables reference agent ids as plain
      // TEXT — they are not FK-bound to a project-tier agents table.
      db.exec(`
        INSERT INTO conversations (id, participants, visibility, message_count, created_at, updated_at)
        VALUES ('conv-1', '["agent-alpha","agent-beta"]', 'private', 0, ${now}, ${now});
      `);

      // Agent Alpha sends a message to Agent Beta.
      db.exec(`
        INSERT INTO messages (id, conversation_id, from_agent_id, to_agent_id, content, content_type, status, created_at)
        VALUES ('msg-1', 'conv-1', 'agent-alpha', 'agent-beta', '/action @agent-beta Hello from Alpha!', 'text', 'pending', ${now});
      `);

      const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get('msg-1') as {
        from_agent_id: string;
        to_agent_id: string;
        content: string;
        status: string;
      };
      expect(msg.from_agent_id).toBe('agent-alpha');
      expect(msg.to_agent_id).toBe('agent-beta');
      expect(msg.content).toContain('Hello from Alpha');
      expect(msg.status).toBe('pending');

      // Mark delivered.
      db.exec(`UPDATE messages SET status = 'delivered', delivered_at = ${now} WHERE id = 'msg-1'`);
      const delivered = db.prepare('SELECT status FROM messages WHERE id = ?').get('msg-1') as {
        status: string;
      };
      expect(delivered.status).toBe('delivered');

      // FTS index should pick up the word "Alpha".
      const ftsResults = db
        .prepare("SELECT content FROM messages_fts WHERE messages_fts MATCH 'Alpha'")
        .all() as Array<{ content: string }>;
      expect(ftsResults.length).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });

  it('should handle full lifecycle: create → message → cleanup', async () => {
    const { ensureConduitDb, getConduitDbPath, checkConduitDbHealth } = await import(
      '@cleocode/core/internal'
    );

    // 1. Create DB.
    const { action, path } = ensureConduitDb(tempDir);
    expect(action).toBe('created');
    expect(path).toBe(getConduitDbPath(tempDir));

    // 2. Verify health.
    const health = checkConduitDbHealth(tempDir);
    expect(health.exists).toBe(true);
    expect(health.tableCount).toBeGreaterThanOrEqual(13);

    // 3. Insert conversation + message directly via a fresh handle (the
    //    ensureConduitDb singleton owns the canonical one; a second handle
    //    is fine for write-through tests in a single-process test runner).
    const { createRequire } = await import('node:module');
    const _require = createRequire(import.meta.url);
    const { DatabaseSync } = _require('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(path);
    const now = Math.floor(Date.now() / 1000);

    try {
      db.exec(
        `INSERT INTO conversations (id, participants, visibility, message_count, created_at, updated_at) VALUES ('c1', '["alice","bob"]', 'private', 0, ${now}, ${now})`,
      );
      db.exec(
        `INSERT INTO messages (id, conversation_id, from_agent_id, to_agent_id, content, content_type, status, created_at) VALUES ('m1', 'c1', 'alice', 'bob', 'Hello Bob!', 'text', 'pending', ${now})`,
      );

      // 4. Verify roundtrip.
      const received = db
        .prepare("SELECT * FROM messages WHERE to_agent_id = 'bob'")
        .all() as Array<{ content: string }>;
      expect(received).toHaveLength(1);
      expect(received[0]?.content).toBe('Hello Bob!');

      // 5. Mark delivered.
      db.exec("UPDATE messages SET status = 'delivered' WHERE id = 'm1'");

      // 6. Verify delivery state persisted.
      const delivered = db
        .prepare("SELECT COUNT(*) as c FROM messages WHERE status = 'delivered'")
        .get() as { c: number };
      expect(delivered.c).toBe(1);
    } finally {
      db.close();
    }

    // 7. Cleanup is handled by afterEach (closeConduitDb + rm tempDir).
  });
});
