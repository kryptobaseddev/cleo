/**
 * RCASD-INDEX.json population and querying.
 *
 * Scans .cleo/rcasd/ and legacy .cleo/rcsd/ directories to build a master index of all RCASD
 * pipeline artifacts. Provides lookup functions for task-anchored artifacts,
 * specs, reports, and pipeline state.
 *
 * @task T4801
 * @epic T4798
 * @ref schemas/rcasd-index.schema.json (compat: rcsd-index.schema.json)
 */

import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoDirAbsolute } from '../paths.js';
import { readJsonFile, writeJsonFileAtomic } from '../../store/file-utils.js';
import type { RcasdManifest, ManifestStageData } from './index.js';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/** RCASD-INDEX.json top-level structure. */
export interface RcasdIndex {
  $schema: string;
  _meta: IndexMeta;
  authorities: Record<string, string>;
  taskAnchored: Record<string, TaskAnchor>;
  specs: SpecEntry[];
  reports: ReportEntry[];
  pipeline?: PipelineState;
  recentChanges?: ChangeEntry[];
}

/** Index metadata. */
export interface IndexMeta {
  version: string;
  lastUpdated: string;
  totals: IndexTotals;
  checksum?: string;
}

/** Aggregate counts. */
export interface IndexTotals {
  tasks: number;
  specs: number;
  reports: number;
  activeResearch: number;
  pendingConsensus: number;
}

/** Task-anchored RCASD artifact reference. */
export interface TaskAnchor {
  shortName: string;
  directory: string;
  spec?: string;
  report?: string;
  status?: 'active' | 'paused' | 'completed' | 'failed' | 'archived';
  pipelineStage: string;
  createdAt?: string;
  updatedAt?: string;
}

/** Specification entry. */
export interface SpecEntry {
  file: string;
  version: string;
  status: 'DRAFT' | 'APPROVED' | 'ACTIVE' | 'IMMUTABLE' | 'DEPRECATED';
  domain: string;
  taskId: string;
  lastUpdated: string;
  category?: string;
  shortName?: string;
  synopsis?: string;
}

/** Report entry. */
export interface ReportEntry {
  file: string;
  relatedSpec: string;
  taskId: string;
  progress: string;
  lastUpdated: string;
  phase?: string;
  notes?: string;
}

/** Pipeline state. */
export interface PipelineState {
  activeOperations: PipelineOperation[];
  queuedTasks: string[];
  lastCompleted?: {
    taskId: string;
    stage: string;
    completedAt: string;
  };
}

/** Active pipeline operation. */
export interface PipelineOperation {
  operationId: string;
  taskId: string;
  stage: string;
  startedAt: string;
  progress?: number;
  message?: string;
}

/** Change entry. */
export interface ChangeEntry {
  timestamp: string;
  taskId: string;
  changeType: string;
  stage?: string;
  description: string;
}

// =============================================================================
// INDEX POPULATION
// =============================================================================

/**
 * Scan .cleo/rcasd/ and legacy .cleo/rcsd/ directories and build the RCASD index.
 *
 * Reads all _manifest.json files and any spec/report markdown files to
 * produce a complete index.
 *
 * @param cwd - Working directory
 * @returns Populated RcasdIndex
 * @task T4801
 */
export function buildIndex(cwd?: string): RcasdIndex {
  const cleoDir = getCleoDirAbsolute(cwd);
  const lifecycleDirs = [join(cleoDir, 'rcasd'), join(cleoDir, 'rcsd')];
  const seenTaskIds = new Set<string>();

  const taskAnchored: Record<string, TaskAnchor> = {};
  const specs: SpecEntry[] = [];
  const reports: ReportEntry[] = [];
  let activeResearch = 0;
  let pendingConsensus = 0;
  let lastCompleted: PipelineState['lastCompleted'] | undefined;

  for (const lifecycleDir of lifecycleDirs) {
    if (!existsSync(lifecycleDir)) {
      continue;
    }
    const entries = readdirSync(lifecycleDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('T') || seenTaskIds.has(entry.name)) {
        continue;
      }

      const taskId = entry.name;
      seenTaskIds.add(taskId);
      const taskDir = join(lifecycleDir, taskId);

      // Read _manifest.json if it exists
      const manifestPath = join(taskDir, '_manifest.json');
      let manifest: RcasdManifest | null = null;

      if (existsSync(manifestPath)) {
        try {
          manifest = readJsonFile<RcasdManifest>(manifestPath);
        } catch {
          // Skip corrupted manifests
          continue;
        }
      }

      // Determine pipeline stage and status
      const { currentStage, status } = determinePipelineState(manifest);

      // Track research/consensus counts
      if (manifest?.stages) {
        const researchStatus = manifest.stages['research']?.status as string | undefined;
        const consensusStatus = manifest.stages['consensus']?.status as string | undefined;

        if (researchStatus && researchStatus !== 'completed' && researchStatus !== 'skipped') {
          activeResearch++;
        }
        if (researchStatus === 'completed' && (!consensusStatus || consensusStatus === 'not_started' || consensusStatus === 'pending')) {
          pendingConsensus++;
        }

        // Track last completed
        for (const [, stageData] of Object.entries(manifest.stages)) {
          if (stageData.status === 'completed' && stageData.completedAt) {
            if (!lastCompleted || stageData.completedAt > lastCompleted.completedAt) {
              lastCompleted = {
                taskId,
                stage: currentStage,
                completedAt: stageData.completedAt,
              };
            }
          }
        }
      }

      // Scan for spec and report files
      const files = readdirSync(taskDir).filter(f => f.endsWith('.md'));
      const specFile = files.find(f => f.includes('-SPEC.md') || f.includes('_spec'));
      const reportFile = files.find(f => f.includes('-REPORT.md') || f.includes('_report') || f.includes('_research'));

      // Derive short name from directory name
      const shortName = deriveShortName(taskId, manifest?.title);

      taskAnchored[taskId] = {
        shortName,
        directory: taskId,
        spec: specFile,
        report: reportFile,
        status,
        pipelineStage: currentStage,
        updatedAt: new Date().toISOString(),
      };

      // Add spec entry if found
      if (specFile) {
        specs.push({
          file: specFile,
          version: '1.0.0',
          status: status === 'completed' ? 'ACTIVE' : 'DRAFT',
          domain: shortName,
          taskId,
          lastUpdated: new Date().toISOString(),
        });
      }

      // Add report entry if found
      if (reportFile) {
        const relatedSpec = specFile || `${shortName}-SPEC.md`;
        reports.push({
          file: reportFile,
          relatedSpec,
          taskId,
          progress: status === 'completed' ? '100%' : 'Varies',
          lastUpdated: new Date().toISOString(),
        });
      }
    }
  }

  const now = new Date().toISOString();

  return {
    $schema: 'https://cleo-dev.com/schemas/v1/rcasd-index.schema.json',
    _meta: {
      version: '1.0.0',
      lastUpdated: now,
      totals: {
        tasks: Object.keys(taskAnchored).length,
        specs: specs.length,
        reports: reports.length,
        activeResearch,
        pendingConsensus,
      },
    },
    authorities: {},
    taskAnchored,
    specs,
    reports,
    pipeline: {
      activeOperations: [],
      queuedTasks: [],
      lastCompleted,
    },
    recentChanges: [],
  };
}

/**
 * Write RCASD-INDEX.json to disk.
 *
 * @param index - The index to write
 * @param cwd - Working directory
 * @task T4801
 */
export function writeIndex(index: RcasdIndex, cwd?: string): void {
  const cleoDir = getCleoDirAbsolute(cwd);
  if (!existsSync(cleoDir)) {
    mkdirSync(cleoDir, { recursive: true });
  }
  const indexPath = join(cleoDir, 'RCASD-INDEX.json');
  writeJsonFileAtomic(indexPath, index);
}

/**
 * Read RCASD-INDEX.json from disk.
 *
 * @param cwd - Working directory
 * @returns The index or null if not found
 * @task T4801
 */
export function readIndex(cwd?: string): RcasdIndex | null {
  const cleoDir = getCleoDirAbsolute(cwd);
  const indexPath = join(cleoDir, 'RCASD-INDEX.json');

  if (!existsSync(indexPath)) {
    return null;
  }

  try {
    return readJsonFile<RcasdIndex>(indexPath);
  } catch {
    return null;
  }
}

/**
 * Rebuild and write the index from current disk state.
 *
 * @param cwd - Working directory
 * @returns The rebuilt index
 * @task T4801
 */
export function rebuildIndex(cwd?: string): RcasdIndex {
  const index = buildIndex(cwd);
  writeIndex(index, cwd);
  return index;
}

// =============================================================================
// QUERYING
// =============================================================================

/**
 * Get task anchor by task ID.
 *
 * @param taskId - The task ID to look up
 * @param cwd - Working directory
 * @returns TaskAnchor or null
 * @task T4801
 */
export function getTaskAnchor(taskId: string, cwd?: string): TaskAnchor | null {
  const index = readIndex(cwd);
  return index?.taskAnchored[taskId] ?? null;
}

/**
 * Find tasks by pipeline stage.
 *
 * @param stage - The pipeline stage to filter by
 * @param cwd - Working directory
 * @returns Array of [taskId, anchor] pairs
 * @task T4801
 */
export function findByStage(stage: string, cwd?: string): Array<[string, TaskAnchor]> {
  const index = readIndex(cwd);
  if (!index) return [];

  return Object.entries(index.taskAnchored)
    .filter(([, anchor]) => anchor.pipelineStage === stage);
}

/**
 * Find tasks by status.
 *
 * @param status - The status to filter by
 * @param cwd - Working directory
 * @returns Array of [taskId, anchor] pairs
 * @task T4801
 */
export function findByStatus(
  status: 'active' | 'paused' | 'completed' | 'failed' | 'archived',
  cwd?: string,
): Array<[string, TaskAnchor]> {
  const index = readIndex(cwd);
  if (!index) return [];

  return Object.entries(index.taskAnchored)
    .filter(([, anchor]) => anchor.status === status);
}

/**
 * Get index summary statistics.
 *
 * @param cwd - Working directory
 * @returns Index totals or null
 * @task T4801
 */
export function getIndexTotals(cwd?: string): IndexTotals | null {
  const index = readIndex(cwd);
  return index?._meta.totals ?? null;
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

/**
 * Determine the current pipeline stage and status from a manifest.
 * @task T4801
 */
function determinePipelineState(manifest: RcasdManifest | null): {
  currentStage: string;
  status: 'active' | 'paused' | 'completed' | 'failed' | 'archived';
} {
  if (!manifest?.stages) {
    return { currentStage: 'initialized', status: 'active' };
  }

  // Walk stages in reverse order to find the most advanced completed stage
  const stageOrder = [
    'release', 'testing', 'validation', 'implementation',
    'decomposition', 'specification', 'consensus', 'research',
  ];

  let mostAdvancedCompleted: string | null = null;
  let hasFailed = false;
  let hasBlocked = false;

  for (const stageName of stageOrder) {
    const stageData: ManifestStageData | undefined = manifest.stages[stageName];
    if (!stageData) continue;

    if (stageData.status === 'completed') {
      if (!mostAdvancedCompleted) {
        mostAdvancedCompleted = stageName;
      }
    }
    if (stageData.status === 'blocked') hasBlocked = true;
  }

  // Determine current stage
  const currentStage = mostAdvancedCompleted || 'research';

  // Determine status
  let status: 'active' | 'paused' | 'completed' | 'failed' | 'archived';
  if (hasFailed) {
    status = 'failed';
  } else if (hasBlocked) {
    status = 'paused';
  } else if (mostAdvancedCompleted === 'release') {
    status = 'completed';
  } else {
    status = 'active';
  }

  return { currentStage, status };
}

/**
 * Derive a short kebab-case name from task ID and optional title.
 * @task T4801
 */
function deriveShortName(taskId: string, title?: string): string {
  if (title) {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 25);
  }
  return taskId.toLowerCase();
}
