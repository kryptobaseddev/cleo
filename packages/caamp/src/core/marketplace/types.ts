/**
 * Marketplace types shared between adapters
 */

/**
 * Contract that each marketplace backend adapter must implement.
 *
 * @public
 */
export interface MarketplaceAdapter {
  /** Human-readable adapter name (e.g. `"agentskills.in"`). */
  name: string;
  /** Search the marketplace for skills matching a query. */
  search(query: string, limit?: number): Promise<MarketplaceResult[]>;
  /** Retrieve a single skill by its scoped name. */
  getSkill(scopedName: string): Promise<MarketplaceResult | null>;
}

/**
 * Normalized marketplace record returned by all adapters.
 *
 * This model captures a single skill listing with enough information
 * for search display and install resolution to GitHub sources.
 */
/**
 * Normalized marketplace record returned by all adapters.
 *
 * @remarks
 * This model captures a single skill listing with enough information
 * for search display and install resolution to GitHub sources.
 *
 * @public
 */
export interface MarketplaceResult {
  /** Short skill name (e.g. `"memory"`). */
  name: string;
  /** Scoped name including author prefix (e.g. `"\@anthropic/memory"`). */
  scopedName: string;
  /** Short description of what the skill does. */
  description: string;
  /** Author or organization name. */
  author: string;
  /** GitHub star count. */
  stars: number;
  /** Full GitHub repository URL. */
  githubUrl: string;
  /** GitHub `owner/repo` path. */
  repoFullName: string;
  /** Path within the repository to the skill file. */
  path: string;
  /** Name of the marketplace source this result came from. */
  source: string;
}

/**
 * Options for marketplace search requests.
 *
 * @public
 */
export interface SearchOptions {
  /** Free-text search query. */
  query: string;
  /** Maximum number of results. @defaultValue `20` */
  limit?: number;
  /** Pagination offset. @defaultValue `0` */
  offset?: number;
  /** Sort order for results. @defaultValue `"stars"` */
  sortBy?: "stars" | "recent" | "name";
  /** Filter by skill category. @defaultValue `undefined` */
  category?: string;
  /** Filter by author name. @defaultValue `undefined` */
  author?: string;
}
