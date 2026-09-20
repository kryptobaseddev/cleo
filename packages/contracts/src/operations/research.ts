/**
 * Research Domain Operations (legacy alias for memory domain)
 *
 * Query operations: 12 (derived from memory domain)
 * Mutate operations: 5 (derived from memory domain)
 *
 * Note: manifest.* operations moved to pipeline domain (T5241).
 * inject operation moved to session.context.inject (T5241).
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
  status: 'completed' | 'partial' | 'blocked';
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
  status: 'completed' | 'partial' | 'blocked';
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
  status?: 'completed' | 'partial' | 'blocked';
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

// pipeline.manifest.list (was research.manifest.read, moved to pipeline T5241)
export interface ResearchManifestReadParams {
  filter?: string;
  limit?: number;
  offset?: number;
}
export type ResearchManifestReadResult = ManifestEntry[];

/**
 * Mutate Operations
 */

// session.context.inject (was research.inject, moved to session domain T5241)
export interface ResearchInjectParams {
  protocolType:
    | 'research'
    | 'consensus'
    | 'specification'
    | 'decomposition'
    | 'implementation'
    | 'contribution'
    | 'release';
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

// pipeline.manifest.append (was research.manifest.append, moved to pipeline T5241)
export interface ResearchManifestAppendParams {
  entry: ManifestEntry;
  validateFile?: boolean;
}
export interface ResearchManifestAppendResult {
  id: string;
  appended: string;
  validated: boolean;
}

// pipeline.manifest.archive (was research.manifest.archive, moved to pipeline T5241)
export interface ResearchManifestArchiveParams {
  beforeDate?: string;
  moveFiles?: boolean;
}
export interface ResearchManifestArchiveResult {
  archived: number;
  entryIds: string[];
  filesMovedCount?: number;
}

/** Physical manifest table contributing authentic stored evidence.
 * @remarks Table identity does not imply scientific or decision authority.
 * @example
 * ```ts
 * const table: ManifestStorageTable = 'docs_pipeline_manifest';
 * ```
 */
export type ManifestStorageTable = 'docs_pipeline_manifest' | 'pipeline_manifest';

/** Physical provenance of a manifest read; multiple tables imply identical stored payloads.
 * @remarks Database identity is observed on the captured project binding; tables are not inferred from recency.
 * @example
 * ```ts
 * const source: ManifestStorageProvenance = { databasePath: '/project/.cleo/cleo.db', tables: ['docs_pipeline_manifest'] };
 * ```
 */
export interface ManifestStorageProvenance {
  /** Absolute path of the canonical project database actually read. */
  databasePath: string;
  /** Tables containing byte-equivalent persisted rows, modern first. */
  tables: ManifestStorageTable[];
}

/** Existing manifest data augmented with its storage provenance.
 * @typeParam T - Existing row or public entry contract.
 * @remarks Adds provenance without replacing the existing manifest result fields.
 * @example
 * ```ts
 * type SourcedEntry = ManifestWithProvenance<ManifestEntry>;
 * ```
 */
export type ManifestWithProvenance<T> = T & {
  /** Observed physical storage sources; never an authority ranking. */
  provenance: ManifestStorageProvenance;
};
