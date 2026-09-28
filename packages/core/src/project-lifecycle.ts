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
 * @task T12556 — relocations RENAME; nothing is copied, so no stale copy exists
 * @task T12558 — `rerootProject`, child/ancestor targets refused, tombstone
 */

import { existsSync, statSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve as resolvePath, sep } from 'node:path';
import type {
  MoveProjectResult,
  ProjectRelocationExclusion,
  ProjectRelocationKind,
  ProjectRelocationPlan,
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
import { generateProjectHash, nexusReconcile, nexusRenameProject } from './nexus/index.js';

export type { MoveProjectResult } from '@cleocode/contracts';

// ── Result types ─────────────────────────────────────────────────────

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

// ── Relocation helpers (T12552 · T12556 · T12558) ─────────────────────

/**
 * Top-level entries `reroot` renames into the child, in order. `.github` is
 * included only when it holds nothing but CLEO's own init templates (see
 * {@link isCleoOwnedGithubDir}); a parent repository's real `.github` stays.
 */
const REROOT_ENTRIES: readonly string[] = ['.cleo', '.worktreeinclude', '.github'];

/** Options shared by {@link moveProject} and {@link rerootProject}. */
export interface RelocateProjectOptions {
  /**
   * Return a {@link ProjectRelocationPlan} instead of acting. A dry run writes
   * nothing to disk and opens no database (T12552).
   */
  dryRun?: boolean;
}

/** Nearest existing ancestor of `p` (itself when it exists). */
function nearestExisting(p: string): string {
  let head = resolvePath(p);
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    head = parent;
  }
  return head;
}

/**
 * Canonical form of a path whose tail may not exist yet: the nearest existing
 * ancestor is resolved through symlinks (macOS `/tmp` → `/private/tmp`) and
 * the missing tail is appended, so containment compares like with like.
 */
function canonicalTarget(p: string): string {
  const resolved = resolvePath(p);
  const head = nearestExisting(resolved);
  return join(canonicalizePath(head), relative(head, resolved));
}

/** `true` when `inner` is strictly inside `outer` (both canonical). */
function isStrictlyInside(outer: string, inner: string): boolean {
  const rel = relative(outer, inner);
  return rel.length > 0 && !rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep);
}

/** `true` when `target` (or its nearest existing ancestor) is on `source`'s device. */
function sameDevice(source: string, target: string): boolean {
  return statSync(source).dev === statSync(nearestExisting(target)).dev;
}

/**
 * `E_CROSS_DEVICE`: a relocation only renames within one device. The fix says
 * to quiesce the project first — a plain `mv` across devices is a copy, so a
 * live writer during it tears the database exactly as the old copy did.
 */
function crossDeviceRefusal(source: string, target: string, command: string): EngineResult<never> {
  return engineError(
    'E_CROSS_DEVICE',
    `"${target}" is on another device than "${source}"; cleo only relocates by rename within one device`,
    {
      exitCode: ExitCode.INVALID_INPUT,
      fix: `First end every session (\`cleo session end\`), stop every process writing to the project, and run \`cleo backup add\`. Then: ${command}`,
    },
  );
}

/** Read `projectId` from project-info.json, or the failure to return. */
async function readRelocatableIdentity(
  projectRoot: string,
): Promise<{ projectId: string } | EngineResult<never>> {
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
  return { projectId };
}

/**
 * CLEO worktrees provisioned for the project at `projectRoot`, plus git
 * worktrees registered in its `.git/`. Both are keyed by absolute path, so a
 * relocation would strand them.
 */
async function listBoundWorktrees(projectRoot: string, includeGit: boolean): Promise<string[]> {
  const found = new Set<string>();
  const dir = resolveWorktreeRootForHash(computeProjectHash(projectRoot));
  if (existsSync(dir)) {
    for (const entry of await readdir(dir)) found.add(`CLEO worktree ${join(dir, entry)}`);
  }
  const { readSentinelIndex } = await import('./worktree/sentinel-index.js');
  for (const entry of readSentinelIndex(projectRoot)) {
    if (existsSync(entry.path)) found.add(`CLEO worktree ${entry.path}`);
  }
  const gitWorktrees = join(projectRoot, '.git', 'worktrees');
  if (includeGit && existsSync(gitWorktrees)) {
    for (const entry of await readdir(gitWorktrees)) {
      found.add(`git worktree ${join(gitWorktrees, entry)}`);
    }
  }
  return [...found].sort();
}

/**
 * The refusal for a relocation while something is bound to the project. The
 * fix names the exact command for each session, bound by `CLEO_SESSION_ID` so
 * it ends THAT session rather than the caller's (T12500).
 */
function blockedError(
  code: 'E_MOVE_BLOCKED' | 'E_REROOT_BLOCKED',
  worktrees: string[],
  activeSessions: string[],
): EngineResult<never> {
  const steps = [
    ...activeSessions.map((id) => `CLEO_SESSION_ID=${id} cleo session end`),
    ...(worktrees.length > 0 ? ['remove each worktree listed in details.worktrees'] : []),
    ...(worktrees.some((w) => w.startsWith('git worktree '))
      ? ['for a git worktree whose directory is already gone, run `git worktree prune`']
      : []),
  ];
  return engineError(
    code,
    `Cannot relocate while bound: ${[...worktrees, ...activeSessions.map((s) => `active session ${s}`)].join('; ')}`,
    {
      exitCode: ExitCode.CONCURRENT_MODIFICATION,
      details: { worktrees, activeSessions },
      fix: `${steps.join(' && ')}, then retry`,
    },
  );
}

/** Ids of active sessions in the project store at `projectRoot`. */
async function activeSessionIds(projectRoot: string): Promise<string[]> {
  const { listSessions } = await import('./store/session-store.js');
  return (await listSessions({ active: true }, projectRoot)).map((s) => s.id);
}

/**
 * Required checkpoint before a relocation: the `cleo backup add` snapshot,
 * then COPIED to `<cleoHome>/backups/<projectId>/<backupId>/` so it does not
 * share fate with the tree it protects.
 */
async function takeCheckpoint(
  projectRoot: string,
  projectId: string,
  kind: ProjectRelocationKind,
  target: string,
): Promise<EngineResult<{ id: string; path: string }>> {
  try {
    const { createBackup } = await import('./system/backup.js');
    const backup = await createBackup(projectRoot, {
      type: kind,
      note: `before cleo project ${kind} ${target}`,
    });
    if (!backup.files.includes('tasks.db')) {
      throw new Error('the project database was not captured');
    }
    const { getCleoHome } = await import('./paths.js');
    const outside = join(getCleoHome(), 'backups', projectId, backup.backupId);
    await mkdir(outside, { recursive: true });
    const names = [
      ...backup.files.map((f) => `${f}.${backup.backupId}`),
      `${backup.backupId}.meta.json`,
    ];
    for (const name of names) {
      const src = join(backup.path, name);
      if (existsSync(src)) await copyFile(src, join(outside, name));
    }
    return engineSuccess({ id: backup.backupId, path: outside });
  } catch (err) {
    return engineError(
      'E_CHECKPOINT_FAILED',
      `Checkpoint before ${kind} failed: ${(err as Error).message}`,
      { exitCode: ExitCode.FILE_ERROR, fix: 'Run `cleo backup add` to diagnose, then retry' },
    );
  }
}

/** Where the checkpoint will be written, for a plan (nothing is created). */
async function checkpointLocation(projectId: string): Promise<string> {
  const { getCleoHome } = await import('./paths.js');
  return join(getCleoHome(), 'backups', projectId, '<backupId>');
}

/** Open the global registry (dynamic: keeps the store graph off import). */
async function openRegistry() {
  const { getNexusRegistryDb } = await import('./store/nexus-sqlite.js');
  const { getCleoHome } = await import('./paths.js');
  return getNexusRegistryDb(getCleoHome());
}

/**
 * Rebind the registry to `livePath` explicitly, then demote `demotedPath` to
 * `missing` — exactly one live location remains.
 *
 * Runs with the project scope pinned to `livePath`: the nexus handle is the
 * AMBIENT project's `cleo.db`, and the ambient root is still the caller's cwd
 * (the old root). Opening it there would create an empty store beside the
 * moved one.
 */
async function rebindRegistry(
  projectId: string,
  livePath: string,
  demotedPath: string,
): Promise<EngineResult<MoveProjectResult['reconcileStatus']>> {
  const { captureProjectScope, worktreeScope } = await import('./project-scope.js');
  const scope = captureProjectScope(livePath, worktreeScope.getStore());
  try {
    const reconcile = await worktreeScope.run(scope, () =>
      nexusReconcile(livePath, { forceRebind: true }),
    );
    const { demoteProjectLocation } = await import('./nexus/path-map.js');
    demoteProjectLocation(
      await openRegistry(),
      { projectId, projectPath: demotedPath, now: new Date().toISOString() },
      'missing',
    );
    return engineSuccess(reconcile.status);
  } catch (err) {
    return engineError(
      'E_NEXUS_RECONCILE_FAILED',
      `Files were relocated to "${livePath}" but the registry rebind failed: ${(err as Error).message}`,
      {
        exitCode: ExitCode.GENERAL_ERROR,
        details: { originalError: (err as Error).message },
        fix: `Run \`cleo nexus reconcile --force-rebind\` in ${livePath}`,
      },
    );
  }
}

/** Every file under `dir`, relative to it. */
async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out;
}

/**
 * `true` when `<root>/.github` holds only files byte-identical to the GitHub
 * templates `cleo init` installs — i.e. CLEO created it, not the repository.
 */
async function isCleoOwnedGithubDir(root: string): Promise<boolean> {
  const { getPackageRoot } = await import('./scaffold/ensure-config.js');
  const templates = join(getPackageRoot(), 'templates', 'github');
  const githubDir = join(root, '.github');
  if (!existsSync(templates)) return false;
  const files = await listFiles(githubDir);
  if (files.length === 0) return false;
  for (const file of files) {
    const template = join(templates, file);
    if (!existsSync(template)) return false;
    const [a, b] = await Promise.all([readFile(join(githubDir, file)), readFile(template)]);
    if (!a.equals(b)) return false;
  }
  return true;
}

/**
 * Split CLEO's top-level entries at `root` into those reroot moves and those
 * it must leave, given what `childDir` already holds.
 */
async function rerootEntries(
  root: string,
  childDir: string,
): Promise<{ entries: string[]; excluded: ProjectRelocationExclusion[]; clashes: string[] }> {
  const entries: string[] = [];
  const excluded: ProjectRelocationExclusion[] = [];
  const clashes: string[] = [];
  for (const entry of REROOT_ENTRIES) {
    if (!existsSync(join(root, entry))) continue;
    if (entry === '.github') {
      if (!(await isCleoOwnedGithubDir(root))) {
        excluded.push({ entry, reason: 'holds files that are not CLEO init templates' });
      } else if (existsSync(join(childDir, entry))) {
        excluded.push({ entry, reason: 'the child already has its own .github' });
      } else {
        entries.push(entry);
      }
      continue;
    }
    if (existsSync(join(childDir, entry))) clashes.push(entry);
    else entries.push(entry);
  }
  return { entries, excluded, clashes };
}

/** Rename `entries` from `from` to `to`; on any failure put back what moved. */
async function renameEntries(from: string, to: string, entries: string[]): Promise<void> {
  const done: string[] = [];
  try {
    for (const entry of entries) {
      await rename(join(from, entry), join(to, entry));
      done.push(entry);
    }
  } catch (err) {
    await renameBack(from, to, done);
    throw err;
  }
}

/** Undo {@link renameEntries} for `entries` (best effort, reverse order). */
async function renameBack(from: string, to: string, entries: string[]): Promise<void> {
  for (const entry of [...entries].reverse()) {
    await rename(join(to, entry), join(from, entry)).catch(() => undefined);
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Move a CLEO project to a new path on the SAME device by RENAMING its root.
 *
 * Nothing is copied: `.git`, the live database and its WAL sidecars move in
 * one atomic rename, so there is never a second copy to diverge (T12556) and
 * no torn database snapshot. In order:
 *
 * 1. Refuses a target inside or containing the project (`E_INVALID_TARGET`),
 *    an existing file or non-empty directory, or a target on another device
 *    (`E_CROSS_DEVICE` — use a plain `mv`, then any cleo command).
 * 2. Refuses while any session, CLEO worktree or git worktree is bound
 *    (`E_MOVE_BLOCKED`).
 * 3. Takes the required checkpoint, copied outside the tree.
 * 4. Closes every database handle and renames the root.
 * 5. Rebinds the registry (the nonce travelled with `.cleo/`), old path `missing`.
 *
 * `project-info.json` is not rewritten: `projectHash` stays byte-identical and
 * no absolute `projectRoot` is written (T12557). A crash after step 4 leaves a
 * state the next command in the new root repairs on its own — the old path is
 * gone and the carried nonce proves the move (T12470).
 *
 * @param newPath - Absolute path to the new project root location.
 * @param projectRoot - Absolute path to the current project root.
 * @param opts - `dryRun: true` returns the plan and changes nothing.
 * @returns The plan (dry run) or the {@link MoveProjectResult}.
 *
 * @example
 * ```typescript
 * const plan = await moveProject('/new/location/project', '/old/project', { dryRun: true });
 * const result = await moveProject('/new/location/project', '/old/project');
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
  const pathErr = validateAbsolutePath('newPath', newPath);
  if (pathErr) return pathErr;
  const rootErr = validateAbsolutePath('projectRoot', projectRoot);
  if (rootErr) return rootErr;
  newPath = resolvePath(newPath);

  if (!existsSync(join(projectRoot, '.cleo', 'project-info.json'))) {
    return engineError('E_NOT_CLEO_PROJECT', `No CLEO project found at "${projectRoot}"`, {
      fix: 'Ensure the project was initialized with `cleo init`',
      exitCode: ExitCode.CONFIG_ERROR,
    });
  }

  const source = canonicalizePath(projectRoot);
  const target = canonicalTarget(newPath);
  if (newPath === resolvePath(projectRoot) || source === target) {
    return engineError(
      'E_SAME_PATH',
      `newPath and projectRoot resolve to the same location: "${projectRoot}"`,
      { exitCode: ExitCode.INVALID_INPUT },
    );
  }

  // Refused before any IO: a directory cannot be renamed into its own subtree
  // or onto an ancestor.
  const targetIsFile = existsSync(newPath) && !statSync(newPath).isDirectory();
  if (isStrictlyInside(source, target)) {
    return engineError(
      'E_INVALID_TARGET',
      `newPath "${newPath}" is inside the project at "${projectRoot}"; a project cannot move into itself`,
      {
        exitCode: ExitCode.INVALID_INPUT,
        fix: targetIsFile
          ? 'Choose a directory outside the project tree'
          : `To make that directory the project root, run \`cleo project reroot ${relative(source, target)}\` from ${projectRoot}`,
      },
    );
  }
  if (isStrictlyInside(target, source)) {
    return engineError(
      'E_INVALID_TARGET',
      `newPath "${newPath}" contains the project at "${projectRoot}"; a project cannot move onto its own ancestor`,
      { exitCode: ExitCode.INVALID_INPUT, fix: 'Choose a path outside the project tree' },
    );
  }
  if (targetIsFile) {
    return engineError('E_INVALID_TARGET', `newPath is an existing file: "${newPath}"`, {
      exitCode: ExitCode.INVALID_INPUT,
      fix: 'Choose a path that does not exist yet, or an empty directory',
    });
  }
  if (existsSync(newPath) && (await readdir(newPath)).length > 0) {
    return engineError('E_INVALID_TARGET', `newPath is not empty: "${newPath}"`, {
      exitCode: ExitCode.INVALID_INPUT,
      fix: 'Choose a path that does not exist yet, or an empty directory',
    });
  }

  const identity = await readRelocatableIdentity(projectRoot);
  if ('success' in identity) return identity;
  const { projectId } = identity;

  const crossDevice = !sameDevice(projectRoot, newPath);
  const crossDeviceError = crossDeviceRefusal(
    projectRoot,
    newPath,
    `mv "${projectRoot}" "${newPath}" && cd "${newPath}" && cleo nexus reconcile — the carried nonce proves the move and git stays intact`,
  );
  const worktrees = await listBoundWorktrees(projectRoot, true);

  if (opts.dryRun) {
    return engineSuccess({
      dryRun: true,
      kind: 'move',
      projectId,
      source: projectRoot,
      target: newPath,
      transfer: 'rename',
      entries: ['.'],
      excluded: [],
      writes: [],
      registry: {
        action: 'rebind',
        livePath: newPath,
        demotedPath: projectRoot,
        demotedState: 'missing',
        nonce: 'carried',
      },
      checkpoint: await checkpointLocation(projectId),
      blockers: [
        ...(crossDevice ? ['E_CROSS_DEVICE: the target is on another device'] : []),
        ...worktrees,
      ],
      deferredChecks: ['no active session (reads the project database)'],
    } satisfies ProjectRelocationPlan);
  }

  if (crossDevice) return crossDeviceError;
  const sessions = await activeSessionIds(projectRoot);
  if (worktrees.length > 0 || sessions.length > 0) {
    return blockedError('E_MOVE_BLOCKED', worktrees, sessions);
  }

  const checkpoint = await takeCheckpoint(projectRoot, projectId, 'move', newPath);
  if (!checkpoint.success) return checkpoint;

  const { closeAllDatabases } = await import('./store/sqlite.js');
  await closeAllDatabases();
  try {
    await mkdir(dirname(newPath), { recursive: true });
    await rename(projectRoot, newPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') return crossDeviceError;
    return engineError(
      'E_MOVE_FAILED',
      `Failed to rename "${projectRoot}" to "${newPath}": ${(err as Error).message}`,
      { exitCode: ExitCode.FILE_ERROR, fix: 'Nothing was moved; check permissions and retry' },
    );
  }

  const rebound = await rebindRegistry(projectId, newPath, projectRoot);
  if (!rebound.success) return rebound;

  return engineSuccess({
    dryRun: false,
    projectId,
    oldPath: projectRoot,
    newPath,
    checkpointId: checkpoint.data.id,
    checkpointPath: checkpoint.data.path,
    reconcileStatus: rebound.data,
  } satisfies MoveProjectResult);
}

/**
 * The registry path of `projectId` when it is a strict ancestor of `childDir`
 * that no longer holds the project — i.e. an earlier reroot renamed `.cleo/`
 * into `childDir` and stopped before rebinding.
 */
async function interruptedRerootSource(
  projectId: string,
  childDir: string,
): Promise<string | null> {
  const { projectRegistry } = await import('./store/schema/nexus-schema.js');
  const { eq } = await import('drizzle-orm');
  const row = (await openRegistry())
    .select({ projectPath: projectRegistry.projectPath })
    .from(projectRegistry)
    .where(eq(projectRegistry.projectId, projectId))
    .get();
  const oldRoot = row?.projectPath;
  if (!oldRoot || !existsSync(oldRoot)) return null;
  if (!isStrictlyInside(canonicalizePath(oldRoot), canonicalizePath(childDir))) return null;
  return existsSync(join(oldRoot, '.cleo', 'project-info.json')) ? null : oldRoot;
}

/**
 * Keep `entry` out of commits in the repository containing `root` (T12558).
 *
 * Asks git for the exclude file (`rev-parse --git-path info/exclude`) and for
 * `root`'s path inside the work tree (`--show-prefix`), so it works when
 * `root` is a subdirectory of a repository and when `.git` is a FILE (a
 * linked worktree or a submodule). The line is anchored to that repo-relative
 * path. Local to this checkout — nothing tracked changes. Best effort: `root`
 * may not be in a repository, and a tombstone is validated on read anyway.
 */
async function excludeFromGit(root: string, entry: string): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const git = async (...args: string[]): Promise<string> =>
    (await promisify(execFile)('git', ['-C', root, ...args], { encoding: 'utf-8' })).stdout.trim();
  try {
    const exclude = resolvePath(root, await git('rev-parse', '--git-path', 'info/exclude'));
    const line = `/${await git('rev-parse', '--show-prefix')}${entry}`;
    await mkdir(dirname(exclude), { recursive: true });
    const current = existsSync(exclude) ? await readFile(exclude, 'utf-8') : '';
    if (current.split(/\r?\n/).includes(line)) return;
    const joiner = current.length === 0 || current.endsWith('\n') ? '' : '\n';
    await writeFile(exclude, `${current}${joiner}${line}\n`);
  } catch {
    // Not in a repository, or git unavailable: the tombstone is still validated on read.
  }
}

/**
 * Finish a reroot from the child: identity, tombstone, rebind. Shared by the
 * normal path (after the rename) and a resume.
 */
async function completeReroot(
  projectId: string,
  childDir: string,
  oldRoot: string,
): Promise<
  EngineResult<{
    projectIdFile: 'present' | 'written';
    tombstone: string;
    status: MoveProjectResult['reconcileStatus'];
  }>
> {
  const { ensurePortableProjectId } = await import('./scaffold/project-identity.js');
  const idOutcome = await ensurePortableProjectId(childDir, projectId);
  if (idOutcome !== 'present' && idOutcome !== 'written') {
    throw new Error(`.cleo/project-id could not record ${projectId} (${idOutcome})`);
  }
  const { PROJECT_TOMBSTONE_FILE, writeProjectTombstone } = await import('./project-tombstone.js');
  const tombstone = writeProjectTombstone(oldRoot, {
    projectId,
    movedTo: childDir,
    at: new Date().toISOString(),
  });
  await excludeFromGit(oldRoot, PROJECT_TOMBSTONE_FILE);
  const rebound = await rebindRegistry(projectId, childDir, oldRoot);
  if (!rebound.success) return rebound;
  return engineSuccess({ projectIdFile: idOutcome, tombstone, status: rebound.data });
}

/**
 * Make a child directory of the current project root the new project root.
 *
 * RENAMES CLEO's own top-level entries into `childDir` — `.cleo/`,
 * `.worktreeinclude`, and `.github/` when it holds only CLEO's init templates.
 * Nothing is copied, so tasks, BRAIN memory, sessions and the checkout nonce
 * travel together. Everything else at the old root stays. In order:
 *
 * 1. Refuses while any session or CLEO worktree is bound (`E_REROOT_BLOCKED`).
 * 2. Takes the required checkpoint, copied outside the tree.
 * 3. Closes every database handle, then renames.
 * 4. Confirms `.cleo/project-id`, writing the SAME id when absent. On failure
 *    the renames are undone.
 * 5. Leaves `.cleo-moved.json` at the old root, so commands there refuse with
 *    `E_PROJECT_MOVED` instead of creating an empty store.
 * 6. Rebinds the registry to `childDir`; the old root becomes `missing`.
 *
 * `project-info.json` is not rewritten: `projectHash` stays byte-identical and
 * no absolute `projectRoot` is written (T12557).
 *
 * Resumable: run from the child (`cleo project reroot .`) after an interrupted
 * run — `.cleo/` already in the child, registry still naming the old root —
 * it finishes steps 4-6.
 *
 * @param childDir - Absolute path of a directory strictly inside `projectRoot`,
 *   or `projectRoot` itself to resume an interrupted reroot.
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
      fix: 'Run `cleo project reroot` from inside the project',
      exitCode: ExitCode.CONFIG_ERROR,
    });
  }
  if (!existsSync(childDir) || !statSync(childDir).isDirectory()) {
    return engineError('E_INVALID_TARGET', `childDir is not an existing directory: "${childDir}"`, {
      exitCode: ExitCode.INVALID_INPUT,
      fix: 'Pass an existing subdirectory of the project',
    });
  }
  const identity = await readRelocatableIdentity(projectRoot);
  if ('success' in identity) return identity;
  const { projectId } = identity;
  const source = canonicalizePath(projectRoot);
  const target = canonicalizePath(childDir);

  // Resume: `.cleo/` is already in this directory and the registry still names
  // an ancestor that no longer holds the project.
  if (source === target) {
    const oldRoot = await interruptedRerootSource(projectId, childDir);
    if (!oldRoot) {
      return engineError(
        'E_SAME_PATH',
        `"${childDir}" is already the project root and no interrupted reroot was found`,
        {
          exitCode: ExitCode.INVALID_INPUT,
          fix: 'Pass a subdirectory: `cleo project reroot <childDir>`',
        },
      );
    }
    if (opts.dryRun) {
      return engineSuccess({
        dryRun: true,
        kind: 'reroot',
        projectId,
        source: oldRoot,
        target: childDir,
        transfer: 'rename',
        entries: [],
        excluded: [],
        writes: [join(oldRoot, '.cleo-moved.json')],
        registry: {
          action: 'rebind',
          livePath: childDir,
          demotedPath: oldRoot,
          demotedState: 'missing',
          nonce: 'carried',
        },
        checkpoint: 'none: resuming an interrupted reroot',
        blockers: [],
        deferredChecks: [],
      } satisfies ProjectRelocationPlan);
    }
    try {
      const done = await completeReroot(projectId, childDir, oldRoot);
      if (!done.success) return done;
      return engineSuccess({
        dryRun: false,
        projectId,
        oldRoot,
        newRoot: childDir,
        resumed: true,
        checkpointId: '',
        checkpointPath: '',
        renamed: [],
        projectIdFile: done.data.projectIdFile,
        tombstone: done.data.tombstone,
        reconcileStatus: done.data.status,
        notes: rerootNotes(oldRoot, childDir),
      } satisfies RerootProjectResult);
    } catch (err) {
      return engineError('E_IDENTITY_CONFLICT', (err as Error).message, {
        exitCode: ExitCode.CONFIG_ERROR,
        fix: 'Run `cleo doctor project-identity --resolve`, then `cleo project reroot .` again',
      });
    }
  }

  if (!isStrictlyInside(source, target)) {
    return engineError(
      'E_INVALID_TARGET',
      `childDir "${childDir}" is not inside the project at "${projectRoot}"`,
      {
        exitCode: ExitCode.INVALID_INPUT,
        fix: `To relocate the whole project, run \`cleo project move ${childDir}\``,
      },
    );
  }
  const { entries, excluded, clashes } = await rerootEntries(projectRoot, childDir);
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

  const worktrees = await listBoundWorktrees(projectRoot, false);
  // A child can be a mount point: then `.cleo/` cannot be renamed into it.
  const crossDevice = !sameDevice(projectRoot, childDir);
  const crossDeviceError = crossDeviceRefusal(
    projectRoot,
    childDir,
    `mv "${join(projectRoot, '.cleo')}" "${join(childDir, '.cleo')}" && cd "${childDir}" && cleo project reroot .`,
  );
  if (opts.dryRun) {
    return engineSuccess({
      dryRun: true,
      kind: 'reroot',
      projectId,
      source: projectRoot,
      target: childDir,
      transfer: 'rename',
      entries,
      excluded,
      writes: [
        ...(tracked.status === 'absent' ? [join(childDir, '.cleo', 'project-id')] : []),
        join(projectRoot, '.cleo-moved.json'),
      ],
      registry: {
        action: 'rebind',
        livePath: childDir,
        demotedPath: projectRoot,
        demotedState: 'missing',
        nonce: 'carried',
      },
      checkpoint: await checkpointLocation(projectId),
      blockers: [
        ...(crossDevice ? ['E_CROSS_DEVICE: the child is on another device'] : []),
        ...worktrees,
      ],
      deferredChecks: ['no active session (reads the project database)'],
    } satisfies ProjectRelocationPlan);
  }

  if (crossDevice) return crossDeviceError;
  const sessions = await activeSessionIds(projectRoot);
  if (worktrees.length > 0 || sessions.length > 0) {
    return blockedError('E_REROOT_BLOCKED', worktrees, sessions);
  }

  const checkpoint = await takeCheckpoint(projectRoot, projectId, 'reroot', childDir);
  if (!checkpoint.success) return checkpoint;

  const { closeAllDatabases } = await import('./store/sqlite.js');
  await closeAllDatabases();
  try {
    await renameEntries(projectRoot, childDir, entries);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') return crossDeviceError;
    return engineError(
      'E_MOVE_FAILED',
      `Failed to rename ${entries.join(', ')} into "${childDir}": ${(err as Error).message}`,
      { exitCode: ExitCode.FILE_ERROR, fix: 'Nothing was moved; check permissions and retry' },
    );
  }

  let done: Awaited<ReturnType<typeof completeReroot>>;
  try {
    done = await completeReroot(projectId, childDir, projectRoot);
  } catch (err) {
    // Identity or tombstone failed before the registry changed: undo the renames.
    await renameBack(projectRoot, childDir, entries);
    const { rm } = await import('node:fs/promises');
    await rm(join(projectRoot, '.cleo-moved.json'), { force: true });
    return engineError('E_REROOT_FAILED', `Reroot rolled back: ${(err as Error).message}`, {
      exitCode: ExitCode.FILE_ERROR,
      fix: 'Nothing changed. Run `cleo doctor project-identity`, then retry',
    });
  }
  if (!done.success) {
    return engineError(done.error.code, done.error.message, {
      exitCode: done.error.exitCode,
      details: done.error.details,
      fix: `The files are already in ${childDir}; run \`cleo project reroot .\` there to finish`,
    });
  }

  return engineSuccess({
    dryRun: false,
    projectId,
    oldRoot: projectRoot,
    newRoot: childDir,
    resumed: false,
    checkpointId: checkpoint.data.id,
    checkpointPath: checkpoint.data.path,
    renamed: entries,
    projectIdFile: done.data.projectIdFile,
    tombstone: done.data.tombstone,
    reconcileStatus: done.data.status,
    notes: rerootNotes(projectRoot, childDir),
  } satisfies RerootProjectResult);
}

/** Git bookkeeping a reroot leaves to the operator. */
function rerootNotes(oldRoot: string, newRoot: string): string[] {
  return [
    `Commit .cleo/project-id in the repository at ${newRoot}`,
    `The repository at ${oldRoot} now shows .cleo/ as deleted; do not restore it (commands there refuse with E_PROJECT_MOVED)`,
  ];
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
