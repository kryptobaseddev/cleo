/**
 * Task Engine Converters — Core Task Record Conversion Utilities
 *
 * Provides converter functions that map between the core Task domain type
 * and the backward-compatible TaskRecord format used by the dispatch layer,
 * as well as interface types for lifecycle and IVTR history entries.
 *
 * Moved from packages/cleo/src/dispatch/engines/task-engine.ts as part of
 * the T1566 engine-migration epic (ADR-057, ADR-058).
 *
 * @task T1568
 * @epic T1566
 * @adr ADR-057
 * @adr ADR-058
 */

import type { Task, TaskRecord, TaskRecordRelation } from '@cleocode/contracts';
import type { IvtrPhase, IvtrPhaseEntry } from '../lifecycle/ivtr-loop.js';

/**
 * A single lifecycle stage transition entry returned by taskShowWithHistory.
 * Maps the `getLifecycleStatus` stage shape into a stable, typed record.
 *
 * @task T1568
 * @epic T1566
 */
export interface LifecycleStageEntry {
  /** Canonical stage name (e.g. "research", "implementation"). */
  stage: string;
  /** Current status of this stage. */
  status: 'not_started' | 'in_progress' | 'completed' | 'skipped' | 'failed';
  /** ISO timestamp when the stage was started, or null. */
  startedAt: string | null;
  /** ISO timestamp when the stage was completed, or null. */
  completedAt: string | null;
  /** Output file path recorded for this stage, or null. */
  outputFile: string | null;
}

/**
 * A single IVTR phase entry returned by taskCompleteStrict and taskShowIvtrHistory.
 * Surface-safe projection of IvtrPhaseEntry with renamed agentIdentity → agent.
 *
 * @task T1568
 * @epic T1566
 */
export interface IvtrHistoryEntry {
  /** Phase name (implement | validate | test | released). */
  phase: IvtrPhase;
  /** Agent identity string, or null if unknown. */
  agent: string | null;
  /** ISO timestamp when this phase was started. */
  startedAt: string;
  /** ISO timestamp when this phase was completed, or null if still active. */
  completedAt: string | null;
  /** Whether this phase passed. null = in-progress. */
  passed: boolean | null;
  /** sha256 hashes of evidence attachments for this phase. */
  evidenceRefs: string[];
}

/**
 * Convert a core Task to a TaskRecord for backward compatibility.
 * TaskRecord has string-typed status/priority; Task has union types.
 *
 * @param task - The core Task domain object to convert
 * @returns TaskRecord compatible with the dispatch layer's response format
 *
 * @task T1568
 * @epic T1566
 */
export function taskToRecord(task: Task): TaskRecord {
  // Task union-typed fields (status, priority, origin, etc.) widen to string in TaskRecord.
  // Some fields have structural mismatches (blockedBy: string vs string[], etc.)
  // so we explicitly map each field rather than relying on spread.
  const relates: TaskRecordRelation[] | undefined = task.relates?.map((r) => ({
    taskId: r.taskId,
    type: r.type,
    ...(r.reason && { reason: r.reason }),
  }));
  return {
    id: task.id,
    title: task.title,
    description: task.description ?? '',
    status: task.status,
    priority: task.priority,
    type: task.type,
    phase: task.phase,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt ?? null,
    completedAt: task.completedAt ?? null,
    cancelledAt: task.cancelledAt ?? null,
    parentId: task.parentId,
    position: task.position,
    positionVersion: task.positionVersion,
    depends: task.depends,
    relates,
    files: task.files,
    acceptance: task.acceptance?.filter((a): a is string => typeof a === 'string'),
    notes: task.notes,
    labels: task.labels,
    size: task.size ?? null,
    epicLifecycle: task.epicLifecycle ?? null,
    noAutoComplete: task.noAutoComplete ?? null,
    verification: task.verification ? { ...task.verification } : null,
    origin: task.origin ?? null,
    cancellationReason: task.cancellationReason,
    blockedBy: task.blockedBy ? [task.blockedBy] : undefined,
    pipelineStage: task.pipelineStage ?? null,
    // T944: orthogonal axes
    role: task.role ?? null,
    scope: task.scope ?? null,
    severity: task.severity ?? null,
  };
}

/**
 * Convert an array of core Tasks to TaskRecords.
 *
 * @param tasks - Array of core Task domain objects to convert
 * @returns Array of TaskRecords compatible with the dispatch layer
 *
 * @task T1568
 * @epic T1566
 */
export function tasksToRecords(tasks: Task[]): TaskRecord[] {
  return tasks.map(taskToRecord);
}

/**
 * Project IvtrPhaseEntry to the surface-safe IvtrHistoryEntry shape.
 *
 * @param e - The IVTR phase entry from the core lifecycle module
 * @returns Surface-safe projection with renamed agentIdentity → agent
 *
 * @task T1568
 * @epic T1566
 */
export function toHistoryEntry(e: IvtrPhaseEntry): IvtrHistoryEntry {
  return {
    phase: e.phase,
    agent: e.agentIdentity,
    startedAt: e.startedAt,
    completedAt: e.completedAt,
    passed: e.passed,
    evidenceRefs: e.evidenceRefs,
  };
}
