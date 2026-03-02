/**
 * Cross-reference management between BRAIN memory entries and tasks.
 *
 * Provides linking/unlinking and query functions for relationships
 * between decisions, patterns, learnings and CLEO tasks.
 *
 * @task T5156
 * @epic T5149
 */

import { getBrainAccessor } from '../../store/brain-accessor.js';
import type { BrainMemoryLinkRow } from '../../store/brain-schema.js';
import type {
  BrainDecisionRow,
  BrainPatternRow,
  BrainLearningRow,
} from '../../store/brain-schema.js';
import { BRAIN_MEMORY_TYPES, BRAIN_LINK_TYPES } from '../../store/brain-schema.js';

type MemoryType = (typeof BRAIN_MEMORY_TYPES)[number];
type LinkType = (typeof BRAIN_LINK_TYPES)[number];

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
 * @task T5156
 */
export async function linkMemoryToTask(
  projectRoot: string,
  memoryType: MemoryType,
  memoryId: string,
  taskId: string,
  linkType: LinkType,
): Promise<BrainMemoryLinkRow> {
  if (!memoryId || !taskId) {
    throw new Error('memoryId and taskId are required');
  }

  const accessor = await getBrainAccessor(projectRoot);

  // Check if link already exists
  const existingLinks = await accessor.getLinksForMemory(memoryType, memoryId);
  const duplicate = existingLinks.find(
    (l) => l.taskId === taskId && l.linkType === linkType,
  );

  if (duplicate) {
    return duplicate;
  }

  await accessor.addLink({
    memoryType,
    memoryId,
    taskId,
    linkType,
  });

  // Return the created link
  const links = await accessor.getLinksForMemory(memoryType, memoryId);
  return links.find(
    (l) => l.taskId === taskId && l.linkType === linkType,
  )!;
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
  let created = 0;
  let skipped = 0;

  for (const link of links) {
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
