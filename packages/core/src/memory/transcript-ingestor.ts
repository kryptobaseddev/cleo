/**
 * Transcript Ingestor — full-fidelity Claude session JSONL → brain_transcript_events (T1002).
 *
 * Pipeline:
 *  1. Scan a directory (or accept an explicit list) of Claude session JSONL files.
 *  2. Parse each file: extract every content block (text, tool_use, tool_result,
 *     thinking, system).
 *  3. Run redaction on each block before persist.
 *  4. Write rows to brain_transcript_events via INSERT OR IGNORE (idempotent on
 *     the (session_id, seq) unique index).
 *  5. After ingest, run auto-research mining on the new session IDs.
 *
 * Constraints:
 *  - Does NOT touch brain_observations, brain_learnings, or brain_patterns —
 *    those are T1001 territory.
 *  - Does NOT ingest real transcripts during tests — callers pass synthetic
 *    fixtures or use the ingestEvents() low-level API.
 *
 * @task T1002
 * @epic T1000
 */

import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { getBrainDb, getBrainNativeDb } from '../store/memory-sqlite.js';
import type { AutoResearchResult } from './auto-research.js';
import { mineTranscripts } from './auto-research.js';
import { redactContent } from './redaction.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single parsed block ready for storage. */
export interface TranscriptEventBlock {
  sessionId: string;
  seq: number;
  role: string;
  blockType: string;
  content: string;
  tokens?: number;
}

/** Result from ingesting one or more transcript files. */
export interface IngestResult {
  /** Number of new rows written to brain_transcript_events. */
  rowsInserted: number;
  /** Number of rows skipped because they already existed (idempotent re-ingest). */
  rowsSkipped: number;
  /** Session IDs processed in this batch. */
  sessionIds: string[];
  /** Auto-research findings from the ingested sessions. */
  autoResearch: AutoResearchResult;
  /** Any non-fatal warnings (e.g. malformed JSONL lines). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// JSONL parsing
// ---------------------------------------------------------------------------

/**
 * Parse a Claude JSONL transcript string into transcript event blocks.
 *
 * Handles all block types: text, tool_use, tool_result, thinking, system.
 * Skips file-history-snapshot and other non-message entry types.
 *
 * @param raw       - Raw JSONL string content.
 * @param sessionId - Session ID to tag the blocks with.
 * @returns Ordered array of TranscriptEventBlock (seq 0-based).
 */
export function parseJsonlBlocks(raw: string, sessionId: string): TranscriptEventBlock[] {
  const lines = raw.split('\n').filter((l) => l.trim());
  const blocks: TranscriptEventBlock[] = [];
  let seq = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;

      // Skip non-message entries
      if (entry['type'] === 'file-history-snapshot') continue;

      const entryType = entry['type'] as string | undefined;
      if (!entryType) continue;

      // Handle system entries
      if (entryType === 'system') {
        const systemContent = entry['content'] as string | undefined;
        if (systemContent) {
          blocks.push({
            sessionId,
            seq: seq++,
            role: 'system',
            blockType: 'system',
            content: systemContent,
          });
        }
        continue;
      }

      if (entryType !== 'user' && entryType !== 'assistant') continue;

      const message = entry['message'] as Record<string, unknown> | undefined;
      if (!message) continue;

      const role = (message['role'] as string | undefined) ?? entryType;
      const content = message['content'];

      if (typeof content === 'string') {
        // Plain string content
        if (content.trim()) {
          blocks.push({ sessionId, seq: seq++, role, blockType: 'text', content: content.trim() });
        }
      } else if (Array.isArray(content)) {
        // Block array — keep every block type
        for (const rawBlock of content) {
          if (typeof rawBlock === 'string') {
            if (rawBlock.trim()) {
              blocks.push({
                sessionId,
                seq: seq++,
                role,
                blockType: 'text',
                content: rawBlock.trim(),
              });
            }
            continue;
          }
          if (typeof rawBlock !== 'object' || rawBlock === null) continue;

          const block = rawBlock as Record<string, unknown>;
          const bType = (block['type'] as string | undefined) ?? 'unknown';

          let serialised = '';
          if (bType === 'text') {
            serialised = (block['text'] as string | undefined) ?? '';
          } else if (bType === 'tool_use') {
            serialised = JSON.stringify({
              id: block['id'],
              name: block['name'],
              input: block['input'],
            });
          } else if (bType === 'tool_result') {
            serialised = JSON.stringify({
              tool_use_id: block['tool_use_id'],
              content: block['content'],
              is_error: block['is_error'],
            });
          } else if (bType === 'thinking') {
            serialised = JSON.stringify({
              thinking: block['thinking'],
            });
          } else {
            // Unknown block type — serialise the whole block
            serialised = JSON.stringify(block);
          }

          if (serialised.trim()) {
            blocks.push({
              sessionId,
              seq: seq++,
              role,
              blockType: bType,
              content: serialised.trim(),
            });
          }
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Derive session ID from filename
// ---------------------------------------------------------------------------

/**
 * Derive a session ID from a JSONL filename.
 *
 * Tries to extract a `ses_YYYYMMDD_xxxxx` style ID from the filename.
 * Falls back to the basename without extension.
 *
 * @param filePath - Absolute or relative path to the JSONL file.
 * @returns Session ID string.
 */
export function deriveSessionId(filePath: string): string {
  const base = basename(filePath, '.jsonl');
  // Match ses_YYYYMMDDHHMMSS_xxxxx or ses_YYYYMMDD_xxxxx patterns
  const match = base.match(/(ses_[A-Za-z0-9_-]+)/);
  return match ? match[1]! : base;
}

// ---------------------------------------------------------------------------
// Core ingest API
// ---------------------------------------------------------------------------

/**
 * Ingest a list of pre-parsed TranscriptEventBlock rows into brain_transcript_events.
 *
 * Uses INSERT OR IGNORE for idempotency — re-ingesting the same (session_id, seq)
 * pair is a safe no-op.
 *
 * Callers that want full-pipeline ingest (parse + store + auto-research) should
 * use ingestTranscriptFiles() instead.
 *
 * @param blocks - Pre-parsed blocks (from parseJsonlBlocks).
 * @param cwd    - Optional project root for getBrainDb path resolution.
 * @returns Number of rows actually inserted (skipped rows are excluded).
 */
export async function ingestEvents(
  blocks: TranscriptEventBlock[],
  cwd?: string,
): Promise<{ inserted: number; skipped: number }> {
  // Ensure DB is initialised (creates tables if first run)
  await getBrainDb(cwd);
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) throw new Error('brain.db not initialised');

  const stmt = nativeDb.prepare(
    `INSERT OR IGNORE INTO brain_transcript_events
       (id, session_id, seq, role, block_type, content, tokens, redacted_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  );

  let inserted = 0;
  let skipped = 0;

  for (const block of blocks) {
    // Apply redaction before persist
    const { content: redactedContent, redacted } = redactContent(block.content);
    const redactedAt = redacted ? new Date().toISOString() : null;
    const id = randomUUID();

    const result = stmt.run(
      id,
      block.sessionId,
      block.seq,
      block.role,
      block.blockType,
      redactedContent,
      block.tokens ?? null,
      redactedAt,
    ) as { changes: number };

    if (result.changes > 0) {
      inserted++;
    } else {
      skipped++;
    }
  }

  return { inserted, skipped };
}

// ---------------------------------------------------------------------------
// File-level ingest
// ---------------------------------------------------------------------------

/**
 * Ingest one or more Claude session JSONL files into brain_transcript_events.
 *
 * For each file:
 *  1. Reads + parses the JSONL into blocks.
 *  2. Writes blocks to brain_transcript_events (idempotent INSERT OR IGNORE).
 *  3. After all files, runs auto-research mining on the new session IDs.
 *
 * @param filePaths - Absolute paths to JSONL files to ingest.
 * @param cwd       - Optional project root for brain.db path resolution.
 * @returns IngestResult summary.
 */
export async function ingestTranscriptFiles(
  filePaths: string[],
  cwd?: string,
): Promise<IngestResult> {
  const warnings: string[] = [];
  const sessionIds: string[] = [];
  let rowsInserted = 0;
  let rowsSkipped = 0;

  for (const filePath of filePaths) {
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf-8');
    } catch (err) {
      warnings.push(
        `Failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    const sessionId = deriveSessionId(filePath);
    const blocks = parseJsonlBlocks(raw, sessionId);

    if (blocks.length === 0) {
      warnings.push(`No blocks found in ${filePath}`);
      continue;
    }

    try {
      const { inserted, skipped } = await ingestEvents(blocks, cwd);
      rowsInserted += inserted;
      rowsSkipped += skipped;
      if (!sessionIds.includes(sessionId)) {
        sessionIds.push(sessionId);
      }
    } catch (err) {
      warnings.push(
        `Ingest failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Auto-research mining on newly-ingested sessions
  let autoResearch: AutoResearchResult = {
    thrashPatterns: [],
    promotionCandidates: [],
    analyzedEventCount: 0,
  };

  if (sessionIds.length > 0) {
    try {
      const nativeDb = getBrainNativeDb();
      if (nativeDb) {
        autoResearch = mineTranscripts(nativeDb, sessionIds);
      }
    } catch (err) {
      warnings.push(
        `Auto-research mining failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { rowsInserted, rowsSkipped, sessionIds, autoResearch, warnings };
}

/**
 * Scan a directory for Claude session JSONL files and ingest them all.
 *
 * @param dir - Directory to scan for *.jsonl files.
 * @param cwd - Optional project root for brain.db path resolution.
 * @returns IngestResult summary.
 */
export async function ingestTranscriptDirectory(dir: string, cwd?: string): Promise<IngestResult> {
  let entries: string[] = [];
  try {
    const names = await readdir(dir);
    entries = names.filter((n) => n.endsWith('.jsonl')).map((n) => join(dir, n));
  } catch (err) {
    return {
      rowsInserted: 0,
      rowsSkipped: 0,
      sessionIds: [],
      autoResearch: { thrashPatterns: [], promotionCandidates: [], analyzedEventCount: 0 },
      warnings: [
        `Failed to read directory ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  return ingestTranscriptFiles(entries, cwd);
}
