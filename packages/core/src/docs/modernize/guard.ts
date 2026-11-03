/**
 * Input guards for `cleo docs modernize` (T14113): a plan or receipt read
 * from disk is untrusted, so its shape is schema-checked and every path it
 * names must stay inside the modernize root, which itself must sit inside the
 * project. Absolute paths, `..` escapes and symlinks are refused.
 *
 * @task T14113
 * @epic T14106
 */

import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  DocsModernizeOverrides,
  DocsModernizePlan,
  DocsModernizeReceipt,
} from '@cleocode/contracts';
import {
  docsModernizeOverridesSchema,
  docsModernizePlanSchema,
  docsModernizeReceiptSchema,
} from '@cleocode/contracts/docs/modernize.js';
import { gitCommonDir } from '../../git/work-tree.js';
import { repoLinkFixAllowed } from './rules.js';

/** Raised when a plan, receipt or path fails a guard. */
export class DocsModernizeUnsafeError extends Error {
  /** Stable code for the envelope. */
  readonly code = 'E_MODERNIZE_UNSAFE';
}

/** Whether `child` is `parent` or inside it (both absolute, resolved). */
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The real path of `p`, or of its nearest existing ancestor joined with the rest. */
function realOrNearest(p: string): string {
  let current = p;
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    tail.unshift(current.slice(parent.length + 1));
    current = parent;
  }
  return resolve(realpathSync(current), ...tail);
}

/**
 * Resolve a root-relative path, refusing anything that leaves the root.
 *
 * @param root - Absolute modernize root.
 * @param rel - Path relative to it, POSIX separators.
 * @returns The absolute path.
 * @throws DocsModernizeUnsafeError for an absolute path, an escape or a symlink.
 */
export function safeJoin(root: string, rel: string): string {
  if (isAbsolute(rel) || rel.includes('\0') || rel.split(/[\\/]/).includes('..')) {
    // @sync-invariant none:input-shape a path that is absolute or climbs out of the root is refused before any write
    throw new DocsModernizeUnsafeError(
      `unsafe path ${JSON.stringify(rel)}: must be relative to the root`,
    );
  }
  const abs = resolve(root, rel.split('/').join(sep));
  const realRoot = realpathSync(root);
  if (!within(realRoot, realOrNearest(abs))) {
    // @sync-invariant none:input-shape a path that resolves outside the root (through a symlink) is refused before any write
    throw new DocsModernizeUnsafeError(`unsafe path ${rel}: resolves outside ${root}`);
  }
  if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) {
    // @sync-invariant none:input-shape a symlinked file is refused before any write; modernize reads and moves real files only
    throw new DocsModernizeUnsafeError(`unsafe path ${rel}: is a symlink`);
  }
  return abs;
}

/**
 * Check that the invoking checkout is the project root or a git worktree of
 * the SAME repository (one git common dir), so no checkout of an unrelated
 * repository can be written to or read as the project's (T14188).
 *
 * @param projectRoot - Project root.
 * @param checkoutRoot - The invoking checkout.
 * @throws DocsModernizeUnsafeError when it is another repository, or git cannot tell.
 */
export function assertCheckoutOfProject(projectRoot: string, checkoutRoot: string): void {
  if (resolve(projectRoot) === resolve(checkoutRoot)) return;
  const project = gitCommonDir(projectRoot);
  const checkout = gitCommonDir(checkoutRoot);
  if (project === null || project !== checkout) {
    // @sync-invariant none:input-shape a checkout of another repository is refused before any read or write
    throw new DocsModernizeUnsafeError(
      `checkout ${checkoutRoot} is not a worktree of the project ${projectRoot} ` +
        `(git common dir ${checkout ?? 'unknown'} vs ${project ?? 'unknown'})`,
    );
  }
}

/**
 * Check that a modernize root sits inside the project, or inside the checkout
 * the command was started from, once that checkout is proven a worktree of
 * the project's repository ({@link assertCheckoutOfProject}, T14188).
 *
 * @param projectRoot - Project root.
 * @param root - Absolute modernize root.
 * @param checkoutRoot - The invoking checkout (default: the project root).
 * @throws DocsModernizeUnsafeError when it sits in neither, or the checkout is
 *   another repository's.
 */
export function assertRootInProject(
  projectRoot: string,
  root: string,
  checkoutRoot: string = projectRoot,
): void {
  assertCheckoutOfProject(projectRoot, checkoutRoot);
  if (
    !isAbsolute(root) ||
    !existsSync(root) ||
    ![projectRoot, checkoutRoot].some((r) => within(realpathSync(r), realpathSync(root)))
  ) {
    // @sync-invariant none:input-shape a modernize root outside the project is refused before any write
    throw new DocsModernizeUnsafeError(
      `modernize root ${root} is not inside the project ${projectRoot}` +
        (checkoutRoot === projectRoot ? '' : ` or the checkout ${checkoutRoot}`),
    );
  }
}

/**
 * Parse and check a plan read from disk.
 *
 * @param raw - File text.
 * @param projectRoot - Project root.
 * @param checkoutRoot - The invoking checkout (default: the project root).
 * @returns The plan, with every path checked.
 * @throws DocsModernizeUnsafeError on a bad shape or an unsafe path.
 */
export function parseModernizePlan(
  raw: string,
  projectRoot: string,
  checkoutRoot: string = projectRoot,
): DocsModernizePlan {
  const parsed = docsModernizePlanSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    // @sync-invariant none:input-shape a malformed plan file is refused before any write
    throw new DocsModernizeUnsafeError(
      `plan file does not match the plan schema: ${parsed.error.message}`,
    );
  }
  const plan: DocsModernizePlan = parsed.data;
  assertPlanPaths(plan, projectRoot, checkoutRoot);
  return plan;
}

/**
 * Check every path a plan names.
 *
 * @param plan - The plan.
 * @param projectRoot - Project root.
 * @param checkoutRoot - The invoking checkout (default: the project root).
 */
export function assertPlanPaths(
  plan: DocsModernizePlan,
  projectRoot: string,
  checkoutRoot: string = projectRoot,
): void {
  assertRootInProject(projectRoot, plan.root, checkoutRoot);
  for (const row of plan.rows) {
    safeJoin(plan.root, row.path);
    if ((row.disposition === 'keep' || row.disposition === 'rename') && row.target) {
      safeJoin(plan.root, row.target);
    }
  }
  const repoFixes = (plan.linkFixes ?? []).filter((f) => f.base === 'repo');
  if (repoFixes.length > 0) assertRepoBase(projectRoot, plan.root, plan.repoRoot, checkoutRoot);
  for (const fix of plan.linkFixes ?? []) {
    if (fix.base !== 'repo') safeJoin(plan.root, fix.path);
    else safeJoin(plan.repoRoot ?? '', fix.path);
  }
}

/**
 * Check the second write base of a plan or receipt (T14196): it exists, it is
 * the project root or the invoking checkout (a worktree of this repository),
 * and the modernize root sits inside it.
 *
 * @param projectRoot - Project root.
 * @param root - Absolute modernize root.
 * @param repoRoot - The base `repo` paths are relative to.
 * @param checkoutRoot - The invoking checkout.
 * @throws DocsModernizeUnsafeError when any of that fails.
 */
function assertRepoBase(
  projectRoot: string,
  root: string,
  repoRoot: string | undefined,
  checkoutRoot: string,
): void {
  if (!repoRoot) {
    // @sync-invariant none:input-shape a repo-base link fix with no repo root is refused before any write
    throw new DocsModernizeUnsafeError('a base:repo entry needs the plan or receipt repoRoot');
  }
  assertRootInProject(projectRoot, repoRoot, checkoutRoot);
  if (!within(realpathSync(repoRoot), realpathSync(root))) {
    // @sync-invariant none:input-shape a repo root that does not hold the modernize root is refused before any write
    throw new DocsModernizeUnsafeError(
      `repoRoot ${repoRoot} does not hold the modernize root ${root}`,
    );
  }
}

/**
 * Parse and check a receipt read back for rollback.
 *
 * @param raw - File text.
 * @param projectRoot - Project root.
 * @param checkoutRoot - The invoking checkout (default: the project root).
 * @returns The receipt, with every path checked.
 */
export function parseModernizeReceipt(
  raw: string,
  projectRoot: string,
  checkoutRoot: string = projectRoot,
): DocsModernizeReceipt {
  const parsed = docsModernizeReceiptSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    // @sync-invariant none:input-shape a malformed receipt is refused before any rollback step
    throw new DocsModernizeUnsafeError(
      `receipt does not match the receipt schema: ${parsed.error.message}`,
    );
  }
  const receipt = parsed.data;
  assertRootInProject(projectRoot, receipt.root, checkoutRoot);
  if (receipt.ops.some((op) => op.base === 'repo')) {
    assertRepoBase(projectRoot, receipt.root, receipt.repoRoot, checkoutRoot);
  }
  for (const op of receipt.ops) {
    if (!op.path) continue;
    if (op.base === 'repo') safeJoin(receipt.repoRoot ?? '', op.path);
    else safeJoin(receipt.root, op.path);
  }
  return receipt;
}

/**
 * Check that a plan hangs together: every `merge-into`/`delete` row names a
 * survivor's slug (so its content has somewhere to go), every `keep` row
 * targets its own path, every survivor target is a `.md`/`.txt` file, and
 * every `link-fix` names a kept file, an unscanned file (with its sha256), or
 * (`base: 'repo'`, T14196) an editable markdown file outside the root (with its
 * sha256), of a tree plan.
 *
 * @param plan - The plan.
 * @throws DocsModernizeUnsafeError on the first inconsistent row.
 */
export function assertPlanConsistent(plan: DocsModernizePlan): void {
  const survivors = new Set(
    plan.rows
      .filter((r) => r.disposition === 'keep' || r.disposition === 'rename')
      .map((r) => r.slug),
  );
  for (const row of plan.rows) {
    const bad = (why: string): never => {
      // @sync-invariant none:input-shape an inconsistent plan row is refused before any write
      throw new DocsModernizeUnsafeError(`plan row ${row.path}: ${why}`);
    };
    if (row.disposition === 'merge-into' || row.disposition === 'delete') {
      if (!row.target || !survivors.has(row.target)) {
        bad(`${row.disposition} must name a survivor's slug (got ${row.target ?? 'none'})`);
      }
    } else if (plan.mode !== 'store-only') {
      if (row.disposition === 'keep' && row.target !== row.path)
        bad('keep must target its own path');
      if (!row.target || !/\.(md|txt)$/i.test(row.target))
        bad('a survivor must target a .md or .txt file');
    }
  }
  // A link-fix names a kept row, or a file the plan neither scans nor writes
  // (T14194), which must carry the bytes it was planned against.
  const kept = new Set(plan.rows.filter((r) => r.disposition === 'keep').map((r) => r.path));
  const touched = new Set(plan.rows.flatMap((r) => [r.path, r.target ?? r.path]));
  // A repo-base fix (T14196) names a file outside the root that policy lets
  // modernize edit; changelogs, changesets and CLEO state never are.
  const rootInRepo =
    plan.repoRoot === undefined
      ? null
      : relative(realpathSync(plan.repoRoot), realpathSync(plan.root)).split(sep).join('/');
  for (const fix of plan.linkFixes ?? []) {
    const ok =
      plan.mode === 'tree' &&
      (fix.base === 'repo'
        ? fix.sha256 !== undefined &&
          rootInRepo !== null &&
          rootInRepo !== '' &&
          !`${fix.path}/`.startsWith(`${rootInRepo}/`) &&
          repoLinkFixAllowed(fix.path)
        : kept.has(fix.path) || (!touched.has(fix.path) && fix.sha256 !== undefined));
    if (!ok) {
      // @sync-invariant none:input-shape a link fix for a file the plan moves or does not vouch for is refused before any write
      throw new DocsModernizeUnsafeError(
        `link-fix ${fix.path}: only a kept file, an unscanned file with its sha256, or (base repo) an editable markdown file outside the root with its sha256, of a tree plan`,
      );
    }
  }
}

/**
 * Parse and check an `--overrides` file.
 *
 * @param raw - File text.
 * @returns The overrides.
 * @throws DocsModernizeUnsafeError on a bad shape.
 */
export function parseModernizeOverrides(raw: string): DocsModernizeOverrides {
  const parsed = docsModernizeOverridesSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    // @sync-invariant none:input-shape a malformed overrides file is refused before any write
    throw new DocsModernizeUnsafeError(
      `overrides file does not match the schema: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}
