/**
 * Research Domain Operations (10 operations)
 *
 * Query operations: 6
 * Mutate operations: 4
 */

/**
 * Common research types
 */
export interface ResearchEntry {
  id: string;
  taskId: string;
  title: string;
  file: string;
  date: string;
  status: 'complete' | 'partial' | 'blocked';
  agentType: string;
  topics: string[];
  keyFindings: string[];
  actionable: boolean;
  needsFollowup: string[];
  linkedTasks: string[];
  confidence?: number;
}

export interface ManifestEntry {
  id: string;
  file: string;
  title: string;
  date: string;
  status: 'complete' | 'partial' | 'blocked';
  agent_type: string;
  topics: string[];
  key_findings: string[];
  actionable: boolean;
  needs_followup: string[];
  linked_tasks: string[];
}

/**
 * Query Operations
 */

// research.show
export interface ResearchShowParams {
  researchId: string;
}
export type ResearchShowResult = ResearchEntry;

// research.list
export interface ResearchListParams {
  epicId?: string;
  status?: 'complete' | 'partial' | 'blocked';
}
export type ResearchListResult = ResearchEntry[];

// research.query
export interface ResearchQueryParams {
  query: string;
  confidence?: number;
}
export interface ResearchQueryResult {
  entries: ResearchEntry[];
  matchCount: number;
  avgConfidence: number;
}

// research.pending
export interface ResearchPendingParams {
  epicId?: string;
}
export type ResearchPendingResult = ResearchEntry[];

// research.stats
export interface ResearchStatsParams {
  epicId?: string;
}
export interface ResearchStatsResult {
  total: number;
  complete: number;
  partial: number;
  blocked: number;
  byAgentType: Record<string, number>;
  byTopic: Record<string, number>;
  avgConfidence: number;
}

// research.manifest.read
export interface ResearchManifestReadParams {
  filter?: string;
  limit?: number;
}
export type ResearchManifestReadResult = ManifestEntry[];

/**
 * Mutate Operations
 */

// research.inject
export interface ResearchInjectParams {
  protocolType: 'research' | 'consensus' | 'specification' | 'decomposition' | 'implementation' | 'contribution' | 'release';
  taskId?: string;
  variant?: string;
}
export interface ResearchInjectResult {
  protocol: string;
  content: string;
  tokensUsed: number;
}

// research.link
export interface ResearchLinkParams {
  researchId: string;
  taskId: string;
  relationship?: 'supports' | 'blocks' | 'references' | 'supersedes';
}
export interface ResearchLinkResult {
  researchId: string;
  taskId: string;
  relationship: string;
  linked: string;
}

// research.manifest.append
export interface ResearchManifestAppendParams {
  entry: ManifestEntry;
  validateFile?: boolean;
}
export interface ResearchManifestAppendResult {
  id: string;
  appended: string;
  validated: boolean;
}

// research.manifest.archive
export interface ResearchManifestArchiveParams {
  beforeDate?: string;
  moveFiles?: boolean;
}
export interface ResearchManifestArchiveResult {
  archived: number;
  entryIds: string[];
  filesMovedCount?: number;
}
