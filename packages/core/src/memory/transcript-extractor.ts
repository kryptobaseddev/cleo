/**
 * TranscriptExtractor — reads a Claude session JSONL file and extracts
 * durable memories using the warm-to-cold LLM backend resolver.
 *
 * Pipeline:
 *   1. Read + decode JSONL session file → raw conversation text
 *   2. Resolve best available LLM backend (warm: Ollama → transformers.js → Sonnet)
 *   3. `generateObject()` with Vercel AI SDK → typed `ExtractedMemory[]`
 *   4. Store each memory via existing CLEO brain APIs (routing through verifyAndStore gate)
 *   5. Write tombstone observation (`transcript-extracted`) to brain_observations
 *   6. Delete source JSONL after successful extraction (unless dry-run)
 *
 * Acceptance criteria (T730):
 *   - Reads a session JSONL and emits ExtractedMemory[] using existing llm-extraction.ts pipeline
 *   - Extracted memories tagged with source_session_id + type transcript-warm-extract
 *   - After success: JSONL deleted + brain_observations tombstone written
 *   - Supports dry-run mode
 *
 * @task T730
 * @epic T726
 */

import { readFile, stat, unlink } from 'node:fs/promises';
import { basename } from 'node:path';
import { generateObject } from 'ai';
import { z } from 'zod';
import { resolveLlmBackend } from './llm-backend-resolver.js';

/** Transformers.js fallback model (must match llm-backend-resolver.ts). */
const TRANSFORMERS_FALLBACK_MODEL = 'onnx-community/Qwen2.5-0.5B-Instruct' as const;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Zod schema matching the upstream ExtractedMemory type from llm-extraction.ts. */
const ExtractedMemorySchema = z.object({
  type: z.enum(['decision', 'pattern', 'learning', 'constraint', 'correction']),
  content: z.string().min(1).max(500),
  importance: z.number().min(0).max(1),
  entities: z.array(z.string()).max(20),
  justification: z.string().min(1).max(200),
});

const ExtractionResponseSchema = z.object({
  memories: z.array(ExtractedMemorySchema).max(20),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for extracting memories from a JSONL transcript file. */
export interface ExtractTranscriptOptions {
  /** Absolute path to the session JSONL file. */
  transcriptPath: string;
  /** CLEO project root for brain.db access. */
  projectRoot: string;
  /**
   * LLM tier to use.
   * `warm` (default): Ollama → transformers.js → Sonnet escalation.
   * `cold`: Claude Sonnet only (requires ANTHROPIC_API_KEY).
   */
  tier?: 'warm' | 'cold';
  /**
   * If true, report what would happen without writing to brain.db or
   * deleting the JSONL file.
   */
  dryRun?: boolean;
  /**
   * CLEO session ID associated with this transcript (used as source tag).
   * If omitted, derived from the JSONL filename.
   */
  sessionId?: string;
}

/** Summary of extraction results for a single JSONL file. */
export interface ExtractionResult {
  /** Path to the JSONL file processed. */
  transcriptPath: string;
  /** CLEO session ID used as source tag. */
  sessionId: string;
  /** Backend that performed the extraction. */
  backend: string;
  /** Number of memories the LLM returned. */
  extractedCount: number;
  /** Number of memories stored to brain.db (0 in dry-run). */
  storedCount: number;
  /** Number of memories rejected (below threshold, dedup, errors). */
  rejectedCount: number;
  /** Whether the JSONL file was deleted post-extraction. */
  deleted: boolean;
  /** Whether this was a dry-run (no writes). */
  dryRun: boolean;
  /** Non-fatal warnings. */
  warnings: string[];
  /** Bytes freed by deleting the JSONL (0 if not deleted or dry-run). */
  bytesFreed: number;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const EXTRACTION_SYSTEM_PROMPT = `You are extracting durable knowledge from a Claude coding session transcript.
Extract ONLY high-value items that a developer would want to remember across sessions.
Reject noise: greetings, meta-commentary, transient state, tool output without findings.

For each extraction provide:
- type: decision|pattern|learning|constraint|correction
- content: the knowledge itself (<=500 chars, declarative form)
- importance: 0.0-1.0 (only >=0.6 will be stored)
- entities: code symbols, files, concepts mentioned
- justification: why worth remembering (<=200 chars)

Type definitions:
- decision: architectural/design choice with rationale ("We chose X because Y")
- pattern: recurring approach that works ("When X, do Y because Z")
- learning: factual knowledge gained ("X depends on Y via Z")
- constraint: rule/limitation discovered ("X must always Y")
- correction: anti-pattern to avoid ("Avoid X; use Z instead")

Return empty array if nothing of durable value exists. Maximum 7 extractions.`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract memories from a single Claude session JSONL file.
 *
 * Reads the file, resolves the best LLM backend, extracts structured
 * memories via `generateObject()`, stores them through existing CLEO brain
 * APIs, writes a tombstone, and deletes the JSONL.
 *
 * Never throws — all errors produce warnings in the result.
 *
 * @param options - Extraction options including file path and tier.
 * @returns Extraction summary.
 *
 * @example
 * ```ts
 * const result = await extractTranscript({
 *   transcriptPath: '/home/user/.claude/projects/myproject/session.jsonl',
 *   projectRoot: '/home/user/projects/myproject',
 *   tier: 'warm',
 * });
 * console.log(`Stored ${result.storedCount} memories`);
 * ```
 */
export async function extractTranscript(
  options: ExtractTranscriptOptions,
): Promise<ExtractionResult> {
  const { transcriptPath, projectRoot, tier = 'warm', dryRun = false } = options;

  // Derive session ID from filename if not provided
  const sessionId = options.sessionId ?? basename(transcriptPath, '.jsonl');

  const result: ExtractionResult = {
    transcriptPath,
    sessionId,
    backend: 'none',
    extractedCount: 0,
    storedCount: 0,
    rejectedCount: 0,
    deleted: false,
    dryRun,
    warnings: [],
    bytesFreed: 0,
  };

  // -------------------------------------------------------------------------
  // Check tombstone — skip if already extracted
  // -------------------------------------------------------------------------
  const alreadyExtracted = await checkTombstone(projectRoot, sessionId);
  if (alreadyExtracted) {
    result.warnings.push('Already extracted (tombstone present) — skipped');
    return result;
  }

  // -------------------------------------------------------------------------
  // Read and parse JSONL
  // -------------------------------------------------------------------------
  let transcriptText: string;
  let fileSize = 0;
  try {
    const fileStat = await stat(transcriptPath);
    fileSize = fileStat.size;
    const raw = await readFile(transcriptPath, 'utf8');
    transcriptText = decodeJsonlTranscript(raw);
  } catch (err) {
    result.warnings.push(
      `Failed to read JSONL: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }

  if (!transcriptText.trim()) {
    result.warnings.push('Transcript is empty after decoding — skipped');
    return result;
  }

  // -------------------------------------------------------------------------
  // Resolve LLM backend
  // -------------------------------------------------------------------------
  const backend = await resolveLlmBackend(tier);
  if (!backend) {
    result.warnings.push(
      'No LLM backend available (no Ollama, no transformers.js, no ANTHROPIC_API_KEY) — skipped',
    );
    return result;
  }
  result.backend = backend.name;

  // -------------------------------------------------------------------------
  // Extract memories via LLM
  // -------------------------------------------------------------------------
  type MemoryItem = {
    type: 'decision' | 'pattern' | 'learning' | 'constraint' | 'correction';
    content: string;
    importance: number;
    entities: string[];
    justification: string;
  };
  let memories: MemoryItem[] = [];

  try {
    const clipped = clipTranscript(transcriptText, 60_000);
    const userPrompt = `Session ID: ${sessionId}\n\nTranscript:\n${clipped}\n\nExtract up to 7 high-value memories. Return empty array if nothing valuable.`;

    if (backend.name === 'transformers') {
      // transformers.js direct path — uses pipeline() without Vercel AI SDK
      memories = await extractWithTransformers(userPrompt, result.warnings);
    } else {
      // Ollama or Anthropic path — uses Vercel AI SDK generateObject()
      const { object } = await generateObject({
        model: backend.model,
        schema: ExtractionResponseSchema,
        system: EXTRACTION_SYSTEM_PROMPT,
        prompt: userPrompt,
      });
      memories = object.memories;
    }

    result.extractedCount = memories.length;
  } catch (err) {
    result.warnings.push(
      `LLM extraction call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }

  // -------------------------------------------------------------------------
  // Store memories (skip in dry-run)
  // -------------------------------------------------------------------------
  if (!dryRun) {
    for (const memory of memories) {
      if (memory.importance < 0.6) {
        result.rejectedCount += 1;
        continue;
      }

      try {
        const outcome = await storeExtractedMemory(projectRoot, sessionId, memory);
        if (outcome === 'stored') {
          result.storedCount += 1;
        } else {
          result.rejectedCount += 1;
        }
      } catch (err) {
        result.warnings.push(`Store failed: ${err instanceof Error ? err.message : String(err)}`);
        result.rejectedCount += 1;
      }
    }

    // ---------------------------------------------------------------------
    // Write tombstone observation
    // ---------------------------------------------------------------------
    try {
      await writeTombstone(projectRoot, sessionId, transcriptPath, {
        extractedCount: result.extractedCount,
        storedCount: result.storedCount,
        backend: backend.name,
        modelId: backend.modelId,
      });
    } catch (err) {
      result.warnings.push(
        `Tombstone write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // ---------------------------------------------------------------------
    // Delete JSONL after successful extraction
    // ---------------------------------------------------------------------
    try {
      await unlink(transcriptPath);
      result.deleted = true;
      result.bytesFreed = fileSize;
    } catch (err) {
      result.warnings.push(
        `JSONL delete failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// JSONL decoding
// ---------------------------------------------------------------------------

/**
 * Decode a Claude session JSONL file into a plain text transcript.
 *
 * Each line is a JSON object. We extract user/assistant message turns,
 * skipping file-history snapshots, tool calls, and other non-content events.
 * The result is a compact text suitable for LLM extraction.
 */
export function decodeJsonlTranscript(raw: string): string {
  const lines = raw.split('\n').filter((l) => l.trim());
  const turns: string[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;

      // Skip non-message entries
      if (entry['type'] === 'file-history-snapshot') continue;
      if (entry['type'] !== 'user' && entry['type'] !== 'assistant') continue;

      const message = entry['message'] as Record<string, unknown> | undefined;
      if (!message) continue;

      const role = (message['role'] as string | undefined) ?? entry['type'];
      const content = message['content'];

      let text = '';
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        // Content blocks array — extract text blocks only
        text = content
          .filter(
            (b): b is { type: string; text?: string } =>
              typeof b === 'object' && b !== null && (b as { type?: unknown })['type'] === 'text',
          )
          .map((b) => b['text'] ?? '')
          .join(' ');
      }

      text = text.trim();
      if (text.length > 0 && text.length < 50_000) {
        turns.push(`[${role}]: ${text}`);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return turns.join('\n\n');
}

// ---------------------------------------------------------------------------
// Memory storage routing (mirrors llm-extraction.ts storeExtracted)
// ---------------------------------------------------------------------------

type StoreOutcome = 'stored' | 'rejected';

/**
 * Store a single extracted memory via the appropriate CLEO brain API.
 *
 * Routing matches the existing llm-extraction.ts storeExtracted logic:
 * - decision   → storeDecision
 * - correction → storePattern (with antiPattern field)
 * - pattern    → storePattern
 * - learning / constraint → storeLearning
 */
async function storeExtractedMemory(
  projectRoot: string,
  sessionId: string,
  memory: {
    type: 'decision' | 'pattern' | 'learning' | 'constraint' | 'correction';
    content: string;
    importance: number;
    entities: string[];
    justification: string;
  },
): Promise<StoreOutcome> {
  const source = `transcript-warm-extract:${sessionId}`;

  if (memory.type === 'decision') {
    const { storeDecision } = await import('./decisions.js');
    try {
      const { decisionText, rationale } = splitDecision(memory.content, memory.justification);
      await storeDecision(projectRoot, {
        type: 'technical',
        decision: decisionText,
        rationale,
        confidence: importanceToConfidence(memory.importance),
      });
      return 'stored';
    } catch {
      return 'rejected';
    }
  }

  if (memory.type === 'correction') {
    const { storePattern } = await import('./patterns.js');
    try {
      await storePattern(projectRoot, {
        type: 'failure',
        pattern: memory.content,
        context: `From transcript ${sessionId}. ${memory.justification}`,
        antiPattern: memory.content,
        mitigation: memory.justification,
        impact: importanceToImpact(memory.importance),
        source,
      });
      return 'stored';
    } catch {
      return 'rejected';
    }
  }

  if (memory.type === 'pattern') {
    const { storePattern } = await import('./patterns.js');
    try {
      await storePattern(projectRoot, {
        type: 'workflow',
        pattern: memory.content,
        context: `From transcript ${sessionId}. ${memory.justification}`,
        impact: importanceToImpact(memory.importance),
        source,
      });
      return 'stored';
    } catch {
      return 'rejected';
    }
  }

  // learning + constraint → storeLearning
  const { storeLearning } = await import('./learnings.js');
  try {
    await storeLearning(projectRoot, {
      insight: memory.content,
      source,
      confidence:
        memory.type === 'constraint' ? Math.max(memory.importance, 0.8) : memory.importance,
      actionable: memory.type === 'constraint',
    });
    return 'stored';
  } catch {
    return 'rejected';
  }
}

// ---------------------------------------------------------------------------
// Tombstone helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a `transcript-extracted` tombstone already exists for this
 * session in brain_observations.
 *
 * This is the idempotency gate — prevents double-extraction when the
 * migration command or session.end hook runs multiple times.
 */
async function checkTombstone(projectRoot: string, sessionId: string): Promise<boolean> {
  try {
    const { getBrainNativeDb } = await import('../store/memory-sqlite.js');
    const db = getBrainNativeDb();
    if (!db) {
      // Brain DB not initialised yet — initialise it via getBrainDb first
      const { getBrainDb } = await import('../store/memory-sqlite.js');
      await getBrainDb(projectRoot);
    }
    const nativeDb = getBrainNativeDb();
    if (!nativeDb) return false;

    const existing = nativeDb
      .prepare(
        `SELECT id FROM brain_observations
         WHERE source_session_id = ? AND title LIKE 'transcript-extracted:%'
         LIMIT 1`,
      )
      .all(sessionId) as { id: string }[];

    return existing.length > 0;
  } catch {
    return false;
  }
}

/**
 * Write a `transcript-extracted` tombstone to brain_observations.
 *
 * The tombstone records that this session JSONL has been processed so
 * subsequent runs skip it (idempotency). It also serves as an audit trail.
 */
async function writeTombstone(
  projectRoot: string,
  sessionId: string,
  filePath: string,
  meta: {
    extractedCount: number;
    storedCount: number;
    backend: string;
    modelId: string;
  },
): Promise<void> {
  const { observeBrain } = await import('./brain-retrieval.js');
  await observeBrain(projectRoot, {
    title: `transcript-extracted:${sessionId}`,
    text: `Transcript extraction complete for session ${sessionId}. Extracted ${meta.extractedCount} memories, stored ${meta.storedCount}. Backend: ${meta.backend} (${meta.modelId}). File: ${filePath}`,
    type: 'discovery',
    sourceType: 'agent',
    sourceSessionId: sessionId,
  });
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/**
 * Clip a transcript to a maximum character count preserving head and tail.
 *
 * The ends of a session typically contain the most valuable content — the
 * initial request and the final outcome. Middle sections (iterative tool
 * calls) are compressed.
 */
function clipTranscript(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2) - 128;
  const head = text.slice(0, half);
  const tail = text.slice(-half);
  const omitted = text.length - 2 * half;
  return `${head}\n\n[... ${omitted} chars omitted ...]\n\n${tail}`;
}

/** Split a decision content string into decision text + rationale. */
function splitDecision(
  content: string,
  justification: string,
): { decisionText: string; rationale: string } {
  const idx = content.toLowerCase().indexOf(' because ');
  if (idx === -1) {
    return { decisionText: content.trim(), rationale: justification };
  }
  return {
    decisionText: content.slice(0, idx).trim(),
    rationale: content.slice(idx + 1).trim(),
  };
}

/** Map importance score to confidence bucket. */
function importanceToConfidence(importance: number): 'low' | 'medium' | 'high' {
  if (importance >= 0.8) return 'high';
  if (importance >= 0.6) return 'medium';
  return 'low';
}

/** Map importance score to impact bucket. */
function importanceToImpact(importance: number): 'high' | 'medium' | 'low' {
  if (importance >= 0.8) return 'high';
  if (importance >= 0.6) return 'medium';
  return 'low';
}

/**
 * Resolve the directory containing Claude session JSONLs for a project path.
 *
 * Claude stores sessions at `~/.claude/projects/<encoded-path>/<session-uuid>.jsonl`.
 * The project path is encoded by replacing `/` with `-`.
 *
 * @param projectPath - Absolute project path (e.g. `/mnt/projects/myapp`)
 * @returns Absolute path to the Claude project directory.
 */
export async function resolveClaudeProjectDir(projectPath: string): Promise<string> {
  const { homedir } = await import('node:os');
  const home = homedir();
  const encoded = projectPath.replace(/\//g, '-');
  return `${home}/.claude/projects/${encoded}`;
}

// ---------------------------------------------------------------------------
// Transformers.js direct extraction path
// ---------------------------------------------------------------------------

type MemoryItem = {
  type: 'decision' | 'pattern' | 'learning' | 'constraint' | 'correction';
  content: string;
  importance: number;
  entities: string[];
  justification: string;
};

/**
 * Run memory extraction using @huggingface/transformers text-generation pipeline.
 *
 * This is the fallback path when Ollama is not available. Uses a small ONNX
 * model to generate a JSON response matching the extraction schema.
 *
 * Returns empty array on any error — never throws.
 */
async function extractWithTransformers(
  userPrompt: string,
  warnings: string[],
): Promise<MemoryItem[]> {
  try {
    const { pipeline } = await import('@huggingface/transformers');

    const pipe = await pipeline('text-generation', TRANSFORMERS_FALLBACK_MODEL, {
      dtype: 'q4',
    });

    const systemInstructions = `${EXTRACTION_SYSTEM_PROMPT}\n\nReturn ONLY valid JSON matching: {"memories":[{"type":"...","content":"...","importance":0.0,"entities":[],"justification":"..."}]}`;
    const fullPrompt = `${systemInstructions}\n\n${userPrompt}`;

    const pipeResult = await pipe(fullPrompt, {
      max_new_tokens: 1024,
      return_full_text: false,
    });

    const outputText =
      Array.isArray(pipeResult) && pipeResult.length > 0
        ? String((pipeResult[0] as { generated_text?: unknown }).generated_text ?? '')
        : '';

    if (!outputText.trim()) return [];

    // Parse JSON from response (may be wrapped in markdown fences)
    const firstBrace = outputText.indexOf('{');
    const lastBrace = outputText.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1) return [];

    const jsonStr = outputText.slice(firstBrace, lastBrace + 1);
    const parsed = JSON.parse(jsonStr) as { memories?: unknown[] };

    if (!Array.isArray(parsed.memories)) return [];

    // Validate each memory item
    const validItems: MemoryItem[] = [];
    const validTypes = new Set(['decision', 'pattern', 'learning', 'constraint', 'correction']);

    for (const item of parsed.memories) {
      const m = item as Record<string, unknown>;
      if (
        typeof m['type'] === 'string' &&
        validTypes.has(m['type']) &&
        typeof m['content'] === 'string' &&
        m['content'].length > 0 &&
        typeof m['importance'] === 'number' &&
        m['importance'] >= 0 &&
        m['importance'] <= 1
      ) {
        validItems.push({
          type: m['type'] as MemoryItem['type'],
          content: String(m['content']).slice(0, 500),
          importance: m['importance'],
          entities: Array.isArray(m['entities'])
            ? (m['entities'] as unknown[])
                .filter((e) => typeof e === 'string')
                .map(String)
                .slice(0, 20)
            : [],
          justification: typeof m['justification'] === 'string' ? m['justification'] : '',
        });
      }
    }

    return validItems;
  } catch (err) {
    warnings.push(
      `Transformers.js extraction failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}
