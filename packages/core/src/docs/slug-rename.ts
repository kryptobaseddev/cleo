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
import { pushWarning } from '../output.js';
import { createAttachmentStore } from '../store/attachment-store.js';
import {
  conduitDocAliasRow,
  ensureConduitDoc,
  getConduitAttachmentVersion,
  getConduitDocHead,
  resolveConduitDocUid,
} from '../store/conduit-doc-history.js';
import { docsWikilinks } from '../store/schema/attachments.js';
import {
  conduitAttachments,
  conduitAttachmentVersions,
  conduitDocSlugAliases,
} from '../store/schema/cleo-project/conduit.js';
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
  db.transaction(
    // @sync-side-effect docs.slug.rename-keeps-alias the live slug moves on the registry and conduit identity rows together; the old slug becomes an append-only alias (T14118)
    (tx) => {
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
        .where(
          and(eq(docsWikilinks.fromSlug, input.oldSlug), eq(docsWikilinks.relation, 'links-to')),
        )
        .run();
      tx.update(docsWikilinks)
        .set({ toSlug: input.newSlug })
        .where(and(eq(docsWikilinks.toSlug, input.oldSlug), eq(docsWikilinks.relation, 'links-to')))
        .run();
      // The alias commits with the rename: the old slug never resolves to nothing.
      tx.insert(conduitDocSlugAliases)
        .values(conduitDocAliasRow({ slug: input.oldSlug, docUid: uid, reason: input.reason }))
        .onConflictDoNothing()
        .run();
    },
  );
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

/** A doc resolved from a slug (T14288): its identity, live slug, head and metadata row. */
export interface DocRef {
  /**
   * `uid` when the slug resolved through the doc's immutable conduit identity
   * (live slug or alias) to its head version; `legacy` when the doc has no
   * identity or head yet and resolved through the registry row's slug. The
   * legacy path is deleted once every store has run `cleo docs migrate`
   * (`cleo upgrade` runs it; T14288 PR 3).
   */
  readonly identity: 'uid' | 'legacy';
  /** The doc's live slug (the conduit row's, on the uid path). */
  readonly slug: string;
  /** The immutable doc uid, or null on the legacy path. */
  readonly docUid: string | null;
  /** The head version uid, or null on the legacy path. */
  readonly headVersionUid: string | null;
  /**
   * SHA-256 of the bytes the doc resolves to: on the uid path the head
   * version's content hash, or the live row's when its write never landed as
   * a version.
   */
  readonly sha256: string;
  /**
   * The registry row carrying the doc's metadata: the head content's row, or
   * (a head moved by sync, or a recorded section conflict, whose content has
   * no row) the live slug's row. Bytes always come from {@link sha256}.
   */
  readonly row: typeof attachments.$inferSelect;
}

/**
 * Resolve a slug, live or an old alias, to its doc (T14288): slug → conduit
 * uid (live slug, then `conduit_doc_slug_aliases`) → head version → content
 * hash → the registry row of that content. One exception on the uid path:
 * a live slug row whose content no version of the doc records is a write
 * whose section projection did not land (`docs update` writes the row and
 * leaves the head when the merge preview or the projection commit fails,
 * T13842), so that row is served; a head moved by sync still wins, since the
 * local row then holds the old head's content, which is a recorded version.
 * A doc with no conduit identity or no head resolves through its registry row's slug, marked
 * `identity: 'legacy'`, with a `W_DOC_NOT_MIGRATED` warning naming
 * `cleo docs migrate`.
 *
 * @param projectRoot - Absolute project root.
 * @param slug - A live slug or an alias.
 * @returns The resolved doc, or null when nothing resolves.
 * @task T14288
 */
export async function resolveDocRef(projectRoot: string, slug: string): Promise<DocRef | null> {
  const db = await getDb(projectRoot);
  const bySlug = async (s: string) =>
    (await db.select().from(attachments).where(eq(attachments.slug, s)).get()) ?? undefined;
  const legacy = (
    live: string,
    row: typeof attachments.$inferSelect | undefined,
  ): DocRef | null => {
    if (!row) return null;
    pushWarning({
      // @sync-invariant none:input-shape the warning only names a doc that predates its version history; it rejects nothing and writes nothing
      code: 'W_DOC_NOT_MIGRATED',
      message:
        `doc '${live}' has no version history yet, so it resolved through its legacy registry row; ` +
        'run `cleo docs migrate` (or `cleo upgrade`) to give it an immutable identity and head.',
    });
    return {
      identity: 'legacy',
      slug: live,
      docUid: null,
      headVersionUid: null,
      sha256: row.sha256,
      row,
    };
  };
  const uid = await resolveConduitDocUid(projectRoot, slug);
  if (uid !== null) {
    const live = await db
      .select({ slug: conduitAttachments.slug })
      .from(conduitAttachments)
      .where(eq(conduitAttachments.uid, uid))
      .get();
    const liveSlug = live?.slug ?? slug;
    const head = await getConduitDocHead(projectRoot, uid);
    const version = head
      ? await getConduitAttachmentVersion(projectRoot, head.headVersionUid)
      : null;
    if (head && version) {
      // A write the projection did not land is newer than the head (above).
      const slugRow = await bySlug(liveSlug);
      if (slugRow && slugRow.sha256 !== version.contentHash) {
        const recorded = await db
          .select({ uid: conduitAttachmentVersions.uid })
          .from(conduitAttachmentVersions)
          .where(
            and(
              eq(conduitAttachmentVersions.attachmentUid, uid),
              eq(conduitAttachmentVersions.contentHash, slugRow.sha256),
            ),
          )
          .get();
        if (!recorded) {
          return {
            identity: 'uid',
            slug: liveSlug,
            docUid: uid,
            headVersionUid: head.headVersionUid,
            sha256: slugRow.sha256,
            row: slugRow,
          };
        }
      }
      const row =
        (await db
          .select()
          .from(attachments)
          .where(eq(attachments.sha256, version.contentHash))
          .get()) ?? (await bySlug(liveSlug));
      if (row) {
        return {
          identity: 'uid',
          slug: liveSlug,
          docUid: uid,
          headVersionUid: head.headVersionUid,
          sha256: version.contentHash,
          row,
        };
      }
    }
    return legacy(liveSlug, await bySlug(liveSlug));
  }
  return legacy(slug, await bySlug(slug));
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
 * Set a doc row's kind (`type`), or clear it with null. Read the previous
 * kind first with {@link getDocKind} when it must be restored later.
 *
 * @param projectRoot - Absolute project root.
 * @param attachmentId - The row id.
 * @param kind - The new kind.
 */
export async function setDocKind(
  projectRoot: string,
  attachmentId: string,
  kind: string | null,
): Promise<void> {
  const db = await getDb(projectRoot);
  await db.update(attachments).set({ type: kind }).where(eq(attachments.id, attachmentId)).run();
  // T14288: the doc's identity row carries its kind too.
  const { mirrorConduitDocMeta } = await import('../store/conduit-doc-history.js');
  await mirrorConduitDocMeta(projectRoot, { rowId: attachmentId });
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
