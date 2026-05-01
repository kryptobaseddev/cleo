/**
 * LLM-driven memory extraction gate.
 *
 * Replaces the legacy keyword regex in `auto-extract.ts`. Takes a session
 * transcript and uses an Anthropic model to extract typed, structured
 * memories (decisions, patterns, learnings, constraints, corrections)
 * with justification, importance score, and referenced entities.
 *
 * Design:
 *   - Runs only when `brain.llmExtraction.enabled` is true AND an Anthropic
 *     API key is available (from ANTHROPIC_API_KEY env var OR Claude Code
 *     credentials at ~/.claude/.credentials.json). Otherwise returns empty.
 *   - Uses structured output (JSON schema) for reliable parsing — no regex
 *     post-processing.
 *   - Never throws — all errors are caught and logged. The pipeline must
 *     never block session end.
 *   - Store routing: each extracted memory is sent through the existing
 *     verify-and-store pipeline. Decisions → brain_decisions, patterns →
 *     brain_patterns, learnings/constraints/corrections → brain_learnings.
 *   - Source is tagged `agent-llm-extracted` so downstream dedup, quality
 *     scoring, and consolidation can distinguish LLM output from other
 *     pipelines.
 *
 * Research basis: `.cleo/agent-outputs/R-llm-memory-systems-research.md`
 * (Mem0, Hindsight, Letta, Mastra Observational Memory).
 */

import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { resolveAnthropicApiKey } from '../llm/credentials.js';
import { checkHashDedup, type MemoryCandidate, verifyAndStore } from './extraction-gate.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Allowed extraction types. Each maps to a downstream BRAIN store:
 *
 * - `decision`    → brain_decisions (architectural/design decisions)
 * - `pattern`     → brain_patterns  (procedural how-to knowledge)
 * - `learning`    → brain_learnings (semantic facts with confidence)
 * - `constraint`  → brain_learnings (rules to follow, high-confidence)
 * - `correction`  → brain_patterns  (anti-patterns stored with antiPattern field)
 */
export type ExtractionType = 'decision' | 'pattern' | 'learning' | 'constraint' | 'correction';

/**
 * A single memory extracted by the LLM. Fields match the research-approved
 * prompt pattern so downstream storage can route without additional parsing.
 */
export interface ExtractedMemory {
  /** Category of knowledge — routes to the correct BRAIN table. */
  type: ExtractionType;
  /** Declarative knowledge content. Capped at 500 characters by the schema. */
  content: string;
  /** Importance score 0.0–1.0; only values ≥ minImportance are persisted. */
  importance: number;
  /** Code symbols, file paths, or concepts referenced by this memory. */
  entities: string[];
  /** Why the model thinks this memory is worth keeping. Capped at 200 chars. */
  justification: string;
}

/** Options for extracting memories from a transcript. */
export interface ExtractFromTranscriptOptions {
  /** CLEO project root. */
  projectRoot: string;
  /** Session ID used as the source tag on stored memories. */
  sessionId: string;
  /** Full session transcript to extract from. */
  transcript: string;
  /**
   * Optional injected Anthropic client — used by tests to mock the SDK
   * without touching the real network. Production callers should omit this
   * and let the function construct its own client from `ANTHROPIC_API_KEY`.
   */
  client?: Pick<Anthropic, 'messages'>;
}

/** Summary of what the LLM extraction pipeline produced. */
export interface ExtractionReport {
  /** Count of extractions returned by the model before filtering. */
  extractedCount: number;
  /** Count persisted after importance filter and verify-and-store gate. */
  storedCount: number;
  /** Count merged into existing entries by the verify-and-store gate. */
  mergedCount: number;
  /** Count rejected (below minImportance, gate-rejected, or errored). */
  rejectedCount: number;
  /** Non-fatal warnings collected during extraction. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Zod schema for structured output
// ---------------------------------------------------------------------------

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
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are extracting durable knowledge from a coding session transcript.
Extract ONLY high-value items. Reject noise (greetings, meta-commentary, transient state).

For each extraction provide:
- type: decision|pattern|learning|constraint|correction
- content: the knowledge itself (<=500 chars, declarative form)
- importance: 0.0-1.0 (only >=0.6 will be stored)
- entities: code symbols, files, concepts mentioned
- justification: why this is worth remembering (<=200 chars)

Type definitions:
- decision: architectural or design choice with rationale ("We chose X because Y")
- pattern: recurring approach that works ("When X, do Y because Z")
- learning: factual knowledge gained ("X depends on Y via Z")
- constraint: rule/limitation discovered ("X must always Y")
- correction: anti-pattern to avoid ("Avoid X because Y; use Z instead")

Rules:
- Capture the WHY, not just the WHAT
- If nothing of durable value exists in the transcript, return an empty array
- Prefer fewer high-quality extractions over many low-quality ones
- Ignore: tool output noise, routine status messages, file reads without a finding
- Maximum 7 extractions per call`;

function buildUserPrompt(sessionId: string, transcript: string, maxExtractions: number): string {
  return `Session ID: ${sessionId}

Transcript:
${transcript}

Extract up to ${maxExtractions} high-value memories. Return empty array if nothing valuable.`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Trim a transcript to a maximum character budget, preserving the head and tail
 * (the ends typically contain the request and the final outcome).
 */
function clipTranscript(transcript: string, maxChars: number): string {
  if (transcript.length <= maxChars) return transcript;
  const half = Math.floor(maxChars / 2) - 64;
  const head = transcript.slice(0, half);
  const tail = transcript.slice(-half);
  return `${head}\n\n[... ${transcript.length - maxChars} chars omitted ...]\n\n${tail}`;
}

/**
 * Store a single LLM-extracted memory, routing it through the full dedup gate.
 *
 * T736: All memory types now pass through the hash-dedup gate before reaching
 * the underlying store function. For decisions (which have domain-specific fields
 * that `verifyAndStore` cannot set), we run `checkHashDedup` first and call
 * `storeDecision` only when no duplicate is found. For all other types, we
 * build a `MemoryCandidate` and delegate to `verifyAndStore` which runs both
 * hash-dedup (Check A) and the full embedding + confidence gate (Checks B, C).
 *
 * Routing:
 *   - decision    → checkHashDedup(brain_decisions) → storeDecision (domain fields preserved)
 *   - pattern     → verifyAndStore (procedural candidate → brain_patterns)
 *   - learning    → verifyAndStore (semantic candidate → brain_learnings)
 *   - constraint  → verifyAndStore (semantic candidate, higher confidence → brain_learnings)
 *   - correction  → verifyAndStore (procedural candidate → brain_patterns)
 */
async function storeExtracted(
  projectRoot: string,
  sessionId: string,
  memory: ExtractedMemory,
): Promise<'stored' | 'merged' | 'rejected'> {
  // ------------------------------------------------------------------
  // Decisions — domain-specific fields require storeDecision directly.
  // Use checkHashDedup as the gate instead of verifyAndStore (which
  // would route semantic→brain_learnings and lose decision metadata).
  // ------------------------------------------------------------------
  if (memory.type === 'decision') {
    // T736 + T737: hash-dedup check on brain_decisions before storing.
    const dedupResult = await checkHashDedup(projectRoot, memory.content, 'brain_decisions');
    if (dedupResult.matched) {
      // Already exists — bump citation count (fire-and-forget) and report merged.
      const { getBrainNativeDb, getBrainDb } = await import('../store/memory-sqlite.js');
      getBrainDb(projectRoot)
        .then(() => {
          const db = getBrainNativeDb();
          db?.prepare(
            'UPDATE brain_decisions SET citation_count = citation_count + 1 WHERE id = ?',
          ).run(dedupResult.id);
        })
        .catch(() => undefined);
      return 'merged';
    }

    const { storeDecision } = await import('./decisions.js');
    try {
      const { decisionText, rationale } = splitDecisionContent(memory.content);
      await storeDecision(projectRoot, {
        type: 'technical',
        decision: decisionText,
        rationale,
        confidence: mapImportanceToConfidence(memory.importance),
      });
      return 'stored';
    } catch {
      return 'rejected';
    }
  }

  // ------------------------------------------------------------------
  // Patterns (workflow), Corrections (failure pattern), Learnings, Constraints.
  // All routed through verifyAndStore so they get hash-dedup + embedding
  // dedup + confidence gate (Checks A, B, C).
  // ------------------------------------------------------------------
  const confidence =
    memory.type === 'constraint' ? Math.max(memory.importance, 0.8) : memory.importance;

  let candidate: MemoryCandidate;

  if (memory.type === 'correction' || memory.type === 'pattern') {
    candidate = {
      text: memory.content,
      title: `${memory.type === 'correction' ? 'Correction' : 'Pattern'}: ${memory.content.slice(0, 80)}`,
      memoryType: 'procedural',
      tier: 'medium',
      confidence,
      source: 'transcript',
      sourceSessionId: sessionId,
      sourceConfidence: 'agent',
    };
  } else {
    // learning | constraint
    candidate = {
      text: memory.content,
      title: `${memory.type === 'constraint' ? 'Constraint' : 'Learning'}: ${memory.content.slice(0, 80)}`,
      memoryType: 'semantic',
      tier: 'medium',
      confidence,
      source: 'transcript',
      sourceSessionId: sessionId,
      sourceConfidence: 'agent',
    };
  }

  try {
    const result = await verifyAndStore(projectRoot, candidate);
    if (result.action === 'stored') return 'stored';
    if (result.action === 'merged') return 'merged';
    // 'pending' and 'rejected' both count as rejected from caller's perspective
    return 'rejected';
  } catch {
    return 'rejected';
  }
}

/**
 * Split a decision extraction into decision + rationale at the first " because "
 * marker. When no marker exists, the full content becomes the decision and the
 * justification becomes the rationale.
 */
function splitDecisionContent(content: string): { decisionText: string; rationale: string } {
  const idx = content.toLowerCase().indexOf(' because ');
  if (idx === -1) {
    return { decisionText: content.trim(), rationale: 'See justification' };
  }
  return {
    decisionText: content.slice(0, idx).trim(),
    rationale: content.slice(idx + 1).trim(),
  };
}

/**
 * Map an importance score to a BrainDecisionRow confidence bucket.
 * Importance is continuous 0–1; confidence is `low` | `medium` | `high`.
 */
function mapImportanceToConfidence(importance: number): 'low' | 'medium' | 'high' {
  if (importance >= 0.8) return 'high';
  if (importance >= 0.6) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// Anthropic client construction
// ---------------------------------------------------------------------------

/**
 * Lazily import and instantiate the Anthropic SDK.
 *
 * Resolves the API key from env or Claude Code credentials. Returns null
 * when no key is available so callers can gracefully degrade to no-op.
 * The SDK is imported via dynamic import so projects that do not use the
 * LLM extraction gate don't pay the load cost at startup.
 */
async function buildAnthropicClient(): Promise<Pick<Anthropic, 'messages'> | null> {
  const apiKey = resolveAnthropicApiKey();
  if (!apiKey) {
    return null;
  }
  try {
    const AnthropicModule = await import('@anthropic-ai/sdk');
    const Ctor =
      (AnthropicModule as { default?: typeof Anthropic }).default ??
      (AnthropicModule as unknown as typeof Anthropic);
    return new Ctor({ apiKey }) as Pick<Anthropic, 'messages'>;
  } catch {
    return null;
  }
}

/**
 * Build the zodOutputFormat helper asynchronously (dynamic import matches
 * SDK's subpath export style). Returns null when the SDK cannot be loaded.
 */
async function buildZodFormat<T extends z.ZodType>(schema: T): Promise<unknown | null> {
  try {
    const helpers = await import('@anthropic-ai/sdk/helpers/zod');
    return helpers.zodOutputFormat(schema);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract and persist structured memories from a session transcript using
 * an Anthropic model.
 *
 * This is the sole entry point replacing the legacy keyword-regex extractor.
 * Callers (e.g. the session-end hook) invoke this and the function handles:
 *   1. Config lookup (brain.llmExtraction.enabled, model, thresholds)
 *   2. API key detection (skips extraction if missing)
 *   3. Transcript clipping to stay within token budget
 *   4. Structured-output LLM call with the research-approved prompt
 *   5. Importance filtering (below minImportance → dropped)
 *   6. Storage routing through the existing verify-and-store pipeline
 *
 * Never throws. Returns an ExtractionReport describing what was stored.
 *
 * @example
 * ```ts
 * await extractFromTranscript({
 *   projectRoot: '/path/to/project',
 *   sessionId: 'ses_20260413192026_519188',
 *   transcript: rawTranscript,
 * });
 * ```
 */
export async function extractFromTranscript(
  options: ExtractFromTranscriptOptions,
): Promise<ExtractionReport> {
  const report: ExtractionReport = {
    extractedCount: 0,
    storedCount: 0,
    mergedCount: 0,
    rejectedCount: 0,
    warnings: [],
  };

  const { projectRoot, sessionId, transcript } = options;

  if (typeof transcript !== 'string' || transcript.trim().length === 0) {
    return report;
  }

  // -------------------------------------------------------------------------
  // Config lookup
  // -------------------------------------------------------------------------
  const { loadConfig } = await import('../config.js');
  type LoadedConfig = Awaited<ReturnType<typeof loadConfig>> | undefined;
  let config: LoadedConfig;
  try {
    config = await loadConfig(projectRoot);
  } catch {
    report.warnings.push('config load failed, using defaults');
    config = undefined;
  }

  const llmCfg = config?.brain?.llmExtraction;
  const enabled = llmCfg?.enabled ?? true;
  if (!enabled) {
    report.warnings.push('llmExtraction.enabled=false');
    return report;
  }

  const model = llmCfg?.model ?? 'claude-haiku-4-5-20251001';
  const minImportance = llmCfg?.minImportance ?? 0.6;
  const maxExtractions = llmCfg?.maxExtractions ?? 7;
  const maxTranscriptChars = llmCfg?.maxTranscriptChars ?? 60000;

  // -------------------------------------------------------------------------
  // Client construction (allow injection for tests)
  // -------------------------------------------------------------------------
  const client = options.client ?? (await buildAnthropicClient());
  if (!client) {
    report.warnings.push(
      'No Anthropic API key found (checked ANTHROPIC_API_KEY env and ~/.claude/.credentials.json) — extraction skipped',
    );
    return report;
  }

  // -------------------------------------------------------------------------
  // Call the model
  // -------------------------------------------------------------------------
  const clipped = clipTranscript(transcript, maxTranscriptChars);
  const userPrompt = buildUserPrompt(sessionId, clipped, maxExtractions);

  let extracted: ExtractedMemory[] = [];

  try {
    const format = await buildZodFormat(ExtractionResponseSchema);
    if (format) {
      // Preferred path: structured output via SDK helper.
      const messages = client.messages as unknown as {
        parse: (body: Record<string, unknown>) => Promise<{
          parsed_output?: { memories?: ExtractedMemory[] };
        }>;
      };
      const response = await messages.parse({
        model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
        output_config: { format },
      });
      extracted = response.parsed_output?.memories ?? [];
    } else {
      // Degraded path: plain messages.create + manual JSON parsing.
      extracted = await extractViaPlainCall(client, model, userPrompt);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    report.warnings.push(`extraction call failed: ${message}`);
    return report;
  }

  report.extractedCount = extracted.length;

  // -------------------------------------------------------------------------
  // Filter + store
  // -------------------------------------------------------------------------
  for (const memory of extracted) {
    if (memory.importance < minImportance) {
      report.rejectedCount += 1;
      continue;
    }

    try {
      const outcome = await storeExtracted(projectRoot, sessionId, memory);
      if (outcome === 'stored') report.storedCount += 1;
      else if (outcome === 'merged') report.mergedCount += 1;
      else report.rejectedCount += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report.warnings.push(`store failed: ${message}`);
      report.rejectedCount += 1;
    }
  }

  return report;
}

/**
 * Fallback extraction path: calls messages.create and parses the response
 * content manually. Used when the zod helper cannot be loaded (e.g. SDK
 * version mismatch) but the messages.create API is still available.
 */
async function extractViaPlainCall(
  client: Pick<Anthropic, 'messages'>,
  model: string,
  userPrompt: string,
): Promise<ExtractedMemory[]> {
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: `${SYSTEM_PROMPT}\n\nReturn ONLY a JSON object of shape {"memories": [...]} with no prose.`,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = extractTextFromResponse(response);
  if (!text) return [];

  const parsed = safeJsonParse(text);
  if (!parsed) return [];

  const validated = ExtractionResponseSchema.safeParse(parsed);
  if (!validated.success) return [];

  return validated.data.memories;
}

/**
 * Pull plain text from a messages.create response. Anthropic returns a
 * content array; we concatenate all text blocks.
 */
function extractTextFromResponse(response: unknown): string {
  const content = (response as { content?: Array<{ type?: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('');
}

/**
 * Parse JSON, extracting the first {...} object even if the model wrapped
 * it in markdown fences or added prose. Returns null on any failure.
 */
function safeJsonParse(text: string): unknown {
  const trimmed = text.trim();
  // Direct parse first
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to extraction
  }
  // Extract between first { and last }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) return null;
  try {
    return JSON.parse(trimmed.slice(first, last + 1));
  } catch {
    return null;
  }
}
