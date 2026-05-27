/**
 * Types for cross-project task transfer via NEXUS.
 *
 * @task T046, T047
 * @epic T4540
 */

import type { Task } from '@cleocode/contracts';

/** Transfer mode: copy keeps source tasks, move archives them. */
export type TransferMode = 'copy' | 'move';

/** Transfer scope: single task or full subtree. */
export type TransferScope = 'single' | 'subtree';

/** Conflict resolution when target has tasks with duplicate titles. */
export type TransferOnConflict = 'duplicate' | 'rename' | 'skip' | 'fail';

/** How to handle missing dependencies in the target project. */
export type TransferOnMissingDep = 'strip' | 'fail';

/** Parameters for a cross-project transfer operation. */
export interface TransferParams {
  /** Task IDs to transfer from the source project. */
  taskIds: string[];
  /** Source project name or hash. */
  sourceProject: string;
  /** Target project name or hash. */
  targetProject: string;
  /** Copy (default) keeps source tasks; move archives them. */
  mode?: TransferMode;
  /** Single transfers individual tasks; subtree transfers tasks + all descendants. */
  scope?: TransferScope;
  /** How to handle title conflicts in the target. */
  onConflict?: TransferOnConflict;
  /** How to handle missing deps in the target. */
  onMissingDep?: TransferOnMissingDep;
  /** Whether to add provenance notes to transferred tasks. */
  provenance?: boolean;
  /** Override parent ID in target project. */
  targetParent?: string;
  /** Whether to transfer brain observations linked to source tasks. */
  transferBrain?: boolean;
  /** Dry run: preview without writing. */
  dryRun?: boolean;
}

/** A single task entry in the transfer manifest. */
export interface TransferManifestEntry {
  /** Original task ID in source project. */
  sourceId: string;
  /** New task ID in target project. */
  targetId: string;
  /** Task title. */
  title: string;
  /** Task type (task, epic, milestone, etc.). */
  type: string;
}

/** Manifest describing what was (or would be) transferred. */
export interface TransferManifest {
  /** Source project name. */
  sourceProject: string;
  /** Target project name. */
  targetProject: string;
  /** Transfer mode used. */
  mode: TransferMode;
  /** Transfer scope used. */
  scope: TransferScope;
  /** Tasks included in the transfer. */
  entries: TransferManifestEntry[];
  /** ID remap table: sourceId -> targetId. */
  idRemap: Record<string, string>;
  /** Number of brain observations transferred. */
  brainObservationsTransferred: number;
}

/** Result of a transfer operation. */
export interface TransferResult {
  /** Whether this was a dry run. */
  dryRun: boolean;
  /** Number of tasks transferred. */
  transferred: number;
  /** Number of tasks skipped (conflict resolution). */
  skipped: number;
  /** Number of source tasks archived (move mode only). */
  archived: number;
  /** Number of external links created. */
  linksCreated: number;
  /** Number of brain observations transferred. */
  brainObservationsTransferred: number;
  /** Transfer manifest with full details. */
  manifest: TransferManifest;
}

/** Options passed to importFromPackage (extracted from importTasksPackage). */
export interface ImportFromPackageOptions {
  /** Working directory for the target project. */
  cwd?: string;
  /** Dry run: preview without writing. */
  dryRun?: boolean;
  /** Parent task ID in target. */
  parent?: string;
  /** Phase override. */
  phase?: string;
  /** Label to add to imported tasks. */
  addLabel?: string;
  /** Whether to add provenance notes. */
  provenance?: boolean;
  /** Status to reset imported tasks to. */
  resetStatus?: Task['status'];
  /** Conflict resolution strategy. */
  onConflict?: TransferOnConflict;
  /** Missing dependency strategy. */
  onMissingDep?: TransferOnMissingDep;
  /** Force import (skip duplicate checks). */
  force?: boolean;
}

/** Result from importFromPackage. */
export interface ImportFromPackageResult {
  imported: number;
  skipped: number;
  idRemap: Record<string, string>;
  dryRun?: boolean;
  preview?: {
    tasks: Array<{ id: string; title: string; type: string }>;
  };
}
