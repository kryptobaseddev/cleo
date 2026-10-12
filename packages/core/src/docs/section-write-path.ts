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
 *      honest encoding); when the stored state differs from the head's text
 *      it carries a concurrent edit and the incoming edit composes onto it
 *      via sequential `crdt_apply_update` so both survive (T13585).
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
import { compareHlc, encodeHlc, genesisHlc, type Hlc, parseHlc, tick } from '../store/sync/hlc.js';
import {
  applySectionTextEdit,
  joinSections,
  sectionId,
  sectionStateText,
  splitDocIntoSections,
} from './section-merge.js';

/** Input for {@link projectDocUpdateThroughSections}. */
export interface ProjectDocUpdateInput {
  /** The doc's live slug (or a known old slug). */
  readonly slug: string;
  /** Revision author agent id. */
  readonly authorAgentId: string;
  /** The full new document text. */
  readonly content: string;
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

  return withConduitDocWriteTransaction(projectRoot, async () => {
    const { uid: docUid, adopted } =
      existingUid !== null
        ? { uid: existingUid, adopted: false }
        : await ensureConduitDoc(projectRoot, {
            slug: input.slug,
            authorAgentId: input.authorAgentId,
            content: contentBuffer,
          });

    // Resolve the previous head's section texts FIRST — the single-writer
    // vs. concurrent discriminator for every section below (T13589).
    const previousHead = await getConduitDocHead(projectRoot, docUid);
    const headSections =
      previousHead !== null ? await readHeadSectionTexts(projectRoot, previousHead) : null;

    // Apply each section's edit onto its stored Loro state and read the
    // MERGED text back out of the state — never out of the input (T13585).
    const sections = splitDocIntoSections(input.content);
    const mergedSections: string[] = [];
    const sectionsModified: string[] = [];
    for (const [index, text] of sections.entries()) {
      const id = sectionId(index);
      const stored = await readSectionCrdtState(projectRoot, docUid, id);
      const { snapshot, changed } = applySectionTextEdit(
        stored?.snapshot ?? null,
        text,
        headSections?.[index] ?? null,
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

    // A landed version rebases the local section states; the derived
    // contributors rollup is rebuilt from the versions table.
    if (version.uid) {
      await rebaseSectionCrdtStates(projectRoot, docUid, version.uid);
    }
    await rebuildConduitAttachmentContributors(projectRoot, docUid);

    return { docUid, adopted, mergedText, sectionsModified, version, head };
  });
}
