/**
 * brain_attention schema tests (T11371 · Epic T11288 · Saga T11283).
 *
 * Verifies that a fresh brain.db — created through the real `getBrainDb`
 * migration path (`migrateWithRetry`, no raw `new DatabaseSync`) — provisions
 * the `brain_attention` table with the declared columns and indexes, and that a
 * row whose `tags` column is a JSONB BLOB round-trips ONLY through `json(col)` /
 * `json_each(col)` (never a raw-BLOB `JSON.parse`, which the E4 `jsonb`
 * `fromDriver` rejects).
 *
 * @task T11371
 * @epic T11288
 * @saga T11283
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;
let cleoDir: string;

describe('brain_attention schema (T11371)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-attention-schema-'));
    cleoDir = join(tempDir, '.cleo');
    process.env['CLEO_DIR'] = cleoDir;
  });

  afterEach(async () => {
    const { closeBrainDb } = await import('../memory-sqlite.js');
    closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates the brain_attention table via the real migration path', async () => {
    const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import('../memory-sqlite.js');
    closeBrainDb();
    await getBrainDb();
    const nativeDb = getBrainNativeDb();
    expect(nativeDb).toBeTruthy();

    const tables = nativeDb!
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain('brain_attention');
  });

  it('declares the AC1 columns with the expected types', async () => {
    const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import('../memory-sqlite.js');
    closeBrainDb();
    await getBrainDb();
    const nativeDb = getBrainNativeDb();

    const columns = nativeDb!.prepare('PRAGMA table_info(brain_attention)').all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    const byName = new Map(columns.map((c) => [c.name, c]));

    // AC1: id, content, sessionId, agentId, scopeKind, scopeId, tags,
    // createdAt, expiresAt, decayScore, status.
    for (const col of [
      'id',
      'content',
      'session_id',
      'agent_id',
      'scope_kind',
      'scope_id',
      'tags',
      'created_at',
      'expires_at',
      'decay_score',
      'status',
    ]) {
      expect(byName.has(col)).toBe(true);
    }
    expect(byName.get('id')?.pk).toBe(1);
    expect(byName.get('content')?.notnull).toBe(1);
    expect(byName.get('scope_kind')?.notnull).toBe(1);
    expect(byName.get('scope_id')?.notnull).toBe(1);
    expect(byName.get('status')?.notnull).toBe(1);
    // tags is the JSONB BLOB storage class.
    expect(byName.get('tags')?.type.toUpperCase()).toBe('BLOB');
    expect(byName.get('decay_score')?.type.toUpperCase()).toBe('REAL');
  });

  it('creates the scoped + TTL indexes so scoped/TTL queries are index-served', async () => {
    const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import('../memory-sqlite.js');
    closeBrainDb();
    await getBrainDb();
    const nativeDb = getBrainNativeDb();

    const indexes = nativeDb!
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='brain_attention' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_brain_attention_scope');
    expect(names).toContain('idx_brain_attention_session');
    expect(names).toContain('idx_brain_attention_status_expires');
  });

  it('round-trips a JSONB tags row read back ONLY via json(col) / json_each', async () => {
    const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import('../memory-sqlite.js');
    closeBrainDb();
    await getBrainDb();
    const nativeDb = getBrainNativeDb();

    // Write via the SQL jsonb() constructor — exactly what the jsonb<T>() helper
    // emits in toDriver.
    nativeDb!
      .prepare(
        `INSERT INTO brain_attention
           (id, content, scope_kind, scope_id, tags, status)
         VALUES (?, ?, ?, ?, jsonb(?), 'open')`,
      )
      .run('att_test_1', 'remember the WAL reset', 'task', 'T-A', JSON.stringify(['bug', 'wal']));

    // Whole-value read via json(col) — emits canonical, parseable TEXT.
    const whole = nativeDb!
      .prepare("SELECT json(tags) AS tags FROM brain_attention WHERE id = 'att_test_1'")
      .get() as { tags: string };
    expect(JSON.parse(whole.tags)).toEqual(['bug', 'wal']);

    // In-SQL membership read via json_each — the digest/list filter path.
    const tagRows = nativeDb!
      .prepare(
        `SELECT je.value AS tag
         FROM brain_attention AS a, json_each(a.tags) AS je
         WHERE a.id = 'att_test_1'
         ORDER BY je.value`,
      )
      .all() as Array<{ tag: string }>;
    expect(tagRows.map((r) => r.tag)).toEqual(['bug', 'wal']);
  });

  it('rejects a raw-BLOB whole read of tags through the drizzle jsonb fromDriver', async () => {
    const { getBrainDb, closeBrainDb } = await import('../memory-sqlite.js');
    const brainSchema = await import('../schema/memory-schema.js');
    const { eq } = await import('drizzle-orm');
    closeBrainDb();

    // getBrainDb returns the drizzle instance directly — no private-field reach.
    const db = await getBrainDb();
    await db
      .insert(brainSchema.brainAttention)
      .values({ id: 'att_raw_1', content: 'x', scopeKind: 'global', scopeId: 'global' });

    // A plain `select()` projects the JSONB BLOB raw → fromDriver MUST throw,
    // directing callers to json(col) / json_each (the load-bearing E4 contract).
    await expect(
      db
        .select()
        .from(brainSchema.brainAttention)
        .where(eq(brainSchema.brainAttention.id, 'att_raw_1')),
    ).rejects.toThrow(/jsonb column read as raw BLOB/);
  });
});
