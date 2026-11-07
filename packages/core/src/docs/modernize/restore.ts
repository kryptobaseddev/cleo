/**
 * Exact store restores for `cleo docs modernize --rollback` (T14113).
 *
 * Apply records the values a step replaced (`DocsModernizeOpPrior`); these
 * helpers read those values before a step and put them back afterwards, so a
 * rollback restores the registry rows as they were rather than writing a new
 * version on top.
 *
 * @task T14113
 * @epic T14106
 */

import type { DocsModernizeOpPrior } from '@cleocode/contracts';
import { and, eq } from 'drizzle-orm';
import { createAttachmentStore } from '../../store/attachment-store.js';
import { getDb } from '../../store/sqlite.js';
import {
  ATTACHMENT_LIFECYCLE_STATUSES,
  type AttachmentLifecycleStatus,
  attachments,
} from '../../store/tasks-schema.js';

/** Narrow a stored string to a lifecycle status, defaulting to `draft`. */
function asStatus(value: string | null | undefined): AttachmentLifecycleStatus {
  return ATTACHMENT_LIFECYCLE_STATUSES.find((s) => s === value) ?? 'draft';
}

/**
 * The supersession pointers a `supersedeDoc(old, new)` will replace.
 *
 * @param projectRoot - Project root.
 * @param oldSlug - Doc about to be superseded.
 * @param newSlug - Doc about to supersede it.
 * @returns The prior values, or null when either slug is unknown.
 */
export async function readSupersessionPrior(
  projectRoot: string,
  oldSlug: string,
  newSlug: string,
): Promise<DocsModernizeOpPrior | null> {
  const db = await getDb(projectRoot);
  const older = await db.select().from(attachments).where(eq(attachments.slug, oldSlug)).get();
  const newer = await db.select().from(attachments).where(eq(attachments.slug, newSlug)).get();
  if (!older || !newer) return null;
  return {
    lifecycleStatus: older.lifecycleStatus,
    supersededBy: older.supersededBy ?? null,
    supersedes: newer.supersedes ?? null,
  };
}

/**
 * Put back the pointers and status a supersede replaced, unless that would
 * leave `superseded` (T14333).
 *
 * `superseded` is absorbing (`docs.lifecycle.transitions`, no leave op): every
 * replica refuses a write that moves a row out of it, on the registry and on
 * the identity row alike. An undo that rewrote the older doc back to its prior
 * status would therefore hold here and nowhere else: a permanent divergence.
 * So a supersession that landed is kept on the older doc: it stays superseded
 * with its successor, and the caller reports it. The newer doc's back pointer
 * (plain LWW, no absorbing state) is still restored, so a rollback that then
 * removes the older doc leaves no dangling pointer. A supersession that never landed (the older doc is not
 * superseded) is restored as before, and so is one whose prior state was
 * superseded already (the successor pointer moves within the state).
 *
 * @param projectRoot - Project root.
 * @param oldSlug - The superseded doc.
 * @param newSlug - The superseding doc.
 * @param prior - Values recorded by {@link readSupersessionPrior}.
 * @returns `kept` when the landed supersession was left in place.
 * @task T14333
 */
export async function restoreSupersession(
  projectRoot: string,
  oldSlug: string,
  newSlug: string,
  prior: DocsModernizeOpPrior,
): Promise<'restored' | 'kept'> {
  const db = await getDb(projectRoot);
  const older = await db.select().from(attachments).where(eq(attachments.slug, oldSlug)).get();
  const newer = await db.select().from(attachments).where(eq(attachments.slug, newSlug)).get();
  // @sync-invariant docs.lifecycle.transitions an undo never moves a row out of superseded; every replica would refuse it
  const kept =
    older?.lifecycleStatus === 'superseded' && asStatus(prior.lifecycleStatus) !== 'superseded';
  db.transaction((tx) => {
    if (older && !kept) {
      tx.update(attachments)
        .set({
          supersededBy: prior.supersededBy ?? null,
          lifecycleStatus: asStatus(prior.lifecycleStatus),
        })
        .where(eq(attachments.id, older.id))
        .run();
    }
    if (newer) {
      tx.update(attachments)
        .set({ supersedes: prior.supersedes ?? null })
        .where(eq(attachments.id, newer.id))
        .run();
    }
  });
  // T14288: both docs' identity rows carry the restored supersession.
  const { mirrorConduitDocMeta } = await import('../../store/conduit-doc-history.js');
  if (older && !kept) await mirrorConduitDocMeta(projectRoot, { rowId: older.id });
  if (newer) await mirrorConduitDocMeta(projectRoot, { rowId: newer.id });
  return kept ? 'kept' : 'restored';
}

/**
 * Undo a `docs update` of `slug`: give the slug back to the row that held it
 * and drop the refs the update copied onto the new row (the new row is purged
 * when none remain). The new row must have been created by that update.
 *
 * @param projectRoot - Project root.
 * @param slug - The updated slug.
 * @param prior - `previousAttachmentId` and `newAttachmentId` from the merge op.
 */
export async function revertDocUpdate(
  projectRoot: string,
  slug: string,
  prior: DocsModernizeOpPrior,
): Promise<void> {
  const previous = prior.previousAttachmentId;
  const created = prior.newAttachmentId;
  if (!previous || !created) return;
  const store = createAttachmentStore();
  const refs = await store.listRefs(previous, projectRoot);
  const db = await getDb(projectRoot);
  db.transaction((tx) => {
    tx.update(attachments)
      .set({ slug: null })
      .where(and(eq(attachments.id, created), eq(attachments.slug, slug)))
      .run();
    tx.update(attachments).set({ slug }).where(eq(attachments.id, previous)).run();
  });
  // T14288: the doc's identity row carries the restored row's metadata.
  const { mirrorConduitDocMeta } = await import('../../store/conduit-doc-history.js');
  await mirrorConduitDocMeta(projectRoot, { rowId: previous });
  for (const ref of refs) await store.deref(created, ref.ownerType, ref.ownerId, projectRoot);
  // The update re-derived the slug's body links from the merged text; put
  // back the edges the old body had.
  if (prior.linkTargets) {
    const { syncDocBodyWikilinks } = await import('../wikilinks.js');
    await syncDocBodyWikilinks(slug, prior.linkTargets, { projectRoot });
  }
}
