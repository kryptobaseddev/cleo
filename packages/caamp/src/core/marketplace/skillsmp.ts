/**
 * agentskills.in marketplace adapter
 *
 * Connects to the SkillsMP API for skill discovery.
 * GitHub is always the actual source for installation.
 */

import { ensureOkResponse, fetchWithTimeout } from '../network/fetch.js';
import type { MarketplaceAdapter, MarketplaceResult } from './types.js';

const API_BASE = 'https://www.agentskills.in/api/skills';

interface ApiSkill {
  id: string;
  name: string;
  description: string;
  author: string;
  scopedName: string;
  stars: number;
  forks: number;
  githubUrl: string;
  repoFullName: string;
  path: string;
  category?: string;
  hasContent: boolean;
}

interface ApiResponse {
  skills: ApiSkill[];
  total: number;
  limit: number;
  offset: number;
}

interface ScopedNameParts {
  author: string;
  name: string;
}

function parseScopedName(value: string): ScopedNameParts | null {
  const match = value.match(/^@([^/]+)\/([^/]+)$/);
  if (!match) return null;
  return {
    author: match[1]!,
    name: match[2]!,
  };
}

function toResult(skill: ApiSkill): MarketplaceResult {
  return {
    name: skill.name,
    scopedName: skill.scopedName,
    description: skill.description,
    author: skill.author,
    stars: skill.stars,
    githubUrl: skill.githubUrl,
    repoFullName: skill.repoFullName,
    path: skill.path,
    source: 'agentskills.in',
  };
}

/**
 * Marketplace adapter for the agentskills.in API.
 *
 * @remarks
 * Implements the {@link MarketplaceAdapter} interface to search and retrieve
 * skills from the agentskills.in marketplace. GitHub remains the actual
 * source for skill installation — this adapter provides discovery only.
 *
 * @public
 */
export class SkillsMPAdapter implements MarketplaceAdapter {
  /** The marketplace identifier used in search results. */
  name = 'agentskills.in';

  /**
   * Search for skills by query string.
   *
   * @param query - Search query to match against skill names and descriptions.
   * @param limit - Maximum number of results to return.
   * @returns Array of marketplace results sorted by stars.
   */
  async search(query: string, limit = 20): Promise<MarketplaceResult[]> {
    const params = new URLSearchParams({
      search: query,
      limit: String(limit),
      sortBy: 'stars',
    });

    const url = `${API_BASE}?${params}`;
    const response = ensureOkResponse(await fetchWithTimeout(url), url);
    const data = (await response.json()) as ApiResponse;
    return data.skills.map(toResult);
  }

  /**
   * Look up a specific skill by its scoped name.
   *
   * @param scopedName - The scoped skill name (e.g. `"@author/skill-name"`).
   * @returns The matching marketplace result, or `null` if not found.
   */
  async getSkill(scopedName: string): Promise<MarketplaceResult | null> {
    const parts = parseScopedName(scopedName);
    const searchTerms = parts
      ? [parts.name, `${parts.author} ${parts.name}`, scopedName]
      : [scopedName];

    const seen = new Set<string>();
    for (const term of searchTerms) {
      if (seen.has(term)) continue;
      seen.add(term);

      const params = new URLSearchParams({
        search: term,
        limit: '50',
        sortBy: 'stars',
      });

      const url = `${API_BASE}?${params}`;
      const response = ensureOkResponse(await fetchWithTimeout(url), url);
      const data = (await response.json()) as ApiResponse;
      const match = data.skills.find(
        (s) => s.scopedName === scopedName || `@${s.author}/${s.name}` === scopedName,
      );
      if (match) {
        return toResult(match);
      }
    }

    return null;
  }
}
