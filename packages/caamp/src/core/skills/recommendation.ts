import type { MarketplaceResult } from '../marketplace/types.js';

/**
 * Error codes used in skill recommendation validation.
 *
 * @remarks
 * These codes identify specific failure reasons when validating recommendation
 * criteria input. Each code maps to a human-readable error code string.
 *
 * @public
 */
export const RECOMMENDATION_ERROR_CODES = {
  QUERY_INVALID: 'E_SKILLS_QUERY_INVALID',
  NO_MATCHES: 'E_SKILLS_NO_MATCHES',
  SOURCE_UNAVAILABLE: 'E_SKILLS_SOURCE_UNAVAILABLE',
  CRITERIA_CONFLICT: 'E_SKILLS_CRITERIA_CONFLICT',
} as const;

/**
 * Union type of all recommendation error code string literals.
 *
 * @remarks
 * Derived from the values of {@link RECOMMENDATION_ERROR_CODES}. Used to type
 * the `code` field on validation issues.
 *
 * @public
 */
export type RecommendationErrorCode =
  (typeof RECOMMENDATION_ERROR_CODES)[keyof typeof RECOMMENDATION_ERROR_CODES];

/**
 * Describes a single validation issue found in recommendation criteria.
 *
 * @remarks
 * Returned as part of {@link RecommendationValidationResult} when the input
 * criteria contain invalid or conflicting values.
 *
 * @public
 */
export interface RecommendationValidationIssue {
  /** The error code identifying the type of validation failure. */
  code: RecommendationErrorCode;
  /** The criteria field that caused the validation issue. */
  field: 'query' | 'mustHave' | 'prefer' | 'exclude';
  /** A human-readable description of the validation issue. */
  message: string;
}

/**
 * Result of validating recommendation criteria input.
 *
 * @remarks
 * When `valid` is true, the `issues` array is empty and the criteria can be
 * safely normalized for scoring. When `valid` is false, each issue describes
 * a specific problem that must be corrected.
 *
 * @public
 */
export interface RecommendationValidationResult {
  /** Whether the criteria passed all validation checks. */
  valid: boolean;
  /** List of validation issues found, empty when valid. */
  issues: RecommendationValidationIssue[];
}

/**
 * Raw user-provided criteria for skill recommendations.
 *
 * @remarks
 * All fields are optional, but at least one must be provided. String values
 * containing commas are tokenized into multiple terms. Arrays are flattened
 * and deduplicated during normalization.
 *
 * @public
 */
export interface RecommendationCriteriaInput {
  /** Free-text search query to match against skill metadata. */
  query?: string;
  /** Terms that a skill must match to be considered relevant. */
  mustHave?: string | string[];
  /** Terms that boost a skill's score when matched. */
  prefer?: string | string[];
  /** Terms that penalize a skill's score when matched. */
  exclude?: string | string[];
}

/**
 * Normalized and tokenized form of recommendation criteria.
 *
 * @remarks
 * Produced by {@link normalizeRecommendationCriteria} from raw
 * {@link RecommendationCriteriaInput}. All values are lowercased, deduplicated,
 * and sorted for deterministic scoring.
 *
 * @public
 */
export interface NormalizedRecommendationCriteria {
  /** The lowercased, trimmed query string. */
  query: string;
  /** Individual tokens extracted from the query string. */
  queryTokens: string[];
  /** Sorted, deduplicated list of required match terms. */
  mustHave: string[];
  /** Sorted, deduplicated list of preferred match terms. */
  prefer: string[];
  /** Sorted, deduplicated list of exclusion terms. */
  exclude: string[];
}

/**
 * String literal union of all reason codes emitted during skill scoring.
 *
 * @remarks
 * Each code corresponds to a specific scoring signal, such as matching a
 * required term, detecting a modern marker, or applying an exclusion penalty.
 * Used in {@link RecommendationReason} to explain score contributions.
 *
 * @public
 */
export type RecommendationReasonCode =
  | 'MATCH_TOPIC_GITBOOK'
  | 'HAS_GIT_SYNC'
  | 'HAS_API_WORKFLOW'
  | 'PENALTY_LEGACY_CLI'
  | 'MUST_HAVE_MATCH'
  | 'MISSING_MUST_HAVE'
  | 'PREFER_MATCH'
  | 'QUERY_MATCH'
  | 'STAR_SIGNAL'
  | 'METADATA_SIGNAL'
  | 'MODERN_MARKER'
  | 'LEGACY_MARKER'
  | 'EXCLUDE_MATCH';

/**
 * A single reason contributing to a skill's recommendation score.
 *
 * @remarks
 * Each reason captures one scoring signal with an optional detail string
 * providing additional context such as match counts.
 *
 * @public
 */
export interface RecommendationReason {
  /** The reason code identifying the scoring signal. */
  code: RecommendationReasonCode;
  /** Optional detail providing additional context, such as match count. */
  detail?: string;
}

/**
 * Detailed breakdown of a skill's recommendation score by category.
 *
 * @remarks
 * Only populated when `includeDetails` is true in {@link RecommendationOptions}.
 * Each field represents the weighted contribution of a scoring category to the
 * total score.
 *
 * @public
 */
export interface RecommendationScoreBreakdown {
  /** Score contribution from must-have term matches. */
  mustHave: number;
  /** Score contribution from preferred term matches. */
  prefer: number;
  /** Score contribution from query token matches. */
  query: number;
  /** Score contribution from repository star count signal. */
  stars: number;
  /** Score contribution from metadata quality and source confidence. */
  metadata: number;
  /** Score contribution from modern vs legacy marker detection. */
  modernity: number;
  /** Penalty applied for matching excluded terms. */
  exclusionPenalty: number;
  /** The final aggregated recommendation score. */
  total: number;
}

/**
 * A single skill recommendation with its computed score and explanations.
 *
 * @remarks
 * Produced by {@link scoreSkillRecommendation} for each candidate skill.
 * Contains the raw score, human-readable reasons, tradeoff warnings, and
 * an optional detailed breakdown.
 *
 * @public
 */
export interface RankedSkillRecommendation {
  /** The marketplace skill result being scored. */
  skill: MarketplaceResult;
  /** The computed recommendation score, higher is better. */
  score: number;
  /** List of reasons explaining the score contributions. */
  reasons: RecommendationReason[];
  /** Human-readable tradeoff warnings for the skill. */
  tradeoffs: string[];
  /** Whether the skill matched one or more exclusion terms. */
  excluded: boolean;
  /** Optional detailed score breakdown by category. */
  breakdown?: RecommendationScoreBreakdown;
}

/**
 * Configuration options for the skill recommendation engine.
 *
 * @remarks
 * All fields are optional and have sensible defaults. Custom weights override
 * individual scoring factors while preserving defaults for unspecified weights.
 *
 * @public
 */
export interface RecommendationOptions {
  /** Maximum number of results to return from the ranked list. */
  top?: number;
  /** Whether to include detailed score breakdown in each result. */
  includeDetails?: boolean;
  /** Partial weight overrides for individual scoring factors. */
  weights?: Partial<RecommendationWeights>;
  /** Custom modern technology marker strings for modernity scoring. */
  modernMarkers?: string[];
  /** Custom legacy technology marker strings for modernity scoring. */
  legacyMarkers?: string[];
}

/**
 * Numeric weights controlling the recommendation scoring algorithm.
 *
 * @remarks
 * Each weight multiplies the corresponding match count or signal value.
 * Higher values increase the influence of that factor on the total score.
 * Penalty weights are subtracted from the total.
 *
 * @public
 */
export interface RecommendationWeights {
  /** Weight applied per must-have term match. */
  mustHaveMatch: number;
  /** Weight applied per preferred term match. */
  preferMatch: number;
  /** Weight applied per query token match. */
  queryTokenMatch: number;
  /** Multiplier for the logarithmic star count signal. */
  starsFactor: number;
  /** Boost for metadata quality and source confidence. */
  metadataBoost: number;
  /** Boost applied per modern technology marker match. */
  modernMarkerBoost: number;
  /** Penalty applied per legacy technology marker match. */
  legacyMarkerPenalty: number;
  /** Penalty applied per excluded term match. */
  excludePenalty: number;
  /** Penalty applied per missing must-have term. */
  missingMustHavePenalty: number;
}

/**
 * The complete result of a skill recommendation operation.
 *
 * @remarks
 * Contains the normalized criteria that were used for scoring and the
 * ranked list of skill recommendations sorted by descending score.
 *
 * @public
 */
export interface RecommendSkillsResult {
  /** The normalized criteria used for scoring. */
  criteria: NormalizedRecommendationCriteria;
  /** Skills ranked by recommendation score, highest first. */
  ranking: RankedSkillRecommendation[];
}

const DEFAULT_WEIGHTS: RecommendationWeights = {
  mustHaveMatch: 10,
  preferMatch: 4,
  queryTokenMatch: 3,
  starsFactor: 2,
  metadataBoost: 2,
  modernMarkerBoost: 3,
  legacyMarkerPenalty: 3,
  excludePenalty: 25,
  missingMustHavePenalty: 20,
};

const DEFAULT_MODERN_MARKERS = ['svelte 5', 'runes', 'lafs', 'slsa', 'drizzle', 'better-auth'];
const DEFAULT_LEGACY_MARKERS = [
  'svelte 3',
  'jquery',
  'bower',
  'legacy',
  'book.json',
  'gitbook-cli',
];

/**
 * Splits a comma-separated criteria string into normalized tokens.
 *
 * @remarks
 * Each token is trimmed and lowercased. Empty tokens are removed.
 * This is the core tokenization used by the recommendation engine to
 * process user-provided criteria values.
 *
 * @param value - The comma-separated string to tokenize
 * @returns An array of trimmed, lowercased, non-empty tokens
 *
 * @example
 * ```typescript
 * const tokens = tokenizeCriteriaValue("React, TypeScript, svelte");
 * // returns ["react", "typescript", "svelte"]
 * ```
 *
 * @public
 */
export function tokenizeCriteriaValue(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeList(value: unknown): string[] {
  if (value === undefined) return [];

  if (!(typeof value === 'string' || Array.isArray(value))) return [];

  const source = Array.isArray(value) ? value : [value];
  const flattened = source.flatMap((item) =>
    typeof item === 'string' ? tokenizeCriteriaValue(item) : [],
  );
  return Array.from(new Set(flattened)).sort((a, b) => a.localeCompare(b));
}

function hasAnyCriteriaInput(input: RecommendationCriteriaInput): boolean {
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (query.length > 0) return true;

  const lists = [input.mustHave, input.prefer, input.exclude];
  return lists.some((list) => normalizeList(list).length > 0);
}

/**
 * Validates recommendation criteria input for correctness and consistency.
 *
 * @remarks
 * Checks that all fields have valid types, that no terms appear in both
 * inclusion and exclusion lists, and that at least one criteria value is
 * provided. Returns a result with `valid: true` when all checks pass.
 *
 * @param input - The raw recommendation criteria to validate
 * @returns A validation result indicating success or listing all issues
 *
 * @example
 * ```typescript
 * const result = validateRecommendationCriteria({
 *   query: "gitbook",
 *   mustHave: "api",
 *   exclude: "legacy",
 * });
 * if (!result.valid) {
 *   console.error(result.issues);
 * }
 * ```
 *
 * @public
 */
export function validateRecommendationCriteria(
  input: RecommendationCriteriaInput,
): RecommendationValidationResult {
  const issues: RecommendationValidationIssue[] = [];

  if (input.query !== undefined && typeof input.query !== 'string') {
    issues.push({
      code: RECOMMENDATION_ERROR_CODES.QUERY_INVALID,
      field: 'query',
      message: 'query must be a string',
    });
  }

  if (
    input.mustHave !== undefined &&
    !(typeof input.mustHave === 'string' || Array.isArray(input.mustHave))
  ) {
    issues.push({
      code: RECOMMENDATION_ERROR_CODES.QUERY_INVALID,
      field: 'mustHave',
      message: 'mustHave must be a string or string[]',
    });
  }

  if (
    input.prefer !== undefined &&
    !(typeof input.prefer === 'string' || Array.isArray(input.prefer))
  ) {
    issues.push({
      code: RECOMMENDATION_ERROR_CODES.QUERY_INVALID,
      field: 'prefer',
      message: 'prefer must be a string or string[]',
    });
  }

  if (
    input.exclude !== undefined &&
    !(typeof input.exclude === 'string' || Array.isArray(input.exclude))
  ) {
    issues.push({
      code: RECOMMENDATION_ERROR_CODES.QUERY_INVALID,
      field: 'exclude',
      message: 'exclude must be a string or string[]',
    });
  }

  const mustHave = normalizeList(input.mustHave);
  const prefer = normalizeList(input.prefer);
  const exclude = normalizeList(input.exclude);
  const conflict =
    mustHave.some((term) => exclude.includes(term)) ||
    prefer.some((term) => exclude.includes(term));
  if (conflict) {
    issues.push({
      code: RECOMMENDATION_ERROR_CODES.CRITERIA_CONFLICT,
      field: 'exclude',
      message: 'criteria terms cannot appear in both prefer/must-have and exclude',
    });
  }

  if (issues.length === 0 && !hasAnyCriteriaInput(input)) {
    issues.push({
      code: RECOMMENDATION_ERROR_CODES.QUERY_INVALID,
      field: 'query',
      message: 'at least one criteria value is required',
    });
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

/**
 * Normalizes raw recommendation criteria into a consistent tokenized form.
 *
 * @remarks
 * Lowercases all values, tokenizes comma-separated strings, deduplicates
 * terms, and sorts lists alphabetically. The result is deterministic for
 * equivalent inputs, ensuring consistent scoring behavior.
 *
 * @param input - The raw recommendation criteria to normalize
 * @returns Normalized criteria with tokenized, sorted, deduplicated terms
 *
 * @example
 * ```typescript
 * const criteria = normalizeRecommendationCriteria({
 *   query: "GitBook API",
 *   mustHave: "sync, api",
 *   prefer: ["modern"],
 * });
 * // criteria.queryTokens => ["api", "gitbook"]
 * // criteria.mustHave => ["api", "sync"]
 * ```
 *
 * @public
 */
export function normalizeRecommendationCriteria(
  input: RecommendationCriteriaInput,
): NormalizedRecommendationCriteria {
  const query = (input.query ?? '').trim().toLowerCase();
  return {
    query,
    queryTokens: query
      ? Array.from(new Set(tokenizeCriteriaValue(query.replace(/\s+/g, ',')))).sort((a, b) =>
          a.localeCompare(b),
        )
      : [],
    mustHave: normalizeList(input.mustHave),
    prefer: normalizeList(input.prefer),
    exclude: normalizeList(input.exclude),
  };
}

function countMatches(haystack: string, needles: string[]): number {
  let count = 0;
  for (const needle of needles) {
    if (haystack.includes(needle)) {
      count += 1;
    }
  }
  return count;
}

function clampScore(value: number): number {
  return Number(value.toFixed(6));
}

function buildSearchText(skill: MarketplaceResult): string {
  return `${skill.name} ${skill.scopedName} ${skill.description} ${skill.author}`.toLowerCase();
}

/**
 * Computes a recommendation score for a single skill against normalized criteria.
 *
 * @remarks
 * Evaluates the skill across multiple scoring dimensions including must-have
 * matches, preferred term matches, query token matches, star count signals,
 * metadata quality, modern/legacy markers, and exclusion penalties. The total
 * score is the weighted sum of all dimensions. When `includeDetails` is true,
 * a full breakdown by category is attached to the result.
 *
 * @param skill - The marketplace skill result to score
 * @param criteria - The normalized recommendation criteria to score against
 * @param options - Optional scoring configuration including weights and markers
 * @returns A ranked recommendation with score, reasons, and tradeoffs
 *
 * @example
 * ```typescript
 * const criteria = normalizeRecommendationCriteria({ query: "gitbook" });
 * const ranked = scoreSkillRecommendation(marketplaceSkill, criteria, {
 *   includeDetails: true,
 * });
 * console.log(ranked.score, ranked.reasons);
 * ```
 *
 * @public
 */
export function scoreSkillRecommendation(
  skill: MarketplaceResult,
  criteria: NormalizedRecommendationCriteria,
  options: RecommendationOptions = {},
): RankedSkillRecommendation {
  const weights = { ...DEFAULT_WEIGHTS, ...options.weights };
  const modernMarkers = (options.modernMarkers ?? DEFAULT_MODERN_MARKERS).map((marker) =>
    marker.toLowerCase(),
  );
  const legacyMarkers = (options.legacyMarkers ?? DEFAULT_LEGACY_MARKERS).map((marker) =>
    marker.toLowerCase(),
  );
  const text = buildSearchText(skill);
  const reasons: RecommendationReason[] = [];
  const tradeoffs: string[] = [];

  const mustHaveMatches = countMatches(text, criteria.mustHave);
  const missingMustHave = Math.max(criteria.mustHave.length - mustHaveMatches, 0);
  const preferMatches = countMatches(text, criteria.prefer);
  const queryMatches = countMatches(text, criteria.queryTokens);
  const excludeMatches = countMatches(text, criteria.exclude);
  const modernMatches = countMatches(text, modernMarkers);
  const legacyMatches = countMatches(text, legacyMarkers);
  const metadataSignal = skill.description.trim().length >= 80 ? 1 : 0;
  const starsSignal = Math.log10(skill.stars + 1);
  const sourceConfidence =
    skill.source === 'agentskills.in' ? 1 : skill.source === 'skills.sh' ? 0.8 : 0.6;

  const mustHaveScore =
    mustHaveMatches * weights.mustHaveMatch - missingMustHave * weights.missingMustHavePenalty;
  const preferScore = preferMatches * weights.preferMatch;
  const queryScore = queryMatches * weights.queryTokenMatch;
  const starsScore = starsSignal * weights.starsFactor;
  const metadataScore = (metadataSignal + sourceConfidence) * weights.metadataBoost;
  const modernityScore =
    modernMatches * weights.modernMarkerBoost - legacyMatches * weights.legacyMarkerPenalty;
  const exclusionPenalty = excludeMatches * weights.excludePenalty;

  const hasGitbookTopic = text.includes('gitbook');
  const hasGitSync = text.includes('git sync') || (text.includes('git') && text.includes('sync'));
  const hasApiWorkflow =
    text.includes('api') && (text.includes('workflow') || text.includes('sync'));
  const hasLegacyCli = text.includes('gitbook-cli') || text.includes('book.json');

  const topicScore =
    (hasGitbookTopic ? 3 : 0) +
    (hasGitSync ? 2 : 0) +
    (hasApiWorkflow ? 2 : 0) -
    (hasLegacyCli ? 4 : 0);

  const total = clampScore(
    mustHaveScore +
      preferScore +
      queryScore +
      starsScore +
      metadataScore +
      modernityScore +
      topicScore -
      exclusionPenalty,
  );

  if (hasGitbookTopic) reasons.push({ code: 'MATCH_TOPIC_GITBOOK' });
  if (hasGitSync) reasons.push({ code: 'HAS_GIT_SYNC' });
  if (hasApiWorkflow) reasons.push({ code: 'HAS_API_WORKFLOW' });
  if (hasLegacyCli) reasons.push({ code: 'PENALTY_LEGACY_CLI' });

  if (mustHaveMatches > 0)
    reasons.push({ code: 'MUST_HAVE_MATCH', detail: String(mustHaveMatches) });
  if (missingMustHave > 0)
    reasons.push({ code: 'MISSING_MUST_HAVE', detail: String(missingMustHave) });
  if (preferMatches > 0) reasons.push({ code: 'PREFER_MATCH', detail: String(preferMatches) });
  if (queryMatches > 0) reasons.push({ code: 'QUERY_MATCH', detail: String(queryMatches) });
  if (starsSignal > 0) reasons.push({ code: 'STAR_SIGNAL' });
  if (metadataSignal > 0) reasons.push({ code: 'METADATA_SIGNAL' });
  if (modernMatches > 0) reasons.push({ code: 'MODERN_MARKER', detail: String(modernMatches) });
  if (legacyMatches > 0) reasons.push({ code: 'LEGACY_MARKER', detail: String(legacyMatches) });
  if (excludeMatches > 0) reasons.push({ code: 'EXCLUDE_MATCH', detail: String(excludeMatches) });

  if (missingMustHave > 0) tradeoffs.push('Missing one or more required criteria terms.');
  if (excludeMatches > 0) tradeoffs.push('Matches one or more excluded terms.');
  if (skill.stars < 10) tradeoffs.push('Low quality signal from repository stars.');
  if (hasLegacyCli) tradeoffs.push('Contains legacy GitBook CLI markers.');

  const result: RankedSkillRecommendation = {
    skill,
    score: total,
    reasons,
    tradeoffs,
    excluded: excludeMatches > 0,
  };

  if (options.includeDetails) {
    result.breakdown = {
      mustHave: clampScore(mustHaveScore),
      prefer: clampScore(preferScore),
      query: clampScore(queryScore),
      stars: clampScore(starsScore),
      metadata: clampScore(metadataScore),
      modernity: clampScore(modernityScore),
      exclusionPenalty: clampScore(exclusionPenalty),
      total,
    };
  }

  return result;
}

/**
 * Validates, normalizes, scores, and ranks a list of skills against criteria.
 *
 * @remarks
 * This is the primary entry point for the recommendation engine. It validates
 * the input criteria, throws on invalid input, then scores each skill and
 * returns them sorted by descending score. Ties are broken by star count, then
 * alphabetically by scoped name. Results can be limited via `options.top`.
 *
 * @param skills - The array of marketplace skill results to rank
 * @param criteriaInput - The raw recommendation criteria from the user
 * @param options - Optional configuration for scoring and result limiting
 * @returns The normalized criteria and ranked skill recommendations
 * @throws Error with `code` and `issues` properties when criteria are invalid
 *
 * @example
 * ```typescript
 * const result = recommendSkills(
 *   marketplaceResults,
 *   { query: "gitbook", mustHave: "api", exclude: "legacy" },
 *   { top: 5, includeDetails: true },
 * );
 * for (const rec of result.ranking) {
 *   console.log(rec.skill.name, rec.score);
 * }
 * ```
 *
 * @public
 */
export function recommendSkills(
  skills: MarketplaceResult[],
  criteriaInput: RecommendationCriteriaInput,
  options: RecommendationOptions = {},
): RecommendSkillsResult {
  const validation = validateRecommendationCriteria(criteriaInput);
  if (!validation.valid) {
    const first = validation.issues[0];
    const error = new Error(first?.message ?? 'Invalid recommendation criteria') as Error & {
      code?: RecommendationErrorCode;
      issues?: RecommendationValidationIssue[];
    };
    error.code = first?.code;
    error.issues = validation.issues;
    throw error;
  }

  const criteria = normalizeRecommendationCriteria(criteriaInput);
  const ranking = skills
    .map((skill) => scoreSkillRecommendation(skill, criteria, options))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.skill.stars !== a.skill.stars) return b.skill.stars - a.skill.stars;
      return a.skill.scopedName.localeCompare(b.skill.scopedName);
    });

  return {
    criteria,
    ranking: typeof options.top === 'number' ? ranking.slice(0, Math.max(0, options.top)) : ranking,
  };
}

/**
 * Alias for {@link recommendSkills} providing a shorter function name.
 *
 * @remarks
 * This is a convenience alias that exposes the same recommendation engine
 * under the name `rankSkills` for backward compatibility.
 *
 * @public
 */
export const rankSkills = recommendSkills;
