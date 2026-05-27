/**
 * Tests for transcript ingestion pipeline (T1002).
 *
 * Tests:
 *  1. Ingest synthetic JSONL with text, tool_use, tool_result, thinking blocks;
 *     assert all 4 block types are persisted.
 *  2. redaction.ts strips known secret patterns (sk-ant-... keys, ANTHROPIC_API_KEY=..., SSH paths).
 *  3. auto-research.ts thrash detection identifies recurring-failure patterns
 *     when the same error appears in 3+ sessions.
 *  4. transcript-extractor.ts decodeJsonlTranscript no longer drops tool_use/tool_result.
 *  5. brain_transcript_events table exists after runBrainMigrations on a fresh DB.
 *  6. Re-ingesting the same session is idempotent (no duplicate rows).
 *
 * @task T1002
 * @epic T1000
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Claude JSONL string containing the given block types. */
function buildJsonl(
  sessionId: string,
  blocks: Array<{ role: 'user' | 'assistant'; type: string; payload: Record<string, unknown> }>,
): string {
  const lines = blocks.map((b, i) =>
    JSON.stringify({
      type: b.role,
      uuid: `msg-${i}`,
      message: {
        role: b.role,
        content: [{ type: b.type, ...b.payload }],
      },
    }),
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_SESSION_ID = 'ses_20260419_t1002test';

const FIXTURE_JSONL = buildJsonl(FIXTURE_SESSION_ID, [
  { role: 'user', type: 'text', payload: { text: 'Hello from user' } },
  { role: 'assistant', type: 'text', payload: { text: 'Response from assistant' } },
  {
    role: 'assistant',
    type: 'tool_use',
    payload: { id: 'tu_001', name: 'bash', input: { command: 'ls -la' } },
  },
  {
    role: 'user',
    type: 'tool_result',
    payload: { tool_use_id: 'tu_001', content: 'file.ts\nother.ts' },
  },
  {
    role: 'assistant',
    type: 'thinking',
    payload: { thinking: 'I should analyse the file list' },
  },
]);

// ---------------------------------------------------------------------------
// Test 1 — All block types persisted
// ---------------------------------------------------------------------------

describe('transcript-ingestor: block type preservation', () => {
  let tempDir: string;
  let cleoDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-tingest-'));
    cleoDir = join(tempDir, '.cleo');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(cleoDir, { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;
  });

  afterEach(async () => {
    try {
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();
    } catch {
      /* ignore */
    }
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('persists text, tool_use, tool_result, and thinking blocks', async () => {
    const { parseJsonlBlocks, ingestEvents } = await import('../transcript-ingestor.js');
    const { closeBrainDb, getBrainNativeDb, getBrainDb } = await import(
      '../../store/memory-sqlite.js'
    );
    closeBrainDb();

    const blocks = parseJsonlBlocks(FIXTURE_JSONL, FIXTURE_SESSION_ID);
    const blockTypes = blocks.map((b) => b.blockType);

    expect(blockTypes).toContain('text');
    expect(blockTypes).toContain('tool_use');
    expect(blockTypes).toContain('tool_result');
    expect(blockTypes).toContain('thinking');

    // Persist to DB
    const { inserted } = await ingestEvents(blocks, tempDir);
    expect(inserted).toBeGreaterThanOrEqual(4);

    // Verify rows in DB
    await getBrainDb(tempDir);
    const nativeDb = getBrainNativeDb();
    const rows = nativeDb!
      .prepare(`SELECT DISTINCT block_type FROM brain_transcript_events WHERE session_id = ?`)
      .all(FIXTURE_SESSION_ID) as Array<{ block_type: string }>;

    const storedTypes = rows.map((r) => r.block_type);
    expect(storedTypes).toContain('text');
    expect(storedTypes).toContain('tool_use');
    expect(storedTypes).toContain('tool_result');
    expect(storedTypes).toContain('thinking');
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Redaction catches API keys + secret paths
// ---------------------------------------------------------------------------

describe('redaction: secret pattern detection', () => {
  it('strips Anthropic API key (sk-ant-...)', async () => {
    const { redactContent } = await import('../redaction.js');
    const raw = 'The key is sk-ant-api03-AAABBBCCCDDDEEEFFFGGGHHH-xxx and that is it';
    const { content, redacted } = redactContent(raw);
    expect(redacted).toBe(true);
    expect(content).not.toContain('sk-ant-api03');
    expect(content).toContain('[REDACTED]');
  });

  it('strips ANTHROPIC_API_KEY= assignment', async () => {
    const { redactContent } = await import('../redaction.js');
    const raw = 'export ANTHROPIC_API_KEY=sk-ant-api03-XXXYYYZZZ123456789';
    const { content, redacted } = redactContent(raw);
    expect(redacted).toBe(true);
    expect(content).toContain('ANTHROPIC_API_KEY');
    expect(content).toContain('[REDACTED]');
    expect(content).not.toContain('sk-ant');
  });

  it('strips SSH private key file path', async () => {
    const { redactContent } = await import('../redaction.js');
    const raw = 'Loading key from ~/.ssh/id_rsa for authentication';
    const { content, redacted } = redactContent(raw);
    expect(redacted).toBe(true);
    expect(content).toContain('[REDACTED_PATH]');
  });

  it('leaves clean content untouched', async () => {
    const { redactContent } = await import('../redaction.js');
    const raw = 'This is a completely normal message with no secrets.';
    const { content, redacted } = redactContent(raw);
    expect(redacted).toBe(false);
    expect(content).toBe(raw);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — Auto-research thrash detection
// ---------------------------------------------------------------------------

describe('auto-research: thrash detection', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-autorese-'));
    const cleoDir = join(tempDir, '.cleo');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(cleoDir, { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;
  });

  afterEach(async () => {
    try {
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();
    } catch {
      /* ignore */
    }
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('identifies recurring-failure patterns across 3+ sessions', async () => {
    const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import(
      '../../store/memory-sqlite.js'
    );
    const { mineTranscripts } = await import('../auto-research.js');

    closeBrainDb();
    await getBrainDb(tempDir);
    const nativeDb = getBrainNativeDb()!;

    // Seed 3 sessions with the same error message
    const sessions = ['ses_a', 'ses_b', 'ses_c'];
    const insert = nativeDb.prepare(
      `INSERT INTO brain_transcript_events (id, session_id, seq, role, block_type, content)
       VALUES (?, ?, 0, 'assistant', 'text', ?)`,
    );
    for (const s of sessions) {
      insert.run(`id-${s}`, s, 'E_VALIDATION: missing required field at line 42');
    }

    const result = mineTranscripts(nativeDb, sessions);
    expect(result.thrashPatterns.length).toBeGreaterThan(0);
    const topics = result.thrashPatterns.map((p) => p.topic);
    // At least one pattern should mention the E_ prefix
    expect(topics.some((t) => t.includes('E_VALIDATION'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 4 — transcript-extractor.ts decodeJsonlTranscript preserves tool blocks
// ---------------------------------------------------------------------------

describe('transcript-extractor: no longer drops tool_use/tool_result', () => {
  it('includes tool_use and tool_result in decoded text', async () => {
    const { decodeJsonlTranscript } = await import('../transcript-extractor.js');

    const jsonl = buildJsonl('ses_extractor_test', [
      { role: 'user', type: 'text', payload: { text: 'Run a command' } },
      {
        role: 'assistant',
        type: 'tool_use',
        payload: { id: 'tu_x', name: 'bash', input: { command: 'echo hello' } },
      },
      {
        role: 'user',
        type: 'tool_result',
        payload: { tool_use_id: 'tu_x', content: 'hello' },
      },
    ]);

    const decoded = decodeJsonlTranscript(jsonl);
    // Post-fix: tool_use and tool_result must appear in decoded output
    expect(decoded).toContain('tool_use');
    expect(decoded).toContain('tool_result');
  });
});

// ---------------------------------------------------------------------------
// Test 5 — brain_transcript_events table exists after migration
// ---------------------------------------------------------------------------

describe('brain_transcript_events: table migration', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-tmig-'));
    const cleoDir = join(tempDir, '.cleo');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(cleoDir, { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;
  });

  afterEach(async () => {
    try {
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();
    } catch {
      /* ignore */
    }
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('brain_transcript_events table exists on a fresh DB after runBrainMigrations', async () => {
    const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import(
      '../../store/memory-sqlite.js'
    );
    closeBrainDb();
    await getBrainDb(tempDir);
    const nativeDb = getBrainNativeDb()!;

    const row = nativeDb
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='brain_transcript_events'`,
      )
      .get() as { name: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.name).toBe('brain_transcript_events');
  });

  it('has the expected columns (session_id, seq, role, block_type, content, redacted_at)', async () => {
    const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import(
      '../../store/memory-sqlite.js'
    );
    closeBrainDb();
    await getBrainDb(tempDir);
    const nativeDb = getBrainNativeDb()!;

    const cols = nativeDb.prepare(`PRAGMA table_info(brain_transcript_events)`).all() as Array<{
      name: string;
    }>;

    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('session_id');
    expect(colNames).toContain('seq');
    expect(colNames).toContain('role');
    expect(colNames).toContain('block_type');
    expect(colNames).toContain('content');
    expect(colNames).toContain('tokens');
    expect(colNames).toContain('redacted_at');
    expect(colNames).toContain('created_at');
  });
});

// ---------------------------------------------------------------------------
// Test 6 — Re-ingest idempotency
// ---------------------------------------------------------------------------

describe('transcript-ingestor: idempotency on re-ingest', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-tidm-'));
    const cleoDir = join(tempDir, '.cleo');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(cleoDir, { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;
  });

  afterEach(async () => {
    try {
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();
    } catch {
      /* ignore */
    }
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('does not create duplicate rows when the same session is ingested twice', async () => {
    const { parseJsonlBlocks, ingestEvents } = await import('../transcript-ingestor.js');
    const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import(
      '../../store/memory-sqlite.js'
    );
    closeBrainDb();

    const blocks = parseJsonlBlocks(FIXTURE_JSONL, FIXTURE_SESSION_ID);

    // First ingest
    const first = await ingestEvents(blocks, tempDir);
    expect(first.inserted).toBeGreaterThan(0);

    // Second ingest — should be all-skipped
    const second = await ingestEvents(blocks, tempDir);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(first.inserted);

    // Verify row count in DB
    await getBrainDb(tempDir);
    const nativeDb = getBrainNativeDb()!;
    const { count } = nativeDb
      .prepare(`SELECT COUNT(*) as count FROM brain_transcript_events WHERE session_id = ?`)
      .get(FIXTURE_SESSION_ID) as { count: number };

    expect(count).toBe(first.inserted);
  });
});
