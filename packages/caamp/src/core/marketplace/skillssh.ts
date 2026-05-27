/**
 * skills.sh marketplace adapter
 *
 * Connects to the skills.sh API for skill discovery.
 * Uses the Vercel Skills model where GitHub is the actual source.
 */

import { ensureOkResponse, fetchWithTimeout } from '../network/fetch.js';
import type { MarketplaceAdapter, MarketplaceResult } from './types.js';

const API_BASE = 'https://skills.sh/api';

interface SkillsShResult {
  name: string;
  author: string;
  description: string;
  repo: string;
  stars?: number;
  url: string;
}

interface SkillsShResponse {
  results: SkillsShResult[];
  total: number;
}

function toResult(skill: SkillsShResult): MarketplaceResult {
  return {
    name: skill.name,
    scopedName: `@${skill.author}/${skill.name}`,
    description: skill.description,
    author: skill.author,
    stars: skill.stars ?? 0,
    githubUrl: skill.url,
    repoFullName: skill.repo,
    path: '',
    source: 'skills.sh',
  };
}

/**
 * Marketplace adapter for the skills.sh API.
 *
 * @remarks
 * Implements the {@link MarketplaceAdapter} interface to search and retrieve
 * skills from the skills.sh marketplace. Uses the Vercel Skills model where
 * GitHub is the actual source for installation.
 *
 * @public
 */
export class SkillsShAdapter implements MarketplaceAdapter {
  /** The marketplace identifier used in search results. */
  name = 'skills.sh';

  /**
   * Search for skills by query string.
   *
   * @param query - Search query to match against skill names.
   * @param limit - Maximum number of results to return.
   * @returns Array of marketplace results.
   */
  async search(query: string, limit = 20): Promise<MarketplaceResult[]> {
    const params = new URLSearchParams({
      q: query,
      limit: String(limit),
    });

    const url = `${API_BASE}/search?${params}`;
    const response = ensureOkResponse(await fetchWithTimeout(url), url);
    const data = (await response.json()) as SkillsShResponse;
    return data.results.map(toResult);
  }

  /**
   * Look up a specific skill by its scoped name.
   *
   * @param scopedName - The scoped skill name (e.g. `"@author/skill-name"`).
   * @returns The matching marketplace result, or `null` if not found.
   */
  async getSkill(scopedName: string): Promise<MarketplaceResult | null> {
    const results = await this.search(scopedName, 5);
    return results.find((r) => r.scopedName === scopedName) ?? null;
  }
}
