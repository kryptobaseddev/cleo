/**
 * Project lifecycle engine — move, reroot, rename, and re-register CLEO projects.
 *
 * Provides the core operations for relocating a CLEO project on disk,
 * renaming it, and reconciling the nexus registry after manual moves.
 *
 * All functions accept explicit absolute paths — no CWD-walk-up (AC7).
 *
 * @task T11010 — T10298-1
 * @task T12552 — dry runs are pure
 * @task T12555 — only root-level `.git` / `node_modules` are skipped
 * @task T12556 — a copy never carries the source's checkout nonce
 * @task T12558 — `rerootProject`, child/ancestor targets refused
 */

import { existsSync, statSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve as resolvePath, sep } from 'node:path';
import type {
  ProjectRelocationPlan,
  ProjectRelocationRegistryAction,
  RerootProjectResult,
} from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';
import {
  canonicalizePath,
  computeProjectHash,
  readPortableProjectId,
  resolveWorktreeRootForHash,
} from '@cleocode/paths';
import { type EngineResult, engineError, engineSuccess } from './engine-result.js';
import { CHECKOUT_NONCE_FIELD, mintCheckoutNonce } from './nexus/checkout-nonce.js';
import { generateProjectHash, nexusReconcile, nexusRenameProject } from './nexus/index.js';

// ── Result types ─────────────────────────────────────────────────────

/** Result of a successful project move. */
export interface MoveProjectResult {
  /** Stable project UUID — preserved across moves. */
  projectId: string;
  /** The old absolute project root path. */
  oldPath: string;
  /** The new absolute project root path. */
  newPath: string;
  /** Updated project hash (based on new path). */
  newProjectHash: string;
  /** Nexus reconcile status. */
  reconcileStatus: 'ok' | 'path_updated' | 'auto_registered' | 'candidate';
  /** Discriminant against a dry-run plan: always `false` for a completed move. */
  dryRun: false;
  /** Root-level entries that were NOT copied (`.git`, `node_modules`). */
  excluded: string[];
}

/** Result of a successful project rename. */
export interface RenameProjectResult {
  /** Stable project UUID — preserved across renames. */
  projectId: string;
  /** The project root path. */
  projectRoot: string;
  /** The old project name. */
  oldName: string;
  /** The new project name. */
  newName: string;
  /** Updated project hash (name influences hash). */
  newProjectHash: string;
}

/** Result of a successful project re-registration. */
export interface ReregisterProjectResult {
  /** Stable project UUID. */
  projectId: string;
  /** The project root path. */
  projectRoot: string;
  /** Current project hash. */
  projectHash: string;
  /** Whether the project had drifted (path changed since last register). */
  drifted: boolean;
  /** Nexus reconcile status. */
  reconcileStatus: 'ok' | 'path_updated' | 'auto_registered' | 'candidate';
  /** Previous path if drift was detected. */
  oldPath?: string;
}

// ── Internal helpers ─────────────────────────────────────────────────

/**
 * Read and parse project-info.json from the given project root.
 * Returns null if the file doesn't exist or is unparseable.
 */
async function readProjectInfo(projectRoot: string): Promise<Record<string, unknown> | null> {
  const infoPath = join(projectRoot, '.cleo', 'project-info.json');
  try {
    const raw = await readFile(infoPath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Write project-info.json atomically (tmp + rename).
 */
async function writeProjectInfo(projectRoot: string, data: Record<string, unknown>): Promise<void> {
  const cleoDir = join(projectRoot, '.cleo');
  const infoPath = join(cleoDir, 'project-info.json');
  const tmpPath = join(cleoDir, 'project-info.json.tmp');

  const content = `${JSON.stringify(data, null, 2)}\n`;
  await writeFile(tmpPath, content, 'utf-8');
  await rename(tmpPath, infoPath);
}

/**
 * Validate that a path is absolute and exists.
 */
function validateAbsolutePath(label: string, p: string): EngineResult<never> | null {
  const resolved = resolvePath(p);
  if (resolved !== p) {
    return engineError('E_INVALID_PATH', `${label} must be an absolute path: "${p}"`, {
      fix: `Provide an absolute path like "${resolved}"`,
    });
  }
  return null; // valid
}

// ── Relocation helpers (T12552 · T12555 · T12556 · T12558) ──────────

/**
 * Top-level entries `move` never copies: rebuildable (`node_modules`) or the
 * source repository's own git database (`.git`). Matched at the project ROOT
 * only — a nested repository's `.git` or a workspace package's
 * `node_modules` is part of the tree and is copied (T12555).
 */
const MOVE_ROOT_EXCLUSIONS: readonly string[] = ['.git', 'node_modules'];

/** Entries `reroot` renames from the old root into the child. */
const REROOT_ENTRIES: readonly string[] = ['.cleo', '.worktreeinclude'];

/** Options shared by {@link moveProject} and {@link rerootProject}. */
export interface RelocateProjectOptions {
  /**
   * Return a {@link ProjectRelocationPlan} instead of acting. A dry run writes
   * nothing to disk and opens no registry or project database (T12552).
   */
  dryRun?: boolean;
}

/**
 * Canonical form of a path whose tail may not exist yet: the nearest existing
 * ancestor is resolved through symlinks (macOS `/tmp` → `/private/tmp`) and
 * the missing tail is appended, so containment compares like with like.
 */
function canonicalTarget(p: string): string {
  let head = resolvePath(p);
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    tail.unshift(basename(head));
    head = parent;
  }
  return join(canonicalizePath(head), ...tail);
}

/** `true` when `inner` is strictly inside `outer` (both canonical). */
function isStrictlyInside(outer: string, inner: string): boolean {
  const rel = relative(outer, inner);
  return rel.length > 0 && !rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep);
}

/** Read `projectId` from project-info.json, or the failure to return. */
async function readRelocatableIdentity(
  projectRoot: string,
): Promise<{ info: Record<string, unknown>; projectId: string } | EngineResult<never>> {
  const info = await readProjectInfo(projectRoot);
  if (!info) {
    return engineError(
      'E_PROJECT_INFO_MISSING',
      `Failed to read project-info.json at "${projectRoot}"`,
      { exitCode: ExitCode.CONFIG_ERROR },
    );
  }
  const projectId = typeof info.projectId === 'string' ? info.projectId : '';
  if (!projectId) {
    return engineError(
      'E_NO_PROJECT_ID',
      `project-info.json at "${projectRoot}" is missing projectId`,
      { fix: 'Run `cleo init` to generate a projectId', exitCode: ExitCode.CONFIG_ERROR },
    );
  }
  return { info, projectId };
}

/** Open the global registry (dynamic: keeps the store graph off import). */
async function openRegistry() {
  const { getNexusRegistryDb } = await import('./store/nexus-sqlite.js');
  const { getCleoHome } = await import('./paths.js');
  return getNexusRegistryDb(getCleoHome());
}

/** Demote the old location after an explicit rebind to the new one. */
async function demoteOldLocation(
  projectId: string,
  oldPath: string,
  state: 'candidate' | 'missing',
): Promise<void> {
  const { demoteProjectLocation } = await import('./nexus/path-map.js');
  demoteProjectLocation(
    await openRegistry(),
    { projectId, projectPath: oldPath, now: new Date().toISOString() },
    state,
  );
}

/**
 * Rebind the registry to `livePath` explicitly, then demote `demotedPath`.
 * Explicit because the old location still exists on this device, which a
 * plain reconcile rightly treats as a second checkout (T12470).
 *
 * Runs with the project scope pinned to `livePath`: the nexus handle is the
 * AMBIENT project's `cleo.db`, and the ambient root is still the caller's cwd
 * (the old root). After a reroot that directory has no `.cleo/`, and opening
 * it there would create an empty store beside the moved one.
 */
async function rebindRegistry(
  projectId: string,
  livePath: string,
  demotedPath: string,
  demotedState: 'candidate' | 'missing',
): Promise<EngineResult<MoveProjectResult['reconcileStatus']>> {
  const { captureProjectScope, worktreeScope } = await import('./project-scope.js');
  const scope = captureProjectScope(livePath, worktreeScope.getStore());
  try {
    const reconcile = await worktreeScope.run(scope, () =>
      nexusReconcile(livePath, { forceRebind: true }),
    );
    await demoteOldLocation(projectId, demotedPath, demotedState);
    return engineSuccess(reconcile.status);
  } catch (err) {
    return engineError(
      'E_NEXUS_RECONCILE_FAILED',
      `Nexus reconcile failed for "${livePath}": ${(err as Error).message}`,
      {
        details: { originalError: (err as Error).message },
        fix: `Run \`cleo nexus reconcile --force-rebind\` in ${livePath}`,
      },
    );
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Move a CLEO project to a new filesystem location.
 *
 * COPIES the project tree to `newPath` (skipping only the root-level `.git`
 * and `node_modules`), stamps the copy with a fresh checkout nonce, and
 * rebinds the nexus registry to it. The source tree is left in place and
 * demoted to a `candidate` location; remove it yourself once satisfied.
 *
 * A target inside the project, or one that contains it, is refused with
 * `E_INVALID_TARGET` before any IO — to make a child directory the project
 * root use {@link rerootProject}.
 *
 * @param newPath - Absolute path to the new project root location.
 * @param projectRoot - Absolute path to the current project root.
 * @param opts - `dryRun: true` returns the plan and changes nothing.
 * @returns The plan (dry run) or the {@link MoveProjectResult}.
 *
 * @remarks AC3: The projectId is preserved across moves; projectHash is
 *   recomputed from the new path. T12556: the copy never carries the source's
 *   checkout nonce, so a stale copy can never be promoted over the original.
 *
 * @example
 * ```typescript
 * const plan = await moveProject('/new/location/project', '/old/project', { dryRun: true });
 * const result = await moveProject('/new/location/project', '/old/project');
 * if (result.success) {
 *   console.log(`Moved to ${result.data.newPath}, hash=${result.data.newProjectHash}`);
 * }
 * ```
 */
export async function moveProject(
  newPath: string,
  projectRoot: string,
  opts: RelocateProjectOptions & { dryRun: true },
): Promise<EngineResult<ProjectRelocationPlan>>;
export async function moveProject(
  newPath: string,
  projectRoot: string,
  opts?: RelocateProjectOptions & { dryRun?: false },
): Promise<EngineResult<MoveProjectResult>>;
export async function moveProject(
  newPath: string,
  projectRoot: string,
  opts?: RelocateProjectOptions,
): Promise<EngineResult<MoveProjectResult | ProjectRelocationPlan>>;
export async function moveProject(
  newPath: string,
  projectRoot: string,
  opts: RelocateProjectOptions = {},
): Promise<EngineResult<MoveProjectResult | ProjectRelocationPlan>> {
  // AC7: Validate absolute paths
  const pathErr = validateAbsolutePath('newPath', newPath);
  if (pathErr) return pathErr;
  const rootErr = validateAbsolutePath('projectRoot', projectRoot);
  if (rootErr) return rootErr;

  // Validate source exists and has project-info.json
  if (!existsSync(join(projectRoot, '.cleo', 'project-info.json'))) {
    return engineError('E_NOT_CLEO_PROJECT', `No CLEO project found at "${projectRoot}"`, {
      fix: 'Ensure the project was initialized with `cleo init`',
      exitCode: ExitCode.CONFIG_ERROR,
    });
  }

  const source = canonicalizePath(projectRoot);
  const target = canonicalTarget(newPath);
  if (resolvePath(newPath) === resolvePath(projectRoot) || source === target) {
    return engineError(
      'E_SAME_PATH',
      `newPath and projectRoot resolve to the same location: "${projectRoot}"`,
      { exitCode: ExitCode.INVALID_INPUT },
    );
  }

  // T12558: a copy into its own subtree recurses; a copy onto an ancestor
  // overwrites the tree it is reading. Both are refused before any IO.
  if (isStrictlyInside(source, target)) {
    return engineError(
      'E_INVALID_TARGET',
      `newPath "${newPath}" is inside the project at "${projectRoot}"; move cannot copy a project into itself`,
      {
        exitCode: ExitCode.INVALID_INPUT,
        fix: `To make that directory the project root, run \`cleo project reroot ${relative(source, target)}\` from ${projectRoot}`,
      },
    );
  }
  if (isStrictlyInside(target, source)) {
    return engineError(
      'E_INVALID_TARGET',
      `newPath "${newPath}" contains the project at "${projectRoot}"; move cannot copy a project onto its own ancestor`,
      {
        exitCode: ExitCode.INVALID_INPUT,
        fix: 'Choose a target outside the project tree. `cleo project reroot <childDir>` relocates the project into one of its own subdirectories.',
      },
    );
  }
  if (existsSync(newPath)) {
    if (!statSync(newPath).isDirectory()) {
      return engineError('E_INVALID_TARGET', `newPath is not a directory: "${newPath}"`, {
        exitCode: ExitCode.INVALID_INPUT,
        fix: 'Choose a path that does not exist yet, or an empty directory',
      });
    }
    if ((await readdir(newPath)).length > 0) {
      return engineError('E_INVALID_TARGET', `newPath is not empty: "${newPath}"`, {
        exitCode: ExitCode.INVALID_INPUT,
        fix: 'Choose a path that does not exist yet, or an empty directory',
      });
    }
  }

  const identity = await readRelocatableIdentity(projectRoot);
  if ('success' in identity) return identity;
  const { info, projectId } = identity;

  const newProjectHash = generateProjectHash(newPath);
  const topLevel = (await readdir(projectRoot)).sort();
  const registry: ProjectRelocationRegistryAction = {
    action: 'rebind',
    livePath: newPath,
    demotedPath: projectRoot,
    demotedState: 'candidate',
    nonce: 'fresh',
  };

  // T12552: the dry run stops here — nothing above wrote anything.
  if (opts.dryRun) {
    return engineSuccess({
      dryRun: true,
      kind: 'move',
      projectId,
      source: projectRoot,
      target: newPath,
      newProjectHash,
      transfer: 'copy',
      entries: topLevel.filter((e) => !MOVE_ROOT_EXCLUSIONS.includes(e)),
      excluded: topLevel.filter((e) => MOVE_ROOT_EXCLUSIONS.includes(e)),
      writes: ['.cleo/project-info.json'],
      registry,
      blockers: [],
      deferredChecks: [],
    } satisfies ProjectRelocationPlan);
  }

  // AC3: Filesystem move via copy — the caller verifies before cleanup.
  try {
    await mkdir(dirname(newPath), { recursive: true });
    const rootExclusions = new Set(MOVE_ROOT_EXCLUSIONS.map((e) => join(projectRoot, e)));
    await cp(projectRoot, newPath, {
      recursive: true,
      // T12555: relative symlinks (pnpm's node_modules, repo-internal links)
      // must stay relative, or the copy points back into the source tree.
      verbatimSymlinks: true,
      filter: (src) => !rootExclusions.has(src),
    });
  } catch (err) {
    return engineError(
      'E_MOVE_FAILED',
      `Failed to copy project from "${projectRoot}" to "${newPath}": ${(err as Error).message}`,
      {
        exitCode: ExitCode.FILE_ERROR,
        fix: `Remove any partial copy at "${newPath}" and check the target is writable`,
      },
    );
  }

  // AC3 + T12556: the copy is a NEW checkout — a fresh nonce, never the source's.
  await writeProjectInfo(newPath, {
    ...info,
    projectRoot: newPath,
    projectHash: newProjectHash,
    [CHECKOUT_NONCE_FIELD]: mintCheckoutNonce(),
    lastUpdated: new Date().toISOString(),
  });

  const rebound = await rebindRegistry(projectId, newPath, projectRoot, 'candidate');
  if (!rebound.success) return rebound;

  return engineSuccess({
    dryRun: false,
    projectId,
    oldPath: projectRoot,
    newPath,
    newProjectHash,
    reconcileStatus: rebound.data,
    excluded: topLevel.filter((e) => MOVE_ROOT_EXCLUSIONS.includes(e)),
  });
}

/**
 * CLEO worktrees provisioned for the project at `projectRoot`. Their
 * directory is keyed by the root's path hash, so a reroot would strand them.
 */
async function listProjectWorktrees(projectRoot: string): Promise<string[]> {
  const found = new Set<string>();
  const dir = resolveWorktreeRootForHash(computeProjectHash(projectRoot));
  if (existsSync(dir)) {
    for (const entry of await readdir(dir)) found.add(join(dir, entry));
  }
  const { readSentinelIndex } = await import('./worktree/sentinel-index.js');
  for (const entry of readSentinelIndex(projectRoot)) {
    if (existsSync(entry.path)) found.add(entry.path);
  }
  return [...found].sort();
}

/**
 * Make a child directory of the current project root the new project root.
 *
 * RENAMES `.cleo/` (and `.worktreeinclude`, when present) into `childDir` —
 * nothing is copied, so tasks, BRAIN memory, sessions and the checkout nonce
 * all travel together. In order:
 *
 * 1. Refuses when any CLEO worktree or active session exists (`E_REROOT_BLOCKED`).
 * 2. Takes a required checkpoint (the `cleo backup add` snapshot).
 * 3. Closes every database handle, then renames.
 * 4. Writes `.cleo/project-id` with the SAME id when absent (never rewrites it).
 * 5. Rebinds the registry to `childDir` and demotes the old root to `missing`.
 *
 * `project-info.json` keeps no absolute `projectRoot` (T12557).
 *
 * @param childDir - Absolute path of a directory strictly inside `projectRoot`.
 * @param projectRoot - Absolute path to the current project root.
 * @param opts - `dryRun: true` returns the plan and touches no disk or registry.
 * @returns The plan (dry run) or the {@link RerootProjectResult}.
 *
 * @example
 * ```typescript
 * const plan = await rerootProject('/work/mono/app', '/work/mono', { dryRun: true });
 * const done = await rerootProject('/work/mono/app', '/work/mono');
 * ```
 */
export async function rerootProject(
  childDir: string,
  projectRoot: string,
  opts: RelocateProjectOptions & { dryRun: true },
): Promise<EngineResult<ProjectRelocationPlan>>;
export async function rerootProject(
  childDir: string,
  projectRoot: string,
  opts?: RelocateProjectOptions & { dryRun?: false },
): Promise<EngineResult<RerootProjectResult>>;
export async function rerootProject(
  childDir: string,
  projectRoot: string,
  opts?: RelocateProjectOptions,
): Promise<EngineResult<RerootProjectResult | ProjectRelocationPlan>>;
export async function rerootProject(
  childDir: string,
  projectRoot: string,
  opts: RelocateProjectOptions = {},
): Promise<EngineResult<RerootProjectResult | ProjectRelocationPlan>> {
  const pathErr = validateAbsolutePath('childDir', childDir);
  if (pathErr) return pathErr;
  const rootErr = validateAbsolutePath('projectRoot', projectRoot);
  if (rootErr) return rootErr;

  if (!existsSync(join(projectRoot, '.cleo', 'project-info.json'))) {
    return engineError('E_NOT_CLEO_PROJECT', `No CLEO project found at "${projectRoot}"`, {
      fix: 'Run `cleo project reroot` from the current project root (the directory holding .cleo/)',
      exitCode: ExitCode.CONFIG_ERROR,
    });
  }
  if (!existsSync(childDir) || !statSync(childDir).isDirectory()) {
    return engineError('E_INVALID_TARGET', `childDir is not an existing directory: "${childDir}"`, {
      exitCode: ExitCode.INVALID_INPUT,
      fix: 'Create the directory first, or pass an existing subdirectory of the project',
    });
  }
  const source = canonicalizePath(projectRoot);
  const target = canonicalizePath(childDir);
  if (!isStrictlyInside(source, target)) {
    return engineError(
      'E_INVALID_TARGET',
      `childDir "${childDir}" is not inside the project at "${projectRoot}"`,
      {
        exitCode: ExitCode.INVALID_INPUT,
        fix: `To relocate the project elsewhere, run \`cleo project move ${childDir}\``,
      },
    );
  }
  const present = REROOT_ENTRIES.filter((e) => existsSync(join(projectRoot, e)));
  const clashes = present.filter((e) => existsSync(join(childDir, e)));
  if (clashes.length > 0) {
    return engineError(
      'E_INVALID_TARGET',
      `childDir already holds ${clashes.join(', ')}: "${childDir}"`,
      {
        exitCode: ExitCode.INVALID_INPUT,
        fix: `Move ${clashes.map((c) => join(childDir, c)).join(', ')} aside first; reroot never merges or overwrites`,
      },
    );
  }

  const identity = await readRelocatableIdentity(projectRoot);
  if ('success' in identity) return identity;
  const { info, projectId } = identity;
  const tracked = readPortableProjectId(projectRoot);
  if (
    tracked.status === 'invalid' ||
    (tracked.status === 'valid' && tracked.projectId !== projectId)
  ) {
    return engineError(
      'E_IDENTITY_CONFLICT',
      `.cleo/project-id does not agree with project-info.json at "${projectRoot}"`,
      {
        exitCode: ExitCode.CONFIG_ERROR,
        fix: 'Run `cleo doctor project-identity` and resolve it first',
      },
    );
  }

  const newProjectHash = generateProjectHash(childDir);
  const worktrees = await listProjectWorktrees(projectRoot);
  const writes = ['.cleo/project-info.json'];
  if (tracked.status === 'absent') writes.unshift('.cleo/project-id');

  if (opts.dryRun) {
    return engineSuccess({
      dryRun: true,
      kind: 'reroot',
      projectId,
      source: projectRoot,
      target: childDir,
      newProjectHash,
      transfer: 'rename',
      entries: present,
      excluded: [],
      writes,
      registry: {
        action: 'rebind',
        livePath: childDir,
        demotedPath: projectRoot,
        demotedState: 'missing',
        nonce: 'carried',
      },
      checkpoint: 'cleo backup add snapshot of the project databases, under .cleo/backups/sqlite/',
      blockers: worktrees.map((w) => `CLEO worktree exists: ${w}`),
      deferredChecks: ['no active session (reads the project database)'],
    } satisfies ProjectRelocationPlan);
  }

  // 1. Refuse while anything is bound to the old root.
  const { listSessions } = await import('./store/session-store.js');
  const active = await listSessions({ active: true }, projectRoot);
  if (worktrees.length > 0 || active.length > 0) {
    const reasons = [
      ...worktrees.map((w) => `worktree ${w}`),
      ...active.map((s) => `active session ${s.id}`),
    ];
    return engineError('E_REROOT_BLOCKED', `Cannot reroot while bound: ${reasons.join('; ')}`, {
      exitCode: ExitCode.INVALID_INPUT,
      details: { worktrees, activeSessions: active.map((s) => s.id) },
      fix: 'End every session (`cleo session end`) and remove every worktree (`cleo worktree list`), then retry',
    });
  }

  // 2. Required checkpoint — no snapshot, no reroot.
  const { createBackup } = await import('./system/backup.js');
  let checkpointId: string;
  try {
    const backup = await createBackup(projectRoot, {
      type: 'reroot',
      note: `before cleo project reroot ${childDir}`,
    });
    if (!backup.files.includes('tasks.db')) {
      throw new Error('the project database was not captured');
    }
    checkpointId = backup.backupId;
  } catch (err) {
    return engineError(
      'E_CHECKPOINT_FAILED',
      `Checkpoint before reroot failed: ${(err as Error).message}`,
      { exitCode: ExitCode.FILE_ERROR, fix: 'Run `cleo backup add` to diagnose, then retry' },
    );
  }

  // 3. Release every handle on the files about to move, then rename.
  const { closeAllDatabases } = await import('./store/sqlite.js');
  await closeAllDatabases();
  const renamed: string[] = [];
  try {
    for (const entry of present) {
      await rename(join(projectRoot, entry), join(childDir, entry));
      renamed.push(entry);
    }
  } catch (err) {
    for (const entry of [...renamed].reverse()) {
      await rename(join(childDir, entry), join(projectRoot, entry)).catch(() => undefined);
    }
    return engineError(
      'E_MOVE_FAILED',
      `Failed to rename ${present.join(', ')} into "${childDir}": ${(err as Error).message}`,
      { exitCode: ExitCode.FILE_ERROR, fix: 'Nothing was moved; check permissions and retry' },
    );
  }

  // 4. Identity: the SAME id, written once when absent; never an absolute root.
  const { ensurePortableProjectId } = await import('./scaffold/project-identity.js');
  const idOutcome = await ensurePortableProjectId(childDir, projectId);
  if (idOutcome !== 'present' && idOutcome !== 'written') {
    return engineError(
      'E_IDENTITY_CONFLICT',
      `.cleo/project-id at "${childDir}" could not record ${projectId} (${idOutcome})`,
      { exitCode: ExitCode.CONFIG_ERROR, fix: 'Run `cleo doctor project-identity --resolve`' },
    );
  }
  const portableInfo: Record<string, unknown> = {
    ...info,
    projectHash: newProjectHash,
    lastUpdated: new Date().toISOString(),
  };
  delete portableInfo.projectRoot;
  await writeProjectInfo(childDir, portableInfo);

  // 5. Promote the child, demote the old root.
  const rebound = await rebindRegistry(projectId, childDir, projectRoot, 'missing');
  if (!rebound.success) return rebound;

  return engineSuccess({
    dryRun: false,
    projectId,
    oldRoot: projectRoot,
    newRoot: childDir,
    newProjectHash,
    checkpointId,
    renamed,
    projectIdFile: idOutcome,
    reconcileStatus: rebound.data,
    notes: [
      `Commit .cleo/project-id in the repository at ${childDir}`,
      `The repository at ${projectRoot} now shows .cleo/ as deleted`,
    ],
  } satisfies RerootProjectResult);
}

/**
 * Rename a CLEO project (updates project-info.json name and hash).
 *
 * This is a lightweight metadata operation — no files are moved.
 * The projectHash is recomputed because the project name influences
 * the canonical project ID (T9149 algorithm).
 *
 * @param newName - The new project name.
 * @param projectRoot - Absolute path to the project root.
 * @returns EngineResult with {@link RenameProjectResult} on success.
 *
 * @remarks AC4: Updates project-info.json name field and recomputes
 *   projectHash based on the new basename.
 *
 * @example
 * ```typescript
 * const result = await renameProject('my-new-name', '/path/to/project');
 * if (result.success) {
 *   console.log(`Renamed to ${result.data.newName}`);
 * }
 * ```
 */
export async function renameProject(
  newName: string,
  projectRoot: string,
): Promise<EngineResult<RenameProjectResult>> {
  // AC7: Validate absolute path
  const rootErr = validateAbsolutePath('projectRoot', projectRoot);
  if (rootErr) return rootErr;

  if (!newName || newName.trim().length === 0) {
    return engineError('E_INVALID_NAME', 'newName must be a non-empty string');
  }

  // Read current project info
  const info = await readProjectInfo(projectRoot);
  if (!info) {
    return engineError(
      'E_PROJECT_INFO_MISSING',
      `Failed to read project-info.json at "${projectRoot}"`,
    );
  }

  const projectId = typeof info.projectId === 'string' ? info.projectId : '';
  if (!projectId) {
    return engineError(
      'E_NO_PROJECT_ID',
      `project-info.json at "${projectRoot}" is missing projectId`,
      { fix: 'Run `cleo init` to generate a projectId' },
    );
  }

  const oldName =
    (typeof info.name === 'string' ? info.name : '') ||
    (typeof info.projectName === 'string' ? info.projectName : '') ||
    basename(projectRoot);

  // AC4: Update project-info.json — only name changes, path stays same
  const newProjectHash = generateProjectHash(projectRoot);
  const newInfo = {
    ...info,
    name: newName.trim(),
    projectHash: newProjectHash,
    lastUpdated: new Date().toISOString(),
  };
  await writeProjectInfo(projectRoot, newInfo);

  // AC1, AC3, AC5: Register self-alias in nexus projectIdAliases table
  // for dispatch-layer consumer compatibility (T11025).
  try {
    await nexusRenameProject(projectId, newName.trim());
  } catch {
    // Non-fatal: alias registration is best-effort; the rename succeeded
  }

  return engineSuccess({
    projectId,
    projectRoot,
    oldName,
    newName: newName.trim(),
    newProjectHash,
  });
}

/**
 * Re-register a CLEO project with the nexus registry.
 *
 * Detects when a project has been moved on the filesystem without using
 * `moveProject`, and reconciles the nexus registry accordingly.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns EngineResult with {@link ReregisterProjectResult} on success.
 *
 * @remarks AC5: Reads project-info.json, calls nexusReconcile, and
 *   returns drift status when the filesystem location has changed.
 *
 * @example
 * ```typescript
 * const result = await reregisterProject('/path/to/moved-project');
 * if (result.success) {
 *   console.log(`Drifted: ${result.data.drifted}, status: ${result.data.reconcileStatus}`);
 * }
 * ```
 */
export async function reregisterProject(
  projectRoot: string,
): Promise<EngineResult<ReregisterProjectResult>> {
  // AC7: Validate absolute path
  const rootErr = validateAbsolutePath('projectRoot', projectRoot);
  if (rootErr) return rootErr;

  if (!existsSync(join(projectRoot, '.cleo', 'project-info.json'))) {
    return engineError('E_NOT_CLEO_PROJECT', `No CLEO project found at "${projectRoot}"`, {
      fix: 'Ensure the project was initialized with `cleo init`',
    });
  }

  // Read current project info
  const info = await readProjectInfo(projectRoot);
  if (!info) {
    return engineError(
      'E_PROJECT_INFO_MISSING',
      `Failed to read project-info.json at "${projectRoot}"`,
    );
  }

  const projectId = typeof info.projectId === 'string' ? info.projectId : '';
  if (!projectId) {
    return engineError(
      'E_NO_PROJECT_ID',
      `project-info.json at "${projectRoot}" is missing projectId`,
      { fix: 'Run `cleo init` to generate a projectId' },
    );
  }

  const projectHash = generateProjectHash(projectRoot);

  // AC5: Reconcile with nexus — detects drift
  let reconcile: {
    status: 'ok' | 'path_updated' | 'auto_registered' | 'candidate';
    oldPath?: string;
  };
  try {
    reconcile = await nexusReconcile(projectRoot);
  } catch (err) {
    return engineError(
      'E_NEXUS_RECONCILE_FAILED',
      `Nexus reconcile failed for "${projectRoot}": ${(err as Error).message}`,
      { details: { originalError: (err as Error).message } },
    );
  }

  const drifted = reconcile.status === 'path_updated';

  return engineSuccess({
    projectId,
    projectRoot,
    projectHash,
    drifted,
    reconcileStatus: reconcile.status,
    ...(drifted && reconcile.oldPath ? { oldPath: reconcile.oldPath } : {}),
  });
}
