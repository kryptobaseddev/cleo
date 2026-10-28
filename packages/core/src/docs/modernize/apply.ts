/**
 * `cleo docs modernize --apply` and `--rollback` (T14113).
 *
 * Apply executes a {@link DocsModernizePlan}:
 *
 * 0. **Blobs.** Every scanned file's bytes are hash-verified into the blob
 *    store before anything else runs; nothing is removed without that.
 * 1. **Bodies.** Each survivor's text gets every `merge-into` row folded in
 *    ({@link mergeDocBodies} never drops content) and its relative `.md`
 *    links rewritten to `[[slug]]` wikilinks.
 * 2. **Store.** Survivors are stored under their slug (`ingest`); a slug the
 *    store already holds is merged into, never replaced (`merge`). A merged
 *    or deleted file is recorded where its content went (`fold`) and, when
 *    its bytes are not already a doc, stored under its legacy name and
 *    superseded by the survivor (`supersede`).
 * 3. **Files.** Survivors are written to their canonical path (`write-file`)
 *    and every other scanned path is removed (`remove-file`).
 * 4. **Graph.** Each survivor's body links become `links-to` edges (`link`)
 *    and the column-derived edges are rebuilt (always, in `finally`).
 *
 * Write-ahead: every step is appended to `.cleo/modernize/<runId>.ops.jsonl`
 * as `pending` (with the values it will replace) before it acts and as
 * `done` after; replaced bytes are copied under `.cleo/modernize/<runId>/`.
 * {@link rollbackDocsModernize} walks the steps backwards, appends
 * `reversed` per step (so a failed rollback resumes where it stopped), and
 * refuses to overwrite a file edited since the apply.
 *
 * @task T14113
 * @epic T14106
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  BlobAttachment,
  DocsModernizeOpPrior,
  DocsModernizePlan,
  DocsModernizePlanRow,
  DocsModernizeReceipt,
  DocsModernizeReceiptOp,
} from '@cleocode/contracts';
import { docsModernizeJournalLineSchema } from '@cleocode/contracts/docs/modernize.js';
import { getCleoDirAbsolute } from '../../paths.js';
import { createAttachmentStore } from '../../store/attachment-store.js';
import { backfillBlobStoreBytes } from '../../store/blob-keep.js';
import { writeFileAtomic } from '../../tools/fs.js';
import { extractWikilinkTargets } from '../derive-links.js';
import { IMPORT_OWNER_TYPE, IMPORT_PROJECT_OWNER_ID } from '../import/attachment-store-accessor.js';
import { normalizeSlug } from '../slug-normalize.js';
import { assertPlanConsistent, assertPlanPaths, parseModernizeReceipt, safeJoin } from './guard.js';
import { readSupersessionPrior, restoreSupersession, revertDocUpdate } from './restore.js';
import { mergeDocBodies, rewriteDocLinks } from './rules.js';

/** Identity recorded on every store write modernize makes. */
export const MODERNIZE_ACTOR = 'cleo docs modernize';

/** Options for {@link applyDocsModernize}. */
export interface ApplyDocsModernizeOptions {
  /** The plan to execute (from `planDocsModernize`, possibly edited). */
  readonly plan: DocsModernizePlan;
  /** Project root (store, receipts). */
  readonly projectRoot: string;
  /** Clock override (tests). */
  readonly now?: () => Date;
  /** Apply even when the root is not a clean git checkout (explicit `--allow-dirty`). */
  readonly allowDirty?: boolean;
}

/** Raised when the tree moved since the plan was made. */
export class DocsModernizeStaleError extends Error {
  /** Stable code for the envelope. */
  readonly code = 'E_MODERNIZE_STALE';
}

/** Raised when `--apply` meets uncommitted changes, or cannot prove there are none. */
export class DocsModernizeDirtyError extends Error {
  /** Stable code for the envelope. */
  readonly code = 'E_MODERNIZE_DIRTY';
}

/** Raised when bytes cannot be confirmed or backed up before a step changes them. */
export class DocsModernizeBlobError extends Error {
  /** Stable code for the envelope. */
  readonly code = 'E_MODERNIZE_BLOB';
}

/** Raised when a receipt cannot be found, was already rolled back, or a file changed since. */
export class DocsModernizeReceiptError extends Error {
  /** Stable code for the envelope. */
  readonly code = 'E_MODERNIZE_RECEIPT';
}

/** SHA-256 hex of text. */
function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** `.cleo/modernize` under the project. */
function modernizeDir(projectRoot: string): string {
  return join(getCleoDirAbsolute(projectRoot), 'modernize');
}

/**
 * Path of a run's receipt.
 *
 * @param projectRoot - Project root.
 * @param runId - Run id.
 * @returns Absolute receipt path.
 */
export function modernizeReceiptPath(projectRoot: string, runId: string): string {
  return join(modernizeDir(projectRoot), `${runId}.json`);
}

/** Path of a run's write-ahead step journal. */
function journalPath(projectRoot: string, runId: string): string {
  return join(modernizeDir(projectRoot), `${runId}.ops.jsonl`);
}

/** Path of a backed-up blob for a run. */
function backupPath(projectRoot: string, runId: string, sha: string): string {
  return join(modernizeDir(projectRoot), runId, sha);
}

/** Copy text into the run's backup folder, keyed by its sha, and confirm it reads back. */
async function backup(projectRoot: string, runId: string, text: string): Promise<string> {
  const sha = sha256(text);
  const path = backupPath(projectRoot, runId, sha);
  if (!existsSync(path)) await writeFileAtomic({ path, content: text });
  if (sha256(readFileSync(path, 'utf-8')) !== sha) {
    // @sync-invariant none:local-only a backup that does not read back is refused before the step it guards
    throw new DocsModernizeBlobError(`backup of ${sha} did not read back intact`);
  }
  return sha;
}

/** Remove now-empty folders from `dir` up to (not including) `root`. */
function pruneEmptyDirs(root: string, dir: string): void {
  let current = dir;
  while (current.startsWith(root) && current !== root) {
    if (!existsSync(current) || readdirSync(current).length > 0) return;
    rmdirSync(current);
    current = dirname(current);
  }
}

/** Canonical JSON of a plan, for the receipt's plan hash. */
function planHash(plan: DocsModernizePlan): string {
  return sha256(JSON.stringify(plan.rows));
}

/** A fresh, unused legacy slug for a superseded file. */
async function legacySlug(
  row: DocsModernizePlanRow,
  projectRoot: string,
  used: Set<string>,
): Promise<string> {
  const store = createAttachmentStore();
  const base = normalizeSlug((row.path.split('/').pop() ?? row.slug).replace(/\.[^.]+$/, ''));
  let slug = base === row.slug ? `${base}-superseded` : base;
  let n = 2;
  while (used.has(slug) || (await store.findBySlug(slug, projectRoot)) !== null) {
    slug = `${base}-superseded-${n}`;
    n += 1;
  }
  used.add(slug);
  return slug;
}

/** Store text, optionally under a slug, for `ownerId`; returns the attachment id. */
async function storeText(
  text: string,
  path: string,
  slug: string | undefined,
  kind: string,
  ownerId: string,
  projectRoot: string,
): Promise<string> {
  const bytes = Buffer.from(text, 'utf-8');
  const attachment: Omit<BlobAttachment, 'sha256'> = {
    kind: 'blob',
    storageKey: '', // computed by AttachmentStore.put
    mime: path.endsWith('.txt') ? 'text/plain' : 'text/markdown',
    size: bytes.byteLength,
  };
  const meta = await createAttachmentStore().put(
    bytes,
    attachment,
    IMPORT_OWNER_TYPE,
    ownerId,
    MODERNIZE_ACTOR,
    projectRoot,
    { ...(slug ? { slug } : {}), type: kind, skipGraphRebuild: true },
  );
  return meta.id;
}

/** The owner a row's store ref goes to: its first task id, else the project sentinel. */
function ownerOf(row: DocsModernizePlanRow): string {
  return row.ownerTasks.find((id) => id.startsWith('T')) ?? IMPORT_PROJECT_OWNER_ID;
}

/**
 * Refuse unless the root is a git checkout with no uncommitted changes, so
 * the moves land as one reviewable diff. Fails closed: a git error refuses.
 */
function assertCleanTree(root: string): void {
  let status: string;
  try {
    status = execFileSync('git', ['status', '--porcelain', '--', '.'], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    // @sync-invariant none:input-shape a root git cannot vouch for is refused before any write; --allow-dirty overrides
    throw new DocsModernizeDirtyError(
      `${root} is not a git checkout git could read; pass --allow-dirty to apply anyway`,
    );
  }
  if (status.trim() !== '') {
    // @sync-invariant none:input-shape a dirty modernize root is refused before any write
    throw new DocsModernizeDirtyError(
      `${root} has uncommitted changes; commit or stash them so the modernize moves land as one diff`,
    );
  }
}

/** The `links-to` targets leaving a slug now. */
async function linkTargets(slug: string, projectRoot: string): Promise<string[]> {
  const { getDocsWikilinks } = await import('../wikilinks.js');
  const edges = await getDocsWikilinks(slug, { direction: 'out', projectRoot });
  return edges.filter((e) => e.relation === 'links-to').map((e) => e.toSlug);
}

/** Append one line and fsync it, so a journal entry survives a crash right after. */
function appendDurable(path: string, line: string): void {
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Write-ahead journal of one run's steps. */
class StepJournal {
  private readonly ops: DocsModernizeReceiptOp[] = [];

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  /** Append a step as `pending` before it acts; returns its index. */
  begin(op: Partial<DocsModernizeReceiptOp> & Pick<DocsModernizeReceiptOp, 'op'>): number {
    const full: DocsModernizeReceiptOp = {
      state: 'pending',
      slug: null,
      path: null,
      target: null,
      attachmentId: null,
      ownerId: null,
      beforeSha256: null,
      afterSha256: null,
      ...op,
    };
    this.ops.push(full);
    const i = this.ops.length - 1;
    appendDurable(this.path, `${JSON.stringify({ i, ...full })}\n`);
    return i;
  }

  /** Mark a step `done`, with anything learned while acting. */
  done(i: number, patch: Partial<DocsModernizeReceiptOp> = {}): void {
    const current = this.ops[i];
    if (!current) return;
    const next: DocsModernizeReceiptOp = { ...current, ...patch, state: 'done' };
    this.ops[i] = next;
    appendDurable(this.path, `${JSON.stringify({ i, ...next })}\n`);
  }

  /** Every step so far. */
  list(): DocsModernizeReceiptOp[] {
    return [...this.ops];
  }
}

/**
 * Execute a modernize plan, journaling every step ahead of it.
 *
 * @param options - Plan, project root and clock.
 * @returns The finished receipt.
 * @throws DocsModernizeStaleError when a planned file is missing or changed.
 * @throws DocsModernizeDirtyError when a `tree` run cannot prove a clean checkout.
 * @throws DocsModernizeBlobError when bytes cannot be confirmed or backed up.
 */
export async function applyDocsModernize(
  options: ApplyDocsModernizeOptions,
): Promise<DocsModernizeReceipt> {
  const { plan, projectRoot } = options;
  const root = plan.root;
  const tree = plan.mode !== 'store-only';
  assertPlanPaths(plan, projectRoot);
  assertPlanConsistent(plan);
  if (tree && !options.allowDirty) assertCleanTree(root);
  const texts = new Map<string, string>();
  for (const row of plan.rows) {
    const abs = safeJoin(root, row.path);
    const text = existsSync(abs) ? readFileSync(abs, 'utf-8') : null;
    if (text === null || sha256(text) !== row.sha256) {
      // @sync-invariant none:input-shape the plan no longer matches the tree; refused before any write
      throw new DocsModernizeStaleError(
        `${row.path} changed since the plan was made; re-run cleo docs modernize --dry-run`,
      );
    }
    texts.set(row.path, text);
  }

  const started = options.now?.() ?? new Date();
  const stamp = started.toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 15);
  const runId = `dm-${stamp}-${sha256(plan.generatedAt + root).slice(0, 6)}`;
  const journal = new StepJournal(journalPath(projectRoot, runId));
  const blobs: { path: string; sha256: string }[] = [];
  const moves: { from: string; to: string }[] = [];
  const deleted: string[] = [];
  const receipt = (edgeCount: number): DocsModernizeReceipt => ({
    runId,
    root,
    appliedAt: started.toISOString(),
    planSha256: planHash(plan),
    ops: journal.list(),
    edgeCount,
    rolledBackAt: null,
    blobs: [...blobs],
    moves: [...moves],
    deleted: [...deleted],
  });
  const save = async (edgeCount = 0): Promise<void> => {
    await writeFileAtomic({
      path: modernizeReceiptPath(projectRoot, runId),
      content: `${JSON.stringify(receipt(edgeCount), null, 2)}\n`,
    });
  };

  // Pass 0 — every scanned file's bytes, hash-verified in the blob store.
  const cleoDir = getCleoDirAbsolute(projectRoot);
  for (const row of plan.rows) {
    const outcome = await backfillBlobStoreBytes(cleoDir, row.sha256, safeJoin(root, row.path));
    if (outcome !== 'written' && outcome !== 'present') {
      // @sync-invariant none:local-only the blob store copy is a local prerequisite; nothing synced was written
      throw new DocsModernizeBlobError(
        `${row.path}: bytes could not be confirmed in the blob store (${outcome}); nothing was removed`,
      );
    }
    blobs.push({ path: row.path, sha256: row.sha256 });
  }
  await save();

  const store = createAttachmentStore();
  const { rebuildDocsWikilinks, syncDocBodyWikilinks } = await import('../wikilinks.js');
  let edgeCount = 0;
  try {
    if (!tree) {
      // Store-only: every file becomes a task-owned, slugless doc; the folder stays.
      for (const row of plan.rows) {
        const ownerId = ownerOf(row);
        const stored = await store.getMetadata(row.sha256, projectRoot);
        const refs = stored ? await store.listRefs(stored.id, projectRoot) : [];
        if (refs.some((r) => r.ownerType === IMPORT_OWNER_TYPE && r.ownerId === ownerId)) continue;
        const i = journal.begin({ op: 'ingest', path: row.path, ownerId, afterSha256: row.sha256 });
        if (stored) {
          // Already a doc: link it to the task, leave its kind and slug alone.
          await store.ref(stored.id, IMPORT_OWNER_TYPE, ownerId, MODERNIZE_ACTOR, projectRoot);
          journal.done(i, { attachmentId: stored.id });
        } else {
          const text = texts.get(row.path) ?? '';
          const attachmentId = await storeText(
            text,
            row.path,
            undefined,
            row.kind,
            ownerId,
            projectRoot,
          );
          journal.done(i, { attachmentId });
        }
      }
    } else {
      // Pass 1 — bodies.
      const survivors = plan.rows.filter(
        (r) => r.disposition === 'keep' || r.disposition === 'rename',
      );
      const slugByPath = new Map(plan.rows.map((r) => [r.path, r.slug]));
      // Old names → final slug for existing [[wikilinks]]: the path without its
      // extension always; the bare file name only when no other file shares it.
      const slugRename = new Map<string, string>();
      const baseCount = new Map<string, number>();
      for (const row of plan.rows) {
        const base = normalizeSlug((row.path.split('/').pop() ?? '').replace(/\.[^.]+$/, ''));
        baseCount.set(base, (baseCount.get(base) ?? 0) + 1);
      }
      for (const row of plan.rows) {
        const noExt = row.path.replace(/\.[^.]+$/, '');
        if (noExt !== row.slug) slugRename.set(noExt, row.slug);
        const base = normalizeSlug((row.path.split('/').pop() ?? '').replace(/\.[^.]+$/, ''));
        if (base && base !== row.slug && baseCount.get(base) === 1) slugRename.set(base, row.slug);
      }
      const bodies = new Map<string, string>();
      for (const row of survivors) {
        let body = texts.get(row.path) ?? '';
        for (const dup of plan.rows) {
          if (dup.disposition === 'merge-into' && dup.target === row.slug) {
            body = mergeDocBodies(
              body,
              texts.get(dup.path) ?? '',
              normalizeSlug(dup.path.replace(/\.[^.]+$/, '')),
            );
          }
        }
        bodies.set(row.path, rewriteDocLinks(body, row.path, slugByPath, slugRename));
      }

      // Pass 2 — store.
      const usedSlugs = new Set(plan.rows.map((r) => r.slug));
      for (const row of survivors) {
        const body = bodies.get(row.path) ?? '';
        const existing = await store.findBySlug(row.slug, projectRoot);
        if (existing && existing.metadata.sha256 === sha256(body)) continue;
        if (existing) {
          // Update before create, as a merge: the stored doc keeps all of its content.
          const before = await store.get(existing.metadata.sha256, projectRoot);
          if (!before) {
            // @sync-invariant none:local-only the stored doc's bytes are unreadable, so the step could not be undone; refused before it acts
            throw new DocsModernizeBlobError(
              `stored doc ${row.slug} has no readable bytes to back up; refusing to update it (roll back with --rollback ${runId})`,
            );
          }
          const storedText = before.bytes.toString('utf-8');
          const merged = mergeDocBodies(
            storedText,
            body,
            normalizeSlug(row.path.replace(/\.[^.]+$/, '')),
          );
          bodies.set(row.path, merged);
          if (merged === storedText) continue;
          if ((await store.getMetadata(sha256(merged), projectRoot)) !== null) continue;
          const beforeSha = await backup(projectRoot, runId, storedText);
          const i = journal.begin({
            op: 'merge',
            slug: row.slug,
            path: row.path,
            beforeSha256: beforeSha,
            afterSha256: sha256(merged),
            prior: {
              previousAttachmentId: existing.metadata.id,
              newAttachmentId: null,
              linkTargets: await linkTargets(row.slug, projectRoot),
            },
          });
          await save();
          const { updateDocBySlug } = await import('../docs-update.js');
          const updated = await updateDocBySlug(projectRoot, {
            slug: row.slug,
            content: merged,
            message: `cleo docs modernize: ${row.path}`,
            attachedBy: MODERNIZE_ACTOR,
          });
          if (!updated.ok) {
            // @sync-invariant none:input-shape the docs update path refused the merged body; the journal holds every earlier step for rollback
            throw new DocsModernizeReceiptError(
              `update of ${row.slug} failed (${updated.error.code}): ${updated.error.message}; roll back with --rollback ${runId}`,
            );
          }
          journal.done(i, {
            attachmentId: updated.result.attachmentId,
            prior: {
              previousAttachmentId: updated.result.previousAttachmentId,
              newAttachmentId: updated.result.attachmentId,
              linkTargets: journal.list()[i]?.prior?.linkTargets ?? [],
            },
          });
          continue;
        }
        // The same bytes are already a doc under another name: re-putting them
        // would re-slug that row, which a rollback could not undo. Leave it.
        if ((await store.getMetadata(sha256(body), projectRoot)) !== null) continue;
        const ownerId = ownerOf(row);
        const i = journal.begin({
          op: 'ingest',
          slug: row.slug,
          path: row.path,
          ownerId,
          afterSha256: sha256(body),
        });
        const attachmentId = await storeText(
          body,
          row.path,
          row.slug,
          row.kind,
          ownerId,
          projectRoot,
        );
        journal.done(i, { attachmentId });
      }

      const { supersedeDoc } = await import('../supersede.js');
      const survivorBySlug = new Map(survivors.map((r) => [r.slug, r]));
      for (const row of plan.rows) {
        if (row.disposition !== 'merge-into' && row.disposition !== 'delete') continue;
        const survivor = row.target ? survivorBySlug.get(row.target) : undefined;
        // Where the content went, even when no store step follows.
        const f = journal.begin({
          op: 'fold',
          path: row.path,
          target: row.target,
          beforeSha256: row.sha256,
          afterSha256: survivor ? sha256(bodies.get(survivor.path) ?? '') : null,
        });
        journal.done(f);
        if (!row.target || !(await store.findBySlug(row.target, projectRoot))) continue;
        const stored = await store.getMetadata(row.sha256, projectRoot);
        let oldSlug: string | null;
        if (stored) {
          // Already a doc: supersede it under its own slug, unless it is the survivor itself.
          oldSlug = (await store.getExtras(stored.id, projectRoot))?.slug ?? null;
          if (!oldSlug || oldSlug === row.target) continue;
        } else {
          oldSlug = await legacySlug(row, projectRoot, usedSlugs);
          const ownerId = ownerOf(row);
          const i = journal.begin({
            op: 'ingest',
            slug: oldSlug,
            path: row.path,
            ownerId,
            afterSha256: row.sha256,
          });
          const attachmentId = await storeText(
            texts.get(row.path) ?? '',
            row.path,
            oldSlug,
            row.kind,
            ownerId,
            projectRoot,
          );
          journal.done(i, { attachmentId });
        }
        const prior = await readSupersessionPrior(projectRoot, oldSlug, row.target);
        const s = journal.begin({
          op: 'supersede',
          slug: oldSlug,
          target: row.target,
          ...(prior ? { prior } : {}),
        });
        await supersedeDoc(projectRoot, {
          oldSlug,
          newSlug: row.target,
          reason: `cleo docs modernize ${runId}: ${row.reasons.at(-1) ?? row.disposition}`,
        });
        journal.done(s);
      }
      await save();

      // Pass 3 — files.
      for (const row of survivors) {
        const body = bodies.get(row.path) ?? '';
        const target = row.target ?? row.path;
        const abs = safeJoin(root, target);
        const before = existsSync(abs) ? readFileSync(abs, 'utf-8') : null;
        if (before !== body) {
          const beforeSha = before === null ? null : await backup(projectRoot, runId, before);
          await backup(projectRoot, runId, body);
          const i = journal.begin({
            op: 'write-file',
            path: target,
            beforeSha256: beforeSha,
            afterSha256: sha256(body),
          });
          await writeFileAtomic({ path: abs, content: body });
          journal.done(i);
        }
        if (target !== row.path) moves.push({ from: row.path, to: target });
      }
      const kept = new Set(survivors.map((r) => r.target ?? r.path));
      for (const row of plan.rows) {
        if (kept.has(row.path)) continue;
        const abs = safeJoin(root, row.path);
        if (!existsSync(abs)) continue;
        const beforeSha = await backup(projectRoot, runId, texts.get(row.path) ?? '');
        const i = journal.begin({ op: 'remove-file', path: row.path, beforeSha256: beforeSha });
        rmSync(abs);
        journal.done(i);
        if (row.disposition === 'merge-into' || row.disposition === 'delete')
          deleted.push(row.path);
        pruneEmptyDirs(root, dirname(abs));
      }
      await save();

      // Pass 4 — graph.
      for (const row of survivors) {
        const targets = extractWikilinkTargets(bodies.get(row.path) ?? '');
        const priorTargets = await linkTargets(row.slug, projectRoot);
        const i = journal.begin({
          op: 'link',
          slug: row.slug,
          prior: { linkTargets: priorTargets },
        });
        await syncDocBodyWikilinks(row.slug, targets, { projectRoot });
        journal.done(i);
      }
    }
  } finally {
    ({ edgeCount } = await rebuildDocsWikilinks({ projectRoot }));
    await save(edgeCount);
  }
  return receipt(edgeCount);
}

/** Fold a step journal into the latest state of each step. */
function readJournal(projectRoot: string, runId: string): DocsModernizeReceiptOp[] | null {
  const path = journalPath(projectRoot, runId);
  if (!existsSync(path)) return null;
  const ops: DocsModernizeReceiptOp[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    const parsed = docsModernizeJournalLineSchema.safeParse(JSON.parse(line));
    if (!parsed.success) {
      // @sync-invariant none:local-only a corrupt journal line stops the rollback before any step
      throw new DocsModernizeReceiptError(
        `journal ${runId} has a malformed line: ${parsed.error.message}`,
      );
    }
    const { i, ...op } = parsed.data;
    ops[i] = op;
  }
  return ops.filter((op): op is DocsModernizeReceiptOp => op !== undefined);
}

/**
 * Read a run's receipt, with its steps taken from the write-ahead journal
 * (which records steps the receipt file may not have caught up with).
 *
 * @param projectRoot - Project root.
 * @param runId - Run id.
 * @returns The receipt.
 * @throws DocsModernizeReceiptError when it does not exist.
 */
export function readDocsModernizeReceipt(projectRoot: string, runId: string): DocsModernizeReceipt {
  const path = modernizeReceiptPath(projectRoot, runId);
  if (!/^dm-[\w-]+$/.test(runId) || !existsSync(path)) {
    // @sync-invariant none:input-shape an unknown run id is refused before any write
    throw new DocsModernizeReceiptError(`no modernize receipt ${runId} under .cleo/modernize/`);
  }
  const receipt = parseModernizeReceipt(readFileSync(path, 'utf-8'), projectRoot);
  const ops = readJournal(projectRoot, runId);
  return ops ? { ...receipt, ops } : receipt;
}

/**
 * Reverse an apply run from its journal, newest step first. Each reversed
 * step is journaled, so a rollback that stops part-way resumes on retry.
 *
 * @param projectRoot - Project root.
 * @param runId - Run id from the apply receipt.
 * @param now - Clock override (tests).
 * @returns The receipt, now stamped `rolledBackAt`.
 * @throws DocsModernizeReceiptError when the receipt is missing, already
 *   rolled back, or a file was edited after the apply.
 */
export async function rollbackDocsModernize(
  projectRoot: string,
  runId: string,
  now: () => Date = () => new Date(),
): Promise<DocsModernizeReceipt> {
  const receipt = readDocsModernizeReceipt(projectRoot, runId);
  if (receipt.rolledBackAt) {
    // @sync-invariant none:input-shape a run is rolled back once; the second request is refused before any write
    throw new DocsModernizeReceiptError(
      `${runId} was already rolled back at ${receipt.rolledBackAt}`,
    );
  }
  const store = createAttachmentStore();
  const readBackup = (sha: string): string => {
    const path = backupPath(projectRoot, runId, sha);
    if (!existsSync(path)) {
      // @sync-invariant none:local-only a missing backup stops the rollback before it overwrites anything
      throw new DocsModernizeReceiptError(`backup ${sha} of ${runId} is missing`);
    }
    return readFileSync(path, 'utf-8');
  };
  const { syncDocBodyWikilinks, rebuildDocsWikilinks } = await import('../wikilinks.js');
  const journal = journalPath(projectRoot, runId);
  const ops = receipt.ops;
  let edgeCount = receipt.edgeCount;

  try {
    for (let i = ops.length - 1; i >= 0; i -= 1) {
      const op = ops[i];
      if (!op || op.state === 'reversed') continue;
      const prior: DocsModernizeOpPrior = op.prior ?? {};
      switch (op.op) {
        case 'remove-file':
        case 'write-file': {
          if (!op.path) break;
          const abs = safeJoin(receipt.root, op.path);
          const current = existsSync(abs) ? sha256(readFileSync(abs, 'utf-8')) : null;
          const expected = op.op === 'write-file' ? op.afterSha256 : null;
          const restored = op.beforeSha256;
          if (current !== expected && current !== restored && op.state === 'done') {
            // @sync-invariant none:local-only a file edited after the apply is never overwritten; rollback stops for the owner
            throw new DocsModernizeReceiptError(
              `${op.path} was changed after the modernize run; resolve it by hand, then re-run --rollback ${runId}`,
            );
          }
          if (restored) {
            mkdirSync(dirname(abs), { recursive: true });
            await writeFileAtomic({ path: abs, content: readBackup(restored) });
          } else if (existsSync(abs)) {
            rmSync(abs);
            pruneEmptyDirs(receipt.root, dirname(abs));
          }
          break;
        }
        case 'link':
          if (op.slug)
            await syncDocBodyWikilinks(op.slug, prior.linkTargets ?? [], { projectRoot });
          break;
        case 'supersede':
          if (op.slug && op.target && op.prior) {
            await restoreSupersession(projectRoot, op.slug, op.target, op.prior);
          }
          break;
        case 'merge': {
          if (!op.slug || !prior.previousAttachmentId) break;
          // A merge journaled `pending` may still have committed: the slug
          // then sits on a row other than the one it started on.
          const live = await store.findBySlug(op.slug, projectRoot);
          const created = prior.newAttachmentId ?? live?.metadata.id ?? null;
          if (created && created !== prior.previousAttachmentId && live?.metadata.id === created) {
            await revertDocUpdate(projectRoot, op.slug, { ...prior, newAttachmentId: created });
          }
          break;
        }
        case 'ingest': {
          const owner = op.ownerId ?? IMPORT_PROJECT_OWNER_ID;
          const id =
            op.attachmentId ??
            (op.afterSha256
              ? (await store.getMetadata(op.afterSha256, projectRoot))?.id
              : undefined);
          if (!id) break;
          const refs = await store.listRefs(id, projectRoot);
          if (refs.some((r) => r.ownerType === IMPORT_OWNER_TYPE && r.ownerId === owner)) {
            await store.deref(id, IMPORT_OWNER_TYPE, owner, projectRoot);
          }
          break;
        }
        case 'fold':
          break;
      }
      appendDurable(journal, `${JSON.stringify({ i, ...op, state: 'reversed' })}\n`);
    }
  } finally {
    ({ edgeCount } = await rebuildDocsWikilinks({ projectRoot }));
  }
  const done: DocsModernizeReceipt = {
    ...receipt,
    ops: readJournal(projectRoot, runId) ?? receipt.ops,
    edgeCount,
    rolledBackAt: now().toISOString(),
  };
  await writeFileAtomic({
    path: modernizeReceiptPath(projectRoot, runId),
    content: `${JSON.stringify(done, null, 2)}\n`,
  });
  return done;
}
