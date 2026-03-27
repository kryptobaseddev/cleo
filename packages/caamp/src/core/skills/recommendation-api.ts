import { MarketplaceClient } from '../marketplace/client.js';
import {
  RECOMMENDATION_ERROR_CODES,
  type RecommendationCriteriaInput,
  type RecommendationOptions,
  type RecommendSkillsResult,
  recommendSkills as rankSkills,
} from './recommendation.js';

/**
 * Options for searching skills via marketplace APIs.
 *
 * @public
 */
export interface SearchSkillsOptions {
  /** Maximum number of results to return. */
  limit?: number;
}

/**
 * Options for the recommendation query combining ranking options with a result limit.
 *
 * @public
 */
export interface RecommendSkillsQueryOptions extends RecommendationOptions {
  /** Maximum number of results to return. */
  limit?: number;
}

/**
 * Format skill recommendation results for display or serialization.
 *
 * @remarks
 * In `"human"` mode, produces a numbered list with reasons and tradeoffs.
 * In `"json"` mode, returns a structured object suitable for machine consumption.
 *
 * @param result - The recommendation result to format
 * @param opts - Formatting options including output mode and detail level
 * @returns Formatted string for human mode, or a structured object for JSON mode
 *
 * @example
 * ```typescript
 * const result = await recommendSkills("testing", { taskType: "test-writing" });
 * const output = formatSkillRecommendations(result, { mode: "human" });
 * console.log(output);
 * ```
 *
 * @public
 */
export function formatSkillRecommendations(
  result: RecommendSkillsResult,
  opts: { mode: 'human' | 'json'; details?: boolean },
): string | Record<string, unknown> {
  const top = result.ranking;

  if (opts.mode === 'human') {
    if (top.length === 0) return 'No recommendations found.';
    const lines: string[] = ['Recommended skills:', ''];
    for (const [index, entry] of top.entries()) {
      const marker = index === 0 ? ' (Recommended)' : '';
      lines.push(`${index + 1}) ${entry.skill.scopedName}${marker}`);
      lines.push(
        `   why: ${entry.reasons.map((reason) => reason.code).join(', ') || 'score-based match'}`,
      );
      lines.push(`   tradeoff: ${entry.tradeoffs[0] ?? 'none'}`);
    }
    lines.push('');
    lines.push(`CHOOSE: ${top.map((_, index) => index + 1).join(',')}`);
    return lines.join('\n');
  }

  const options = top.map((entry, index) => ({
    rank: index + 1,
    scopedName: entry.skill.scopedName,
    score: entry.score,
    reasons: entry.reasons,
    tradeoffs: entry.tradeoffs,
    ...(opts.details
      ? {
          description: entry.skill.description,
          source: entry.skill.source,
          evidence: entry.breakdown ?? null,
        }
      : {}),
  }));

  return {
    query: result.criteria.query,
    recommended: options[0] ?? null,
    options,
  };
}

/**
 * Search for skills via marketplace APIs.
 *
 * @remarks
 * Queries the unified marketplace client and returns matching skill entries.
 * Throws with a coded error if the query is empty or the marketplace is unavailable.
 *
 * @param query - Search query string (must be non-empty)
 * @param options - Search options including result limit
 * @returns Array of marketplace skill entries matching the query
 *
 * @example
 * ```typescript
 * const results = await searchSkills("test runner", { limit: 10 });
 * console.log(`Found ${results.length} skills`);
 * ```
 *
 * @public
 */
export async function searchSkills(query: string, options: SearchSkillsOptions = {}) {
  const trimmed = query.trim();
  if (!trimmed) {
    const error = new Error('query must be non-empty') as Error & { code?: string };
    error.code = RECOMMENDATION_ERROR_CODES.QUERY_INVALID;
    throw error;
  }

  const client = new MarketplaceClient();
  try {
    return await client.search(trimmed, options.limit ?? 20);
  } catch (error) {
    const wrapped = new Error(error instanceof Error ? error.message : String(error)) as Error & {
      code?: string;
    };
    wrapped.code = RECOMMENDATION_ERROR_CODES.SOURCE_UNAVAILABLE;
    throw wrapped;
  }
}

/**
 * Search and rank skills based on query and recommendation criteria.
 *
 * @remarks
 * Combines marketplace search with the recommendation engine to produce
 * scored, ranked skill suggestions. Throws if no matches are found.
 *
 * @param query - Search query string
 * @param criteria - Recommendation criteria (task type, context, preferences)
 * @param options - Options for limiting and tuning results
 * @returns Ranked recommendation results with scores and reasons
 *
 * @example
 * ```typescript
 * const result = await recommendSkills("testing", { taskType: "test-writing" });
 * const best = result.ranking[0];
 * console.log(`Top pick: ${best.skill.scopedName} (score: ${best.score})`);
 * ```
 *
 * @public
 */
export async function recommendSkills(
  query: string,
  criteria: Omit<RecommendationCriteriaInput, 'query'>,
  options: RecommendSkillsQueryOptions = {},
): Promise<RecommendSkillsResult> {
  const hits = await searchSkills(query, {
    limit: options.limit ?? Math.max((options.top ?? 3) * 5, 20),
  });
  const ranked = rankSkills(hits, { ...criteria, query }, options);

  if (ranked.ranking.length === 0) {
    const error = new Error('no matches found') as Error & { code?: string };
    error.code = RECOMMENDATION_ERROR_CODES.NO_MATCHES;
    throw error;
  }

  return ranked;
}
