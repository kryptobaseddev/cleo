/**
 * Docs update write path through the section CRDT merge layer (T13355 ·
 * spec `cleodocs-rearch-design` §2 option b · D11165).
 *
 * Every `cleo docs update` carrying new inline text is projected through
 * this module after the legacy whole-row write lands (`docs-update.ts`):
 *
 *   1. Resolve the doc's immutable uid, adopting a legacy doc into the
 *      conduit family on first sight ({@link ensureConduitDoc}).
 *   2. Split the new text into sections and resolve the previous head's
 *      section texts from its version blob — the single-writer vs.
 *      concurrent discriminator (T13589).
 *   3. Apply each section's edit to its local Loro state
 *      (`section-merge.ts`): while the stored state equals the head's text
 *      the input projects EXACTLY (re-seed; replaces and deletions apply
 *      verbatim — the primitives can only append, so re-seeding is the
 *      honest encoding); a concurrent edit that is a pure append composes
 *      onto the stored state so both survive (T13585); a concurrent
 *      NON-append edit is never fabricated into a merge — it is landed as
 *      its own version row and recorded as a head conflict (T13595).
 *   4. Read the MERGED text back out of the merged Loro states — never out
 *      of the input — and write its content-addressed blob so the version
 *      row's `storage_key` resolves.
 *   5. Append the merged text as a DAG version row
 *      (`appendConduitAttachmentVersion`, parent = the previous head's
 *      version) — history is append-only.
 *   6. Project the merged text into the current-version row via
 *      {@link upsertConduitDocHead}: the max-HLC head wins and a losing
 *      concurrent head is recorded as a conflict, never silently shadowed
 *      (typed rule `docs.head.max-hlc`).
 *   7. Rebase the local section states onto the landed version and rebuild
 *      the derived contributors rollup.
 *
 * Steps 1–7 run inside ONE `BEGIN IMMEDIATE` transaction
 * ({@link withConduitDocWriteTransaction}, T13583): a failure after the
 * version append rolls everything back, so the next update cannot fork
 * onto a half-landed projection. The body uses only sync-driver accessors
 * and sync `node:fs` calls, so no real I/O yield can admit another writer
 * on the connection mid-transaction (the documented constraint).
 *
 * Loro owns LOCAL-ONLY section state; the syncing rows are owned by the
 * Stage C journal merge engine — one merge authority per table (§2).
 *
 * @module
 * @task T13355
 * @epic T13340
 * @saga T13339
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getCleoDirAbsolute } from '../paths.js';
import {
  appendConduitAttachmentVersion,
  type ConduitAttachmentVersionRow,
  type ConduitDocHeadRow,
  ensureConduitDoc,
  getConduitAttachmentVersion,
  getConduitDocHead,
  readSectionCrdtState,
  rebaseSectionCrdtStates,
  rebuildConduitAttachmentContributors,
  resolveConduitDocUid,
  type UpsertConduitDocHeadResult,
  upsertConduitDocHead,
  withConduitDocWriteTransaction,
  writeSectionCrdtState,
} from '../store/conduit-doc-history.js';
import { resolveBoundSession } from '../store/session-store.js';
import { compareHlc, encodeHlc, genesisHlc, type Hlc, parseHlc, tick } from '../store/sync/hlc.js';
import {
  listSectionLeases,
  type SectionLeaseConflict,
  SectionLeaseManager,
} from './section-leases.js';
import {
  applySectionTextEdit,
  joinSections,
  planSectionMerge,
  sectionIds,
  sectionStateText,
  seedSectionState,
  splitDocIntoSections,
} from './section-merge.js';

/**
 * TTL granted by the write path's lease acquisitions (seconds). Inside
 * llmtxt's 1–300 s range; long enough to cover an edit burst, short enough
 * that a dead session's lease dies quickly (AC4: lease state never outlives
 * its session without renew).
 */
export const SECTION_LEASE_TTL_SECONDS = 60;

/** Input for {@link projectDocUpdateThroughSections}. */
export interface ProjectDocUpdateInput {
  /** The doc's live slug (or a known old slug). */
  readonly slug: string;
  /** Revision author agent id. */
  readonly authorAgentId: string;
  /** The full new document text. */
  readonly content: string;
  /**
   * The session performing the edit. Callers that know their session (tests,
   * sync apply) pass it explicitly; otherwise the projection resolves the
   * caller's BOUND session ({@link resolveBoundSession}, gate 16 — never a
   * bare `getActiveSession()`). With no session the edit proceeds
   * UNCOORDINATED: leases are per-session state, so there is nothing to
   * acquire or renew under.
   */
  readonly sessionId?: string;
  /**
   * The candidate head's HLC (journal wire form). Omit to mint one locally:
   * the mint ticks forward from this device's last issued HLC and never
   * lands at or below the stored head, so a local write always advances the
   * projection. Sync callers pass the remote HLC to exercise the max-HLC
   * rule.
   */
  readonly hlc?: string;
  /**
   * Explicit DAG parent (sync apply). Omit to chain onto the current head's
   * version; `null` forces a root version.
   */
  readonly parentVersionUid?: string | null;
  /**
   * The section texts of the version this edit was AUTHORED AGAINST
   * (T13674) — the write path's stale-base discriminator. Callers that
   * fetched a head and declared it pass its section texts (resolved and
   * validated before any write); every section is then merged relative to
   * that base, so an edit authored against a superseded head composes onto
   * the stored state (append) or records a conflict (non-append) instead of
   * re-seeding over a concurrent writer's edit. Omit (or null) to assert
   * single-writer semantics against the previous head — the pre-T13674
   * behavior.
   */
  readonly baseSections?: readonly string[] | null;
  /** Optional change summary for the version row. */
  readonly changeSummary?: string;
}

/** Outcome of {@link projectDocUpdateThroughSections}. */
export interface ProjectDocUpdateResult {
  /** The doc's immutable uid (`conduit_attachments.uid`). */
  readonly docUid: string;
  /** Whether this call adopted the doc into the conduit family. */
  readonly adopted: boolean;
  /** The merged document text, extracted from the merged Loro states. */
  readonly mergedText: string;
  /** Section ids whose state changed in this projection. */
  readonly sectionsModified: readonly string[];
  /** The appended DAG version row. */
  readonly version: ConduitAttachmentVersionRow;
  /** The head upsert outcome (advanced vs. conflict recorded). */
  readonly head: UpsertConduitDocHeadResult;
  /**
   * The head version uid this projection chained onto (`null` when the doc
   * had no head yet). Callers that declared a base compare it against their
   * base to detect a stale merge (T13674).
   */
  readonly previousHeadVersionUid: string | null;
  /**
   * Non-append concurrent section edits recorded as conflicts (T13595): the
   * incoming edit could not be composed without fabricating text, so it was
   * landed as its own version row (append-only history preserves both) while
   * the head keeps the stored projection.
   */
  readonly conflicts: readonly SectionConflict[];
  /**
   * Advisory lease notices (T13356): sections this edit touched are leased
   * by ANOTHER live session. The edit proceeded anyway — leases are
   * advisory ("409 is a social signal, not a hard lock", llmtxt T285).
   */
  readonly leaseNotices: readonly SectionLeaseNotice[];
}

/** One recorded non-append concurrent section edit (T13595). */
export interface SectionConflict {
  /** The section that could not be merged. */
  readonly sectionId: string;
  /** The version row carrying the incoming (authored) edit — the loser. */
  readonly incomingVersionUid: string;
  /** The projection version row the head kept — the winner. */
  readonly projectionVersionUid: string;
}

/** One advisory lease notice (T13356): the section is leased elsewhere. */
export interface SectionLeaseNotice {
  /** The leased section the edit touched. */
  readonly sectionId: string;
  /** The current holder agent id. */
  readonly holder: string;
  /** The current holder's session id. */
  readonly sessionId: string;
  /** When the blocking lease expires without renew (ISO-8601). */
  readonly expiresAt: string;
}

/**
 * This device's docs-writer HLC state. Module-level (not the journal's
 * persisted `_sync_clock`): the docs projection's HLC orders the
 * current-version row only, is seeded from the stored head on open, and a
 * reset across processes is safe because the head comparison is (phys, ctr,
 * replica) — a fresher wall clock always wins.
 */
let writerReplica: string | null = null;
let lastIssued: Hlc | null = null;

/** The local writer's replica id (one random UUID per process). */
function localWriterReplica(): string {
  writerReplica ??= randomUUID();
  return writerReplica;
}

/**
 * Mint the next local head HLC, strictly above the stored head when one
 * exists (so a local write always advances the max-HLC projection).
 *
 * @param headHlc - The stored head's HLC, or `null` when no projection yet.
 * @param wallMs - The physical candidate (defaults to `Date.now()`).
 * @returns The encoded HLC.
 */
function mintHeadHlc(headHlc: string | null, wallMs: number = Date.now()): string {
  let base = lastIssued ?? genesisHlc(localWriterReplica());
  if (headHlc !== null) {
    try {
      const head = parseHlc(headHlc);
      if (compareHlc(head, base) > 0) base = { ...head, replica: localWriterReplica() };
    } catch {
      // A stored head this process cannot parse is ignored: the mint below
      // still lands at the wall clock, ahead of any plausible stored head.
    }
  }
  lastIssued = tick(base, wallMs);
  return encodeHlc(lastIssued);
}

/**
 * Rough token count for the version row (whitespace split; display only).
 *
 * @param text - The text to count.
 * @returns The token count.
 */
function countTokens(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/**
 * Resolve the on-disk path of a version row's content-addressed blob.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param storageKey - The version's `storage_key` (`<2>/<rest>.md`).
 * @returns The absolute blob path.
 */
function versionBlobPath(projectRoot: string, storageKey: string): string {
  return join(getCleoDirAbsolute(projectRoot), 'attachments', 'sha256', storageKey);
}

/**
 * Read the previous head version's merged text and split it into sections.
 *
 * This is the single-writer vs. concurrent discriminator (T13589): a
 * section whose stored state text equals the head's section text holds no
 * unlanded concurrent edit. Sync `node:fs` only — the caller runs inside
 * the write transaction, which must not yield to real I/O.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param head - The current head row.
 * @returns The head's sections in document order, or `null` when the head's
 *   version or its blob is not resolvable locally (callers then take the
 *   single-writer path — see {@link applySectionTextEdit}).
 */
async function readHeadSectionTexts(
  projectRoot: string,
  head: ConduitDocHeadRow,
): Promise<string[] | null> {
  const version = await getConduitAttachmentVersion(projectRoot, head.headVersionUid);
  if (!version?.storageKey) return null;
  try {
    const text = readFileSync(versionBlobPath(projectRoot, version.storageKey), 'utf-8');
    return splitDocIntoSections(text);
  } catch {
    return null;
  }
}

/**
 * Write the merged text's content-addressed blob so the version row's
 * `storage_key` resolves. Sync `node:fs` only (transaction constraint, see
 * {@link withConduitDocWriteTransaction}); content-addressed, so an existing
 * file is reused and an orphan from a rolled-back transaction is harmless.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param storageKey - The version's `storage_key`.
 * @param text - The merged text the key addresses.
 */
function writeMergedBlob(projectRoot: string, storageKey: string, text: string): void {
  const path = versionBlobPath(projectRoot, storageKey);
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf-8');
}

/**
 * Project one docs update through the section CRDT merge layer.
 *
 * The whole projection — adopt, section-state writes, version append, head
 * upsert, rebase, contributors rebuild — is one transaction
 * ({@link withConduitDocWriteTransaction}); the merged text is read back
 * from the merged Loro states, so concurrent same-base section edits both
 * survive into the version row and the head projection.
 *
 * Lease coordination (T13356, ADVISORY): before the transaction, the
 * projection resolves the caller's session (input, else the bound session,
 * gate 16) and acquires/renews a lease for every section the edit touches.
 * A section leased by another live session yields a {@link SectionLeaseNotice}
 * — the 409 equivalent as data. The edit PROCEEDS regardless: "409 is a
 * social signal, not a hard lock" (llmtxt T285); the CRDT layer guarantees
 * nothing is lost when coordination fails. Leases acquired for a projection
 * that then rolls back are released, so a failed edit leaves no stale claim.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param input - The update facts.
 * @returns The merge outcome.
 */
export async function projectDocUpdateThroughSections(
  projectRoot: string,
  input: ProjectDocUpdateInput,
): Promise<ProjectDocUpdateResult> {
  const existingUid = await resolveConduitDocUid(projectRoot, input.slug);
  const contentBuffer = Buffer.from(input.content, 'utf-8');

  // T13356 — advisory lease coordination, before the transaction. Unbound
  // callers (no input session, no bound session) edit uncoordinated: leases
  // are per-session state and there is nothing to acquire under.
  const boundSessionId =
    input.sessionId ?? (await resolveBoundSession(projectRoot))?.session.id ?? null;
  const leaseNotices: SectionLeaseNotice[] = [];
  const acquiredThisRun: string[] = [];
  if (boundSessionId !== null) {
    const leaseManager = new SectionLeaseManager(projectRoot, {
      sessionId: boundSessionId,
      holder: input.authorAgentId,
    });
    const docUidForLeases = existingUid ?? input.slug;
    const leaseSections = splitDocIntoSections(input.content);
    const leaseIds = sectionIds(leaseSections);
    for (const [index, text] of leaseSections.entries()) {
      const id = leaseIds[index] ?? '';
      const stored =
        existingUid !== null ? await readSectionCrdtState(projectRoot, docUidForLeases, id) : null;
      // Only sections the edit actually touches are coordinated: unchanged
      // sections carry no edit, so claiming them would only block others.
      const touches = stored === null || sectionStateText(stored.snapshot) !== text;
      if (!touches) continue;
      const acquired = await leaseManager.acquire(
        input.slug,
        id,
        SECTION_LEASE_TTL_SECONDS,
        input.changeSummary ?? 'section edit',
      );
      if (acquired.ok) {
        acquiredThisRun.push(id);
        continue;
      }
      if (acquired.conflict.sessionId === boundSessionId) {
        // Our own lease: continued edits renew it (T13356 AC2).
        const renewed = await leaseManager.renew(input.slug, id, SECTION_LEASE_TTL_SECONDS);
        if (!renewed.ok) {
          // Expired between the probes: re-acquire (takeover of our own
          // stale lease). A foreign live lease here is reported below.
          const retry = await leaseManager.acquire(
            input.slug,
            id,
            SECTION_LEASE_TTL_SECONDS,
            input.changeSummary ?? 'section edit',
          );
          if (retry.ok) {
            acquiredThisRun.push(id);
            continue;
          }
          leaseNotices.push(noticeOf(id, retry.conflict));
        }
        continue;
      }
      leaseNotices.push(noticeOf(id, acquired.conflict));
    }
  }

  try {
    return await withConduitDocWriteTransaction(projectRoot, async () => {
      const { uid: docUid, adopted } =
        existingUid !== null
          ? { uid: existingUid, adopted: false }
          : await ensureConduitDoc(projectRoot, {
              slug: input.slug,
              authorAgentId: input.authorAgentId,
              content: contentBuffer,
            });

      // Resolve the previous head's section texts FIRST — the default
      // single-writer vs. concurrent discriminator for every section below
      // (T13589). A caller-declared base (T13674) REPLACES it: the incoming
      // edit is then judged against the base it was authored from, so a
      // stale base composes (append) or conflicts (non-append) instead of
      // re-seeding over a concurrent writer's landed edit.
      const previousHead = await getConduitDocHead(projectRoot, docUid);
      const headSections =
        previousHead !== null ? await readHeadSectionTexts(projectRoot, previousHead) : null;
      const referenceSections =
        input.baseSections !== undefined && input.baseSections !== null
          ? input.baseSections
          : headSections;
      // T13584/T13835/T13836: a three-way, id-keyed section plan — never
      // positional — so a concurrent insert, rename or duplicate heading
      // cannot pair a section with its neighbour's state, nor drop a landed
      // section the incoming list does not mention.
      const plan = planSectionMerge(
        referenceSections,
        headSections,
        splitDocIntoSections(input.content),
      );

      // Apply each section's edit onto its stored Loro state and read the
      // MERGED text back out of the state — never out of the input (T13585).
      const mergedSections: string[] = [];
      const sectionsModified: string[] = [];
      const conflictedSections: string[] = [...plan.conflicts];
      for (const step of plan.steps) {
        if (step.kind === 'keep') {
          mergedSections.push(step.text);
          continue;
        }
        const { id } = step;
        const stored = await readSectionCrdtState(projectRoot, docUid, id);
        // A section with no local state under its id (a doc whose states were
        // written under pre-T13584 positional ids) starts from the head's
        // text: a committed projection leaves state equal to the head, so
        // this is what the legacy row held, and the concurrency discriminator
        // still sees the landed edit.
        const { snapshot, changed, conflicted } = applySectionTextEdit(
          stored?.snapshot ?? (step.headText !== null ? seedSectionState(step.headText) : null),
          step.text,
          step.referenceText,
        );
        if (changed || stored === null) {
          await writeSectionCrdtState(projectRoot, {
            attachmentUid: docUid,
            sectionId: id,
            snapshot,
            baseVersionUid: stored?.baseVersionUid ?? null,
          });
        }
        if (changed) sectionsModified.push(id);
        if (conflicted) conflictedSections.push(id);
        mergedSections.push(sectionStateText(snapshot));
      }
      const mergedText = joinSections(mergedSections);

      // Append the DAG version row (parent = the previous head's version).
      const contentHash = createHash('sha256').update(mergedText, 'utf-8').digest('hex');
      const size = Buffer.byteLength(mergedText, 'utf-8');
      const storageKey = `${contentHash.slice(0, 2)}/${contentHash.slice(2)}.md`;
      // Write the blob BEFORE the insert so a committed row never references
      // missing bytes; a rollback only leaves a harmless content-addressed
      // orphan (reused by a later identical projection).
      writeMergedBlob(projectRoot, storageKey, mergedText);
      const parentVersionUid =
        input.parentVersionUid !== undefined
          ? input.parentVersionUid
          : (previousHead?.headVersionUid ?? null);
      const version = await appendConduitAttachmentVersion(projectRoot, {
        attachmentUid: docUid,
        parentVersionUid,
        authorAgentId: input.authorAgentId,
        storageKey,
        contentHash,
        originalSize: size,
        compressedSize: size,
        tokens: countTokens(mergedText),
        changeType: 'patch',
        ...(input.changeSummary !== undefined ? { changeSummary: input.changeSummary } : {}),
        sectionsModified,
        tokensAdded: countTokens(input.content),
      });

      // Project into the current-version row under the max-HLC rule. The
      // version row survives even when a concurrent head wins, so nothing
      // written above is lost.
      const headHlc = input.hlc ?? mintHeadHlc(previousHead?.headHlc ?? null);
      const head = await upsertConduitDocHead(projectRoot, {
        attachmentUid: docUid,
        headVersionUid: version.uid ?? '',
        headHlc,
      });

      // T13595: a non-append concurrent section edit cannot be merged without
      // fabricating text (the primitives are append-only), so land the incoming
      // edit as its OWN version row — append-only history already preserves
      // both — keep the stored projection as the head, and record the conflict
      // on the head, mirroring the docs.head.max-hlc semantics. The conflict
      // upsert uses the previous head's HLC, which is strictly below the
      // projection HLC in the local-mint path, so the incoming version always
      // loses honestly. (With an explicit `hlc` at or below the previous
      // head's, the projection itself loses first and the incoming version
      // records a second conflict — both stay visible, nothing is invented.)
      const conflicts: SectionConflict[] = [];
      if (conflictedSections.length > 0) {
        const incomingHash = createHash('sha256').update(input.content, 'utf-8').digest('hex');
        const incomingKey = `${incomingHash.slice(0, 2)}/${incomingHash.slice(2)}.md`;
        writeMergedBlob(projectRoot, incomingKey, input.content);
        const incoming = await appendConduitAttachmentVersion(projectRoot, {
          attachmentUid: docUid,
          parentVersionUid,
          authorAgentId: input.authorAgentId,
          storageKey: incomingKey,
          contentHash: incomingHash,
          originalSize: Buffer.byteLength(input.content, 'utf-8'),
          compressedSize: Buffer.byteLength(input.content, 'utf-8'),
          tokens: countTokens(input.content),
          changeType: 'patch',
          changeSummary: `concurrent non-append edit on ${conflictedSections.join(', ')} — conflict recorded, not merged`,
          sectionsModified: conflictedSections,
          tokensAdded: countTokens(input.content),
        });
        if (previousHead !== null && incoming.uid) {
          await upsertConduitDocHead(projectRoot, {
            attachmentUid: docUid,
            headVersionUid: incoming.uid,
            headHlc: previousHead.headHlc,
          });
          for (const sectionId of conflictedSections) {
            conflicts.push({
              sectionId,
              incomingVersionUid: incoming.uid,
              projectionVersionUid: version.uid ?? '',
            });
          }
        }
      }

      // A landed version rebases the local section states; the derived
      // contributors rollup is rebuilt from the versions table.
      if (version.uid) {
        await rebaseSectionCrdtStates(projectRoot, docUid, version.uid);
      }
      await rebuildConduitAttachmentContributors(projectRoot, docUid);

      return {
        docUid,
        adopted,
        mergedText,
        sectionsModified,
        version,
        head,
        previousHeadVersionUid: previousHead?.headVersionUid ?? null,
        conflicts,
        leaseNotices,
      };
    });
  } catch (err) {
    // The projection rolled back: release the leases acquired for it, so a
    // failed edit leaves no stale claim. (Renewed pre-existing leases stay —
    // the session still holds them.)
    if (boundSessionId !== null && acquiredThisRun.length > 0) {
      const leaseManager = new SectionLeaseManager(projectRoot, {
        sessionId: boundSessionId,
        holder: input.authorAgentId,
      });
      for (const section of acquiredThisRun) {
        await leaseManager.release(input.slug, section);
      }
    }
    throw err;
  }
}

/** Conflict view of a lease for a {@link SectionLeaseNotice}. */
function noticeOf(sectionIdValue: string, conflict: SectionLeaseConflict): SectionLeaseNotice {
  return {
    sectionId: sectionIdValue,
    holder: conflict.holder,
    sessionId: conflict.sessionId,
    expiresAt: conflict.expiresAt,
  };
}

/**
 * Release every section lease this session holds for a doc — the "release
 * on completion" path of T13356 AC2: a session calls this when it finishes
 * editing the doc, so the sections are free for the next editor before the
 * TTL would have expired them.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param slug - The doc's live slug (leases are keyed by it).
 * @param sessionId - The finishing session (only its own leases are released).
 * @returns The section ids released.
 */
export async function releaseSectionLeases(
  projectRoot: string,
  slug: string,
  sessionId: string,
): Promise<string[]> {
  const leaseManager = new SectionLeaseManager(projectRoot, { sessionId });
  const released: string[] = [];
  for (const lease of await listSectionLeases(projectRoot, slug)) {
    if (lease.sessionId !== sessionId) continue;
    if (await leaseManager.release(lease.slug, lease.sectionId)) {
      released.push(lease.sectionId);
    }
  }
  return released;
}
