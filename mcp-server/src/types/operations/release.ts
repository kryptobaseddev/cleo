/**
 * Release Domain Operations (7 operations)
 *
 * All mutate operations
 */

/**
 * Common release types
 */
export type ReleaseType = 'major' | 'minor' | 'patch';

export interface ReleaseGate {
  name: string;
  description: string;
  passed: boolean;
  reason?: string;
}

export interface ChangelogSection {
  type: 'feat' | 'fix' | 'docs' | 'test' | 'refactor' | 'chore';
  entries: Array<{
    taskId: string;
    message: string;
  }>;
}

/**
 * Mutate Operations
 */

// release.prepare
export interface ReleasePrepareParams {
  version: string;
  type: ReleaseType;
}
export interface ReleasePrepareResult {
  version: string;
  type: ReleaseType;
  currentVersion: string;
  files: string[];
  ready: boolean;
  warnings: string[];
}

// release.changelog
export interface ReleaseChangelogParams {
  version: string;
  sections?: Array<'feat' | 'fix' | 'docs' | 'test' | 'refactor' | 'chore'>;
}
export interface ReleaseChangelogResult {
  version: string;
  content: string;
  sections: ChangelogSection[];
  commitCount: number;
}

// release.commit
export interface ReleaseCommitParams {
  version: string;
  files?: string[];
}
export interface ReleaseCommitResult {
  version: string;
  commitHash: string;
  message: string;
  filesCommitted: string[];
}

// release.tag
export interface ReleaseTagParams {
  version: string;
  message?: string;
}
export interface ReleaseTagResult {
  version: string;
  tagName: string;
  created: string;
}

// release.push
export interface ReleasePushParams {
  version: string;
  remote?: string;
}
export interface ReleasePushResult {
  version: string;
  remote: string;
  pushed: string;
  tagsPushed: string[];
}

// release.gates.run
export interface ReleaseGatesRunParams {
  gates?: string[];
}
export interface ReleaseGatesRunResult {
  total: number;
  passed: number;
  failed: number;
  gates: ReleaseGate[];
  canRelease: boolean;
}

// release.rollback
export interface ReleaseRollbackParams {
  version: string;
  reason: string;
}
export interface ReleaseRollbackResult {
  version: string;
  rolledBack: string;
  restoredVersion: string;
  reason: string;
}
