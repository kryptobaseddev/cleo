/**
 * L1 complexity classifier — a prompt-complexity **tier proposer** for the E9
 * LLM chokepoint.
 *
 * ## What this is
 *
 * A faithful TypeScript port of the deleted Rust `cant-router` Layer-1
 * classifier (`crates/cant-router/src/features.rs` + `classifier.rs`, retired
 * in T11807 / D11137). It converts a raw prompt string into five auditable
 * heuristic features, scores them with a fixed linear model, and maps the
 * scalar score to a three-level complexity tier (`low` / `mid` / `high`).
 *
 * The classifier is a **proposer** that COMPLEMENTS — never replaces — the E9
 * resolver {@link resolveLLMForSystem}. The flow is:
 *
 * ```text
 *   classifyComplexity(prompt)  ->  ComplexityTier ('low'|'mid'|'high')
 *   complexityTierToRole(tier)  ->  RoleName       (cheap → capable ladder)
 *   resolveLLMForSystem({ kind:'role', id })  ->  model + credential
 * ```
 *
 * So when a caller has NO explicit tier/role, it can derive one from the
 * prompt's complexity and feed it to the chokepoint.
 *
 * ## What this is NOT (Gate-13 LLM Chokepoint Guard — T11783)
 *
 * - It NEVER constructs a transport or SDK client.
 * - It NEVER reads `*_API_KEY` (no credential I/O at all).
 * - It NEVER hardcodes a model-id literal. The tier→model mapping is the E9
 *   resolver's job; this module stops at proposing a {@link RoleName}.
 *
 * It returns a TIER (and, via the helper, a role). The provider, model, and
 * credential are resolved exclusively by {@link resolveLLMForSystem}.
 *
 * The classifier is a pure, deterministic function with no I/O and no module
 * side effects — safe to import anywhere in the chokepoint.
 *
 * @module llm/complexity-classifier
 * @task T11906
 * @epic T11745
 * @see {@link resolveLLMForSystem} — the E9 chokepoint this proposer feeds.
 */

import type { RoleName } from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The three-level complexity ladder proposed by {@link classifyComplexity}.
 *
 * Ported verbatim from the Rust `Tier` enum (`low` / `mid` / `high`, in
 * lowercase serde rename order). It is distinct from the dispatch
 * `Tier = 0 | 1 | 2` in `@cleocode/contracts`: this ladder describes prompt
 * complexity, not dispatch privilege.
 *
 * - `low`  — fastest, cheapest models. Short, simple prompts.
 * - `mid`  — balanced cost/latency/capability. The default workhorse.
 * - `high` — most capable, most expensive models. Complex reasoning.
 */
export type ComplexityTier = 'low' | 'mid' | 'high';

/**
 * The five heuristic features extracted from a prompt — the inputs to the
 * linear classifier.
 *
 * Each field corresponds to one of the five signals defined in the deleted
 * Rust `PromptFeatures` struct (ULTRAPLAN §11.1). Pure heuristics, no ML
 * runtime — each extractor is a small, auditable signal.
 */
export interface PromptFeatures {
  /** Raw whitespace-delimited token count of the prompt. */
  tokenCount: number;
  /** Syntactic complexity in `[0.0, 1.0]` — proxied by nested bracket depth. */
  syntacticComplexity: number;
  /** Count of reasoning keywords (why / should / compare / decide / …). */
  reasoningDepth: number;
  /** Domain-specificity in `[0.0, 1.0]` — proxied by CamelCase identifier density. */
  domainSpecificity: number;
  /** Number of file references detected in the prompt. */
  touchesFilesCount: number;
}

/**
 * A classification result — the tier recommended for a prompt, plus the raw
 * score and feature vector that produced it.
 *
 * Mirrors the deleted Rust `Classification` struct so downstream consumers can
 * inspect the signals behind the decision.
 */
export interface Classification {
  /** Scalar complexity score in `[0.0, 1.0]` produced by the weighted sum. */
  score: number;
  /** The tier chosen by threshold-mapping `score`. */
  tier: ComplexityTier;
  /** The raw feature vector that produced this classification. */
  features: PromptFeatures;
}

// ---------------------------------------------------------------------------
// Classifier weights + thresholds (ULTRAPLAN §11.1 — ported from classifier.rs)
// ---------------------------------------------------------------------------

/** Weight applied to the normalized `tokenCount` feature. */
export const WEIGHT_TOKEN_COUNT = 0.15;

/** Weight applied to the normalized `syntacticComplexity` feature. */
export const WEIGHT_SYNTACTIC_COMPLEXITY = 0.25;

/** Weight applied to the normalized `reasoningDepth` feature. */
export const WEIGHT_REASONING_DEPTH = 0.3;

/** Weight applied to the normalized `domainSpecificity` feature. */
export const WEIGHT_DOMAIN_SPECIFICITY = 0.2;

/** Weight applied to the normalized `touchesFilesCount` feature. */
export const WEIGHT_TOUCHES_FILES_COUNT = 0.1;

/** Score at or above which the classifier returns the `high` tier. */
export const THRESHOLD_HIGH = 0.75;

/**
 * Score at or above which the classifier returns the `mid` tier.
 *
 * Scores strictly below this threshold are mapped to `low`.
 */
export const THRESHOLD_MID = 0.35;

// ---------------------------------------------------------------------------
// Feature extraction (ported from features.rs — five pure heuristics)
// ---------------------------------------------------------------------------

/**
 * Estimate syntactic complexity by counting nested bracket depth.
 *
 * Walks the string once tracking the running depth of `(`, `{`, `[` (and their
 * matching closers). The maximum depth observed is divided by 5 and clamped to
 * `[0.0, 1.0]`, so a prompt with no brackets scores 0 and one with 5+ nested
 * brackets scores 1.
 *
 * @param s - The raw prompt string.
 * @returns A syntactic-complexity score in `[0.0, 1.0]`.
 */
function estimateSyntacticComplexity(s: string): number {
  let depth = 0;
  let maxDepth = 0;
  for (const c of s) {
    if (c === '(' || c === '{' || c === '[') {
      depth += 1;
      if (depth > maxDepth) maxDepth = depth;
    } else if (c === ')' || c === '}' || c === ']') {
      depth = Math.max(depth - 1, 0);
    }
  }
  return Math.min(maxDepth / 5.0, 1.0);
}

/**
 * Reasoning-signal keywords — terms that correlate with multi-step reasoning.
 *
 * Intentionally short and biased; ported verbatim from the Rust `KEYWORDS`
 * slice in `count_reasoning_keywords`.
 */
const REASONING_KEYWORDS: readonly string[] = [
  'why',
  'should',
  'compare',
  'decide',
  'explain',
  'analyze',
  'evaluate',
  'consider',
  'trade-off',
  'tradeoff',
];

/**
 * Count reasoning-signal keyword occurrences in the prompt (case-insensitive,
 * counting every (possibly overlapping-free) occurrence, matching the Rust
 * `str::matches` semantics).
 *
 * @param s - The raw prompt string.
 * @returns The total number of reasoning-keyword occurrences.
 */
function countReasoningKeywords(s: string): number {
  const lower = s.toLowerCase();
  let total = 0;
  for (const keyword of REASONING_KEYWORDS) {
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(keyword, from);
      if (idx === -1) break;
      total += 1;
      // Rust's `str::matches` advances past each non-overlapping match.
      from = idx + keyword.length;
    }
  }
  return total;
}

/**
 * Count the uppercase characters in a token (used by the CamelCase proxy).
 *
 * @param w - A single whitespace-delimited token.
 * @returns The number of uppercase characters in `w`.
 */
function uppercaseCount(w: string): number {
  let n = 0;
  for (const c of w) {
    // An uppercase letter is one that differs from its lowercase form and equals
    // its own uppercase form (excludes digits/punctuation, mirroring Rust's
    // `char::is_uppercase`).
    if (c !== c.toLowerCase() && c === c.toUpperCase()) n += 1;
  }
  return n;
}

/**
 * Estimate domain specificity via CamelCase identifier density.
 *
 * Counts whitespace-delimited tokens containing at least two uppercase letters
 * (a rough proxy for domain-specific identifiers like `ModelSelection` or
 * `XDGBaseDir`). The count is divided by 10 and clamped to `[0.0, 1.0]`.
 *
 * @param s - The raw prompt string.
 * @returns A domain-specificity score in `[0.0, 1.0]`.
 */
function estimateDomainSpecificity(s: string): number {
  const camelCaseCount = splitWhitespace(s).filter((w) => uppercaseCount(w) >= 2).length;
  return Math.min(camelCaseCount / 10.0, 1.0);
}

/**
 * Count file references in the prompt.
 *
 * A token is a file reference if it contains a `/` or ends in a known
 * source-file extension (`.rs`, `.ts`, `.md`, `.json`). Punctuation on the
 * token is left intact for v1 — callers aware of this limitation can pre-clean
 * their prompts.
 *
 * @param s - The raw prompt string.
 * @returns The number of file-reference tokens.
 */
function countFileReferences(s: string): number {
  return splitWhitespace(s).filter(
    (w) =>
      w.includes('/') ||
      w.endsWith('.rs') ||
      w.endsWith('.ts') ||
      w.endsWith('.md') ||
      w.endsWith('.json'),
  ).length;
}

/**
 * Split a string on Unicode whitespace, dropping empty segments — matching
 * Rust's `str::split_whitespace` (which never yields empty tokens).
 *
 * @param s - The string to split.
 * @returns The non-empty whitespace-delimited tokens of `s`.
 */
function splitWhitespace(s: string): string[] {
  return s.split(/\s+/).filter((w) => w.length > 0);
}

/**
 * Extract a {@link PromptFeatures} vector from a raw prompt string.
 *
 * Pure heuristics, no ML runtime — the Layer-1 input stage. Each field is a
 * small, auditable signal that feeds {@link classify}.
 *
 * @param prompt - The raw prompt string.
 * @returns The five-feature vector for `prompt`.
 *
 * @example
 * ```ts
 * const f = extractFeatures('Refactor auth.ts to use JWT tokens.');
 * f.tokenCount; // > 0
 * ```
 */
export function extractFeatures(prompt: string): PromptFeatures {
  return {
    tokenCount: splitWhitespace(prompt).length,
    syntacticComplexity: estimateSyntacticComplexity(prompt),
    reasoningDepth: countReasoningKeywords(prompt),
    domainSpecificity: estimateDomainSpecificity(prompt),
    touchesFilesCount: countFileReferences(prompt),
  };
}

// ---------------------------------------------------------------------------
// Linear classifier (ported from classifier.rs)
// ---------------------------------------------------------------------------

/** Intermediate structure holding features clamped to `[0.0, 1.0]`. */
interface NormalizedFeatures {
  tokenCount: number;
  syntacticComplexity: number;
  reasoningDepth: number;
  domainSpecificity: number;
  touchesFilesCount: number;
}

/**
 * Clamp a value to `[lo, hi]` — equivalent to Rust's `f64::clamp`. Returns `lo`
 * for `NaN`, matching the saturating intent of the original normalizers.
 */
function clamp(value: number, lo: number, hi: number): number {
  if (Number.isNaN(value)) return lo;
  return Math.min(Math.max(value, lo), hi);
}

/**
 * Normalize each feature to `[0.0, 1.0]` for the weighted sum.
 *
 * These normalization constants are the heuristic v1 defaults tuned against
 * the ULTRAPLAN §11.1 example ranges (not a labeled corpus). Ported verbatim
 * from the Rust `normalize_features`.
 */
function normalizeFeatures(f: PromptFeatures): NormalizedFeatures {
  return {
    tokenCount: Math.min(f.tokenCount / 1000.0, 1.0),
    syntacticComplexity: clamp(f.syntacticComplexity, 0.0, 1.0),
    reasoningDepth: Math.min(f.reasoningDepth / 10.0, 1.0),
    domainSpecificity: clamp(f.domainSpecificity, 0.0, 1.0),
    touchesFilesCount: Math.min(f.touchesFilesCount / 20.0, 1.0),
  };
}

/**
 * Classify a feature vector into a {@link Classification} result.
 *
 * Applies the linear weighted sum from ULTRAPLAN §11.1 and maps the resulting
 * score to a tier via {@link THRESHOLD_HIGH} and {@link THRESHOLD_MID}. The
 * input {@link PromptFeatures} is preserved so downstream consumers can inspect
 * the raw signals that produced the decision.
 *
 * @param features - The five-feature vector to score.
 * @returns The score, tier, and preserved feature vector.
 */
export function classify(features: PromptFeatures): Classification {
  const normalized = normalizeFeatures(features);
  const score =
    WEIGHT_TOKEN_COUNT * normalized.tokenCount +
    WEIGHT_SYNTACTIC_COMPLEXITY * normalized.syntacticComplexity +
    WEIGHT_REASONING_DEPTH * normalized.reasoningDepth +
    WEIGHT_DOMAIN_SPECIFICITY * normalized.domainSpecificity +
    WEIGHT_TOUCHES_FILES_COUNT * normalized.touchesFilesCount;

  const tier: ComplexityTier =
    score >= THRESHOLD_HIGH ? 'high' : score >= THRESHOLD_MID ? 'mid' : 'low';

  return { score, tier, features };
}

// ---------------------------------------------------------------------------
// Public proposer API
// ---------------------------------------------------------------------------

/**
 * Classify a raw prompt into a complexity {@link ComplexityTier}.
 *
 * The one-call entry point: `extractFeatures` → `classify` → tier. This is the
 * **proposer** half of the L1 router — it stops at a tier and never touches a
 * model, transport, or credential (Gate-13 compliant).
 *
 * @param prompt - The raw prompt string to classify.
 * @returns The proposed complexity tier (`low` / `mid` / `high`).
 *
 * @example
 * ```ts
 * classifyComplexity('list files');                       // 'low'
 * classifyComplexity('Why should we compare these and decide the trade-off?'); // 'mid'+
 * ```
 */
export function classifyComplexity(prompt: string): ComplexityTier {
  return classify(extractFeatures(prompt)).tier;
}

/**
 * The next tier up for escalation — ported from the Rust `Tier::escalate`.
 *
 * Returns `null` when already at `high`, signalling the caller that no further
 * escalation is possible.
 *
 * @param tier - The current complexity tier.
 * @returns The next tier up, or `null` at the top of the ladder.
 */
export function escalateTier(tier: ComplexityTier): ComplexityTier | null {
  switch (tier) {
    case 'low':
      return 'mid';
    case 'mid':
      return 'high';
    case 'high':
      return null;
  }
}

/**
 * Map a complexity {@link ComplexityTier} to the {@link RoleName} that
 * {@link resolveLLMForSystem} should resolve when no explicit tier/role was
 * given.
 *
 * This is the wiring contract (AC2) that lets a tier flow into the E9
 * chokepoint: the classifier proposes a tier, this maps it to a role, and
 * `resolveLLMForSystem({ kind: 'role', id })` performs the actual model +
 * credential resolution. The mapping is a cheap → capable ladder over the
 * canonical {@link RoleName} set — it pins NO model literal of its own.
 *
 * - `low`  → `hygiene`      — cheapest single-turn cleanup-class role.
 * - `mid`  → `consolidation` — the default workhorse role.
 * - `high` → `judgement`    — the most-capable reasoning role.
 *
 * @param tier - The proposed complexity tier.
 * @returns The {@link RoleName} to feed into the E9 resolver.
 */
export function complexityTierToRole(tier: ComplexityTier): RoleName {
  switch (tier) {
    case 'low':
      return 'hygiene';
    case 'mid':
      return 'consolidation';
    case 'high':
      return 'judgement';
  }
}

/**
 * Propose the {@link RoleName} for a raw prompt by classifying its complexity
 * and mapping the resulting tier to a role.
 *
 * Convenience composition of {@link classifyComplexity} and
 * {@link complexityTierToRole} — the single call a caller uses to derive a role
 * for {@link resolveLLMForSystem} when it has no explicit tier/role.
 *
 * The returned role is intended to be passed as the structured descriptor:
 * `resolveLLMForSystem({ kind: 'role', id: proposeRoleForPrompt(prompt) })`.
 *
 * @param prompt - The raw prompt string.
 * @returns The proposed {@link RoleName} for the E9 chokepoint.
 *
 * @example
 * ```ts
 * import { proposeRoleForPrompt } from './complexity-classifier.js';
 * import { resolveLLMForSystem } from './system-resolver.js';
 *
 * const role = proposeRoleForPrompt(userPrompt);
 * const llm = await resolveLLMForSystem({ kind: 'role', id: role }, { projectRoot });
 * ```
 */
export function proposeRoleForPrompt(prompt: string): RoleName {
  return complexityTierToRole(classifyComplexity(prompt));
}
