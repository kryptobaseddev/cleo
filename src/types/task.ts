/**
 * Task type definitions matching todo.schema.json (v2.10.0).
 * @epic T4454
 * @task T4456
 */

import type { TaskStatus } from '../store/status-registry.js';
export type { TaskStatus };

/** Task priority levels. */
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';

/** Task type in hierarchy. */
export type TaskType = 'epic' | 'task' | 'subtask';

/** Task size (scope, NOT time). */
export type TaskSize = 'small' | 'medium' | 'large';

/** Epic lifecycle states. */
export type EpicLifecycle = 'backlog' | 'planning' | 'active' | 'review' | 'released' | 'archived';

/** Task origin (provenance). */
export type TaskOrigin =
  | 'internal'
  | 'bug-report'
  | 'feature-request'
  | 'security'
  | 'technical-debt'
  | 'dependency'
  | 'regression';

/** Verification agent types. */
export type VerificationAgent = 'planner' | 'coder' | 'testing' | 'qa' | 'cleanup' | 'security' | 'docs';

/** Verification gate names. */
export type VerificationGate =
  | 'implemented'
  | 'testsPassed'
  | 'qaPassed'
  | 'cleanupDone'
  | 'securityPassed'
  | 'documented';

/** Verification failure log entry. */
export interface VerificationFailure {
  round: number;
  agent: string;
  reason: string;
  timestamp: string;
}

/** Task verification state. */
export interface TaskVerification {
  passed: boolean;
  round: number;
  gates: Partial<Record<VerificationGate, boolean | null>>;
  lastAgent: VerificationAgent | null;
  lastUpdated: string | null;
  failureLog: VerificationFailure[];
}

/** Task provenance tracking. */
export interface TaskProvenance {
  createdBy: string | null;
  modifiedBy: string | null;
  sessionId: string | null;
}

/** A single task relation entry. */
export interface TaskRelation {
  taskId: string;
  type: string;
  reason?: string;
}

/** A single CLEO task. */
export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  type?: TaskType;
  parentId?: string | null;
  position?: number | null;
  positionVersion?: number;
  size?: TaskSize | null;
  phase?: string;
  description?: string;
  files?: string[];
  acceptance?: string[];
  depends?: string[];
  relates?: TaskRelation[];
  epicLifecycle?: EpicLifecycle | null;
  noAutoComplete?: boolean | null;
  blockedBy?: string;
  notes?: string[];
  labels?: string[];
  origin?: TaskOrigin | null;
  createdAt: string;
  updatedAt?: string | null;
  completedAt?: string;
  cancelledAt?: string;
  cancellationReason?: string;
  verification?: TaskVerification | null;
  provenance?: TaskProvenance | null;
}

/** Phase status. */
export type PhaseStatus = 'pending' | 'active' | 'completed';

/** Phase definition. */
export interface Phase {
  order: number;
  name: string;
  description?: string;
  status: PhaseStatus;
  startedAt?: string | null;
  completedAt?: string | null;
}

/** Phase transition record. */
export interface PhaseTransition {
  phase: string;
  transitionType: 'started' | 'completed' | 'rollback';
  timestamp: string;
  taskCount: number;
  fromPhase?: string | null;
  reason?: string;
}

/** Release status. */
export type ReleaseStatus = 'planned' | 'active' | 'released';

/** Release definition. */
export interface Release {
  version: string;
  status: ReleaseStatus;
  targetDate?: string | null;
  releasedAt?: string | null;
  tasks: string[];
  notes?: string | null;
  changelog?: string | null;
}

/** Project metadata. */
export interface ProjectMeta {
  name: string;
  currentPhase?: string | null;
  phases: Record<string, Phase>;
  phaseHistory?: PhaseTransition[];
  releases?: Release[];
}

/** File metadata (_meta block). */
export interface FileMeta {
  schemaVersion: string;
  specVersion?: string;
  checksum: string;
  configVersion: string;
  lastSessionId?: string | null;
  activeSession?: string | null;
  activeSessionCount?: number;
  sessionsFile?: string | null;
  generation?: number;
}

/** Session note in taskWork block. */
export interface SessionNote {
  note: string;
  timestamp: string;
  conversationId?: string | null;
  agent?: string | null;
}

/** Task work state. */
export interface TaskWorkState {
  currentTask?: string | null;
  currentPhase?: string | null;
  blockedUntil?: string | null;
  sessionNote?: string | null;
  sessionNotes?: SessionNote[];
  nextAction?: string | null;
  primarySession?: string | null;
}

/** Root tasks.json structure. */
export interface TaskFile {
  version: string;
  project: ProjectMeta;
  lastUpdated: string;
  _meta: FileMeta;
  taskWork?: TaskWorkState;
  focus?: TaskWorkState;
  tasks: Task[];
  labels?: Record<string, string[]>;
}
