/**
 * Disposal guard for task worktrees (T13696).
 *
 * Disposing a worktree deletes its whole directory. Two things outside it can
 * still need files inside it:
 *
 * 1. Other checkouts that symlink into it — agents share one physical
 *    `node_modules` across worktrees, so deleting the owner breaks every
 *    sibling that links to it.
 * 2. The task's own evidence — a `test-run:` receipt or a gitignored `files:`
 *    path hashed inside the worktree exists nowhere else, so deleting it makes
 *    the recorded sha256 unverifiable forever.
 *
 * Evidence is kept in place rather than moved: re-validation reads the atom's
 * `resolvedPath`, then the same path under the project root, and nothing else,
 * so a moved file would fail it exactly like a deleted one.
 *
 * @task T13696
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type {
  EvidenceAtom,
  WorktreeDisposalBlockers,
  WorktreeKeepMarker,
} from '@cleocode/contracts';
import { gitSync } from './git.js';

/** shortcut: at most this many entries are read per scanned directory; raise it if a store outgrows it. */
const MAX_ENTRIES_PER_DIR = 5000;

/** Resolve symlinks when the path exists; otherwise `null`. */
function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Whether `target` is `root` itself or strictly inside it (both already real paths). */
function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** Directory entries as absolute paths, bounded; `[]` when unreadable. */
function entries(dir: string): string[] {
  try {
    return readdirSync(dir)
      .slice(0, MAX_ENTRIES_PER_DIR)
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/**
 * Paths a checkout could link into another worktree through: `node_modules`
 * itself, its top-level entries and `.pnpm` entries, and each workspace
 * package's `node_modules`.
 */
function linkCandidates(checkout: string): string[] {
  const nm = join(checkout, 'node_modules');
  const packageNms = entries(join(checkout, 'packages')).map((p) => join(p, 'node_modules'));
  return [nm, ...entries(nm), ...entries(join(nm, '.pnpm')), ...packageNms];
}

/** Every other checkout that could hold a link: registered git worktrees and siblings under the worktree root. */
function otherCheckouts(worktreePath: string, gitRoot: string): string[] {
  const found = new Set<string>(entries(dirname(worktreePath)));
  try {
    for (const line of gitSync(['worktree', 'list', '--porcelain'], gitRoot).split('\n')) {
      if (line.startsWith('worktree ')) found.add(line.slice('worktree '.length));
    }
  } catch {
    // Not a git checkout: the sibling scan still runs.
  }
  return [...found];
}

/**
 * Symlinks in other checkouts that resolve into `worktreePath`.
 *
 * @param worktreePath - The worktree about to be disposed.
 * @param gitRoot - Git root whose registered worktrees are scanned.
 * @returns The linking paths (empty when nothing depends on it).
 *
 * @task T13696
 */
export function findWorktreeDependents(worktreePath: string, gitRoot: string): string[] {
  const self = realOrNull(worktreePath);
  if (self === null) return [];
  const dependents: string[] = [];
  for (const checkout of otherCheckouts(worktreePath, gitRoot)) {
    const real = realOrNull(checkout);
    if (real === null || isWithin(self, real)) continue;
    for (const candidate of linkCandidates(checkout)) {
      let isLink = false;
      try {
        isLink = lstatSync(candidate).isSymbolicLink();
      } catch {
        continue;
      }
      if (!isLink) continue;
      const target = realOrNull(candidate);
      if (target !== null && isWithin(self, target)) dependents.push(candidate);
    }
  }
  return dependents;
}

/** sha256 of a file, or `null` when it cannot be read. */
function sha256Of(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

/** The hashed files an evidence atom references, with the sha256 recorded at verify time. */
function hashedFiles(
  atom: EvidenceAtom,
): Array<{ path: string; sha256: string; resolvedPath?: string }> {
  if (atom.kind === 'files') return atom.files;
  if (atom.kind === 'test-run' || atom.kind === 'qa-run') return [atom];
  return [];
}

/**
 * Evidence files inside `worktreePath` with no byte-identical copy at the same
 * relative path under `projectRoot`; with `projectRoot` `null`, every one.
 */
function unrecoverableEvidenceFiles(
  worktreePath: string,
  projectRoot: string | null,
  evidence: readonly EvidenceAtom[],
): Array<{ path: string; sha256: string }> {
  const self = realOrNull(worktreePath);
  if (self === null) return [];
  const lost = new Map<string, string>();
  for (const atom of evidence) {
    for (const file of hashedFiles(atom)) {
      const abs = file.resolvedPath ?? (isAbsolute(file.path) ? file.path : null);
      const real = abs === null ? null : realOrNull(abs);
      if (real === null || !isWithin(self, real)) continue;
      const counterpart = projectRoot === null ? null : join(projectRoot, relative(self, real));
      if (
        counterpart === null ||
        !existsSync(counterpart) ||
        sha256Of(counterpart) !== file.sha256
      ) {
        lost.set(real, file.sha256);
      }
    }
  }
  return [...lost].map(([path, sha256]) => ({ path, sha256 }));
}

/**
 * Evidence files inside `worktreePath` that re-validation could not find once
 * the worktree is gone: no byte-identical file at the same relative path under
 * `projectRoot` (where a merged, committed file lands).
 *
 * @param worktreePath - The worktree about to be disposed.
 * @param projectRoot - The main checkout re-validation falls back to.
 * @param evidence - The task's recorded evidence atoms.
 * @returns Absolute paths of the files that would be lost.
 *
 * @task T13696
 */
export function findUnrecoverableEvidence(
  worktreePath: string,
  projectRoot: string,
  evidence: readonly EvidenceAtom[],
): string[] {
  return unrecoverableEvidenceFiles(worktreePath, projectRoot, evidence).map((f) => f.path);
}

/**
 * Why `worktreePath` must not be disposed, or `null` when nothing needs it.
 *
 * @param worktreePath - The worktree about to be disposed.
 * @param opts.gitRoot - Git root whose registered worktrees are scanned.
 * @param opts.projectRoot - The main checkout evidence re-validation falls back to.
 * @param opts.evidence - The task's recorded evidence atoms.
 * @returns The blockers, or `null` when disposal is safe.
 *
 * @task T13696
 */
export function findDisposalBlockers(
  worktreePath: string,
  opts: { gitRoot: string; projectRoot: string; evidence?: readonly EvidenceAtom[] },
): WorktreeDisposalBlockers | null {
  const dependents = findWorktreeDependents(worktreePath, opts.gitRoot);
  const evidence = findUnrecoverableEvidence(worktreePath, opts.projectRoot, opts.evidence ?? []);
  return dependents.length > 0 || evidence.length > 0 ? { dependents, evidence } : null;
}

/**
 * One line naming what kept a worktree and why, for logs and `error` fields.
 *
 * @param worktreePath - The kept worktree.
 * @param blockers - What kept it.
 * @returns A human-readable explanation.
 *
 * @task T13696
 */
export function describeDisposalBlockers(
  worktreePath: string,
  blockers: WorktreeDisposalBlockers,
): string {
  const parts: string[] = [];
  if (blockers.dependents.length > 0) {
    parts.push(
      `${blockers.dependents.length} link(s) from other checkouts resolve into it (${blockers.dependents.join(', ')})`,
    );
  }
  if (blockers.evidence.length > 0) {
    parts.push(
      `${blockers.evidence.length} evidence file(s) exist only there (${blockers.evidence.join(', ')})`,
    );
  }
  return `Worktree ${worktreePath} kept: ${parts.join('; ')}. Remove the links or re-verify, then dispose it.`;
}

/**
 * Where the keep marker for `worktreePath` lives: beside the checkout, never
 * inside it, so `git status` stays clean and nothing can commit it.
 *
 * @param worktreePath - The worktree the marker describes.
 * @returns `<worktreePath>.keep.json`.
 *
 * @task T13700
 */
export function keepMarkerPath(worktreePath: string): string {
  return `${worktreePath.replace(/[\\/]+$/, '')}.keep.json`;
}

/**
 * The keep marker for `worktreePath`, or `null` when there is none or it is
 * unreadable.
 *
 * @param worktreePath - The worktree to look up.
 * @returns The marker, or `null`.
 *
 * @task T13700
 */
export function readKeepMarker(worktreePath: string): WorktreeKeepMarker | null {
  let parsed: Partial<WorktreeKeepMarker>;
  try {
    parsed = JSON.parse(
      readFileSync(keepMarkerPath(worktreePath), 'utf-8'),
    ) as Partial<WorktreeKeepMarker>;
  } catch {
    return null;
  }
  return {
    taskId: typeof parsed.taskId === 'string' ? parsed.taskId : null,
    reason: typeof parsed.reason === 'string' ? parsed.reason : 'unknown',
    projectRoot: typeof parsed.projectRoot === 'string' ? parsed.projectRoot : null,
    dependents: Array.isArray(parsed.dependents) ? parsed.dependents : [],
    evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
    keptAt: typeof parsed.keptAt === 'string' ? parsed.keptAt : '',
  };
}

/**
 * The one disposal guard every path that deletes a worktree calls first
 * (T13700): dependents scan, evidence check, and the durable keep marker.
 *
 * Evidence from an earlier keep is re-checked from the marker, so a batch
 * prune with no task store still honours it. While anything blocks, the marker
 * is written (or refreshed) and the blockers returned; once nothing does, the
 * marker is removed and `null` returned, so the caller may dispose.
 *
 * @param worktreePath - The worktree about to be disposed.
 * @param opts.taskId - Owning task, recorded on a new marker.
 * @param opts.reason - The disposal asking, recorded on a new marker.
 * @param opts.gitRoot - Git root whose worktrees are scanned; defaults to the worktree itself.
 * @param opts.projectRoot - Main checkout evidence falls back to; defaults to the marker's.
 * @param opts.evidence - The task's recorded evidence atoms, when the caller has them.
 * @param opts.dryRun - Report only; never write or remove the marker.
 * @returns The blockers, or `null` when disposal is safe.
 *
 * @task T13700
 */
export function guardWorktreeDisposal(
  worktreePath: string,
  opts: {
    taskId: string | null;
    reason: string;
    gitRoot?: string;
    projectRoot?: string;
    evidence?: readonly EvidenceAtom[];
    dryRun?: boolean;
  },
): WorktreeDisposalBlockers | null {
  const marker = readKeepMarker(worktreePath);
  const projectRoot = opts.projectRoot ?? marker?.projectRoot ?? null;
  const evidence: EvidenceAtom[] = [...(opts.evidence ?? [])];
  if (marker !== null && marker.evidence.length > 0) {
    evidence.push({
      kind: 'files',
      files: marker.evidence.map((f) => ({ ...f, resolvedPath: f.path })),
    });
  }
  const dependents = findWorktreeDependents(worktreePath, opts.gitRoot ?? worktreePath);
  const lost = unrecoverableEvidenceFiles(worktreePath, projectRoot, evidence);
  const blockers =
    dependents.length > 0 || lost.length > 0
      ? { dependents, evidence: lost.map((f) => f.path) }
      : null;
  if (opts.dryRun === true) return blockers;
  try {
    if (blockers !== null) {
      const next: WorktreeKeepMarker = {
        taskId: marker?.taskId ?? opts.taskId,
        reason: marker?.reason ?? opts.reason,
        projectRoot,
        dependents,
        evidence: lost,
        keptAt: marker?.keptAt || new Date().toISOString(),
      };
      writeFileSync(keepMarkerPath(worktreePath), `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
    } else if (marker !== null) {
      rmSync(keepMarkerPath(worktreePath), { force: true });
    }
  } catch {
    // The marker is a record, not the guard: the scan above already decided.
  }
  return blockers;
}
