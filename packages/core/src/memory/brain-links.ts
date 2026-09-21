/**
 * Cross-reference management between BRAIN memory entries and tasks.
 *
 * Provides linking/unlinking and query functions for relationships
 * between decisions, patterns, learnings and CLEO tasks.
 *
 * @task T5156
 * @epic T5149
 */

import { statSync } from 'node:fs';
import { captureProjectScope, worktreeScope } from '../project-scope.js';
import { taskExistsInTasksDb, taskExistsInTasksDbFresh } from '../store/cross-db-cleanup.js';
import { BrainDataAccessor, getBrainAccessor } from '../store/memory-accessor.js';
import { peekProjectDomain } from '../store/ports/domain-binding.js';
import type {
  BRAIN_LINK_TYPES,
  BRAIN_MEMORY_TYPES,
  BrainDecisionRow,
  BrainLearningRow,
  BrainMemoryLinkRow,
  BrainPatternRow,
} from '../store/schema/memory-schema.js';
import { getDb } from '../store/sqlite.js';

type MemoryType = (typeof BRAIN_MEMORY_TYPES)[number];
type LinkType = (typeof BRAIN_LINK_TYPES)[number];

/** Authenticate the already-bound consolidated handle without reopening a moved path. */
function retainedLinkAccessor(
  projectRoot: string,
  tasksDb: Awaited<ReturnType<typeof getDb>>,
): BrainDataAccessor {
  const scope = captureProjectScope(projectRoot, worktreeScope.getStore());
  const binding = worktreeScope.run(scope, () =>
    peekProjectDomain<Awaited<ReturnType<typeof getDb>>>('tasks', scope.worktreeRoot),
  );
  if (!binding || binding.db !== tasksDb || !binding.store.isOpen || !binding.native.isOpen) {
    throw new Error('Retained task handle is closed or does not belong to this project binding');
  }
  const identity = binding.store.identity;
  if (identity.scope !== 'project' || !identity.fileDevice || !identity.fileInode) {
    throw new Error('Retained task handle has no authenticated consolidated file identity');
  }
  const current = statSync(identity.dbPath, { bigint: true, throwIfNoEntry: false });
  if (
    current &&
    (String(current.dev) !== identity.fileDevice || String(current.ino) !== identity.fileInode)
  ) {
    throw new Error('Retained task handle refers to a replaced database generation');
  }
  const table = binding.native
    .prepare(
      "SELECT name FROM main.sqlite_schema WHERE type = 'table' AND name = 'brain_memory_links'",
    )
    .get();
  if (!table)
    throw new Error('Retained consolidated database lacks required brain_memory_links schema');
  return new BrainDataAccessor(tasksDb);
}

async function createMemoryTaskLink(
  projectRoot: string,
  memoryType: MemoryType,
  memoryId: string,
  taskId: string,
  linkType: LinkType,
  retained?: BrainDataAccessor,
): Promise<BrainMemoryLinkRow> {
  const accessor = retained ?? (await getBrainAccessor(projectRoot));

  const existingLinks = await accessor.getLinksForMemory(memoryType, memoryId);
  const duplicate = existingLinks.find((l) => l.taskId === taskId && l.linkType === linkType);
  if (duplicate) return duplicate;

  await accessor.addLink({
    memoryType,
    memoryId,
    taskId,
    linkType,
  });

  const links = await accessor.getLinksForMemory(memoryType, memoryId);
  return links.find((l) => l.taskId === taskId && l.linkType === linkType)!;
}

/** A link to be created in bulk. */
export interface BulkLinkEntry {
  memoryType: MemoryType;
  memoryId: string;
  taskId: string;
  linkType: LinkType;
}

/**
 * Link a memory entry to a task.
 *
 * @param projectRoot - Project root containing the task and brain databases.
 * @param memoryType - Type of memory entry to link.
 * @param memoryId - Memory entry identifier.
 * @param taskId - Task identifier to validate and link.
 * @param linkType - Relationship represented by the link.
 * @param tasksDbOverride - Existing task handle retained by a multi-step caller.
 * @returns The existing or newly created memory link.
 * @task T5156 T12034
 */
export async function linkMemoryToTask(
  projectRoot: string,
  memoryType: MemoryType,
  memoryId: string,
  taskId: string,
  linkType: LinkType,
  tasksDbOverride?: Awaited<ReturnType<typeof getDb>>,
): Promise<BrainMemoryLinkRow> {
  if (!memoryId || !taskId) {
    throw new Error('memoryId and taskId are required');
  }

  const retained = tasksDbOverride ? retainedLinkAccessor(projectRoot, tasksDbOverride) : undefined;

  // Write-guard: reject stale task IDs before creating cross-db reference
  let taskExists: boolean | undefined;
  let tasksDb: Awaited<ReturnType<typeof getDb>> | null = null;
  try {
    tasksDb = tasksDbOverride ?? (await getDb(projectRoot));
    if (await taskExistsInTasksDb(taskId, tasksDb)) {
      taskExists = true;
    }
  } catch {
    // The independent probe below handles a closed shared handle.
  }
  if (taskExists !== true) {
    try {
      taskExists = await taskExistsInTasksDbFresh(taskId, tasksDb, projectRoot);
    } catch {
      // Validation unavailable is not proof of absence. Preserve the link.
    }
  }
  if (taskExists === false) {
    throw new Error(
      `Write-guard: task ${taskId} does not exist in tasks.db — refusing to create brain link`,
    );
  }

  return createMemoryTaskLink(projectRoot, memoryType, memoryId, taskId, linkType, retained);
}

/**
 * Link memory to a task whose existence was validated before a multi-write batch.
 *
 * This preserves the soft-FK decision across queued BRAIN writes that may replace
 * the caller's shared project handle. Callers MUST validate the task immediately
 * before starting the batch; general callers should use {@link linkMemoryToTask}.
 *
 * @param projectRoot - Project root containing the consolidated database.
 * @param memoryType - Type of memory entry to link.
 * @param memoryId - Memory entry identifier.
 * @param taskId - Prevalidated task identifier.
 * @param linkType - Relationship represented by the link.
 * @returns The existing or newly created memory link.
 * @task T12034
 */
export async function linkPrevalidatedMemoryToTask(
  projectRoot: string,
  memoryType: MemoryType,
  memoryId: string,
  taskId: string,
  linkType: LinkType,
): Promise<BrainMemoryLinkRow> {
  if (!memoryId || !taskId) {
    throw new Error('memoryId and taskId are required');
  }
  return createMemoryTaskLink(projectRoot, memoryType, memoryId, taskId, linkType);
}

/**
 * Remove a link between a memory entry and a task.
 *
 * @task T5156
 */
export async function unlinkMemoryFromTask(
  projectRoot: string,
  memoryType: MemoryType,
  memoryId: string,
  taskId: string,
  linkType: LinkType,
): Promise<void> {
  const accessor = await getBrainAccessor(projectRoot);
  await accessor.removeLink(memoryType, memoryId, taskId, linkType);
}

/**
 * Get all memory entries linked to a specific task.
 *
 * @task T5156
 */
export async function getTaskLinks(
  projectRoot: string,
  taskId: string,
): Promise<BrainMemoryLinkRow[]> {
  const accessor = await getBrainAccessor(projectRoot);
  return accessor.getLinksForTask(taskId);
}

/**
 * Get all tasks linked to a specific memory entry.
 *
 * @task T5156
 */
export async function getMemoryLinks(
  projectRoot: string,
  memoryType: MemoryType,
  memoryId: string,
): Promise<BrainMemoryLinkRow[]> {
  const accessor = await getBrainAccessor(projectRoot);
  return accessor.getLinksForMemory(memoryType, memoryId);
}

/**
 * Batch create multiple links at once.
 *
 * @task T5156
 */
export async function bulkLink(
  projectRoot: string,
  links: BulkLinkEntry[],
): Promise<{ created: number; skipped: number }> {
  const accessor = await getBrainAccessor(projectRoot);
  const tasksDb = await getDb(projectRoot);
  let created = 0;
  let skipped = 0;

  for (const link of links) {
    // Write-guard: reject stale task IDs before creating cross-db reference
    if (!(await taskExistsInTasksDb(link.taskId, tasksDb))) {
      skipped++;
      continue;
    }

    // Check for duplicate
    const existing = await accessor.getLinksForMemory(link.memoryType, link.memoryId);
    const duplicate = existing.find(
      (l) => l.taskId === link.taskId && l.linkType === link.linkType,
    );

    if (duplicate) {
      skipped++;
      continue;
    }

    await accessor.addLink({
      memoryType: link.memoryType,
      memoryId: link.memoryId,
      taskId: link.taskId,
      linkType: link.linkType,
    });
    created++;
  }

  return { created, skipped };
}

/**
 * Get all decisions linked to a task.
 * Convenience method that fetches full decision rows.
 *
 * @task T5156
 */
export async function getLinkedDecisions(
  projectRoot: string,
  taskId: string,
): Promise<BrainDecisionRow[]> {
  const accessor = await getBrainAccessor(projectRoot);
  const links = await accessor.getLinksForTask(taskId);
  const decisionLinks = links.filter((l) => l.memoryType === 'decision');

  const decisions: BrainDecisionRow[] = [];
  for (const link of decisionLinks) {
    const decision = await accessor.getDecision(link.memoryId);
    if (decision) {
      decisions.push(decision);
    }
  }
  return decisions;
}

/**
 * Get all patterns linked to a task.
 * Convenience method that fetches full pattern rows.
 *
 * @task T5156
 */
export async function getLinkedPatterns(
  projectRoot: string,
  taskId: string,
): Promise<BrainPatternRow[]> {
  const accessor = await getBrainAccessor(projectRoot);
  const links = await accessor.getLinksForTask(taskId);
  const patternLinks = links.filter((l) => l.memoryType === 'pattern');

  const patterns: BrainPatternRow[] = [];
  for (const link of patternLinks) {
    const pattern = await accessor.getPattern(link.memoryId);
    if (pattern) {
      patterns.push(pattern);
    }
  }
  return patterns;
}

/**
 * Get all learnings linked to a task.
 * Convenience method that fetches full learning rows.
 *
 * @task T5156
 */
export async function getLinkedLearnings(
  projectRoot: string,
  taskId: string,
): Promise<BrainLearningRow[]> {
  const accessor = await getBrainAccessor(projectRoot);
  const links = await accessor.getLinksForTask(taskId);
  const learningLinks = links.filter((l) => l.memoryType === 'learning');

  const learnings: BrainLearningRow[] = [];
  for (const link of learningLinks) {
    const learning = await accessor.getLearning(link.memoryId);
    if (learning) {
      learnings.push(learning);
    }
  }
  return learnings;
}
