/**
 * TaskRecord — string-widened version of Task for JSON serialization in dispatch/LAFS layer.
 *
 * Union-typed fields (status, priority, origin, etc.) are widened to string
 * so that the dispatch layer does not need to validate enum membership.
 *
 * @task T4657
 * @epic T4654
 */

import type { TaskVerification } from './task.js';

/** A single task relation entry (string-widened version). */
export interface TaskRecordRelation {
  taskId: string;
  type: string;
  reason?: string;
}

/** Validation history entry. */
export interface ValidationHistoryEntry {
  round: number;
  agent: string;
  result: string;
  timestamp: string;
}

/** String-widened Task for JSON serialization in dispatch/LAFS layer. */
export interface TaskRecord {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  type?: string;
  phase?: string;
  createdAt: string;
  updatedAt: string | null;
  completedAt?: string | null;
  cancelledAt?: string | null;
  parentId?: string | null;
  position?: number | null;
  positionVersion?: number;
  depends?: string[];
  relates?: TaskRecordRelation[];
  files?: string[];
  acceptance?: string[];
  notes?: string[];
  labels?: string[];
  size?: string | null;
  epicLifecycle?: string | null;
  noAutoComplete?: boolean | null;
  verification?: TaskVerification | null;
  origin?: string | null;
  createdBy?: string | null;
  validatedBy?: string | null;
  testedBy?: string | null;
  lifecycleState?: string | null;
  validationHistory?: ValidationHistoryEntry[];
  blockedBy?: string[];
  cancellationReason?: string;
}

/** Minimal task representation for find results. */
export interface MinimalTaskRecord {
  id: string;
  title: string;
  status: string;
  priority: string;
  parentId?: string | null;
}
