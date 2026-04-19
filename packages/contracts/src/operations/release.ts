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
/**
 * Parameters for `release.prepare`.
 *
 * @remarks
 * Re-synced to match `prepareRelease(version, tasks?, notes?)` in
 * `packages/core/src/release/release-manifest.ts`. The legacy `type` field
 * was never accepted by the engine — the release manifest persists the
 * version as-is after normalization. Task filtering happens via the
 * optional `tasks` array (defaults to all tasks with `status=done`).
 *
 * @task T963 — contract↔impl drift reconciliation (T910 audit)
 */
export interface ReleasePrepareParams {
  /** Version string (e.g. `YYYY.M.patch` or `X.Y.Z`). @task T963 */
  version: string;
  /**
   * Specific task IDs to bundle into the release. When omitted, all
   * completed tasks with `completedAt` are included.
   * @task T963
   */
  tasks?: string[];
  /** Free-form release notes persisted onto the manifest entry. @task T963 */
  notes?: string;
}
/** Result of `release.prepare`. @task T963 */
export interface ReleasePrepareResult {
  /** Normalized version string. @task T963 */
  version: string;
  /** Manifest status — always `'prepared'` on success. @task T963 */
  status: string;
  /** Task IDs committed to the manifest. @task T963 */
  tasks: string[];
  /** Count of tasks in the release. @task T963 */
  taskCount: number;
}

// release.changelog
/** Parameters for `release.changelog`. @task T963 */
export interface ReleaseChangelogParams {
  /** Version to build the changelog for (must match an existing manifest). @task T963 */
  version: string;
  /** Filter emitted sections. @task T963 */
  sections?: Array<'feat' | 'fix' | 'docs' | 'test' | 'refactor' | 'chore'>;
}
/** Result of `release.changelog`. @task T963 */
export interface ReleaseChangelogResult {
  /** Version. @task T963 */
  version: string;
  /** Rendered changelog content (Markdown). @task T963 */
  content: string;
  /** Grouped changelog sections. @task T963 */
  sections: ChangelogSection[];
  /** Count of commits aggregated. @task T963 */
  commitCount: number;
}

// release.commit
/** Parameters for `release.commit`. @task T963 */
export interface ReleaseCommitParams {
  /** Version tag being committed. @task T963 */
  version: string;
  /** Files associated with the commit. @task T963 */
  files?: string[];
}
/** Result of `release.commit`. @task T963 */
export interface ReleaseCommitResult {
  /** Version. @task T963 */
  version: string;
  /** Git commit hash. @task T963 */
  commitHash: string;
  /** Commit message. @task T963 */
  message: string;
  /** Files actually committed. @task T963 */
  filesCommitted: string[];
}

// release.tag
/** Parameters for `release.tag`. @task T963 */
export interface ReleaseTagParams {
  /** Version being tagged. @task T963 */
  version: string;
  /** Tag message (annotated tag). @task T963 */
  message?: string;
}
/** Result of `release.tag`. @task T963 */
export interface ReleaseTagResult {
  /** Version. @task T963 */
  version: string;
  /** Tag name created. @task T963 */
  tagName: string;
  /** ISO 8601 creation timestamp. @task T963 */
  created: string;
}

// release.push
/** Parameters for `release.push`. @task T963 */
export interface ReleasePushParams {
  /** Version being pushed. @task T963 */
  version: string;
  /** Git remote name. Defaults to `origin`. @task T963 */
  remote?: string;
}
/** Result of `release.push`. @task T963 */
export interface ReleasePushResult {
  /** Version. @task T963 */
  version: string;
  /** Remote that received the push. @task T963 */
  remote: string;
  /** ISO 8601 push timestamp. @task T963 */
  pushed: string;
  /** Tags that were pushed alongside. @task T963 */
  tagsPushed: string[];
}

// release.gates.run
/** Parameters for `release.gates.run`. @task T963 */
export interface ReleaseGatesRunParams {
  /** Specific gate names to run. Omit to run all. @task T963 */
  gates?: string[];
}
/** Result of `release.gates.run`. @task T963 */
export interface ReleaseGatesRunResult {
  /** Total gates evaluated. @task T963 */
  total: number;
  /** Gates that passed. @task T963 */
  passed: number;
  /** Gates that failed. @task T963 */
  failed: number;
  /** Full per-gate report. @task T963 */
  gates: ReleaseGate[];
  /** True when every gate passed. @task T963 */
  canRelease: boolean;
}

// release.rollback
/** Parameters for `release.rollback`. @task T963 */
export interface ReleaseRollbackParams {
  /** Version to roll back. @task T963 */
  version: string;
  /** Human-readable reason for the rollback. @task T963 */
  reason: string;
}
/** Result of `release.rollback`. @task T963 */
export interface ReleaseRollbackResult {
  /** Version that was rolled back. @task T963 */
  version: string;
  /** ISO 8601 rollback timestamp. @task T963 */
  rolledBack: string;
  /** Version that is now current. @task T963 */
  restoredVersion: string;
  /** Rollback reason. @task T963 */
  reason: string;
}
