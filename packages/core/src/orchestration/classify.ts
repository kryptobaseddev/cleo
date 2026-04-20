/**
 * Task-to-agent classifier — T891.
 *
 * Examines task attributes (labels, type, size, title keywords) and returns a
 * `ClassifyResult` that names the agent id, the intended spawn role, and a
 * confidence score. The resolved agent is fetched from the 4-tier registry
 * (ADR-049) so that `cleo agent attach/detach/remove` directly affect which
 * persona gets spawned.
 *
 * Resolution order:
 *  1. Label-exact match  — task.labels contains a known persona label
 *  2. Keyword match      — task.title / task.description contain trigger words
 *  3. Type/size heuristic — e.g. type=epic → orchestrator, size=small → worker
 *  4. Fallback           — `cleo-subagent` with confidence 0.0 + warning
 *
 * Confidence floor: 0.5 (per T377 memory). Scores below the floor map to the
 * generic `cleo-subagent` fallback and emit a meta warning so callers can
 * surface the degradation in telemetry / spawn manifests.
 *
 * The five default personas are:
 *  - `cleo-prime`    — orchestrator, coordinates multi-agent workflows
 *  - `cleo-dev`      — lead, general-purpose development
 *  - `cleo-rust-lead`— lead, Rust crate work
 *  - `cleo-db-lead`  — lead, database / schema work
 *  - `cleo-historian`— lead, canon / documentation work
 *
 * @module orchestration/classify
 * @task T891 CANT persona wiring
 * @epic T889
 */

import type { Task } from '@cleocode/contracts';

// ============================================================================
// Types
// ============================================================================

/**
 * Minimum confidence required to route to a named persona.
 *
 * Results below this floor are promoted to the generic `cleo-subagent` fallback
 * so that low-confidence routing does not silently pick the wrong specialist.
 */
export const CLASSIFY_CONFIDENCE_FLOOR = 0.5;

/**
 * Generic fallback agent id used when no persona clears the confidence floor.
 *
 * The fallback is still a valid agent — it resolves via the 4-tier registry
 * at the `packaged` or `fallback` tier. It carries no specialist skills, which
 * is intentional: the orchestrator should treat low-confidence routing as a
 * signal to decompose the task further or escalate for human review.
 */
export const CLASSIFY_FALLBACK_AGENT_ID = 'cleo-subagent';

/**
 * Classification result returned by {@link classifyTask}.
 */
export interface ClassifyResult {
  /** Resolved agent id (e.g. `cleo-dev`, `cleo-rust-lead`, `cleo-subagent`). */
  agentId: string;
  /**
   * Intended spawn role. Derived from the agent's default role but clamped to
   * the registry taxonomy so callers can feed it directly into
   * {@link ComposeSpawnPayloadOptions.role}.
   *
   * - `orchestrator` — only `cleo-prime` + explicit orchestrator labels
   * - `lead`         — specialist lead agents (rust-lead, db-lead, historian, dev)
   * - `worker`       — generic subagent or explicitly worker-labelled tasks
   */
  role: 'orchestrator' | 'lead' | 'worker';
  /** Confidence in [0, 1]. Values < {@link CLASSIFY_CONFIDENCE_FLOOR} use fallback. */
  confidence: number;
  /** Human-readable explanation of why this agent was chosen. */
  reason: string;
  /**
   * When `true`, the result was demoted to `cleo-subagent` because no rule
   * cleared the confidence floor. Callers should surface this in telemetry.
   */
  usedFallback: boolean;
  /**
   * Warning message present only when `usedFallback === true`.
   * Callers SHOULD surface this in the spawn manifest / prompt meta.
   */
  warning?: string;
}

// ============================================================================
// Internal persona table
// ============================================================================

/**
 * A single classifier rule that maps task signals to an agent persona.
 *
 * Rules are evaluated in declaration order; the first rule whose `match`
 * predicate returns a positive confidence wins.
 */
interface ClassifierRule {
  /** Agent id this rule resolves to. */
  agentId: string;
  /** Spawn role for this persona. */
  role: 'orchestrator' | 'lead' | 'worker';
  /** Base confidence when the match fires (0.5–1.0). */
  baseConfidence: number;
  /** Keywords matched against `task.labels` (lowercased). */
  labelKeywords?: readonly string[];
  /** Keywords matched against `task.title` (lowercased). */
  titleKeywords?: readonly string[];
  /** Keywords matched against `task.description` (lowercased). */
  descKeywords?: readonly string[];
  /**
   * Optional structural predicate (type, size). Runs after keyword checks.
   * Returns a confidence delta (0 for no match, positive for boost).
   */
  structuralBoost?: (task: Task) => number;
}

/**
 * Ordered list of persona rules.
 *
 * Evaluation stops at the first rule that clears the confidence floor.
 * Rules are ordered from most-specific (label-exact) to least-specific
 * (structural heuristic).
 */
const CLASSIFIER_RULES: readonly ClassifierRule[] = [
  // ── cleo-prime (orchestrator) ────────────────────────────────────────────
  {
    agentId: 'cleo-prime',
    role: 'orchestrator',
    baseConfidence: 0.9,
    labelKeywords: ['orchestrate', 'orchestrator', 'multi-agent', 'cleo-prime'],
    titleKeywords: ['orchestrate', 'orchestration', 'multi-agent', 'cleo-prime'],
    structuralBoost: (task) => (task.type === 'epic' ? 0.1 : 0),
  },

  // ── cleo-rust-lead (Rust specialist) ─────────────────────────────────────
  {
    agentId: 'cleo-rust-lead',
    role: 'lead',
    baseConfidence: 0.85,
    labelKeywords: ['rust', 'crate', 'cleo-rust-lead', 'cant-core', 'cant-napi', 'cant-lsp'],
    titleKeywords: ['rust', 'crate', 'cargo', 'napi', '.rs', 'cant-core', 'cant-lsp'],
    descKeywords: ['rust crate', 'cargo', 'napi-rs'],
  },

  // ── cleo-db-lead (database / schema specialist) ───────────────────────────
  {
    agentId: 'cleo-db-lead',
    role: 'lead',
    baseConfidence: 0.85,
    labelKeywords: ['database', 'schema', 'migration', 'drizzle', 'sqlite', 'db', 'cleo-db-lead'],
    titleKeywords: [
      'schema',
      'migration',
      'drizzle',
      'sqlite',
      'database',
      'db-lead',
      'data model',
    ],
    descKeywords: ['schema', 'migration', 'drizzle', 'sqlite'],
  },

  // ── cleo-historian (canon / docs specialist) ─────────────────────────────
  {
    agentId: 'cleo-historian',
    role: 'lead',
    baseConfidence: 0.8,
    labelKeywords: ['canon', 'docs', 'documentation', 'adr', 'historian', 'spec'],
    titleKeywords: [
      'adr',
      'document',
      'specification',
      'spec',
      'canon',
      'historian',
      'changelog',
      'readme',
    ],
    descKeywords: ['adr', 'document', 'specification', 'canon'],
  },

  // ── cleo-dev (general development) ───────────────────────────────────────
  {
    agentId: 'cleo-dev',
    role: 'lead',
    baseConfidence: 0.7,
    labelKeywords: [
      'dev',
      'development',
      'feature',
      'implementation',
      'bug',
      'fix',
      'refactor',
      'cleo-dev',
    ],
    titleKeywords: ['implement', 'add', 'fix', 'refactor', 'build', 'create', 'update', 'wir'],
    structuralBoost: (task) => {
      if (task.role === 'bug') return 0.15;
      if (task.type === 'task' || task.type === 'subtask') return 0.05;
      return 0;
    },
  },
];

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Compute how many elements from `keywords` appear in `haystack`.
 *
 * @param haystack  - Lowercased string to search.
 * @param keywords  - Keywords to look for.
 * @returns Match count (0 when no overlap).
 */
function countMatches(haystack: string, keywords: readonly string[]): number {
  let count = 0;
  for (const kw of keywords) {
    if (haystack.includes(kw.toLowerCase())) count++;
  }
  return count;
}

/**
 * Compute the raw confidence score for a rule against a task.
 *
 * Scoring strategy:
 *  - Label match:  +0.2 per matched label keyword (capped at 0.3 total)
 *  - Title match:  +0.15 per matched title keyword (capped at 0.25 total)
 *  - Desc match:   +0.1 per matched desc keyword (capped at 0.15 total)
 *  - Structural:   rule.structuralBoost(task)
 *
 * The base confidence is only assigned when at least ONE signal fires.
 *
 * Returns 0 when no signals match so the caller can skip this rule.
 */
function scoreRule(rule: ClassifierRule, task: Task): number {
  const lowerTitle = (task.title ?? '').toLowerCase();
  const lowerDesc = (task.description ?? '').toLowerCase();
  const lowerLabels = (task.labels ?? []).map((l) => l.toLowerCase()).join(' ');

  let labelScore = 0;
  let titleScore = 0;
  let descScore = 0;

  if (rule.labelKeywords?.length) {
    const matches = countMatches(lowerLabels, rule.labelKeywords);
    labelScore = Math.min(matches * 0.2, 0.3);
  }
  if (rule.titleKeywords?.length) {
    const matches = countMatches(lowerTitle, rule.titleKeywords);
    titleScore = Math.min(matches * 0.15, 0.25);
  }
  if (rule.descKeywords?.length) {
    const matches = countMatches(lowerDesc, rule.descKeywords);
    descScore = Math.min(matches * 0.1, 0.15);
  }

  // Keyword signals (labels, title, desc) must fire for the rule to apply.
  // Structural boost is additive — it only adds to a score that already has
  // keyword evidence. It CANNOT trigger routing on its own because type='task'
  // is the default for all tasks and would make cleo-dev match everything.
  const keywordSignalSum = labelScore + titleScore + descScore;
  if (keywordSignalSum === 0) return 0;

  const structBoost = rule.structuralBoost?.(task) ?? 0;
  const signalSum = keywordSignalSum + structBoost;

  // Base confidence applies only when at least one keyword signal is present.
  return Math.min(rule.baseConfidence + signalSum, 1.0);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Classify a task against the known persona table and return the best-matching
 * agent id, role, and confidence score.
 *
 * **Confidence floor**: any result below {@link CLASSIFY_CONFIDENCE_FLOOR}
 * (0.5) is replaced by the generic `cleo-subagent` fallback with
 * `usedFallback: true` so callers can emit a warning.
 *
 * @param task - Full task record (at minimum: id, title, type, labels).
 * @returns Classification result with agentId, role, confidence, and reason.
 *
 * @example
 * ```typescript
 * const result = classifyTask(task);
 * if (result.usedFallback) {
 *   console.warn(`[classify] ${result.warning}`);
 * }
 * // Pass result directly into composeSpawnPayload options:
 * const payload = await composeSpawnPayload(db, task, {
 *   agentId: result.agentId,
 *   role: result.role,
 * });
 * ```
 *
 * @task T891
 */
export function classifyTask(task: Task): ClassifyResult {
  let bestScore = 0;
  let bestRule: ClassifierRule | null = null;

  for (const rule of CLASSIFIER_RULES) {
    const score = scoreRule(rule, task);
    if (score > bestScore) {
      bestScore = score;
      bestRule = rule;
    }
  }

  // Below-floor: demote to generic fallback.
  if (bestScore < CLASSIFY_CONFIDENCE_FLOOR || bestRule === null) {
    return {
      agentId: CLASSIFY_FALLBACK_AGENT_ID,
      role: 'worker',
      confidence: bestScore,
      reason: 'No persona cleared the confidence floor; using generic cleo-subagent.',
      usedFallback: true,
      warning:
        `classifyTask(${task.id}): confidence ${bestScore.toFixed(2)} < floor ${CLASSIFY_CONFIDENCE_FLOOR}. ` +
        'Routing to cleo-subagent. Consider adding persona labels or keywords to the task.',
    };
  }

  const lowerTitle = (task.title ?? '').toLowerCase();
  const matchedLabel =
    bestRule.labelKeywords?.find((kw) =>
      (task.labels ?? []).some((l) => l.toLowerCase() === kw.toLowerCase()),
    ) ?? null;
  const matchedTitle =
    bestRule.titleKeywords?.find((kw) => lowerTitle.includes(kw.toLowerCase())) ?? null;

  const reason = matchedLabel
    ? `Label match: '${matchedLabel}' → ${bestRule.agentId} (confidence ${bestScore.toFixed(2)})`
    : matchedTitle
      ? `Title keyword match: '${matchedTitle}' → ${bestRule.agentId} (confidence ${bestScore.toFixed(2)})`
      : `Structural heuristic matched ${bestRule.agentId} (confidence ${bestScore.toFixed(2)})`;

  return {
    agentId: bestRule.agentId,
    role: bestRule.role,
    confidence: bestScore,
    reason,
    usedFallback: false,
  };
}
