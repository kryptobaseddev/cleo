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
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { CleoError } from '../errors.js';
import { pushWarning } from '../output.js';
import { createAttachmentStore } from '../store/attachment-store.js';
import {
  type ConduitDocMeta,
  conduitDocAliasRow,
  conduitDocMetaOf,
  conduitDocMetaOfRow,
  ensureConduitDoc,
  getConduitAttachmentVersion,
  getConduitDocHead,
  resolveConduitDocUid,
  resolveRegistryRowDocSlug,
} from '../store/conduit-doc-history.js';
import { docsWikilinks } from '../store/schema/attachments.js';
import {
  conduitAttachments,
  conduitAttachmentVersions,
  conduitDocHeads,
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
 * Why a slug rename cannot happen, or the registry row it would move.
 *
 * `not-found`: no doc carries `oldSlug` as its CURRENT slug (an alias does
 * not count). `same`: the slugs are equal. `taken`: another doc answers to
 * `newSlug` as its live slug or an alias; a doc taking back one of its own
 * aliases is allowed.
 */
export type SlugRenameCheck =
  | { readonly ok: true; readonly id: string; readonly sha256: string }
  | { readonly ok: false; readonly reason: 'not-found' | 'same' | 'taken' };

/**
 * Check a slug rename without writing anything: the one rule
 * {@link renameDocSlug} applies, shared with preflights that must refuse a
 * whole batch before its first rename (T14578).
 *
 * @param projectRoot - Absolute project root.
 * @param oldSlug - The doc's current slug.
 * @param newSlug - The slug it should carry.
 * @returns The registry row to move, or why the rename is refused.
 */
export async function checkSlugRename(
  projectRoot: string,
  oldSlug: string,
  newSlug: string,
): Promise<SlugRenameCheck> {
  const registry = await getDb(projectRoot);
  const live = await registry
    .select({ id: attachments.id, sha256: attachments.sha256 })
    .from(attachments)
    .where(eq(attachments.slug, oldSlug))
    .get();
  if (!live) return { ok: false, reason: 'not-found' };
  if (newSlug === oldSlug) return { ok: false, reason: 'same' };
  // T14288: taken means a doc already answers to the slug (a live slug or an
  // alias), unless it is this doc's own old slug (a rename back).
  const holder = await resolveConduitDocUid(projectRoot, newSlug);
  const own = await resolveConduitDocUid(projectRoot, oldSlug);
  if ((await isDocSlugTaken(projectRoot, newSlug)) && !(holder !== null && holder === own)) {
    return { ok: false, reason: 'taken' };
  }
  return { ok: true, id: live.id, sha256: live.sha256 };
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
  // The registry row the rename moves: the one carrying the live slug.
  const check = await checkSlugRename(projectRoot, input.oldSlug, input.newSlug);
  if (!check.ok && check.reason === 'not-found') {
    // @sync-invariant none:input-shape renaming a slug no doc carries is refused before any write
    throw new CleoError(ExitCode.NOT_FOUND, `no doc has the slug '${input.oldSlug}'`);
  }
  if (!check.ok && check.reason === 'same') {
    // @sync-invariant none:input-shape a rename to the same slug is refused before any write
    throw new CleoError(ExitCode.VALIDATION_ERROR, 'the new slug equals the old slug');
  }
  if (!check.ok) {
    // @sync-invariant none:input-shape a rename onto a live slug is refused before any write; slugs stay unique
    throw new CleoError(ExitCode.VALIDATION_ERROR, `the slug '${input.newSlug}' is already taken`);
  }
  const row = { metadata: { id: check.id, sha256: check.sha256 } };
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
  // T14288: the doc resolver follows the live slug and aliases.
  return (await resolveDocRef(projectRoot, slug, { quiet: true }))?.slug ?? null;
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
  /**
   * The doc's own registry row (T14288 PR 3b-2): the one carrying its live
   * slug, with its owners, creation time and version counter. It differs from
   * {@link row} when the doc's head is content another doc also holds (the
   * shared content row stays that doc's); otherwise it is the same row.
   */
  readonly ownRow: typeof attachments.$inferSelect;
  /**
   * The doc's metadata (T14288 PR 3b): from its identity row on the uid path,
   * from the registry row on the legacy path (supersession pointers are then
   * doc uids when the other doc has one). An identity row created before the
   * metadata columns existed, with nothing mirrored yet, also reads the
   * registry row; `cleo upgrade` mirrors every such row.
   */
  readonly meta: ConduitDocMeta;
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
 * @param opts - `quiet` skips the legacy warning (lookups that probe many slugs).
 * @returns The resolved doc, or null when nothing resolves.
 * @task T14288
 */
export async function resolveDocRef(
  projectRoot: string,
  slug: string,
  opts: { readonly quiet?: boolean } = {},
): Promise<DocRef | null> {
  const db = await getDb(projectRoot);
  const bySlug = async (s: string) =>
    (await db.select().from(attachments).where(eq(attachments.slug, s)).get()) ?? undefined;
  const legacy = async (
    live: string,
    row: typeof attachments.$inferSelect | undefined,
  ): Promise<DocRef | null> => {
    if (!row) return null;
    if (opts.quiet !== true)
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
      ownRow: row,
      meta: await conduitDocMetaOfRow(projectRoot, row),
    };
  };
  const uid = await resolveConduitDocUid(projectRoot, slug);
  if (uid !== null) {
    const live = await db
      .select()
      .from(conduitAttachments)
      .where(eq(conduitAttachments.uid, uid))
      .get();
    const liveSlug = live?.slug ?? slug;
    const head = await getConduitDocHead(projectRoot, uid);
    const version = head
      ? await getConduitAttachmentVersion(projectRoot, head.headVersionUid)
      : null;
    if (head && version) {
      const own = await bySlug(liveSlug);
      // A write the projection did not land is newer than the head (above).
      if (own && own.sha256 !== version.contentHash) {
        const recorded = await db
          .select({ uid: conduitAttachmentVersions.uid })
          .from(conduitAttachmentVersions)
          .where(
            and(
              eq(conduitAttachmentVersions.attachmentUid, uid),
              eq(conduitAttachmentVersions.contentHash, own.sha256),
            ),
          )
          .get();
        if (!recorded) {
          return {
            identity: 'uid',
            slug: liveSlug,
            docUid: uid,
            headVersionUid: head.headVersionUid,
            sha256: own.sha256,
            row: own,
            ownRow: own,
            meta:
              live?.lifecycleStatus != null
                ? conduitDocMetaOf(live)
                : await conduitDocMetaOfRow(projectRoot, own),
          };
        }
      }
      const row =
        (own?.sha256 === version.contentHash ? own : undefined) ??
        (await db
          .select()
          .from(attachments)
          .where(eq(attachments.sha256, version.contentHash))
          .get()) ??
        own;
      if (row) {
        return {
          identity: 'uid',
          slug: liveSlug,
          docUid: uid,
          headVersionUid: head.headVersionUid,
          sha256: version.contentHash,
          row,
          ownRow: own ?? row,
          // Mirrored identity rows always hold a lifecycle; NULL means none yet.
          meta:
            live?.lifecycleStatus != null
              ? conduitDocMetaOf(live)
              : await conduitDocMetaOfRow(projectRoot, own ?? row),
        };
      }
    }
    return await legacy(liveSlug, await bySlug(liveSlug));
  }
  return await legacy(slug, await bySlug(slug));
}

/**
 * Every doc in the project, resolved as {@link resolveDocRef} resolves one
 * (T14288 PR 3b): each doc identity with a head (its head content's registry
 * row, its identity metadata) and each legacy registry row whose slug has no
 * identity yet. Four set reads, no per-doc query, so listing and indexing
 * surfaces can use it on every call. No warning is pushed.
 *
 * @param projectRoot - Absolute project root.
 * @returns One {@link DocRef} per doc, uid docs first, each slug once.
 * @task T14288
 */
export async function listDocRefs(projectRoot: string): Promise<DocRef[]> {
  return listDocRefsFromDb(await getDb(projectRoot));
}

/** List canonical doc heads from an already-bound store, including a private recovery snapshot. */
export async function listDocRefsFromDb(db: NodeSQLiteDatabase): Promise<DocRef[]> {
  const registry = await db.select().from(attachments).all();
  const bySha = new Map(registry.map((r) => [r.sha256, r]));
  const byId = new Map(registry.map((r) => [r.id, r]));
  const bySlug = new Map(registry.flatMap((r) => (r.slug ? [[r.slug, r] as const] : [])));
  const heads = await db
    .select({
      doc: conduitAttachments,
      headVersionUid: conduitDocHeads.headVersionUid,
      contentHash: conduitAttachmentVersions.contentHash,
    })
    .from(conduitAttachments)
    .innerJoin(conduitDocHeads, eq(conduitDocHeads.attachmentUid, conduitAttachments.uid))
    .innerJoin(
      conduitAttachmentVersions,
      eq(conduitAttachmentVersions.uid, conduitDocHeads.headVersionUid),
    )
    .all();
  const uidBySlug = new Map(
    heads.flatMap((h) => (h.doc.uid ? [[h.doc.slug, h.doc.uid] as const] : [])),
  );
  const uidOfRowId = (id: string | null): string | null => {
    if (id === null) return null;
    const slug = byId.get(id)?.slug;
    return slug ? (uidBySlug.get(slug) ?? null) : null;
  };
  const metaOfRow = (row: typeof attachments.$inferSelect): ConduitDocMeta => ({
    docType: row.type ?? null,
    lifecycleStatus: row.lifecycleStatus,
    supersedesUid: uidOfRowId(row.supersedes ?? null),
    supersededByUid: uidOfRowId(row.supersededBy ?? null),
    summary: row.summary ?? null,
    keywords: row.keywords ?? null,
    topics: row.topics ?? null,
    relatedTasks: row.relatedTasks ?? null,
    displayAlias: row.displayAlias ?? null,
    ownerVersion: row.ownerVersion ?? null,
  });
  const out: DocRef[] = [];
  const listed = new Set<string>();
  // A live slug row whose content no version of its doc records is a write
  // the projection did not land, served over the head (as resolveDocRef does).
  const recorded = new Set(
    (
      await db
        .select({
          doc: conduitAttachmentVersions.attachmentUid,
          hash: conduitAttachmentVersions.contentHash,
        })
        .from(conduitAttachmentVersions)
        .all()
    ).map((v) => `${v.doc}|${v.hash}`),
  );
  for (const { doc, headVersionUid, contentHash } of heads) {
    const own = bySlug.get(doc.slug);
    const unlanded =
      own !== undefined && own.sha256 !== contentHash && !recorded.has(`${doc.uid}|${own.sha256}`);
    const row = unlanded
      ? own
      : ((own?.sha256 === contentHash ? own : undefined) ?? bySha.get(contentHash) ?? own);
    if (!row || !doc.uid || listed.has(doc.slug)) continue;
    listed.add(doc.slug);
    out.push({
      identity: 'uid',
      slug: doc.slug,
      docUid: doc.uid,
      headVersionUid,
      sha256: unlanded ? row.sha256 : contentHash,
      row,
      ownRow: own ?? row,
      meta: doc.lifecycleStatus != null ? conduitDocMetaOf(doc) : metaOfRow(own ?? row),
    });
  }
  for (const [slug, row] of bySlug) {
    if (listed.has(slug)) continue;
    listed.add(slug);
    out.push({
      identity: 'legacy',
      slug,
      docUid: null,
      headVersionUid: null,
      sha256: row.sha256,
      row,
      ownRow: row,
      meta: metaOfRow(row),
    });
  }
  return out;
}

/**
 * The live slugs of the docs a resolved doc supersedes and is superseded by
 * (T14288 PR 3b): through the doc uids of its metadata, else (a doc the other
 * side of which has no identity yet) through the registry row's pointer,
 * resolved to the doc that row is a version of (T14565).
 *
 * @param projectRoot - Absolute project root.
 * @param ref - A resolved doc.
 * @returns The two slugs, null where there is none.
 * @task T14288
 */
export async function supersessionSlugs(
  projectRoot: string,
  ref: DocRef,
): Promise<{ supersedes: string | null; supersededBy: string | null }> {
  const db = await getDb(projectRoot);
  const slugOfUid = async (uid: string | null): Promise<string | null> => {
    if (uid === null) return null;
    const row = await db
      .select({ slug: conduitAttachments.slug })
      .from(conduitAttachments)
      .where(eq(conduitAttachments.uid, uid))
      .get();
    return row?.slug ?? null;
  };
  // T14565: a pointer names a registry row, one version of a doc; it resolves
  // to that doc, not to whatever slug the row itself carries.
  const slugOfRow = (id: string | null): Promise<string | null> =>
    resolveRegistryRowDocSlug(projectRoot, id);
  return {
    supersedes:
      (await slugOfUid(ref.meta.supersedesUid)) ?? (await slugOfRow(ref.ownRow.supersedes ?? null)),
    supersededBy:
      (await slugOfUid(ref.meta.supersededByUid)) ??
      (await slugOfRow(ref.ownRow.supersededBy ?? null)),
  };
}

/**
 * Whether a slug already names a doc (T14288 PR 3b): a registry row's slug, a
 * doc identity's live slug, or an old slug kept as an alias. An alias counts:
 * a new doc under it would shadow the renamed doc its old links reach.
 *
 * @param projectRoot - Absolute project root.
 * @param slug - The candidate slug.
 * @returns True when the slug is taken.
 * @task T14288
 */
export async function isDocSlugTaken(projectRoot: string, slug: string): Promise<boolean> {
  const db = await getDb(projectRoot);
  const registry = await db
    .select({ id: attachments.id })
    .from(attachments)
    .where(eq(attachments.slug, slug))
    .get();
  if (registry) return true;
  const { isConduitDocSlug } = await import('../store/conduit-doc-history.js');
  return isConduitDocSlug(db, slug);
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
