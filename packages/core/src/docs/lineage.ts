/**
 * A doc's supersession chain and the work it serves (T14110).
 *
 * Everything is read from what the docs store already records — the
 * `supersedes` / `superseded_by` pointers that `docs supersede` writes, the
 * task refs that own the doc, and `related_tasks` (task ids its body names) —
 * so readers (`docs fetch`, the session briefing) can point from a replaced
 * doc to the one to read instead, and never surface a superseded doc as
 * current.
 *
 * @task T14110
 * @epic T14106
 */

import type { SearchBrainCompactResult } from '@cleocode/contracts/memory/search.js';
import type { DocsLineage } from '@cleocode/contracts/operations/docs.js';
import { eq } from 'drizzle-orm';
import { getDb } from '../store/sqlite.js';
import { attachmentRefs, attachments } from '../store/tasks-schema.js';

/** Hops followed along `superseded_by` before giving up (a cycle guard). */
export const DOC_LINEAGE_MAX_HOPS = 32;

/** Task ids in a JSON-array column, tolerating null and malformed values. */
function taskIdsOf(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === 'string' && /^T\d+$/.test(v))
      : [];
  } catch {
    return [];
  }
}

/**
 * Read a doc's lineage by slug.
 *
 * @param projectRoot - Project root.
 * @param slug - The doc's slug.
 * @returns The lineage, or null when no doc has the slug.
 */
export async function readDocLineage(
  projectRoot: string,
  slug: string,
): Promise<DocsLineage | null> {
  const db = await getDb(projectRoot);
  const row = await db.select().from(attachments).where(eq(attachments.slug, slug)).get();
  if (!row) return null;
  const slugOf = async (id: string | null): Promise<string | null> => {
    if (!id) return null;
    const hit = await db
      .select({ slug: attachments.slug })
      .from(attachments)
      .where(eq(attachments.id, id))
      .get();
    return hit?.slug ?? null;
  };

  // Walk superseded_by to the doc that is current now.
  let currentSlug = slug;
  let next = row.supersededBy ?? null;
  const seen = new Set<string>([row.id]);
  for (let hop = 0; next && !seen.has(next) && hop < DOC_LINEAGE_MAX_HOPS; hop += 1) {
    seen.add(next);
    const hit = await db
      .select({ slug: attachments.slug, supersededBy: attachments.supersededBy })
      .from(attachments)
      .where(eq(attachments.id, next))
      .get();
    if (!hit) break;
    if (hit.slug) currentSlug = hit.slug;
    next = hit.supersededBy ?? null;
  }

  const owners = await db
    .select({ ownerType: attachmentRefs.ownerType, ownerId: attachmentRefs.ownerId })
    .from(attachmentRefs)
    .where(eq(attachmentRefs.attachmentId, row.id))
    .all();
  const servesTasks = new Set<string>();
  for (const o of owners)
    if (o.ownerType === 'task' && /^T\d+$/.test(o.ownerId)) servesTasks.add(o.ownerId);
  for (const t of taskIdsOf(row.relatedTasks ?? null)) servesTasks.add(t);

  return {
    lifecycleStatus: row.lifecycleStatus,
    supersedes: await slugOf(row.supersedes ?? null),
    supersededBy: await slugOf(row.supersededBy ?? null),
    currentSlug,
    servesTasks: [...servesTasks].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))),
  };
}

/**
 * The current docs a task owns: each owner-attached doc resolved along its
 * `superseded_by` chain, so a superseded doc is never named (T14110).
 *
 * @param projectRoot - Project root.
 * @param taskId - The task id (`T####`).
 * @returns Current doc slugs, unique, in attachment order.
 */
export async function currentDocsForTask(projectRoot: string, taskId: string): Promise<string[]> {
  const { createAttachmentStore } = await import('../store/attachment-store.js');
  const store = createAttachmentStore();
  const out: string[] = [];
  for (const meta of await store.listByOwner('task', taskId, projectRoot)) {
    const slug = (await store.getExtras(meta.id, projectRoot))?.slug;
    if (!slug) continue;
    const current = (await readDocLineage(projectRoot, slug))?.currentSlug ?? slug;
    if (!out.includes(current)) out.push(current);
  }
  return out;
}

/**
 * The current docs linked to a decision through `decision_adr_links`, each
 * resolved along its `superseded_by` chain (T14110).
 *
 * @param projectRoot - Project root.
 * @param decisionId - The decision id (`D####`).
 * @returns Current doc slugs, unique.
 */
export async function currentDocsForDecision(
  projectRoot: string,
  decisionId: string,
): Promise<string[]> {
  const { listAdrLinksForDecision } = await import('../store/decision-adr-links.js');
  const out: string[] = [];
  for (const link of await listAdrLinksForDecision(projectRoot, decisionId)) {
    const current = (await readDocLineage(projectRoot, link.adrSlug))?.currentSlug ?? link.adrSlug;
    if (!out.includes(current)) out.push(current);
  }
  return out;
}

/**
 * Decisions a doc supersedes, derived from what exists (T14110 · D: Q1a):
 * the doc links the decision that replaced an older one, and that decision
 * records `supersedes` in BRAIN. No doc→decision edge is stored.
 *
 * @param projectRoot - Project root.
 * @param linkedDecisions - The doc's live linked `D####` decisions.
 * @returns The decision ids those decisions supersede, unique.
 */
export async function supersededDecisionsOf(
  projectRoot: string,
  linkedDecisions: readonly string[],
): Promise<string[]> {
  if (linkedDecisions.length === 0) return [];
  const { recallDecision } = await import('../memory/decisions.js');
  const out = new Set<string>();
  for (const id of linkedDecisions) {
    const decision = await recallDecision(projectRoot, id);
    if (decision?.supersedes) out.add(decision.supersedes);
  }
  return [...out];
}

/**
 * Attach current docs to a memory search result (T14110 · D: Q2a): each
 * decision hit gets its linked docs, and every task the query names or a
 * decision hit belongs to gets `taskDocs`. Superseded docs never appear;
 * their current doc does. Best-effort: a store that cannot be read leaves
 * the result as it was.
 *
 * @param projectRoot - Project root.
 * @param query - The search text (task ids in it are honoured).
 * @param result - The search result, enriched in place.
 */
export async function attachCurrentDocs(
  projectRoot: string,
  query: string,
  result: SearchBrainCompactResult,
): Promise<void> {
  try {
    const tasks = new Set<string>(query.match(/\bT\d{2,}\b/g) ?? []);
    const { recallDecision } = await import('../memory/decisions.js');
    for (const hit of result.results) {
      if (hit.type !== 'decision' || hit.scope === 'global') continue;
      const docs = await currentDocsForDecision(projectRoot, hit.id);
      if (docs.length > 0) hit.docs = docs;
      const taskId = (await recallDecision(projectRoot, hit.id))?.contextTaskId;
      if (taskId) tasks.add(taskId);
    }
    const taskDocs: Array<{ taskId: string; docs: string[] }> = [];
    for (const taskId of tasks) {
      const docs = await currentDocsForTask(projectRoot, taskId);
      if (docs.length > 0) taskDocs.push({ taskId, docs });
    }
    if (taskDocs.length > 0) result.taskDocs = taskDocs;
  } catch {
    // Docs store unavailable — search results stand on their own.
  }
}
