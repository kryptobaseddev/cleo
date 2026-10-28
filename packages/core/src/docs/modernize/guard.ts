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
import type { DocsModernizePlan, DocsModernizeReceipt } from '@cleocode/contracts';
import {
  docsModernizePlanSchema,
  docsModernizeReceiptSchema,
} from '@cleocode/contracts/docs/modernize.js';

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
 * Check that a modernize root sits inside the project.
 *
 * @param projectRoot - Project root.
 * @param root - Absolute modernize root.
 * @throws DocsModernizeUnsafeError when it does not.
 */
export function assertRootInProject(projectRoot: string, root: string): void {
  if (
    !isAbsolute(root) ||
    !existsSync(root) ||
    !within(realpathSync(projectRoot), realpathSync(root))
  ) {
    // @sync-invariant none:input-shape a modernize root outside the project is refused before any write
    throw new DocsModernizeUnsafeError(
      `modernize root ${root} is not inside the project ${projectRoot}`,
    );
  }
}

/**
 * Parse and check a plan read from disk.
 *
 * @param raw - File text.
 * @param projectRoot - Project root.
 * @returns The plan, with every path checked.
 * @throws DocsModernizeUnsafeError on a bad shape or an unsafe path.
 */
export function parseModernizePlan(raw: string, projectRoot: string): DocsModernizePlan {
  const parsed = docsModernizePlanSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    // @sync-invariant none:input-shape a malformed plan file is refused before any write
    throw new DocsModernizeUnsafeError(
      `plan file does not match the plan schema: ${parsed.error.message}`,
    );
  }
  const plan: DocsModernizePlan = parsed.data;
  assertPlanPaths(plan, projectRoot);
  return plan;
}

/**
 * Check every path a plan names.
 *
 * @param plan - The plan.
 * @param projectRoot - Project root.
 */
export function assertPlanPaths(plan: DocsModernizePlan, projectRoot: string): void {
  assertRootInProject(projectRoot, plan.root);
  for (const row of plan.rows) {
    safeJoin(plan.root, row.path);
    if ((row.disposition === 'keep' || row.disposition === 'rename') && row.target) {
      safeJoin(plan.root, row.target);
    }
  }
}

/**
 * Parse and check a receipt read back for rollback.
 *
 * @param raw - File text.
 * @param projectRoot - Project root.
 * @returns The receipt, with every path checked.
 */
export function parseModernizeReceipt(raw: string, projectRoot: string): DocsModernizeReceipt {
  const parsed = docsModernizeReceiptSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    // @sync-invariant none:input-shape a malformed receipt is refused before any rollback step
    throw new DocsModernizeUnsafeError(
      `receipt does not match the receipt schema: ${parsed.error.message}`,
    );
  }
  const receipt = parsed.data;
  assertRootInProject(projectRoot, receipt.root);
  for (const op of receipt.ops) if (op.path) safeJoin(receipt.root, op.path);
  return receipt;
}
