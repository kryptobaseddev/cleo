/**
 * Rename a doc's slug and keep the old slug resolvable (T14118).
 *
 * The slug is an alias, not an identity (spec `cleodocs-rearch-design` §3,
 * D11165): the immutable id is the conduit doc uid. A rename therefore
 *
 * 1. adopts the doc into the conduit family if it is not there yet
 *    ({@link ensureConduitDoc}), so it has a uid to alias;
 * 2. moves the live slug on the registry row (`docs_attachments`) and on the
 *    conduit identity row (`conduit_attachments`);
 * 3. records `old slug → uid` in `conduit_doc_slug_aliases` (append-only), so
 *    `cleo docs fetch <old>` and every reader that resolves through
 *    {@link resolveDocSlug} still find the doc;
 * 4. re-points the body-derived `links-to` edges (the column-derived edges are
 *    rebuilt by the caller).
 *
 * Renaming back (rollback) is the same operation in reverse; the earlier
 * alias row stays as history and is shadowed by the live slug.
 *
 * @task T14118
 * @epic T14106
 */

import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { and, eq } from 'drizzle-orm';
import { CleoError } from '../errors.js';
import { createAttachmentStore } from '../store/attachment-store.js';
import {
  ensureConduitDoc,
  recordConduitDocAlias,
  resolveConduitDocUid,
} from '../store/conduit-doc-history.js';
import { docsWikilinks } from '../store/schema/attachments.js';
import { conduitAttachments, conduitDocSlugAliases } from '../store/schema/cleo-project/conduit.js';
import { getDb } from '../store/sqlite.js';
import { attachments } from '../store/tasks-schema.js';

/** Input to {@link renameDocSlug}. */
export interface RenameDocSlugInput {
  /** The doc's current slug. */
  readonly oldSlug: string;
  /** The slug it should carry. */
  readonly newSlug: string;
  /** Why (kept on the alias row), e.g. `modernize`, `adr-renumber`. */
  readonly reason: string;
  /** Agent recorded when the doc is adopted into the conduit family. */
  readonly authorAgentId: string;
}

/** Result of {@link renameDocSlug}. */
export interface RenameDocSlugResult {
  /** The doc's immutable conduit uid. */
  readonly docUid: string;
  /** Whether this rename adopted the doc into the conduit family. */
  readonly adopted: boolean;
}

/**
 * Rename a doc's slug, keeping the old one as an alias.
 *
 * @param projectRoot - Absolute project root.
 * @param input - Old and new slug, reason and author.
 * @returns The doc uid and whether it was adopted.
 * @throws CleoError `E_NOT_FOUND` when `oldSlug` names no doc; `E_VALIDATION`
 *   when `newSlug` is already a live slug.
 */
export async function renameDocSlug(
  projectRoot: string,
  input: RenameDocSlugInput,
): Promise<RenameDocSlugResult> {
  const store = createAttachmentStore();
  const row = await store.findBySlug(input.oldSlug, projectRoot);
  if (!row) {
    // @sync-invariant none:input-shape renaming a slug no doc carries is refused before any write
    throw new CleoError(ExitCode.NOT_FOUND, `no doc has the slug '${input.oldSlug}'`);
  }
  if (input.newSlug === input.oldSlug) {
    // @sync-invariant none:input-shape a rename to the same slug is refused before any write
    throw new CleoError(ExitCode.VALIDATION_ERROR, 'the new slug equals the old slug');
  }
  if ((await store.findBySlug(input.newSlug, projectRoot)) !== null) {
    // @sync-invariant none:input-shape a rename onto a live slug is refused before any write; slugs stay unique
    throw new CleoError(ExitCode.VALIDATION_ERROR, `the slug '${input.newSlug}' is already taken`);
  }
  const bytes = await store.get(row.metadata.sha256, projectRoot);
  const { uid, adopted } = await ensureConduitDoc(projectRoot, {
    slug: input.oldSlug,
    authorAgentId: input.authorAgentId,
    content: bytes?.bytes ?? Buffer.alloc(0),
  });

  const db = await getDb(projectRoot);
  db.transaction((tx) => {
    tx.update(attachments)
      .set({ slug: input.newSlug })
      .where(eq(attachments.id, row.metadata.id))
      .run();
    tx.update(conduitAttachments)
      .set({ slug: input.newSlug })
      .where(and(eq(conduitAttachments.uid, uid), eq(conduitAttachments.slug, input.oldSlug)))
      .run();
    tx.update(docsWikilinks)
      .set({ fromSlug: input.newSlug })
      .where(and(eq(docsWikilinks.fromSlug, input.oldSlug), eq(docsWikilinks.relation, 'links-to')))
      .run();
    tx.update(docsWikilinks)
      .set({ toSlug: input.newSlug })
      .where(and(eq(docsWikilinks.toSlug, input.oldSlug), eq(docsWikilinks.relation, 'links-to')))
      .run();
  });
  await recordConduitDocAlias(projectRoot, {
    slug: input.oldSlug,
    docUid: uid,
    reason: input.reason,
  });
  return { docUid: uid, adopted };
}

/**
 * Resolve a slug that may be an old alias to the doc's live slug.
 *
 * @param projectRoot - Absolute project root.
 * @param slug - A live slug or an alias.
 * @returns The live slug, or null when neither resolves.
 */
export async function resolveDocSlug(projectRoot: string, slug: string): Promise<string | null> {
  const store = createAttachmentStore();
  if ((await store.findBySlug(slug, projectRoot)) !== null) return slug;
  const uid = await resolveConduitDocUid(projectRoot, slug);
  if (uid === null) return null;
  const db = await getDb(projectRoot);
  const live = await db
    .select({ slug: conduitAttachments.slug })
    .from(conduitAttachments)
    .where(eq(conduitAttachments.uid, uid))
    .get();
  if (!live?.slug || live.slug === slug) return null;
  return (await store.findBySlug(live.slug, projectRoot)) !== null ? live.slug : null;
}

/**
 * Every slug a doc has carried: its live slug first, then its aliases.
 *
 * @param projectRoot - Absolute project root.
 * @param slug - The live slug or any alias.
 * @returns The slugs, or `[slug]` when the doc has no conduit identity.
 */
export async function listDocSlugs(projectRoot: string, slug: string): Promise<string[]> {
  const uid = await resolveConduitDocUid(projectRoot, slug);
  if (uid === null) return [slug];
  const db = await getDb(projectRoot);
  const live = await db
    .select({ slug: conduitAttachments.slug })
    .from(conduitAttachments)
    .where(eq(conduitAttachments.uid, uid))
    .get();
  const aliases = await db
    .select({ slug: conduitDocSlugAliases.slug })
    .from(conduitDocSlugAliases)
    .where(eq(conduitDocSlugAliases.docUid, uid))
    .all();
  return [...new Set([live?.slug ?? slug, ...aliases.map((a) => a.slug)])];
}

/**
 * Set a doc row's kind (`type`), or clear it with null.
 *
 * @param projectRoot - Absolute project root.
 * @param attachmentId - The row id.
 * @param kind - The new kind.
 * @returns The previous kind.
 */
export async function setDocKind(
  projectRoot: string,
  attachmentId: string,
  kind: string | null,
): Promise<string | null> {
  const db = await getDb(projectRoot);
  const before = await db
    .select({ type: attachments.type })
    .from(attachments)
    .where(eq(attachments.id, attachmentId))
    .get();
  await db.update(attachments).set({ type: kind }).where(eq(attachments.id, attachmentId)).run();
  return before?.type ?? null;
}

/**
 * Read a doc row's kind (`type`).
 *
 * @param projectRoot - Absolute project root.
 * @param attachmentId - The row id.
 * @returns The kind, or null when untyped or unknown.
 */
export async function getDocKind(
  projectRoot: string,
  attachmentId: string,
): Promise<string | null> {
  const db = await getDb(projectRoot);
  const row = await db
    .select({ type: attachments.type })
    .from(attachments)
    .where(eq(attachments.id, attachmentId))
    .get();
  return row?.type ?? null;
}
