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
 * The five canonical role personas (ADR-055 D032 clean-forward, T1258 E1):
 *  - `project-orchestrator`  — coordinates multi-agent workflows
 *  - `project-dev-lead`      — general-purpose development lead
 *  - `project-code-worker`   — implementation / code execution worker
 *  - `project-docs-worker`   — documentation / canon worker
 *  - `project-security-worker` — security-focused worker
 *
 * @module orchestration/classify
 * @task T891 CANT persona wiring
 * @task T1258 E1 canonical naming refactor
 * @task T1936 live-registry source for getRegisteredAgentIds + startup validation
 * @epic T889 / T1929
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Task } from '@cleocode/contracts';
import { ClassifierUnregisteredAgentError } from '@cleocode/contracts';
import { typedAll } from '../store/typed-query.js';

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
  /**
   * Resolved canonical agent id.
   *
   * One of: `project-orchestrator`, `project-dev-lead`, `project-code-worker`,
   * `project-docs-worker`, `project-security-worker`, or `cleo-subagent`.
   */
  agentId: string;
  /**
   * Intended spawn role. Derived from the agent's default role but clamped to
   * the registry taxonomy so callers can feed it directly into
   * {@link ComposeSpawnPayloadOptions.role}.
   *
   * - `orchestrator` — only `project-orchestrator` + explicit orchestrator labels
   * - `lead`         — specialist lead agents (dev-lead)
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
 * Ordered list of persona rules using canonical ADR-055 D032 agent identifiers.
 *
 * Evaluation stops at the first rule that clears the confidence floor.
 * Rules are ordered from most-specific (label-exact) to least-specific
 * (structural heuristic).
 *
 * @see T1258 E1 canonical naming refactor
 */
const CLASSIFIER_RULES: readonly ClassifierRule[] = [
  // ── project-orchestrator ─────────────────────────────────────────────────
  {
    agentId: 'project-orchestrator',
    role: 'orchestrator',
    baseConfidence: 0.9,
    labelKeywords: ['orchestrate', 'orchestrator', 'multi-agent', 'project-orchestrator'],
    titleKeywords: ['orchestrate', 'orchestration', 'multi-agent'],
    structuralBoost: (task) => (task.type === 'epic' ? 0.1 : 0),
  },

  // ── project-security-worker (security-focused tasks) ─────────────────────
  {
    agentId: 'project-security-worker',
    role: 'worker',
    baseConfidence: 0.85,
    labelKeywords: [
      'security',
      'audit',
      'vulnerability',
      'cve',
      'pentest',
      'project-security-worker',
    ],
    titleKeywords: ['security', 'vulnerability', 'audit', 'cve', 'pentest', 'owasp'],
    descKeywords: ['security', 'vulnerability', 'audit', 'cve'],
  },

  // ── project-docs-worker (documentation / canon) ──────────────────────────
  {
    agentId: 'project-docs-worker',
    role: 'worker',
    baseConfidence: 0.8,
    labelKeywords: [
      'canon',
      'docs',
      'documentation',
      'adr',
      'historian',
      'spec',
      'project-docs-worker',
    ],
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

  // ── project-dev-lead (general development lead) ───────────────────────────
  {
    agentId: 'project-dev-lead',
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
      'project-dev-lead',
    ],
    titleKeywords: ['implement', 'add', 'fix', 'refactor', 'build', 'create', 'update', 'wir'],
    structuralBoost: (task) => {
      if (task.role === 'bug') return 0.15;
      if (task.type === 'task' || task.type === 'subtask') return 0.05;
      return 0;
    },
  },

  // ── project-code-worker (implementation / execution) ─────────────────────
  {
    agentId: 'project-code-worker',
    role: 'worker',
    baseConfidence: 0.65,
    labelKeywords: ['worker', 'code-worker', 'project-code-worker', 'implementation', 'coding'],
    titleKeywords: ['implement', 'code', 'write', 'build'],
    structuralBoost: (task) => {
      if (task.size === 'small') return 0.1;
      if (task.type === 'subtask') return 0.1;
      return 0;
    },
  },
];

// ============================================================================
// Registry vocabulary
// ============================================================================

/**
 * Tiers queried when a live `signaldock.db` handle is provided to
 * {@link getRegisteredAgentIds}. Only agents installed at these tiers are
 * considered part of the "registered" vocabulary used for classifier validation.
 *
 * @task T1936
 */
const REGISTRY_QUERY_TIERS = ['project', 'global', 'packaged'] as const;

/**
 * Static fallback list of canonical agent IDs returned by
 * {@link getRegisteredAgentIds} when no live DB is available.
 *
 * Mirrors the five worker template names installed by `cleo init` (ADR-068)
 * plus the generic `cleo-subagent` fallback. Must be kept in sync with
 * `packages/agents/templates/*.cant` filenames.
 *
 * @task T1936
 * @epic T1929
 */
const STATIC_FALLBACK_AGENT_IDS: readonly string[] = [
  'project-orchestrator',
  'project-dev-lead',
  'project-code-worker',
  'project-docs-worker',
  'project-security-worker',
  CLASSIFY_FALLBACK_AGENT_ID,
];

/**
 * Returns the set of agent IDs that the classifier is allowed to emit.
 *
 * When `db` is provided (an open handle to `signaldock.db`), the live
 * `agents` table is queried for all rows whose `tier` is one of
 * `'project'`, `'global'`, or `'packaged'`. The result set is unique
 * and order-stable (alphabetical within tier groups). The generic
 * `cleo-subagent` fallback is always appended last.
 *
 * When `db` is omitted or the query fails, the function falls back to the
 * five canonical worker template names (the ADR-068 install set). This
 * preserves correctness in CI bootstrap scenarios and unit tests that run
 * without a live registry.
 *
 * Per ADR-068 (T1929): the canonical source-of-truth is the installed
 * templates set registered in `signaldock.db.agents` by `cleo init` (T1934).
 * Passing the open DB handle here wires that source to the classifier.
 *
 * @param db - Optional open `DatabaseSync` handle to `signaldock.db`.
 *   When supplied the live `agents` table is used; when omitted the static
 *   5-template fallback list is returned instead.
 * @returns Readonly array of valid agent IDs (unique).
 *
 * @example Without DB (static fallback):
 * ```typescript
 * const ids = getRegisteredAgentIds();
 * // ['project-orchestrator', 'project-dev-lead', 'project-code-worker',
 * //  'project-docs-worker', 'project-security-worker', 'cleo-subagent']
 * ```
 *
 * @example With live DB (registry-backed):
 * ```typescript
 * const db = new DatabaseSync(getGlobalSignaldockDbPath());
 * const ids = getRegisteredAgentIds(db);
 * // [...all installed agents..., 'cleo-subagent']
 * db.close();
 * ```
 *
 * @task T1326
 * @task T1936
 * @epic T1323 / T1929
 */
export function getRegisteredAgentIds(db?: DatabaseSync): readonly string[] {
  if (db) {
    try {
      const placeholders = REGISTRY_QUERY_TIERS.map(() => '?').join(', ');
      const stmt = db.prepare(
        `SELECT DISTINCT agent_id FROM agents WHERE tier IN (${placeholders}) ORDER BY agent_id ASC`,
      );
      const rows = typedAll<{ agent_id: string }>(stmt, ...REGISTRY_QUERY_TIERS);

      if (rows.length > 0) {
        const ids = rows.map((r) => r.agent_id);
        // Always include the fallback — it resolves via the packaged/fallback tier.
        if (!ids.includes(CLASSIFY_FALLBACK_AGENT_ID)) {
          ids.push(CLASSIFY_FALLBACK_AGENT_ID);
        }
        return ids;
      }
    } catch {
      // DB query failed (schema not yet migrated, table absent, etc.)
      // Fall through to the static fallback list below.
    }
  }

  // Static fallback: canonical 5-template set + generic fallback.
  // Used when no DB is provided (CI bootstrap, unit tests without registry).
  return STATIC_FALLBACK_AGENT_IDS;
}

/**
 * Validate that every agent ID referenced in {@link CLASSIFIER_RULES} is
 * present in the live registry. Throws {@link ClassifierUnregisteredAgentError}
 * at the first rule whose `agentId` is absent from the registered set.
 *
 * Call this once on classifier init (e.g. at `cleo session start`) to catch
 * drift between hardcoded classifier vocabulary and registered agents at startup
 * time rather than at task-classification time. The static fallback is always
 * accepted as a valid ID source when no DB is provided.
 *
 * Per T1326 contract: the error class, code (`E_CLASSIFIER_UNREGISTERED_AGENT`),
 * and field names are unchanged — only the validation trigger point moves from
 * per-classify-call to once-at-startup.
 *
 * @param db - Optional open `DatabaseSync` handle to `signaldock.db`.
 *   When supplied the live registry is used for the registered-id lookup;
 *   when omitted the static 5-template fallback is used (always passes for
 *   the canonical rule set).
 * @throws {@link ClassifierUnregisteredAgentError} when a rule references an
 *   agent ID that is absent from the registered vocabulary.
 *
 * @example At session start:
 * ```typescript
 * const db = new DatabaseSync(getGlobalSignaldockDbPath());
 * validateClassifierRules(db);  // throws immediately if rules are stale
 * db.close();
 * ```
 *
 * @task T1936
 * @epic T1929
 */
export function validateClassifierRules(db?: DatabaseSync): void {
  const registered = new Set(getRegisteredAgentIds(db));
  for (const rule of CLASSIFIER_RULES) {
    if (!registered.has(rule.agentId)) {
      throw new ClassifierUnregisteredAgentError(rule.agentId, [...registered]);
    }
  }
}

/**
 * Options for {@link classifyTask}.
 *
 * @task T1326
 * @epic T1323
 */
export interface ClassifyOptions {
  /**
   * Override the set of valid agent IDs used for output validation.
   *
   * When provided, the classifier throws {@link ClassifierUnregisteredAgentError}
   * if its result is not in this set. When omitted, the classifier validates
   * against {@link getRegisteredAgentIds()} — the built-in rule vocabulary.
   *
   * Pass the live registry IDs (`AgentRegistryAPI.list()` → `.map(a => a.agentId)`)
   * here to enforce that the classifier can only route to agents that are
   * currently attached and enabled in the project.
   */
  allowedAgentIds?: readonly string[];
}

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
  // is the default for all tasks and would make project-dev-lead match everything.
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
 * **Registry validation**: after scoring, the resolved agent ID is checked
 * against `opts.allowedAgentIds` (when provided) or the built-in vocabulary
 * from {@link getRegisteredAgentIds()}. If the emitted ID is not present,
 * {@link ClassifierUnregisteredAgentError} is thrown with a fix-hint listing
 * valid IDs. This ensures the classifier output space is always a strict subset
 * of the registry input space (Council 2026-04-24 FP atomic truth #3).
 *
 * @param task - Full task record (at minimum: id, title, type, labels).
 * @param opts - Optional classification options (registry override for validation).
 * @returns Classification result with agentId, role, confidence, and reason.
 * @throws {@link ClassifierUnregisteredAgentError} when the resolved agent ID
 *   is absent from the allowed vocabulary.
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
 * @example Registry-constrained classification (live DB agents only):
 * ```typescript
 * const liveIds = (await registry.list()).map(a => a.agentId);
 * const result = classifyTask(task, { allowedAgentIds: liveIds });
 * ```
 *
 * @task T891
 * @task T1258 E1 canonical naming refactor
 * @task T1326 classifier↔registry contract
 */
export function classifyTask(task: Task, opts?: ClassifyOptions): ClassifyResult {
  let bestScore = 0;
  let bestRule: ClassifierRule | null = null;

  for (const rule of CLASSIFIER_RULES) {
    const score = scoreRule(rule, task);
    if (score > bestScore) {
      bestScore = score;
      bestRule = rule;
    }
  }

  // Resolve the allowed vocabulary: caller-supplied override or built-in set.
  const allowedIds: readonly string[] = opts?.allowedAgentIds ?? getRegisteredAgentIds();

  // Below-floor: demote to generic fallback.
  if (bestScore < CLASSIFY_CONFIDENCE_FLOOR || bestRule === null) {
    // Validate the fallback itself against the allowed vocabulary.
    if (!allowedIds.includes(CLASSIFY_FALLBACK_AGENT_ID)) {
      throw new ClassifierUnregisteredAgentError(CLASSIFY_FALLBACK_AGENT_ID, allowedIds);
    }
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

  // Validate the resolved persona against the allowed vocabulary.
  if (!allowedIds.includes(bestRule.agentId)) {
    throw new ClassifierUnregisteredAgentError(bestRule.agentId, allowedIds);
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
