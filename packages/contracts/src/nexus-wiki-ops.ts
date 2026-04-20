/**
 * Nexus Wiki Index Operations - Contract Layer
 *
 * Defines types for generating a community-grouped wiki index
 * from the nexus code graph.
 *
 * @task T1060
 * @epic T1042
 */

/**
 * Statistics for a single community in the wiki index.
 */
export interface CommunityWikiStats {
  /** Community node ID (e.g. "community:42") */
  communityId: string;
  /** Number of symbols in this community */
  memberCount: number;
}

/**
 * Result of wiki index generation.
 */
export interface NexusWikiResult {
  /** Whether generation succeeded */
  success: boolean;
  /** Output directory where files were written */
  outputDir: string;
  /** Number of communities processed */
  communityCount: number;
  /** Total number of files written (community files + overview) */
  fileCount: number;
  /** Stats per community */
  communities: CommunityWikiStats[];
  /** Error message if success is false */
  error?: string;
}

/**
 * Symbol metadata as it appears in the wiki index.
 */
export interface WikiSymbolRow {
  /** Symbol name */
  name: string;
  /** Symbol kind (function, class, interface, etc.) */
  kind: string;
  /** File path relative to project root */
  filePath: string | null;
  /** Number of symbols that call this symbol */
  callerCount: number;
  /** Number of symbols this symbol calls */
  calleeCount: number;
}
