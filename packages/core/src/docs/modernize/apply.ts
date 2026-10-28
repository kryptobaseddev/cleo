/**
 * `cleo docs modernize --apply` and `--rollback` (T14113).
 *
 * Apply executes a {@link DocsModernizePlan} in four passes:
 *
 * 1. **Bodies.** Each survivor's text gets every `merge-into` row folded in
 *    and its relative `.md` links rewritten to `[[slug]]` wikilinks.
 * 2. **Store.** Survivors are stored under their slug (`ingest`), or update
 *    the existing doc that already owns the slug (`merge`, update before
 *    create). A merged or deleted file whose bytes are not already stored is
 *    stored under its legacy name and superseded by the survivor
 *    (`supersede`), so its history and the supersession edge stay queryable.
 * 3. **Files.** Survivors are written to their canonical path (`write-file`)
 *    and every other scanned path is removed (`remove-file`); folders left
 *    empty are removed.
 * 4. **Graph.** Each survivor's body links become `links-to` edges and the
 *    column-derived edges are rebuilt.
 *
 * Every step is appended to the receipt (`.cleo/modernize/<runId>.json`)
 * before the next one starts, with the bytes it replaced copied under
 * `.cleo/modernize/<runId>/`. {@link rollbackDocsModernize} walks a receipt
 * backwards: files come back from those copies, store rows are restored or
 * dereferenced, and supersession pointers are cleared.
 *
 * @task T14113
 * @epic T14106
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  BlobAttachment,
  DocsModernizePlan,
  DocsModernizePlanRow,
  DocsModernizeReceipt,
  DocsModernizeReceiptOp,
} from '@cleocode/contracts';
import { getCleoDirAbsolute } from '../../paths.js';
import { createAttachmentStore } from '../../store/attachment-store.js';
import { backfillBlobStoreBytes } from '../../store/blob-keep.js';
import { writeFileAtomic } from '../../tools/fs.js';
import { extractWikilinkTargets } from '../derive-links.js';
import { IMPORT_OWNER_TYPE, IMPORT_PROJECT_OWNER_ID } from '../import/attachment-store-accessor.js';
import { normalizeSlug } from '../slug-normalize.js';
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
  /** Skip the clean-tree check (tests on a temp tree that is not a checkout). */
  readonly allowDirty?: boolean;
}

/** Raised when the tree moved since the plan was made. */
export class DocsModernizeStaleError extends Error {
  /** Stable code for the envelope. */
  readonly code = 'E_MODERNIZE_STALE';
}

/** Raised when `--apply` meets uncommitted changes under the root. */
export class DocsModernizeDirtyError extends Error {
  /** Stable code for the envelope. */
  readonly code = 'E_MODERNIZE_DIRTY';
}

/** Raised when a file's bytes cannot be confirmed in the blob store before removal. */
export class DocsModernizeBlobError extends Error {
  /** Stable code for the envelope. */
  readonly code = 'E_MODERNIZE_BLOB';
}

/** Raised when a receipt cannot be found or was already rolled back. */
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

/** Path of a backed-up blob for a run. */
function backupPath(projectRoot: string, runId: string, sha: string): string {
  return join(modernizeDir(projectRoot), runId, sha);
}

/** Copy text into the run's backup folder, keyed by its sha. */
async function backup(projectRoot: string, runId: string, text: string): Promise<string> {
  const sha = sha256(text);
  const path = backupPath(projectRoot, runId, sha);
  if (!existsSync(path)) await writeFileAtomic({ path, content: text });
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
 * Refuse when the root has uncommitted changes, so the moves land as one
 * reviewable diff. Outside a git checkout there is nothing to check.
 */
function assertCleanTree(root: string): void {
  let status: string;
  try {
    status = execFileSync('git', ['status', '--porcelain', '--', '.'], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return;
  }
  if (status.trim() !== '') {
    // @sync-invariant none:input-shape a dirty modernize root is refused before any write
    throw new DocsModernizeDirtyError(
      `${root} has uncommitted changes; commit or stash them so the modernize moves land as one diff`,
    );
  }
}

/**
 * Execute a modernize plan, writing a receipt as it goes.
 *
 * @param options - Plan, project root and clock.
 * @returns The finished receipt.
 * @throws DocsModernizeStaleError when a planned file is missing or changed.
 * @throws DocsModernizeDirtyError when a `tree` run meets uncommitted changes.
 * @throws DocsModernizeBlobError when a file's bytes cannot be confirmed in the blob store.
 */
export async function applyDocsModernize(
  options: ApplyDocsModernizeOptions,
): Promise<DocsModernizeReceipt> {
  const { plan, projectRoot } = options;
  const root = plan.root;
  const tree = plan.mode !== 'store-only';
  if (tree && !options.allowDirty) assertCleanTree(root);
  const texts = new Map<string, string>();
  for (const row of plan.rows) {
    const abs = join(root, row.path);
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
  const ops: DocsModernizeReceiptOp[] = [];
  const blobs: { path: string; sha256: string }[] = [];
  const moves: { from: string; to: string }[] = [];
  const deleted: string[] = [];
  const receipt = (edgeCount = 0): DocsModernizeReceipt => ({
    runId,
    root,
    appliedAt: started.toISOString(),
    planSha256: planHash(plan),
    ops: [...ops],
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
  const record = async (
    op: Partial<DocsModernizeReceiptOp> & Pick<DocsModernizeReceiptOp, 'op'>,
  ) => {
    ops.push({
      slug: null,
      path: null,
      target: null,
      attachmentId: null,
      ownerId: null,
      beforeSha256: null,
      afterSha256: null,
      ...op,
    });
    await save();
  };

  // Pass 0 — every scanned file's bytes, hash-verified in the blob store
  // before anything else happens (nothing is removed without it).
  const cleoDir = getCleoDirAbsolute(projectRoot);
  for (const row of plan.rows) {
    const outcome = await backfillBlobStoreBytes(cleoDir, row.sha256, join(root, row.path));
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
  if (!tree) {
    // Store-only: every file becomes a task-owned, slugless doc; the folder stays.
    for (const row of plan.rows) {
      const ownerId = ownerOf(row);
      const stored = await store.getMetadata(row.sha256, projectRoot);
      const refs = stored ? await store.listRefs(stored.id, projectRoot) : [];
      if (refs.some((r) => r.ownerType === IMPORT_OWNER_TYPE && r.ownerId === ownerId)) continue;
      let attachmentId: string;
      if (stored) {
        // Already a doc: link it to the task, leave its kind and slug alone.
        await store.ref(stored.id, IMPORT_OWNER_TYPE, ownerId, MODERNIZE_ACTOR, projectRoot);
        attachmentId = stored.id;
      } else {
        const text = texts.get(row.path) ?? '';
        attachmentId = await storeText(text, row.path, undefined, row.kind, ownerId, projectRoot);
      }
      await record({
        op: 'ingest',
        path: row.path,
        attachmentId,
        ownerId,
        afterSha256: row.sha256,
      });
    }
    const { rebuildDocsWikilinks } = await import('../wikilinks.js');
    const { edgeCount } = await rebuildDocsWikilinks({ projectRoot });
    await save(edgeCount);
    return receipt(edgeCount);
  }

  // Pass 1 — bodies.
  const survivors = plan.rows.filter((r) => r.disposition === 'keep' || r.disposition === 'rename');
  const slugByPath = new Map(plan.rows.map((r) => [r.path, r.slug]));
  const slugRename = new Map<string, string>();
  for (const row of plan.rows) {
    const oldName = normalizeSlug((row.path.split('/').pop() ?? '').replace(/\.[^.]+$/, ''));
    if (oldName && oldName !== row.slug) slugRename.set(oldName, row.slug);
  }
  const bodies = new Map<string, string>();
  for (const row of survivors) {
    let body = texts.get(row.path) ?? '';
    for (const dup of plan.rows) {
      if (dup.disposition === 'merge-into' && dup.target === row.slug) {
        body = mergeDocBodies(body, texts.get(dup.path) ?? '', dup.slug);
      }
    }
    bodies.set(row.path, rewriteDocLinks(body, row.path, slugByPath, slugRename));
  }

  // Pass 2 — store.
  const usedSlugs = new Set(plan.rows.map((r) => r.slug));
  for (const row of survivors) {
    const body = bodies.get(row.path) ?? '';
    const afterSha = sha256(body);
    const existing = await store.findBySlug(row.slug, projectRoot);
    if (existing && existing.metadata.sha256 === afterSha) continue;
    if (existing) {
      const before = await store.get(existing.metadata.sha256, projectRoot);
      const beforeSha = before
        ? await backup(projectRoot, runId, before.bytes.toString('utf-8'))
        : existing.metadata.sha256;
      const { updateDocBySlug } = await import('../docs-update.js');
      const updated = await updateDocBySlug(projectRoot, {
        slug: row.slug,
        content: body,
        message: `cleo docs modernize: ${row.path}`,
        attachedBy: MODERNIZE_ACTOR,
      });
      if (!updated.ok) {
        // @sync-invariant none:input-shape the docs update path refused the merged body; the receipt holds every earlier step for rollback
        throw new DocsModernizeReceiptError(
          `update of ${row.slug} failed (${updated.error.code}): ${updated.error.message}; roll back with --rollback ${runId}`,
        );
      }
      await record({
        op: 'merge',
        slug: row.slug,
        path: row.path,
        beforeSha256: beforeSha,
        afterSha256: afterSha,
      });
      continue;
    }
    // The same bytes are already a doc under another name: re-putting them
    // would re-slug that row, which a rollback could not undo. Leave it.
    if ((await store.getMetadata(afterSha, projectRoot)) !== null) continue;
    const ownerId = ownerOf(row);
    const attachmentId = await storeText(body, row.path, row.slug, row.kind, ownerId, projectRoot);
    await record({
      op: 'ingest',
      slug: row.slug,
      path: row.path,
      attachmentId,
      ownerId,
      afterSha256: afterSha,
    });
  }
  const { supersedeDoc } = await import('../supersede.js');
  for (const row of plan.rows) {
    if (row.disposition !== 'merge-into' && row.disposition !== 'delete') continue;
    if (!row.target || !(await store.findBySlug(row.target, projectRoot))) continue;
    const stored = await store.getMetadata(row.sha256, projectRoot);
    let oldSlug: string | null = null;
    if (stored) {
      // Already a doc: supersede it under its own slug, unless it is the survivor itself.
      oldSlug = (await store.getExtras(stored.id, projectRoot))?.slug ?? null;
      if (!oldSlug || oldSlug === row.target) continue;
    } else {
      oldSlug = await legacySlug(row, projectRoot, usedSlugs);
      const ownerId = ownerOf(row);
      const attachmentId = await storeText(
        texts.get(row.path) ?? '',
        row.path,
        oldSlug,
        row.kind,
        ownerId,
        projectRoot,
      );
      await record({
        op: 'ingest',
        slug: oldSlug,
        path: row.path,
        attachmentId,
        ownerId,
        afterSha256: row.sha256,
      });
    }
    await supersedeDoc(projectRoot, {
      oldSlug,
      newSlug: row.target,
      reason: `cleo docs modernize ${runId}: ${row.reasons.at(-1) ?? row.disposition}`,
    });
    await record({ op: 'supersede', slug: oldSlug, target: row.target });
  }

  // Pass 3 — files.
  for (const row of survivors) {
    const body = bodies.get(row.path) ?? '';
    const target = row.target ?? row.path;
    const abs = join(root, target);
    const before = existsSync(abs) ? readFileSync(abs, 'utf-8') : null;
    if (before !== body) {
      const beforeSha = before === null ? null : await backup(projectRoot, runId, before);
      await backup(projectRoot, runId, body);
      await writeFileAtomic({ path: abs, content: body });
      await record({
        op: 'write-file',
        path: target,
        beforeSha256: beforeSha,
        afterSha256: sha256(body),
      });
    }
    if (target !== row.path) moves.push({ from: row.path, to: target });
  }
  const kept = new Set(survivors.map((r) => r.target ?? r.path));
  for (const row of plan.rows) {
    if (kept.has(row.path)) continue;
    const abs = join(root, row.path);
    if (!existsSync(abs)) continue;
    const beforeSha = await backup(projectRoot, runId, texts.get(row.path) ?? '');
    rmSync(abs);
    if (row.disposition === 'merge-into' || row.disposition === 'delete') deleted.push(row.path);
    await record({ op: 'remove-file', path: row.path, beforeSha256: beforeSha });
    pruneEmptyDirs(root, dirname(abs));
  }

  // Pass 4 — graph.
  const { rebuildDocsWikilinks, syncDocBodyWikilinks } = await import('../wikilinks.js');
  for (const row of survivors) {
    await syncDocBodyWikilinks(row.slug, extractWikilinkTargets(bodies.get(row.path) ?? ''), {
      projectRoot,
    });
  }
  const { edgeCount } = await rebuildDocsWikilinks({ projectRoot });
  await save(edgeCount);
  return receipt(edgeCount);
}

/**
 * Read a run's receipt.
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
  return JSON.parse(readFileSync(path, 'utf-8')) as DocsModernizeReceipt;
}

/**
 * Reverse an apply run from its receipt, newest step first.
 *
 * @param projectRoot - Project root.
 * @param runId - Run id from the apply receipt.
 * @param now - Clock override (tests).
 * @returns The receipt, now stamped `rolledBackAt`.
 * @throws DocsModernizeReceiptError when the receipt is missing or already rolled back.
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
  const readBackup = (sha: string): string =>
    readFileSync(backupPath(projectRoot, runId, sha), 'utf-8');
  const { clearDocSupersession } = await import('../supersede.js');
  const { syncDocBodyWikilinks, rebuildDocsWikilinks } = await import('../wikilinks.js');

  for (const op of [...receipt.ops].reverse()) {
    switch (op.op) {
      case 'remove-file':
      case 'write-file': {
        if (!op.path) break;
        const abs = join(receipt.root, op.path);
        if (op.beforeSha256) {
          mkdirSync(dirname(abs), { recursive: true });
          await writeFileAtomic({ path: abs, content: readBackup(op.beforeSha256) });
        } else if (existsSync(abs)) {
          rmSync(abs);
          pruneEmptyDirs(receipt.root, dirname(abs));
        }
        break;
      }
      case 'supersede':
        if (op.slug && op.target) await clearDocSupersession(projectRoot, op.slug, op.target);
        break;
      case 'merge': {
        if (!op.slug || !op.beforeSha256) break;
        const { updateDocBySlug } = await import('../docs-update.js');
        await updateDocBySlug(projectRoot, {
          slug: op.slug,
          content: readBackup(op.beforeSha256),
          message: `cleo docs modernize rollback ${runId}`,
          attachedBy: MODERNIZE_ACTOR,
        });
        break;
      }
      case 'ingest':
        if (op.slug) await syncDocBodyWikilinks(op.slug, [], { projectRoot });
        if (op.attachmentId) {
          await store.deref(
            op.attachmentId,
            IMPORT_OWNER_TYPE,
            op.ownerId ?? IMPORT_PROJECT_OWNER_ID,
            projectRoot,
          );
        }
        break;
    }
  }
  const { edgeCount } = await rebuildDocsWikilinks({ projectRoot });
  const done: DocsModernizeReceipt = { ...receipt, edgeCount, rolledBackAt: now().toISOString() };
  await writeFileAtomic({
    path: modernizeReceiptPath(projectRoot, runId),
    content: `${JSON.stringify(done, null, 2)}\n`,
  });
  return done;
}
