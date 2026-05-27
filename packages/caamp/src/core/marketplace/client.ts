/**
 * Unified marketplace client
 *
 * Aggregates results from multiple marketplace adapters,
 * deduplicates, and sorts by relevance.
 */

import { SkillsMPAdapter } from './skillsmp.js';
import { SkillsShAdapter } from './skillssh.js';
import type { MarketplaceAdapter, MarketplaceResult } from './types.js';

/**
 * Error thrown when all marketplace sources fail to respond.
 *
 * @remarks
 * Contains an array of per-adapter failure details so callers can report
 * which sources were unreachable and why.
 *
 * @public
 */
export class MarketplaceUnavailableError extends Error {
  /** Per-adapter failure messages. */
  details: string[];

  constructor(message: string, details: string[]) {
    super(message);
    this.name = 'MarketplaceUnavailableError';
    this.details = details;
  }
}

/**
 * Unified marketplace client that aggregates results from multiple marketplace adapters.
 *
 * Queries all configured marketplaces in parallel, deduplicates results by scoped name,
 * and sorts by star count.
 *
 * @remarks
 * Default adapters query agentskills.in and skills.sh. Custom adapters can
 * be injected via the constructor for testing or additional sources.
 *
 * @example
 * ```typescript
 * const client = new MarketplaceClient();
 * const results = await client.search("filesystem");
 * for (const r of results) {
 *   console.log(`${r.scopedName} (${r.stars} stars)`);
 * }
 * ```
 *
 * @public
 */
export class MarketplaceClient {
  /** Configured marketplace adapters. */
  private adapters: MarketplaceAdapter[];

  /**
   * Create a new marketplace client.
   *
   * @param adapters - Custom marketplace adapters (defaults to agentskills.in and skills.sh)
   *
   * @example
   * ```typescript
   * // Use default adapters
   * const client = new MarketplaceClient();
   *
   * // Use custom adapters
   * const client = new MarketplaceClient([myAdapter]);
   * ```
   */
  constructor(adapters?: MarketplaceAdapter[]) {
    this.adapters = adapters ?? [new SkillsMPAdapter(), new SkillsShAdapter()];
  }

  /**
   * Search all marketplaces and return deduplicated, sorted results.
   *
   * Queries all adapters in parallel and deduplicates by `scopedName`,
   * keeping the entry with the highest star count. Results are sorted by
   * stars descending.
   *
   * @param query - Search query string
   * @param limit - Maximum number of results to return (default: 20)
   * @returns Deduplicated and sorted marketplace results
   *
   * @example
   * ```typescript
   * const results = await client.search("code review", 10);
   * ```
   */
  async search(query: string, limit = 20): Promise<MarketplaceResult[]> {
    const settled = await Promise.allSettled(
      this.adapters.map((adapter) => adapter.search(query, limit)),
    );

    const flat: MarketplaceResult[] = [];
    const failures: string[] = [];

    for (const [index, result] of settled.entries()) {
      const adapterName = this.adapters[index]?.name ?? 'unknown';

      if (result.status === 'fulfilled') {
        flat.push(...result.value);
      } else {
        const reason =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        failures.push(`${adapterName}: ${reason}`);
      }
    }

    if (flat.length === 0 && failures.length > 0) {
      throw new MarketplaceUnavailableError('All marketplace sources failed.', failures);
    }

    // Deduplicate by scopedName, keeping higher star count
    const seen = new Map<string, MarketplaceResult>();
    for (const result of flat) {
      const existing = seen.get(result.scopedName);
      if (!existing || result.stars > existing.stars) {
        seen.set(result.scopedName, result);
      }
    }

    // Sort by stars descending
    const deduplicated = Array.from(seen.values());
    deduplicated.sort((a, b) => b.stars - a.stars);

    return deduplicated.slice(0, limit);
  }

  /**
   * Get a specific skill by its scoped name from any marketplace.
   *
   * Tries each adapter in order and returns the first match.
   *
   * @param scopedName - Scoped skill name (e.g. `"@author/my-skill"`)
   * @returns The marketplace result, or `null` if not found in any marketplace
   *
   * @example
   * ```typescript
   * const skill = await client.getSkill("@anthropic/memory");
   * ```
   */
  async getSkill(scopedName: string): Promise<MarketplaceResult | null> {
    const failures: string[] = [];

    for (const adapter of this.adapters) {
      try {
        const result = await adapter.getSkill(scopedName);
        if (result) return result;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failures.push(`${adapter.name}: ${reason}`);
      }
    }

    if (failures.length === this.adapters.length && this.adapters.length > 0) {
      throw new MarketplaceUnavailableError('All marketplace sources failed.', failures);
    }

    return null;
  }
}
