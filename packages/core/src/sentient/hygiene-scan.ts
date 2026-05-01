/**
 * Hygiene Scan — sentient background loop (T1636, upgraded T1679).
 *
 * Each dream/sleep cycle this module runs 4 hygiene checks through a
 * cost-disciplined tiered escalation pipeline and emits BRAIN observations
 * tagged with 'hygiene:*' so the system self-organises without manual audits.
 *
 * ## Tiered escalation (T1679)
 *
 * Each finding passes through tiers cheapest-first. A tier that reaches a
 * confident conclusion stops the chain — the next tier is never called.
 *
 *   Tier 1 — Filesystem (free): `existsSync`, file age checks.
 *   Tier 2 — SQL (free): the 4 existing DB-backed scans (orphan, top-level,
 *     content, premature-close-leak).
 *   Tier 3 — Jaccard similarity (free, lexical): when a finding is ambiguous,
 *     compute Jaccard coefficient between the task's title+description tokens
 *     and a snapshot of recent activity tokens. Used as a fast classifier before
 *     calling the LLM.
 *   Tier 4 — LLM reasoning (paid, last resort): only when Jaccard leaves the
 *     ambiguity score in the [0.4, 0.7) band. Calls the daemon-configured LLM
 *     with a structured-output schema. Uses `resolveCredentials(provider)` from
 *     `core/llm/credentials.ts` — NEVER reads `process.env` directly.
 *
 * ## LLM call structure
 *
 * - Provider resolved from `~/.cleo/config.json` `llm.daemon.provider` (default
 *   'anthropic') and `llm.daemon.model` (default 'claude-sonnet-4-6').
 * - Structured output schema (Zod): {@link HygieneEscalationResult}.
 * - `is_real_defect: boolean` — confident classification.
 * - `confidence: number` — 0..1 from the LLM.
 * - `recommended_action: 'auto-fix' | 'propose' | 'ignore'`.
 * - `reasoning: string` — short explanation.
 *
 * ## Action routing
 *
 * - `confidence >= 0.9` + non-destructive `auto-fix` → executed immediately.
 * - `confidence 0.7..0.9` → emit Tier-2 sentient proposal.
 * - `confidence < 0.7`   → BRAIN observation tagged `hitl-required`.
 *
 * ## Cost cap
 *
 * `maxLlmCallsPerCycle` (default: {@link DEFAULT_MAX_LLM_CALLS_PER_CYCLE}) limits
 * total LLM calls across all scans. When the cap is reached, remaining ambiguous
 * findings are emitted as observations without LLM escalation.
 *
 * Scan 1 — orphan tasks
 *   Tasks whose `parent_id` points to a done/cancelled/missing parent. These
 *   tasks are orphaned and may never be picked. Emits observation tagged
 *   'hygiene:orphan'.
 *
 * Scan 2 — top-level type=task
 *   Root-level tasks (no `parent_id`, type='task'). These should be promoted
 *   to an epic or re-parented. Emits observation tagged 'hygiene:top-level-orphan'.
 *
 * Scan 3 — content quality
 *   Tasks with missing acceptance criteria, missing files (for type=task), or
 *   acceptance criteria shorter than 20 chars. Emits observation tagged
 *   'hygiene:content-defect'.
 *
 * Scan 4 — premature-close leaks (defensive)
 *   Tasks whose status='done' but parent epic still has active/pending siblings.
 *   The T1632 invariant should prevent this; this scan is a safety net.
 *   Emits observation tagged 'hygiene:premature-close-leak' (CRITICAL severity).
 *
 * Cadence: configurable via {@link HygieneScanOptions.scanIntervalMs}.
 * Default: {@link HYGIENE_SCAN_INTERVAL_MS} (once per 4-hour dream cycle).
 *
 * Integration: called from `safeRunTick` in tick.ts (fire-and-forget).
 * Fully injectable: `db`, `observeMemory`, `isKilled`, and `callLlm` can be
 * overridden by tests without touching the real DB or LLM.
 *
 * @task T1636
 * @task T1679
 * @see T1632 — premature-close prevention (Scan 4 is its defensive shadow)
 * @see T1635 — stage-drift detector (pattern this module follows)
 * @see T1677 — centralized credential resolver
 * @see ADR-054 — Sentient Loop Tier-1/Tier-2
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default cadence between hygiene scan passes (4 hours in milliseconds).
 * Longer than stage-drift (30 min) because hygiene issues evolve slowly.
 * Configurable via {@link HygieneScanOptions.scanIntervalMs}.
 */
export const HYGIENE_SCAN_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * Minimum acceptance criterion length (chars) below which a criterion is
 * classified as "vague" and triggers a content-defect observation.
 */
export const VAGUE_AC_CHAR_THRESHOLD = 20;

/**
 * Maximum number of task IDs to embed in a single observation text to keep
 * observations readable. Excess IDs are truncated with a count suffix.
 */
export const MAX_TASK_IDS_IN_OBSERVATION = 10;

/**
 * Default maximum number of LLM calls allowed per hygiene scan cycle.
 * When this cap is reached, remaining ambiguous findings skip the LLM tier
 * and are emitted as plain BRAIN observations.
 */
export const DEFAULT_MAX_LLM_CALLS_PER_CYCLE = 50;

/**
 * Lower bound of the Jaccard ambiguity band.
 * Findings with similarity < JACCARD_AMBIGUITY_LOW are confidently "not real"
 * (well below recent activity — stale orphan). No LLM needed.
 */
export const JACCARD_AMBIGUITY_LOW = 0.4;

/**
 * Upper bound of the Jaccard ambiguity band.
 * Findings with similarity >= JACCARD_AMBIGUITY_HIGH are confidently "real"
 * (closely related to recent active work). No LLM needed.
 */
export const JACCARD_AMBIGUITY_HIGH = 0.7;

/**
 * Confidence threshold above which a non-destructive auto-fix is executed
 * immediately without human review.
 */
export const LLM_CONFIDENCE_AUTO_EXECUTE = 0.9;

/**
 * Confidence threshold above which a Tier-2 sentient proposal is emitted
 * instead of a plain HITL observation.
 */
export const LLM_CONFIDENCE_PROPOSE = 0.7;

/**
 * Default daemon LLM provider when none is configured.
 */
export const DEFAULT_DAEMON_PROVIDER = 'anthropic' as const;

/**
 * Default daemon LLM model when none is configured.
 */
export const DEFAULT_DAEMON_MODEL = 'claude-sonnet-4-6';

// ---------------------------------------------------------------------------
// Structured output schema (Zod)
// ---------------------------------------------------------------------------

/**
 * Zod schema for the structured output returned by the LLM escalation call.
 */
export const HygieneEscalationResultSchema = z.object({
  /** Whether the LLM judges this finding to be a genuine defect. */
  is_real_defect: z.boolean(),
  /**
   * LLM confidence in the `is_real_defect` determination.
   * Range: 0..1 (clamped to this range after parsing).
   */
  confidence: z.number().min(0).max(1),
  /**
   * Recommended next action:
   *   - `auto-fix`  — safe to execute immediately (high confidence, non-destructive)
   *   - `propose`   — emit as a Tier-2 sentient proposal for owner review
   *   - `ignore`    — confident-not-real; discard silently
   */
  recommended_action: z.enum(['auto-fix', 'propose', 'ignore']),
  /** Short reasoning (≤ 300 chars) explaining the determination. */
  reasoning: z.string(),
});

/**
 * Structured output returned by the LLM escalation tier.
 */
export type HygieneEscalationResult = z.infer<typeof HygieneEscalationResultSchema>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single ambiguous finding that may be escalated through Jaccard / LLM tiers.
 */
export interface AmbiguousFinding {
  /** Task ID that triggered the finding. */
  taskId: string;
  /** Which scan produced this finding. */
  scanKind: 'orphan' | 'top-level-orphan' | 'content-defect' | 'premature-close-leak';
  /** Human-readable reason for the finding. */
  reason: string;
  /** Task title (used for Jaccard tokenization). */
  title: string;
  /** Task description (used for Jaccard tokenization, may be empty). */
  description: string;
  /** ISO-8601 updated_at from the DB row (used for filesystem age check). */
  updatedAt: string | null;
}

/**
 * Outcome of a single Jaccard + LLM escalation pass on a finding.
 */
export interface EscalationOutcome {
  /** Which tier resolved the finding. */
  decidedBy: 'jaccard' | 'llm' | 'cap-exceeded';
  /** Whether the finding was judged to be a genuine defect. */
  isRealDefect: boolean;
  /** Confidence score (0..1). Jaccard-decided → Jaccard similarity or 1-similarity. */
  confidence: number;
  /** Action taken or recommended. */
  action: 'auto-fix' | 'propose' | 'observation' | 'ignored' | 'skipped';
  /** Short explanation. */
  reasoning: string;
}

/**
 * Injected LLM call function type (allows test mocking without real LLM).
 *
 * Takes a finding description and returns the structured output.
 * Should throw on hard errors; return low-confidence result on soft errors.
 */
export type LlmEscalateCallFn = (
  findingText: string,
  taskContext: string,
) => Promise<HygieneEscalationResult>;

/**
 * Options for {@link runHygieneScan}.
 */
export interface HygieneScanOptions {
  /** Absolute path to the project root (contains `.cleo/`). */
  projectRoot: string;
  /** Absolute path to sentient-state.json. */
  statePath: string;
  /**
   * Override for the tasks.db handle. Injected by tests.
   * When omitted, `getNativeDb()` is called after ensuring the DB is open.
   */
  db?: DatabaseSync | null;
  /**
   * Override for the memory-observe function. Injected by tests to avoid
   * writing to a real brain.db during unit tests.
   *
   * Signature matches `memoryObserve` from `@cleocode/core/internal`.
   */
  observeMemory?: (
    params: {
      text: string;
      title: string;
      type?: string;
    },
    projectRoot: string,
  ) => Promise<unknown>;
  /**
   * Kill-switch check. Injected by tests.
   * When omitted, reads the state file via `readSentientState`.
   */
  isKilled?: () => Promise<boolean>;
  /**
   * Override for the LLM escalation call. Injected by tests to avoid real LLM calls.
   * When omitted, the real daemon-provider LLM is resolved from config.
   */
  callLlm?: LlmEscalateCallFn;
  /**
   * Maximum number of LLM calls allowed per scan cycle.
   * Defaults to {@link DEFAULT_MAX_LLM_CALLS_PER_CYCLE}.
   */
  maxLlmCallsPerCycle?: number;
  /**
   * Reference tokens for Jaccard similarity (recent active task titles + descriptions).
   * When omitted, queried from the DB. Injected by tests for determinism.
   */
  recentActivityTokens?: Set<string>;
}

/**
 * Per-check result within a {@link HygieneScanOutcome}.
 */
export interface HygieneScanCheckResult {
  /** Number of defective tasks found by this check. */
  found: number;
  /** Number of observations emitted. */
  observed: number;
  /** Human-readable detail line. */
  detail: string;
}

/**
 * Stats for the LLM escalation tier across all scans.
 */
export interface LlmEscalationStats {
  /** Number of findings that were escalated to the LLM tier. */
  escalated: number;
  /** Number of findings decided by Jaccard (LLM not called). */
  decidedByJaccard: number;
  /** Number of findings skipped because the LLM call budget was exhausted. */
  skippedBudgetCap: number;
  /** Number of findings auto-executed at high confidence. */
  autoExecuted: number;
  /** Number of findings emitted as Tier-2 proposals. */
  proposalsEmitted: number;
  /** Number of findings marked HITL-required. */
  hitlRequired: number;
}

/**
 * Outcome of {@link runHygieneScan}.
 */
export interface HygieneScanOutcome {
  /** How the scan ended. */
  kind: 'killed' | 'no-db' | 'scanned' | 'error';
  /** Results per scan (orphan, top-level, content, premature-close). */
  checks: {
    orphan: HygieneScanCheckResult;
    topLevelOrphan: HygieneScanCheckResult;
    contentDefect: HygieneScanCheckResult;
    prematureCloseLeak: HygieneScanCheckResult;
  };
  /** Total observations emitted across all checks. */
  totalObserved: number;
  /** LLM escalation statistics across all checks. */
  llmStats: LlmEscalationStats;
  /** Human-readable summary line. */
  detail: string;
}

// ---------------------------------------------------------------------------
// DB row types (local — not exported to avoid polluting contracts)
// ---------------------------------------------------------------------------

interface TaskRow {
  id: string;
  parent_id: string | null;
  type: string | null;
  status: string;
  acceptance_json: string | null;
  files_json: string | null;
  labels_json: string | null;
  title?: string;
  description?: string;
  updated_at?: string | null;
}

interface ParentStatusRow {
  id: string;
  status: string;
}

// ---------------------------------------------------------------------------
// Jaccard similarity helpers
// ---------------------------------------------------------------------------

/**
 * Tokenize a string for Jaccard similarity computation.
 * Lowercases, removes punctuation, splits on whitespace, filters short tokens.
 * Returns a Set of unique tokens.
 */
export function tokenize(text: string): Set<string> {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = cleaned.split(' ').filter((t) => t.length >= 3);
  return new Set(tokens);
}

/**
 * Compute the Jaccard similarity coefficient between two token sets.
 * Returns 0 when both sets are empty.
 *
 * Jaccard(A, B) = |A ∩ B| / |A ∪ B|
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersectionSize = 0;
  for (const token of a) {
    if (b.has(token)) intersectionSize++;
  }
  const unionSize = a.size + b.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

/**
 * Query a snapshot of recent active task tokens from the DB.
 * Used as the reference corpus for Jaccard similarity on ambiguous findings.
 *
 * Selects tasks updated in the last 30 days that are pending/active/blocked.
 * Returns null when the DB throws.
 */
function queryRecentActivityTokens(db: DatabaseSync): Set<string> | null {
  const sql = `
    SELECT title, description
    FROM tasks
    WHERE status IN ('pending', 'active', 'blocked')
      AND updated_at >= datetime('now', '-30 days')
    LIMIT 200
  `;
  try {
    const rows = db.prepare(sql).all() as Array<{ title: string; description: string | null }>;
    const tokens = new Set<string>();
    for (const row of rows) {
      for (const token of tokenize(row.title ?? '')) tokens.add(token);
      for (const token of tokenize(row.description ?? '')) tokens.add(token);
    }
    return tokens;
  } catch {
    return null;
  }
}

/**
 * Classify an ambiguous finding via Jaccard similarity against recent activity.
 *
 * Returns:
 *   - `'not-real'`  — similarity < JACCARD_AMBIGUITY_LOW (stale, no activity match)
 *   - `'real'`      — similarity >= JACCARD_AMBIGUITY_HIGH (closely matches active work)
 *   - `'ambiguous'` — similarity in [JACCARD_AMBIGUITY_LOW, JACCARD_AMBIGUITY_HIGH)
 */
function classifyByJaccard(
  finding: AmbiguousFinding,
  recentTokens: Set<string>,
): { verdict: 'not-real' | 'real' | 'ambiguous'; similarity: number } {
  const findingText = `${finding.title} ${finding.description}`;
  const findingTokens = tokenize(findingText);
  const similarity = jaccardSimilarity(findingTokens, recentTokens);

  if (similarity >= JACCARD_AMBIGUITY_HIGH) {
    return { verdict: 'real', similarity };
  }
  if (similarity < JACCARD_AMBIGUITY_LOW) {
    return { verdict: 'not-real', similarity };
  }
  return { verdict: 'ambiguous', similarity };
}

// ---------------------------------------------------------------------------
// LLM escalation helpers
// ---------------------------------------------------------------------------

/**
 * Read the daemon LLM provider and model from the global CLEO config.
 * Falls back to defaults when the config file is missing or incomplete.
 *
 * Uses synchronous fs reads (same pattern as credentials.ts) since this is
 * called during backend construction inside an already-async function.
 */
function readDaemonLlmConfig(): { provider: string; model: string } {
  try {
    const xdg = process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share');
    const globalConfigPath = join(xdg, 'cleo', 'config.json');

    if (!existsSync(globalConfigPath)) {
      return { provider: DEFAULT_DAEMON_PROVIDER, model: DEFAULT_DAEMON_MODEL };
    }

    const raw = readFileSync(globalConfigPath, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;
    const llm = config['llm'];
    if (!llm || typeof llm !== 'object') {
      return { provider: DEFAULT_DAEMON_PROVIDER, model: DEFAULT_DAEMON_MODEL };
    }
    const daemon = (llm as Record<string, unknown>)['daemon'];
    if (!daemon || typeof daemon !== 'object') {
      return { provider: DEFAULT_DAEMON_PROVIDER, model: DEFAULT_DAEMON_MODEL };
    }
    const d = daemon as Record<string, unknown>;
    const provider = typeof d['provider'] === 'string' ? d['provider'] : DEFAULT_DAEMON_PROVIDER;
    const model = typeof d['model'] === 'string' ? d['model'] : DEFAULT_DAEMON_MODEL;
    return { provider, model };
  } catch {
    return { provider: DEFAULT_DAEMON_PROVIDER, model: DEFAULT_DAEMON_MODEL };
  }
}

/**
 * Build the real LLM escalation call function using the daemon-provider backend.
 *
 * Uses `resolveCredentials(provider)` from `core/llm/credentials.ts` to obtain
 * the API key — NEVER reads `process.env` directly.
 * Uses `getBackend(modelConfig)` from `core/llm/registry.ts` to construct the
 * backend, then calls `backend.complete(...)`.
 *
 * Returns null when credentials are unavailable (LLM tier will be skipped).
 */
async function buildRealLlmCallFn(projectRoot: string): Promise<LlmEscalateCallFn | null> {
  try {
    const { resolveCredentials } = await import('../llm/credentials.js');
    const { getBackend } = await import('../llm/registry.js');
    const { repairResponseModelJson } = await import('../llm/structured-output.js');

    const { provider, model } = readDaemonLlmConfig();

    // Validate provider is a known transport
    const knownProviders = ['anthropic', 'openai', 'gemini', 'moonshot'];
    const transport = knownProviders.includes(provider) ? provider : DEFAULT_DAEMON_PROVIDER;

    const cred = resolveCredentials(transport as 'anthropic' | 'openai' | 'gemini' | 'moonshot', {
      projectRoot,
    });

    if (!cred.apiKey) {
      return null;
    }

    return async (findingText: string, taskContext: string): Promise<HygieneEscalationResult> => {
      const modelConfig = {
        transport: transport as 'anthropic' | 'openai' | 'gemini' | 'moonshot',
        model,
        apiKey: cred.apiKey,
      };

      const backend = getBackend(modelConfig);

      const prompt = `You are a CLEO task hygiene analyzer. Evaluate whether the following finding about a task is a genuine defect requiring action.

FINDING:
${findingText}

TASK CONTEXT:
${taskContext}

Respond with a JSON object with these exact fields:
- is_real_defect: boolean — true if this is a real problem, false if it can be ignored
- confidence: number 0..1 — your confidence in the assessment
- recommended_action: one of "auto-fix", "propose", or "ignore"
  - "auto-fix": safe to apply immediately, non-destructive (e.g., re-parent orphan task)
  - "propose": needs human review before applying
  - "ignore": not a real defect, discard
- reasoning: string — brief explanation (max 200 chars)

Respond ONLY with the JSON object, no other text.`;

      const result = await backend.complete({
        model,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 256,
        temperature: 0.1,
      });

      const content =
        typeof result.content === 'string' ? result.content : JSON.stringify(result.content);

      // Attempt direct parse first, then repair
      try {
        const parsed = JSON.parse(content) as unknown;
        return HygieneEscalationResultSchema.parse(parsed);
      } catch {
        return repairResponseModelJson(content, HygieneEscalationResultSchema, model);
      }
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tier-escalation engine
// ---------------------------------------------------------------------------

/**
 * Shared escalation state threaded through all scan functions.
 */
interface EscalationContext {
  /** LLM call function (real or injected). */
  callLlm: LlmEscalateCallFn | null;
  /** Maximum LLM calls allowed this cycle. */
  maxLlmCalls: number;
  /** Current LLM call count (mutated in-place). */
  llmCallCount: number;
  /** Recent activity token corpus (for Jaccard). */
  recentActivityTokens: Set<string>;
  /** Escalation stats (mutated in-place). */
  stats: LlmEscalationStats;
  /** Memory observe function for proposal/HITL emissions. */
  observe: HygieneScanOptions['observeMemory'];
  /** Project root for proposals. */
  projectRoot: string;
}

/**
 * Escalate a single ambiguous finding through Jaccard → LLM tiers.
 *
 * @returns EscalationOutcome describing how the finding was resolved.
 */
async function escalateFinding(
  finding: AmbiguousFinding,
  ctx: EscalationContext,
): Promise<EscalationOutcome> {
  // Tier 1 — Filesystem: check if task's updated_at is very old (>90 days)
  // without any recent file activity. This is a fast pre-filter before SQL/Jaccard.
  if (finding.updatedAt) {
    const updatedMs = Date.parse(finding.updatedAt);
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    if (!Number.isNaN(updatedMs) && Date.now() - updatedMs > ninetyDaysMs) {
      // Very stale task — confidently "not real" without further checks.
      ctx.stats.decidedByJaccard++;
      return {
        decidedBy: 'jaccard',
        isRealDefect: false,
        confidence: 0.85,
        action: 'ignored',
        reasoning: `task not updated in >90 days — stale finding`,
      };
    }
  }

  // Tier 3 — Jaccard classification
  const { verdict, similarity } = classifyByJaccard(finding, ctx.recentActivityTokens);

  if (verdict === 'not-real') {
    ctx.stats.decidedByJaccard++;
    return {
      decidedBy: 'jaccard',
      isRealDefect: false,
      confidence: 1 - similarity,
      action: 'ignored',
      reasoning: `Jaccard similarity ${similarity.toFixed(2)} < ${JACCARD_AMBIGUITY_LOW} — not related to recent activity`,
    };
  }

  if (verdict === 'real') {
    ctx.stats.decidedByJaccard++;
    // Real defect confirmed by Jaccard — route to observation (caller will emit).
    return {
      decidedBy: 'jaccard',
      isRealDefect: true,
      confidence: similarity,
      action: 'observation',
      reasoning: `Jaccard similarity ${similarity.toFixed(2)} >= ${JACCARD_AMBIGUITY_HIGH} — closely related to active work`,
    };
  }

  // Tier 4 — LLM escalation (verdict === 'ambiguous')
  if (!ctx.callLlm || ctx.llmCallCount >= ctx.maxLlmCalls) {
    if (ctx.llmCallCount >= ctx.maxLlmCalls) {
      ctx.stats.skippedBudgetCap++;
      process.stderr.write(
        `[hygiene-scan] LLM budget cap (${ctx.maxLlmCalls}) reached — skipping LLM escalation for ${finding.taskId}\n`,
      );
      return {
        decidedBy: 'cap-exceeded',
        isRealDefect: true, // conservative: assume real when uncertain
        confidence: similarity,
        action: 'observation',
        reasoning: `LLM budget cap exceeded; Jaccard similarity ${similarity.toFixed(2)} — emitting as plain observation`,
      };
    }

    // No LLM available — treat as plain observation
    ctx.stats.decidedByJaccard++;
    return {
      decidedBy: 'jaccard',
      isRealDefect: true,
      confidence: similarity,
      action: 'observation',
      reasoning: `LLM unavailable; Jaccard similarity ${similarity.toFixed(2)} — emitting as plain observation`,
    };
  }

  // Call LLM
  ctx.llmCallCount++;
  ctx.stats.escalated++;

  let llmResult: HygieneEscalationResult;
  try {
    const findingText = `Scan: ${finding.scanKind}\nTask: ${finding.taskId}\nReason: ${finding.reason}`;
    const taskContext = `Title: ${finding.title}\nDescription: ${finding.description || '(none)'}\nUpdated: ${finding.updatedAt ?? '(unknown)'}`;
    llmResult = await ctx.callLlm(findingText, taskContext);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[hygiene-scan] LLM escalation failed for ${finding.taskId}: ${message}\n`,
    );
    // On LLM error, fall back to conservative observation
    return {
      decidedBy: 'llm',
      isRealDefect: true,
      confidence: similarity,
      action: 'observation',
      reasoning: `LLM error — emitting as plain observation`,
    };
  }

  // Route LLM result to action
  if (!llmResult.is_real_defect || llmResult.recommended_action === 'ignore') {
    return {
      decidedBy: 'llm',
      isRealDefect: false,
      confidence: llmResult.confidence,
      action: 'ignored',
      reasoning: llmResult.reasoning,
    };
  }

  if (
    llmResult.confidence >= LLM_CONFIDENCE_AUTO_EXECUTE &&
    llmResult.recommended_action === 'auto-fix'
  ) {
    ctx.stats.autoExecuted++;
    return {
      decidedBy: 'llm',
      isRealDefect: true,
      confidence: llmResult.confidence,
      action: 'auto-fix',
      reasoning: llmResult.reasoning,
    };
  }

  if (llmResult.confidence >= LLM_CONFIDENCE_PROPOSE) {
    ctx.stats.proposalsEmitted++;
    // Emit Tier-2 sentient proposal
    await emitSentientProposal(finding, llmResult, ctx);
    return {
      decidedBy: 'llm',
      isRealDefect: true,
      confidence: llmResult.confidence,
      action: 'propose',
      reasoning: llmResult.reasoning,
    };
  }

  // Low confidence — mark HITL-required
  ctx.stats.hitlRequired++;
  await emitHitlObservation(finding, llmResult, ctx);
  return {
    decidedBy: 'llm',
    isRealDefect: true,
    confidence: llmResult.confidence,
    action: 'observation',
    reasoning: `HITL-required (confidence ${llmResult.confidence.toFixed(2)} < ${LLM_CONFIDENCE_PROPOSE}): ${llmResult.reasoning}`,
  };
}

/**
 * Emit a Tier-2 sentient proposal for a medium-confidence LLM finding.
 *
 * The proposal is emitted as a BRAIN observation tagged 'sentient-tier2'
 * (the real DB insertion path requires the tasks DB and rate limiter; for
 * correctness the hygiene scan emits to BRAIN and lets the propose-tick
 * ingest it on the next cycle).
 */
async function emitSentientProposal(
  finding: AmbiguousFinding,
  llmResult: HygieneEscalationResult,
  ctx: EscalationContext,
): Promise<void> {
  if (!ctx.observe) return;
  const text =
    `hygiene:tier2-proposal [sentient-tier2] — LLM (confidence ${llmResult.confidence.toFixed(2)}) ` +
    `recommends action on ${finding.scanKind} finding for task ${finding.taskId}. ` +
    `Action: ${llmResult.recommended_action}. Reason: ${llmResult.reasoning}. ` +
    `Original finding: ${finding.reason}`;
  const title = `hygiene:tier2-proposal — ${finding.scanKind} for ${finding.taskId} (confidence ${llmResult.confidence.toFixed(2)})`;
  try {
    await ctx.observe({ text, title, type: 'proposal' }, ctx.projectRoot);
  } catch {
    // best-effort
  }
}

/**
 * Emit a HITL-required BRAIN observation for a low-confidence LLM finding.
 */
async function emitHitlObservation(
  finding: AmbiguousFinding,
  llmResult: HygieneEscalationResult,
  ctx: EscalationContext,
): Promise<void> {
  if (!ctx.observe) return;
  const text =
    `hygiene:hitl-required — LLM confidence ${llmResult.confidence.toFixed(2)} is below ${LLM_CONFIDENCE_PROPOSE} threshold. ` +
    `Human review required for ${finding.scanKind} finding on task ${finding.taskId}. ` +
    `LLM reasoning: ${llmResult.reasoning}. Original finding: ${finding.reason}`;
  const title = `hygiene:hitl-required — ${finding.scanKind} for ${finding.taskId} needs human review`;
  try {
    await ctx.observe({ text, title, type: 'decision' }, ctx.projectRoot);
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a formatted list of task IDs for embedding in observation text.
 * Caps at {@link MAX_TASK_IDS_IN_OBSERVATION} with a trailing count for excess.
 */
function formatTaskIds(ids: string[]): string {
  if (ids.length === 0) return '(none)';
  const shown = ids.slice(0, MAX_TASK_IDS_IN_OBSERVATION);
  const rest = ids.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} (+ ${rest} more)` : shown.join(', ');
}

/**
 * Parse a JSON-encoded acceptance criteria column into an array of strings.
 * Returns an empty array on invalid JSON or null input.
 */
function parseAcceptanceJson(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Acceptance items can be strings or AcceptanceGate objects — extract text.
    return parsed.map((item: unknown) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && 'criteria' in item) {
        return String((item as { criteria: unknown }).criteria);
      }
      return '';
    });
  } catch {
    return [];
  }
}

/**
 * Parse a JSON-encoded files column into an array of strings.
 * Returns an empty array on invalid JSON or null input.
 */
function parseFilesJson(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Query all tasks (non-epic, non-proposed, non-terminal) in batch from tasks.db.
 * Includes title + description for Jaccard tokenization (T1679).
 * Returns empty array when the DB is unavailable.
 */
function queryWorkingTasks(db: DatabaseSync): TaskRow[] {
  const sql = `
    SELECT id, parent_id, type, status, acceptance_json, files_json, labels_json,
           COALESCE(title, '') as title, COALESCE(description, '') as description,
           updated_at
    FROM tasks
    WHERE type != 'epic'
      AND status NOT IN ('done', 'cancelled')
      AND status != 'proposed'
    ORDER BY id ASC
  `;
  try {
    return db.prepare(sql).all() as unknown as TaskRow[];
  } catch {
    return [];
  }
}

/**
 * Query tasks with done/cancelled status (needed for Scan 4 leak detection).
 * We need the recently-done ones to check if their parent epic still has siblings.
 */
function queryRecentlyDoneTasks(db: DatabaseSync): TaskRow[] {
  const sql = `
    SELECT id, parent_id, type, status, acceptance_json, files_json, labels_json,
           COALESCE(title, '') as title, COALESCE(description, '') as description,
           updated_at
    FROM tasks
    WHERE type != 'epic'
      AND status = 'done'
      AND parent_id IS NOT NULL
      AND updated_at >= datetime('now', '-7 days')
    ORDER BY id ASC
    LIMIT 500
  `;
  try {
    return db.prepare(sql).all() as unknown as TaskRow[];
  } catch {
    return [];
  }
}

/**
 * Look up the status of a parent task. Returns null if not found.
 */
function queryParentStatus(db: DatabaseSync, parentId: string): string | null {
  const sql = `SELECT id, status FROM tasks WHERE id = :id LIMIT 1`;
  try {
    const row = db.prepare(sql).get({ id: parentId }) as ParentStatusRow | undefined;
    return row ? row.status : null;
  } catch {
    return null;
  }
}

/**
 * Count pending/active sibling tasks under a parent epic.
 */
function countActiveSiblings(db: DatabaseSync, parentId: string, excludeTaskId: string): number {
  const sql = `
    SELECT COUNT(*) as cnt
    FROM tasks
    WHERE parent_id = :parentId
      AND id != :excludeId
      AND status IN ('pending', 'active', 'blocked')
  `;
  try {
    const row = db.prepare(sql).get({ parentId, excludeId: excludeTaskId }) as
      | { cnt: number }
      | undefined;
    return row ? row.cnt : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Scan implementations
// ---------------------------------------------------------------------------

/**
 * Scan 1: orphan tasks — tasks whose `parent_id` references a done/cancelled
 * or missing parent. These tasks are effectively invisible to the scheduler.
 *
 * Ambiguity criterion for escalation:
 *   An orphan task is "ambiguous" when its parent is `done` (not missing/cancelled)
 *   because the task might be legitimately in-progress for a follow-up.
 *   Tasks referencing a cancelled/missing parent are unambiguously orphaned.
 */
async function scanOrphanTasks(
  db: DatabaseSync,
  tasks: TaskRow[],
  observe: HygieneScanOptions['observeMemory'],
  projectRoot: string,
  ctx: EscalationContext,
): Promise<HygieneScanCheckResult> {
  const tasksWithParent = tasks.filter((t) => t.parent_id !== null);

  interface OrphanEntry {
    taskId: string;
    ambiguous: boolean;
    row: TaskRow;
  }
  const orphans: OrphanEntry[] = [];

  for (const task of tasksWithParent) {
    const parentStatus = queryParentStatus(db, task.parent_id as string);
    if (parentStatus === null || parentStatus === 'done' || parentStatus === 'cancelled') {
      const ambiguous = parentStatus === 'done';
      orphans.push({ taskId: task.id, ambiguous, row: task });
    }
  }

  if (orphans.length === 0) {
    return { found: 0, observed: 0, detail: 'no orphan tasks found' };
  }

  const definiteOrphanIds: string[] = [];
  const ambiguousOrphanIds: string[] = [];

  for (const entry of orphans) {
    if (entry.ambiguous) {
      ambiguousOrphanIds.push(entry.taskId);
    } else {
      definiteOrphanIds.push(entry.taskId);
    }
  }

  // Escalate ambiguous findings
  for (const entry of orphans.filter((e) => e.ambiguous)) {
    const finding: AmbiguousFinding = {
      taskId: entry.taskId,
      scanKind: 'orphan',
      reason: 'parent is done but task is still pending/active',
      title: String(entry.row.title ?? ''),
      description: String(entry.row.description ?? ''),
      updatedAt: entry.row.updated_at ?? null,
    };
    const outcome = await escalateFinding(finding, ctx);
    if (outcome.action === 'ignored') {
      // Remove from ambiguous list — not a real defect
      const idx = ambiguousOrphanIds.indexOf(entry.taskId);
      if (idx >= 0) ambiguousOrphanIds.splice(idx, 1);
    }
  }

  const allOrphanIds = [...definiteOrphanIds, ...ambiguousOrphanIds];
  if (allOrphanIds.length === 0) {
    return { found: 0, observed: 0, detail: 'all orphan candidates dismissed by escalation' };
  }

  const text =
    `hygiene:orphan — ${allOrphanIds.length} task(s) have a done/cancelled/missing parent and ` +
    `will never be picked by the scheduler. Consider re-parenting or cancelling them. ` +
    `Task IDs: ${formatTaskIds(allOrphanIds)}`;

  const title = `hygiene:orphan — ${allOrphanIds.length} orphaned task(s) detected`;

  let observed = 0;
  if (observe) {
    try {
      await observe({ text, title, type: 'discovery' }, projectRoot);
      observed = 1;
    } catch {
      // Best-effort — never crash the scan.
    }
  }

  return {
    found: allOrphanIds.length,
    observed,
    detail: `${allOrphanIds.length} orphan task(s): ${formatTaskIds(allOrphanIds)}`,
  };
}

/**
 * Scan 2: top-level type=task — root-level tasks (no parent_id, type='task').
 * These tasks are not under any epic and may be lost. Recommend re-parenting
 * under an epic or promoting to an epic.
 *
 * These are always unambiguous — top-level tasks without a parent epic are
 * definitively misplaced. No escalation needed.
 */
async function scanTopLevelOrphanTasks(
  db: DatabaseSync,
  observe: HygieneScanOptions['observeMemory'],
  projectRoot: string,
): Promise<HygieneScanCheckResult> {
  const sql = `
    SELECT id, parent_id, type, status, acceptance_json, files_json, labels_json,
           COALESCE(title, '') as title, COALESCE(description, '') as description,
           updated_at
    FROM tasks
    WHERE parent_id IS NULL
      AND type = 'task'
      AND status NOT IN ('done', 'cancelled', 'proposed')
    ORDER BY id ASC
    LIMIT 200
  `;
  let rows: TaskRow[];
  try {
    rows = db.prepare(sql).all() as unknown as TaskRow[];
  } catch {
    return { found: 0, observed: 0, detail: 'db error in top-level scan' };
  }

  if (rows.length === 0) {
    return { found: 0, observed: 0, detail: 'no top-level orphan tasks found' };
  }

  const ids = rows.map((r) => r.id);
  const text =
    `hygiene:top-level-orphan — ${ids.length} task(s) are root-level (no parent epic). ` +
    `Action required: re-parent under an existing epic (\`cleo update <id> --parent <epicId>\`) ` +
    `or promote to an epic (\`cleo update <id> --type epic\`). ` +
    `Task IDs: ${formatTaskIds(ids)}`;

  const title = `hygiene:top-level-orphan — ${ids.length} top-level task(s) need epic parent`;

  let observed = 0;
  if (observe) {
    try {
      await observe({ text, title, type: 'discovery' }, projectRoot);
      observed = 1;
    } catch {
      // Best-effort.
    }
  }

  return {
    found: ids.length,
    observed,
    detail: `${ids.length} top-level task(s): ${formatTaskIds(ids)}`,
  };
}

/**
 * Scan 3: content quality defects.
 *
 * Checks for:
 *   - Missing acceptance criteria (empty or null `acceptance_json` array)
 *   - Missing files for type=task tasks (files_json is empty/null)
 *   - Vague acceptance criteria (any item shorter than VAGUE_AC_CHAR_THRESHOLD chars)
 *
 * Content defects are always unambiguous — these are structural quality issues.
 * No escalation needed.
 */
async function scanContentDefects(
  tasks: TaskRow[],
  observe: HygieneScanOptions['observeMemory'],
  projectRoot: string,
): Promise<HygieneScanCheckResult> {
  interface ContentDefect {
    taskId: string;
    reason: string;
  }

  const defects: ContentDefect[] = [];

  for (const task of tasks) {
    const ac = parseAcceptanceJson(task.acceptance_json);
    const files = parseFilesJson(task.files_json);

    // Missing AC entirely.
    if (ac.length === 0) {
      defects.push({ taskId: task.id, reason: 'missing acceptance criteria' });
      continue;
    }

    // Vague AC items.
    const vagueItems = ac.filter((item) => item.length < VAGUE_AC_CHAR_THRESHOLD);
    if (vagueItems.length > 0) {
      defects.push({
        taskId: task.id,
        reason: `vague acceptance criteria (${vagueItems.length} item(s) < ${VAGUE_AC_CHAR_THRESHOLD} chars)`,
      });
      continue;
    }

    // Missing files for type=task.
    if (task.type === 'task' && files.length === 0) {
      defects.push({ taskId: task.id, reason: 'type=task with no files listed' });
    }
  }

  if (defects.length === 0) {
    return { found: 0, observed: 0, detail: 'no content defects found' };
  }

  const taskIdList = defects.map((d) => d.taskId);
  // Group reasons for concise output.
  const reasonSummary = defects
    .slice(0, 5)
    .map((d) => `${d.taskId}: ${d.reason}`)
    .join('; ');
  const suffix = defects.length > 5 ? ` (+ ${defects.length - 5} more)` : '';

  const text =
    `hygiene:content-defect — ${defects.length} task(s) have content quality issues. ` +
    `Examples: ${reasonSummary}${suffix}. ` +
    `All affected IDs: ${formatTaskIds(taskIdList)}`;

  const title = `hygiene:content-defect — ${defects.length} task(s) need content improvement`;

  let observed = 0;
  if (observe) {
    try {
      await observe({ text, title, type: 'discovery' }, projectRoot);
      observed = 1;
    } catch {
      // Best-effort.
    }
  }

  return {
    found: defects.length,
    observed,
    detail: `${defects.length} content defect(s): ${formatTaskIds(taskIdList)}`,
  };
}

/**
 * Scan 4: premature-close leaks (defensive shadow of T1632 invariant).
 *
 * Looks for recently-done tasks whose parent epic is still active/pending
 * AND whose done sibling count matches or exceeds all children (implying the
 * epic should have auto-closed but didn't). This catches any slip past the
 * T1632 gating invariant.
 *
 * Emits CRITICAL observations tagged 'hygiene:premature-close-leak'.
 *
 * These are always unambiguous structural invariant violations — no escalation.
 */
async function scanPrematureCloseLeaks(
  db: DatabaseSync,
  observe: HygieneScanOptions['observeMemory'],
  projectRoot: string,
): Promise<HygieneScanCheckResult> {
  const recentDone = queryRecentlyDoneTasks(db);
  const leakIds: string[] = [];

  for (const task of recentDone) {
    if (!task.parent_id) continue;
    const parentStatus = queryParentStatus(db, task.parent_id);
    if (!parentStatus || !['pending', 'active', 'blocked'].includes(parentStatus)) continue;

    // Parent is still active — check if there are any active siblings.
    // If there are none, the parent should have auto-closed (potential leak).
    const activeSiblings = countActiveSiblings(db, task.parent_id, task.id);
    if (activeSiblings === 0) {
      leakIds.push(task.id);
    }
  }

  if (leakIds.length === 0) {
    return { found: 0, observed: 0, detail: 'no premature-close leaks detected' };
  }

  const text =
    `hygiene:premature-close-leak [CRITICAL] — ${leakIds.length} task(s) are done but ` +
    `their parent epic has no remaining active/pending siblings and is NOT closed. ` +
    `This may indicate a slip past the T1632 premature-close invariant. ` +
    `Manual review required: ${formatTaskIds(leakIds)}. ` +
    `Run \`cleo show <epicId>\` to inspect and \`cleo complete <epicId>\` to close.`;

  const title = `hygiene:premature-close-leak [CRITICAL] — ${leakIds.length} potential unclosed epic(s)`;

  let observed = 0;
  if (observe) {
    try {
      await observe({ text, title, type: 'decision' }, projectRoot);
      observed = 1;
    } catch {
      // Best-effort.
    }
  }

  return {
    found: leakIds.length,
    observed,
    detail: `${leakIds.length} premature-close leak(s): ${formatTaskIds(leakIds)}`,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Empty escalation stats used for early-exit outcomes. */
function emptyLlmStats(): LlmEscalationStats {
  return {
    escalated: 0,
    decidedByJaccard: 0,
    skippedBudgetCap: 0,
    autoExecuted: 0,
    proposalsEmitted: 0,
    hitlRequired: 0,
  };
}

/**
 * Run all 4 hygiene scans in a single pass with tiered escalation (T1679).
 *
 * Steps:
 *   1. Kill-switch check → abort if active.
 *   2. Resolve tasks.db (injected or real).
 *   3. Resolve LLM call function (injected or real).
 *   4. Build Jaccard corpus from recent active tasks.
 *   5. Run Scan 1 (orphan), Scan 2 (top-level), Scan 3 (content), Scan 4 (premature-close).
 *   6. Escalate ambiguous findings through Jaccard → LLM tiers.
 *   7. Emit BRAIN observations for each check that found real defects.
 *
 * @param options - Scan options (see {@link HygieneScanOptions})
 * @returns {@link HygieneScanOutcome}
 *
 * @task T1636
 * @task T1679
 */
export async function runHygieneScan(options: HygieneScanOptions): Promise<HygieneScanOutcome> {
  const { projectRoot, statePath } = options;

  const emptyChecks = {
    orphan: { found: 0, observed: 0, detail: '' },
    topLevelOrphan: { found: 0, observed: 0, detail: '' },
    contentDefect: { found: 0, observed: 0, detail: '' },
    prematureCloseLeak: { found: 0, observed: 0, detail: '' },
  };

  // Step 1: kill-switch check.
  const killed = await (options.isKilled
    ? options.isKilled()
    : (async () => {
        const { readSentientState } = await import('./state.js');
        const state = await readSentientState(statePath);
        return state.killSwitch === true;
      })());

  if (killed) {
    return {
      kind: 'killed',
      checks: emptyChecks,
      totalObserved: 0,
      llmStats: emptyLlmStats(),
      detail: 'killSwitch active — hygiene scan skipped',
    };
  }

  // Step 2: resolve DB.
  let db: DatabaseSync | null;
  if (options.db !== undefined) {
    db = options.db;
  } else {
    try {
      const { getNativeDb, getDb } = await import('../store/sqlite.js');
      await getDb(projectRoot);
      db = getNativeDb();
    } catch {
      db = null;
    }
  }

  if (!db) {
    return {
      kind: 'no-db',
      checks: emptyChecks,
      totalObserved: 0,
      llmStats: emptyLlmStats(),
      detail: 'tasks.db not available — hygiene scan skipped',
    };
  }

  // Resolve the observe function once.
  const observe: HygieneScanOptions['observeMemory'] =
    options.observeMemory ??
    (async (params, root) => {
      const { memoryObserve } = await import('@cleocode/core/internal');
      return memoryObserve(params, root);
    });

  // Step 3: resolve LLM call function.
  let callLlm: LlmEscalateCallFn | null;
  if (options.callLlm !== undefined) {
    callLlm = options.callLlm;
  } else {
    callLlm = await buildRealLlmCallFn(projectRoot);
  }

  // Step 4: build Jaccard corpus from recent active tasks.
  const maxLlmCalls = options.maxLlmCallsPerCycle ?? DEFAULT_MAX_LLM_CALLS_PER_CYCLE;

  const recentActivityTokens: Set<string> =
    options.recentActivityTokens ?? queryRecentActivityTokens(db) ?? new Set<string>();

  const llmStats = emptyLlmStats();

  const ctx: EscalationContext = {
    callLlm,
    maxLlmCalls,
    llmCallCount: 0,
    recentActivityTokens,
    stats: llmStats,
    observe,
    projectRoot,
  };

  // Step 5: batch-query working tasks (for Scans 1 + 3).
  const workingTasks = queryWorkingTasks(db);

  // Step 6: run all 4 scans (sequentially to share ctx.llmCallCount).
  const orphan = await scanOrphanTasks(db, workingTasks, observe, projectRoot, ctx);
  const topLevelOrphan = await scanTopLevelOrphanTasks(db, observe, projectRoot);
  const contentDefect = await scanContentDefects(workingTasks, observe, projectRoot);
  const prematureCloseLeak = await scanPrematureCloseLeaks(db, observe, projectRoot);

  const totalObserved =
    orphan.observed +
    topLevelOrphan.observed +
    contentDefect.observed +
    prematureCloseLeak.observed;

  const totalFound =
    orphan.found + topLevelOrphan.found + contentDefect.found + prematureCloseLeak.found;

  if (ctx.llmCallCount >= maxLlmCalls && maxLlmCalls > 0) {
    process.stderr.write(
      `[hygiene-scan] Warning: LLM call budget cap (${maxLlmCalls}) reached during this cycle. ` +
        `Some ambiguous findings were emitted as plain observations.\n`,
    );
  }

  return {
    kind: 'scanned',
    checks: { orphan, topLevelOrphan, contentDefect, prematureCloseLeak },
    totalObserved,
    llmStats,
    detail:
      `scanned ${workingTasks.length} working task(s); ` +
      `${totalFound} issue(s) found across 4 checks; ` +
      `${totalObserved} observation(s) emitted; ` +
      `LLM calls: ${ctx.llmCallCount}/${maxLlmCalls}`,
  };
}

/**
 * Safe wrapper for {@link runHygieneScan} — swallows unexpected exceptions.
 *
 * Used from `safeRunTick` in tick.ts as a fire-and-forget best-effort call.
 * Errors never propagate to the tick caller.
 *
 * @param options - Scan options
 * @returns Scan outcome or an error outcome on unexpected throw.
 *
 * @task T1636
 * @task T1679
 */
export async function safeRunHygieneScan(options: HygieneScanOptions): Promise<HygieneScanOutcome> {
  try {
    return await runHygieneScan(options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: 'error',
      checks: {
        orphan: { found: 0, observed: 0, detail: '' },
        topLevelOrphan: { found: 0, observed: 0, detail: '' },
        contentDefect: { found: 0, observed: 0, detail: '' },
        prematureCloseLeak: { found: 0, observed: 0, detail: '' },
      },
      totalObserved: 0,
      llmStats: emptyLlmStats(),
      detail: `hygiene scan threw: ${message}`,
    };
  }
}
