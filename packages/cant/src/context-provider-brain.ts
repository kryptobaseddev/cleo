/**
 * BRAIN-backed ContextProvider implementation for the JIT Agent Composer.
 *
 * Wires the `ContextProvider` interface from `composer.ts` to the live BRAIN
 * database via `memoryFind` from `@cleocode/core`. This is the critical T432
 * activation — without this provider, `composeSpawnPayload` cannot pull real
 * context from BRAIN at spawn time.
 *
 * The `agent` filter (T417/T418) ensures that mental model observations written
 * by a specific agent are returned rather than unrelated global observations.
 *
 * @epic T377
 * @task T432
 * @packageDocumentation
 */

import { memoryFetch, memoryFind } from '@cleocode/core/internal';
import type { ContextProvider, ContextSlice, MentalModelSlice } from './composer.js';
import { estimateTokens } from './composer.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Truncate text to fit within a token budget using a 4 chars/token estimate.
 *
 * @param text - The text to truncate.
 * @param maxTokens - The maximum token count.
 * @returns The (possibly truncated) text.
 */
function truncateToTokenBudget(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

// ---------------------------------------------------------------------------
// BRAIN ContextProvider
// ---------------------------------------------------------------------------

/**
 * A {@link ContextProvider} implementation that retrieves context from the
 * BRAIN database (`brain.db`) via the `memoryFind` and `memoryFetch` functions
 * from `@cleocode/core`.
 *
 * @remarks
 * This provider is designed for use in the canonical spawn path:
 * `composeSpawnPayload(agentDef, brainContextProvider(projectRoot), projectHash)`.
 *
 * The `source` parameter maps to BRAIN table categories:
 * - `"patterns"` → searches the patterns table
 * - `"decisions"` → searches the decisions table
 * - `"learnings"` → searches the learnings table
 * - `"observations"` → searches the observations table (default)
 *
 * @param projectRoot - Absolute path to the project root (where `.cleo/` lives).
 * @returns A `ContextProvider` instance backed by the project's BRAIN database.
 *
 * @example
 * ```typescript
 * import { composeSpawnPayload } from '@cleocode/cant';
 * import { brainContextProvider } from '@cleocode/cant/context-provider-brain';
 *
 * const payload = await composeSpawnPayload(
 *   agentDef,
 *   brainContextProvider('/project/root'),
 *   projectHash,
 * );
 * ```
 */
export function brainContextProvider(projectRoot: string): ContextProvider {
  return {
    /**
     * Query BRAIN for context entries matching a source category and query string.
     *
     * @param source - BRAIN table category (patterns, decisions, learnings, observations).
     * @param query - The search query string.
     * @param maxTokens - Maximum token budget for the returned content.
     * @returns A ContextSlice with content truncated to the token budget.
     */
    async queryContext(source: string, query: string, maxTokens: number): Promise<ContextSlice> {
      if (maxTokens <= 0) {
        return { source, content: '', tokens: 0 };
      }

      try {
        // Map source to a BRAIN table filter.
        const validTables = ['patterns', 'decisions', 'learnings', 'observations'] as const;
        type BrainTable = (typeof validTables)[number];
        const table = validTables.includes(source as BrainTable)
          ? ([source] as BrainTable[])
          : undefined;

        const findResult = await memoryFind(
          {
            query,
            limit: 10,
            tables: table,
          },
          projectRoot,
        );

        if (!findResult.success || !findResult.data) {
          return { source, content: '', tokens: 0 };
        }

        // memoryFind returns { results: BrainCompactHit[] }
        const data = findResult.data as {
          results?: Array<{ id: string; title: string; type: string }>;
        };
        const hits = data.results ?? [];

        if (hits.length === 0) {
          return { source, content: '', tokens: 0 };
        }

        // Fetch full content for the top hits within the budget.
        const ids = hits.map((h) => h.id);
        const fetchResult = await memoryFetch({ ids }, projectRoot);

        let content = '';
        if (fetchResult.success && fetchResult.data) {
          const fetchData = fetchResult.data as {
            entries?: Array<{ id: string; title: string; content?: string; text?: string }>;
          };
          const entries = fetchData.entries ?? [];
          content = entries.map((e) => `[${e.title}]\n${e.content ?? e.text ?? ''}`).join('\n\n');
        } else {
          // Fallback to compact titles if fetch failed.
          content = hits.map((h) => h.title).join('\n');
        }

        const truncated = truncateToTokenBudget(content, maxTokens);
        return {
          source,
          content: truncated,
          tokens: estimateTokens(truncated),
        };
      } catch {
        // Return empty slice on any error — the composer handles missing context gracefully.
        return { source, content: '', tokens: 0 };
      }
    },

    /**
     * Load the mental model for an agent from BRAIN observations.
     *
     * Uses the T417/T418 `agent` filter to retrieve only observations
     * produced by the specific agent for this project scope.
     *
     * @param agentName - The agent name to load the mental model for.
     * @param projectHash - Project identifier ('global' for global scope).
     * @param maxTokens - Maximum token budget for the mental model content.
     * @returns A MentalModelSlice with content truncated to the token budget.
     */
    async loadMentalModel(
      agentName: string,
      projectHash: string,
      maxTokens: number,
    ): Promise<MentalModelSlice> {
      if (maxTokens <= 0) {
        return { content: '', tokens: 0, lastConsolidated: null };
      }

      try {
        // Query brain_observations filtered by agent name (T417/T418).
        const findResult = await memoryFind(
          {
            query: `mental model ${agentName}`,
            limit: 5,
            tables: ['observations'],
            agent: agentName,
          },
          projectRoot,
        );

        if (!findResult.success || !findResult.data) {
          return { content: '', tokens: 0, lastConsolidated: null };
        }

        const data = findResult.data as {
          results?: Array<{ id: string; title: string; date?: string }>;
        };
        const hits = data.results ?? [];

        if (hits.length === 0) {
          return { content: '', tokens: 0, lastConsolidated: null };
        }

        // Sort by date descending and take the most recent entries.
        const sorted = [...hits].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
        const ids = sorted.map((h) => h.id);

        const fetchResult = await memoryFetch({ ids }, projectRoot);
        let content = '';
        let lastConsolidated: string | null = null;

        if (fetchResult.success && fetchResult.data) {
          const fetchData = fetchResult.data as {
            entries?: Array<{
              id: string;
              title: string;
              content?: string;
              text?: string;
              date?: string;
            }>;
          };
          const entries = fetchData.entries ?? [];
          content = entries.map((e) => `[${e.title}]\n${e.content ?? e.text ?? ''}`).join('\n\n');
          lastConsolidated = entries[0]?.date ?? null;
        } else {
          content = sorted.map((h) => h.title).join('\n');
          lastConsolidated = sorted[0]?.date ?? null;
        }

        // Scope prefix to help the agent understand its mental model context.
        const prefix =
          projectHash === 'global'
            ? `[Global mental model for ${agentName}]\n`
            : `[Project mental model for ${agentName} — scope: ${projectHash}]\n`;

        const full = prefix + content;
        const truncated = truncateToTokenBudget(full, maxTokens);

        return {
          content: truncated,
          tokens: estimateTokens(truncated),
          lastConsolidated,
        };
      } catch {
        return { content: '', tokens: 0, lastConsolidated: null };
      }
    },
  };
}
