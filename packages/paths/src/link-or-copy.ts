/**
 * `linkOrCopy` — the one way CLEO makes a filesystem link.
 *
 * A plain `symlink(target, link, 'dir')` needs Developer Mode or admin on
 * Windows, and a file symlink needs the same; code that calls it directly
 * fails on Windows (or silently leaves a stale entry) and nothing notices.
 * This helper:
 *
 * 1. sets an existing SYMLINK at `linkPath` aside (lstat-based, so a dangling
 *    link is found — `existsSync` follows links and reports it absent) and
 *    restores it if every replacement fails;
 * 2. links: a directory junction on win32 (no privilege needed), a symlink
 *    elsewhere;
 * 3. verifies the link resolves; when linking throws or the link does not
 *    resolve, falls back to a copy (recursive for directories) built in a
 *    hidden staging sibling and renamed into place. The link path itself is
 *    only ever unlinked, never deleted recursively;
 * 4. returns which mode it used, so callers can record a copy.
 *
 * A real file or directory at `linkPath` is only replaced with
 * `overwrite: true` — it may be user data, not a link this helper made.
 *
 * @task T12607
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** What the link points at. */
export type LinkKind = 'dir' | 'file';

/** How the entry was made. */
export type LinkMode = 'symlink' | 'junction' | 'copy';

/** Options for {@link linkOrCopy}. */
export interface LinkOrCopyOptions {
  /** Replace a real file or directory at `linkPath` (default false). */
  overwrite?: boolean;
  /** Platform to behave as (tests). Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /**
   * `'copy'` (default) copies the target when linking fails. `'none'` throws
   * instead — for targets too large to copy (e.g. a whole `node_modules`),
   * where the caller has its own degraded path.
   */
  fallback?: 'copy' | 'none';
}

/** Result of {@link linkOrCopy}. */
export interface LinkOrCopyResult {
  /** How the entry was made. */
  mode: LinkMode;
  /** Absolute link path. */
  linkPath: string;
  /** Absolute resolved target. */
  target: string;
  /** Why linking was abandoned in favour of a copy, when `mode === 'copy'`. */
  fallbackReason: string | null;
}

/** Thrown when `linkPath` holds a real entry and `overwrite` is not set. */
export class LinkOccupiedError extends Error {
  /** Stable error code. */
  readonly code = 'E_LINK_OCCUPIED';
  /** @param linkPath - The occupied path. */
  constructor(readonly linkPath: string) {
    super(`${linkPath} exists and is not a link; pass overwrite to replace it`);
    this.name = 'LinkOccupiedError';
  }
}

type SymlinkImpl = (target: string, path: string, type?: 'dir' | 'file' | 'junction') => void;

let symlinkImpl: SymlinkImpl = (target, path, type) => symlinkSync(target, path, type);

/**
 * Replace the symlink implementation (tests only), e.g. to force the
 * Windows-without-Developer-Mode failure on any host. Pass nothing to restore.
 *
 * @internal
 */
export function _setSymlinkImplForTests(impl?: SymlinkImpl): void {
  symlinkImpl = impl ?? ((target, path, type) => symlinkSync(target, path, type));
}

/** Hidden sibling of `path` for a staged copy or a set-aside previous entry. */
function sibling(path: string, role: 'staging' | 'prev'): string {
  const suffix = `${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
  return join(dirname(path), `.${basename(path)}.link-or-copy-${role}-${suffix}`);
}

/** Unlink `path` only if it is a link — never follows it, never recurses. */
function unlinkIfLink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) unlinkSync(path);
  } catch {
    // nothing there
  }
}

/**
 * Move whatever occupies `linkPath` to a hidden sibling so it can be restored
 * if the replacement fails. Returns the set-aside path, or null when empty.
 */
function setAside(linkPath: string, overwrite: boolean): { path: string; isLink: boolean } | null {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(linkPath);
  } catch {
    return null; // nothing there
  }
  const isLink = stat.isSymbolicLink();
  if (!isLink && !overwrite) throw new LinkOccupiedError(linkPath);
  const aside = sibling(linkPath, 'prev');
  renameSync(linkPath, aside);
  return { path: aside, isLink };
}

/** Drop the set-aside previous entry once its replacement is in place. */
function discard(prev: { path: string; isLink: boolean } | null): void {
  if (prev === null) return;
  if (prev.isLink) unlinkSync(prev.path);
  else rmSync(prev.path, { recursive: true, force: true }); // an entry the caller asked to overwrite
}

/**
 * Make `linkPath` point at `target`: junction (win32 dirs) or symlink,
 * verified to resolve, else a copy.
 *
 * @param target - Link target; relative targets resolve from `dirname(linkPath)`.
 * @param linkPath - Path to create.
 * @param kind - `'dir'` or `'file'`.
 * @param opts - See {@link LinkOrCopyOptions}.
 * @returns The mode used and the resolved paths.
 * @throws {LinkOccupiedError} When a real entry occupies `linkPath` without `overwrite`.
 * @throws The copy error when neither a link nor a copy can be made.
 * @example
 * ```ts
 * const { mode } = linkOrCopy('2026-models.json', join(dir, 'latest.json'), 'file', { overwrite: true });
 * ```
 * @task T12607
 */
export function linkOrCopy(
  target: string,
  linkPath: string,
  kind: LinkKind,
  opts: LinkOrCopyOptions = {},
): LinkOrCopyResult {
  const platform = opts.platform ?? process.platform;
  const absLink = resolve(linkPath);
  const absTarget = resolve(dirname(absLink), target);
  // The previous entry is set aside, not deleted, until its replacement is in
  // place; any failure below puts it back.
  const prev = setAside(absLink, opts.overwrite === true);

  let fallbackReason: string | null = null;
  const junction = platform === 'win32' && kind === 'dir';
  try {
    // A junction must be absolute; a symlink keeps the caller's (possibly
    // relative) target so the pair stays relocatable.
    symlinkImpl(junction ? absTarget : target, absLink, junction ? 'junction' : kind);
    if (existsSync(absLink)) {
      discard(prev);
      return {
        mode: junction ? 'junction' : 'symlink',
        linkPath: absLink,
        target: absTarget,
        fallbackReason,
      };
    }
    fallbackReason = 'link was created but does not resolve';
  } catch (err) {
    fallbackReason ??= err instanceof Error ? err.message : String(err);
  }
  // The link path only ever held our link here: unlink, never recurse.
  unlinkIfLink(absLink);

  const restore = (): void => {
    if (prev !== null) renameSync(prev.path, absLink);
  };
  if (opts.fallback === 'none') {
    restore();
    throw new Error(`could not link ${absLink} → ${absTarget}: ${fallbackReason}`);
  }
  // Build the copy beside the target, then rename it into place.
  const staging = sibling(absLink, 'staging');
  try {
    if (kind === 'dir') cpSync(absTarget, staging, { recursive: true });
    else copyFileSync(absTarget, staging);
    renameSync(staging, absLink);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true }); // our own staging copy
    restore();
    throw err;
  }
  discard(prev);
  return { mode: 'copy', linkPath: absLink, target: absTarget, fallbackReason };
}
