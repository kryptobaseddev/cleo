/**
 * Dependency-leaf project scope, root discovery and identity decoding.
 *
 * The public paths and project-info modules re-export or delegate here so store
 * ownership can reuse the same policy without importing store-aware routing.
 * @packageDocumentation
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { ExitCode } from '@cleocode/contracts';
import type { OperationExecutionContext } from '@cleocode/contracts/jobs';
import {
  isAbsolutePath,
  isValidProjectDisplayName,
  readDeclaredProjectIdentity,
  readPortableProjectId,
} from '@cleocode/paths';
import { CleoError } from './errors.js';
import { generateProjectHash } from './nexus/hash.js';
import {
  isProjectMovedRefusalEnabled,
  projectMovedError,
  readValidProjectTombstone,
} from './project-tombstone.js';

/**
 * Async context payload set by the spawn adapter when launching a subagent
 * inside a git worktree (ADR-041 §D3).
 *
 * @remarks
 * When `worktreeScope.run(scope, fn)` is active, `getProjectRoot()` returns
 * `scope.worktreeRoot` instead of walking ancestors. All DB path functions
 * that delegate to `getProjectRoot()` therefore direct their I/O to the
 * worktree's `.cleo/` directory, closing the T335 worktree-leak root cause.
 *
 * For processes that were spawned with `CLEO_WORKTREE_ROOT` in their
 * environment (but where AsyncLocalStorage is not in scope), callers should
 * populate the store via:
 * ```ts
 * worktreeScope.run(
 *   { worktreeRoot: process.env.CLEO_WORKTREE_ROOT, projectHash: process.env.CLEO_PROJECT_HASH },
 *   () => { ... }
 * );
 * ```
 *
 * @task T380
 * @public
 */
export interface WorktreeScope {
  /** Optional captured operation lifetime for guarded asynchronous storage work. */
  readonly execution?: OperationExecutionContext;
  /**
   * Absolute path to the worktree directory (value of `CLEO_WORKTREE_ROOT`).
   */
  worktreeRoot: string;
  /**
   * Project hash used to scope the worktree under the XDG worktree root
   * (value of `CLEO_PROJECT_HASH`).
   */
  projectHash: string;
}

/**
 * AsyncLocalStorage instance that carries the active {@link WorktreeScope}
 * for the current async execution context.
 *
 * @remarks
 * Set by the spawn adapter (or any caller that wants to redirect CLEO path
 * resolution to a worktree directory) before invoking subagent logic.
 * `getProjectRoot()` checks this store BEFORE the `CLEO_ROOT` env-var and
 * ancestor-walk, so scoped callers transparently receive the worktree root.
 *
 * Callers outside a worktree context receive `undefined` from
 * `worktreeScope.getStore()` and fall through to the existing resolution
 * order unchanged.
 *
 * @example
 * ```ts
 * import { worktreeScope } from '@cleocode/core/paths';
 *
 * worktreeScope.run(
 *   { worktreeRoot: '/path/to/worktree', projectHash: 'abc123' },
 *   async () => {
 *     const root = getProjectRoot(); // returns '/path/to/worktree'
 *   }
 * );
 * ```
 *
 * @task T380
 * @public
 */
export const worktreeScope = new AsyncLocalStorage<WorktreeScope>();

/**
 * Capture explicit project ownership and compatible operation authority before awaiting.
 * @param projectRoot - Requested project root, resolved independently of ambient pins.
 * @param inherited - Caller scope captured at the same synchronous boundary.
 * @returns Immutable scope retaining the original execution context and canonical path hash.
 * @throws Error if execution is inactive or its project root or persisted identity differs.
 * @remarks A portable project ID is compared only with persisted identity, never
 * with the path hash used by worktree routing. Ambient environment pins are unchanged.
 * Existing task-accessor error messages are retained for compatibility.
 * @example
 * ```ts
 * const scope = captureProjectScope(projectRoot, worktreeScope.getStore());
 * await worktreeScope.run(scope, () => performProjectOperation());
 * ```
 */
export function captureProjectScope(
  projectRoot: string,
  inherited: WorktreeScope | undefined,
): WorktreeScope {
  const root = resolve(projectRoot);
  const execution = inherited?.execution;
  execution?.assertActive();
  if (execution && resolve(execution.identity.projectRoot) !== root)
    throw new Error('Task accessor project differs from captured execution ownership.');
  const scope = Object.freeze({
    ...inherited,
    worktreeRoot: root,
    projectHash: generateProjectHash(root),
  });
  if (execution) {
    const info = readProjectInfoAtDirectorySync(root, join(root, '.cleo'));
    if ((info.projectId || info.projectHash) !== execution.identity.projectId)
      throw new Error('Task accessor identity differs from captured execution ownership.');
  }
  return scope;
}

/**
 * Read the `gitdir:` target of a gitlink `.git` FILE in `dir`.
 *
 * @param dir - Directory to inspect.
 * @returns The absolute gitdir; `''` when `.git` is a file that cannot be
 *   parsed; `null` when `.git` is missing or is a directory.
 */
function readGitlinkTarget(dir: string): string | null {
  const gitMarker = join(dir, '.git');
  try {
    if (!statSync(gitMarker).isFile()) return null;
  } catch {
    return null;
  }
  try {
    const match = readFileSync(gitMarker, 'utf-8').match(/^gitdir:\s*(.+)$/m);
    // A relative gitdir (`worktree.useRelativePaths`) is relative to the checkout.
    return match?.[1] ? resolve(dir, match[1].trim()) : '';
  } catch {
    return '';
  }
}

/**
 * Return the main checkout root of the linked git worktree at `dir`.
 *
 * A linked worktree's gitlink points at `<common>/worktrees/<name>`; the main
 * checkout is the parent of `<common>` when that is a `.git` directory, or the
 * `core.worktree` of `<common>` for a worktree of a submodule. A
 * submodule or `--separate-git-dir` gitlink points elsewhere (for example
 * `<super>/.git/modules/<name>`) and is its own repository, so it returns
 * `null` (T12562).
 *
 * @param dir - Directory to inspect.
 * @returns The main checkout root, or `null` when `dir` is not a linked worktree.
 * @example
 * ```ts
 * linkedWorktreeMainRoot('/data/cleo/worktrees/abc/T1'); // '/home/u/project'
 * linkedWorktreeMainRoot('/home/u/project/vendor/sub'); // null (submodule)
 * ```
 * @task T12562
 */
export function linkedWorktreeMainRoot(dir: string): string | null {
  const gitdir = readGitlinkTarget(dir);
  if (!gitdir || basename(dirname(gitdir)) !== 'worktrees') return null;
  const commonDir = dirname(dirname(gitdir));
  if (basename(commonDir) === '.git') return dirname(commonDir);
  // A worktree of a submodule: the common dir is `<super>/.git/modules/<name>`,
  // a git-internal path. The checkout is its `core.worktree`; without one,
  // the main checkout is unknown.
  return readCoreWorktree(commonDir);
}

/**
 * Name the project that owns the linked git worktree at `dir`, for refusals
 * that must say where the store actually lives (T12677).
 *
 * @param dir - Worktree root.
 * @returns e.g. `owning project /home/u/project (projectId abc)`,
 *   `owning repository /home/u/project (not an initialised CLEO project)`, or
 *   `owning repository unknown (unreadable gitlink)`.
 * @remarks Never throws. Reads only the gitlink, the main checkout's gitdir
 *   config and its declared identity (`.cleo/project.json`, the legacy
 *   `.cleo/project-id`, then `.cleo/project-info.json`).
 * @example
 * ```ts
 * describeWorktreeOwner('/data/cleo/worktrees/abc/T1');
 * // 'owning project /home/u/project (projectId 7f3c…)'
 * ```
 * @task T12677
 */
export function describeWorktreeOwner(dir: string): string {
  const mainRoot = linkedWorktreeMainRoot(dir);
  if (mainRoot === null) {
    // T12680: a bare repository's worktree has a readable gitlink but no main
    // checkout; say so instead of blaming the gitlink.
    const bare = bareRepositoryOfWorktree(dir);
    return bare === null
      ? 'owning repository unknown (unreadable gitlink)'
      : `owning repository ${bare} is a bare git repository with no main checkout to hold a CLEO store; ` +
          'clone it to a regular checkout, run `cleo init` there, and create worktrees from that checkout';
  }
  // T12716: the declared identity (tracked id first, then the cache).
  let projectId: string | null = null;
  try {
    projectId = readDeclaredProjectIdentity(mainRoot)?.projectId ?? null;
  } catch {
    // No readable identity: named below as not initialised.
  }
  return projectId === null
    ? `owning repository ${mainRoot} (not an initialised CLEO project)`
    : `owning project ${mainRoot} (projectId ${projectId})`;
}

/**
 * Return the bare repository that owns the linked worktree at `dir`: its
 * gitlink points at `<bare>/worktrees/<name>` and `<bare>/config` sets
 * `core.bare = true`.
 *
 * @param dir - Directory to inspect.
 * @returns The bare repository's git directory, or `null` when `dir` is not a
 *   worktree of a bare repository.
 * @remarks Never throws.
 * @example
 * ```ts
 * bareRepositoryOfWorktree('/src/app-wt'); // '/src/app.git'
 * ```
 * @task T12680
 */
export function bareRepositoryOfWorktree(dir: string): string | null {
  const gitdir = readGitlinkTarget(dir);
  if (!gitdir || basename(dirname(gitdir)) !== 'worktrees') return null;
  const commonDir = dirname(dirname(gitdir));
  try {
    const config = readFileSync(join(commonDir, 'config'), 'utf-8');
    const core = /^\[core\][^[]*/m.exec(config)?.[0] ?? '';
    return /^\s*bare\s*=\s*true\s*$/im.test(core) ? commonDir : null;
  } catch {
    return null;
  }
}

/**
 * Read `core.worktree` from a git directory's `config`, resolved against it.
 *
 * @param gitDir - Absolute git directory.
 * @returns The absolute work tree, or `null` when unset or unreadable.
 */
function readCoreWorktree(gitDir: string): string | null {
  try {
    const config = readFileSync(join(gitDir, 'config'), 'utf-8');
    const core = /^\[core\][^[]*/m.exec(config)?.[0] ?? '';
    const value = /^\s*worktree\s*=\s*(.+?)\s*$/m.exec(core)?.[1];
    return value ? resolve(gitDir, value) : null;
  } catch {
    return null;
  }
}

/**
 * Report whether `dir` is the root of a linked git worktree: its `.git` is a
 * gitlink FILE whose `gitdir` lies under `<common>/worktrees/`.
 *
 * @param dir - Directory to inspect.
 * @returns `true` for a linked worktree, or for a gitlink that cannot be
 *   parsed (conservatively). `false` for a real repository directory, a
 *   missing `.git`, or a submodule / `--separate-git-dir` gitlink, which is its
 *   own repository and may own its own store (T12562).
 * @remarks Never throws.
 * @example
 * ```ts
 * isGitLinkedCheckout('/home/u/.local/share/cleo/worktrees/abc/T1'); // true
 * isGitLinkedCheckout('/home/u/project'); // false: .git is a directory
 * ```
 * @task T12460
 * @task T12562
 */
export function isGitLinkedCheckout(dir: string): boolean {
  const gitdir = readGitlinkTarget(dir);
  if (gitdir === null) return false;
  if (gitdir === '') return true;
  return basename(dirname(gitdir)) === 'worktrees';
}

/**
 * Map a candidate project root to the root that OWNS the project store.
 *
 * A CLEO worktree (ADR-055) is a linked git checkout whose `.cleo/` can exist
 * on disk: the project's own tracked `.cleo/` files, or the
 * `project-info.json` seeded for identity inheritance (T11033). Neither makes
 * the worktree a project. Its store is the PARENT project's `.cleo/cleo.db`.
 * When `root` is a linked checkout whose main repository is a valid CLEO
 * project, this returns that main repository; otherwise `root` unchanged.
 *
 * @param root - Candidate project root (worktree root, scope root, or walk hit).
 * @returns The parent project root for a CLEO worktree, else `root`.
 * @remarks Only `root` itself is inspected, never its ancestors, so a nested
 * fixture `.cleo/` inside a checkout keeps resolving to itself. A worktree
 * whose parent is not a CLEO project is returned unchanged; the store-open
 * guard then refuses it instead of creating a local store.
 * @example
 * ```ts
 * resolveStoreOwnerRoot('/data/cleo/worktrees/abc/T1'); // '/home/u/project'
 * resolveStoreOwnerRoot('/home/u/project');             // '/home/u/project'
 * ```
 * @task T12460
 */
export function resolveStoreOwnerRoot(root: string): string {
  if (!isGitLinkedCheckout(root)) return root;
  return _resolveMainRepoFromGitlink(root) ?? root;
}

/**
 * Attempt to resolve the main git repo root from a gitlink (.git as FILE).
 * Returns the main repo path if the gitlink is valid and the main repo is a
 * CLEO project; otherwise returns `null`.
 *
 * @param gitlinkDir - Directory containing the candidate Git link.
 * @returns Validated main repository root, or null when unavailable.
 * @internal
 * @task T11034
 */
export function _resolveMainRepoFromGitlink(gitlinkDir: string): string | null {
  try {
    const gitLinkPath = join(gitlinkDir, '.git');
    if (!existsSync(gitLinkPath)) return null;
    const stat = statSync(gitLinkPath);
    if (!stat.isFile()) return null;
    const gitLinkContent = readFileSync(gitLinkPath, 'utf-8').trim();
    const match = gitLinkContent.match(/^gitdir:\s*(.+)$/m);
    if (!match) return null;
    // A relative gitdir (`worktree.useRelativePaths`) is relative to the checkout.
    const gitdir = resolve(gitlinkDir, match[1].trim());
    // T12562: only `<main>/.git/worktrees/<name>` is a linked worktree. A
    // submodule's `<super>/.git/modules/<name>` stripped the same way named the
    // superproject, so a submodule shared (and wrote) its parent's store.
    if (basename(dirname(gitdir)) !== 'worktrees') return null;
    // gitdir is `<main>/.git/worktrees/<name>` → strip last 3 segments.
    const mainRepo = dirname(dirname(dirname(gitdir)));
    if (existsSync(join(mainRepo, '.cleo')) && validateProjectRoot(mainRepo)) {
      return mainRepo;
    }
  } catch {
    // Parse error — not a valid gitlink.
  }
  return null;
}

/**
 * Validate that a candidate project root directory is a legitimate CLEO
 * project root and not a stray parent `.cleo/` directory that happened to
 * be found by the walk-up algorithm.
 *
 * ## Primary path (T1864 — project-info.json contract)
 *
 * A candidate is **accepted** when `.cleo/project-info.json` exists and
 * parses as JSON with a non-empty `projectId` string field.  This is the
 * canonical form written by `cleo init` and is the only form that guarantees
 * the directory is a proper CLEO project rather than a stray `.cleo/` left by
 * an old installation or a git worktree that auto-created its own `.cleo/`.
 *
 * ## Tracked identity (T12716)
 *
 * A candidate whose `.cleo/project.json` (or legacy `.cleo/project-id`)
 * declares a valid id is also accepted, without the legacy warning — a fresh
 * clone before `cleo init` is a project root. As in `resolveProjectByCwd`, a
 * tracked-only `.cleo/` counts only at a git toplevel (a real `.git/`
 * directory), so a committed id in a monorepo subdirectory never shadows its
 * parent, and a worktree (gitlink `.git` file) still resolves to its parent.
 *
 * ## Legacy fallback (backwards-compatibility)
 *
 * Projects initialized before `project-info.json` was introduced are still
 * accepted when **both** of the following are true:
 *   1. `.cleo/` exists in `candidate`
 *   2. `.git/` exists as a sibling of `.cleo/` in `candidate`
 *
 * A one-time stderr warning is emitted (guarded by `_legacyFallbackWarned`)
 * so operators know to re-run `cleo init` to upgrade the project metadata.
 *
 * **Breaking change vs. prior implementation**: bare `package.json` alone is
 * no longer sufficient.  The old check `existsSync(gitDir) || existsSync(pkgJson)`
 * accepted any Node.js package directory as a valid project root, which caused
 * the monorepo-package bug where sub-packages inside `packages/` created their
 * own empty `.cleo/` databases.
 *
 * @param candidate - Absolute path to the directory being considered as the
 *   project root (parent of the `.cleo/` directory).
 * @returns `true` when the candidate is a recognised CLEO project root.
 * @remarks This validates existing markers without creating directories or opening
 * stores. Git-link worktrees resolve through their parent instead of becoming roots.
 *
 * @example
 * ```typescript
 * // Project root with project-info.json — valid (primary path)
 * validateProjectRoot('/home/user/myproject'); // true
 *
 * // Legacy project root with .git/ but no project-info.json — valid + warning
 * validateProjectRoot('/home/user/legacy-project'); // true (+ stderr warning)
 *
 * // Stray .cleo in home dir with no markers — invalid
 * validateProjectRoot('/home/user'); // false
 * ```
 *
 * @task T1463
 * @task T1864
 */
export function validateProjectRoot(candidate: string): boolean {
  const cleoDir = join(candidate, '.cleo');
  if (!existsSync(cleoDir)) {
    return false;
  }

  // Primary: .cleo/project-info.json with a valid projectId string.
  // T11034 — Worktree guard: a worktree has .git as a gitlink FILE, not a
  // directory. project-info.json is copied into worktrees for identity
  // inheritance (T11033), but worktrees must NOT be treated as standalone
  // project roots — path resolution must walk past them to the parent project.
  const projectInfoPath = join(cleoDir, 'project-info.json');
  if (existsSync(projectInfoPath)) {
    try {
      const raw = readFileSync(projectInfoPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'projectId' in parsed &&
        typeof (parsed as Record<string, unknown>)['projectId'] === 'string' &&
        (parsed as Record<string, unknown>)['projectId'] !== ''
      ) {
        // T11034: Reject worktrees — .git is a gitlink FILE, not a directory.
        // Workers should resolve through to the parent project root.
        const gitMarker = join(candidate, '.git');
        if (existsSync(gitMarker)) {
          try {
            if (!statSync(gitMarker).isDirectory()) {
              // Gitlink file (worktree) — NOT a project root.
              return false;
            }
          } catch {
            // Stat failed — treat as non-directory (reject).
            return false;
          }
        }
        return true;
      }
    } catch {
      // JSON parse error or read error — fall through to legacy check.
    }
  }

  // T12716: a valid tracked identity marks a root at a git toplevel.
  if (readPortableProjectId(candidate).status === 'valid') {
    try {
      if (statSync(join(candidate, '.git')).isDirectory()) return true;
    } catch {
      // No `.git/`: not a toplevel — fall through (rejected below).
    }
  }

  // Legacy fallback: .cleo/ + .git/ sibling (no project-info.json required).
  // Emits a one-time warning to prompt the operator to run `cleo init`.
  //
  // CRITICAL (T9092): a git worktree has `.git` as a *file* (a "gitlink" pointing
  // back to the main repo's .git/worktrees/<name> directory), NOT a directory.
  // Accepting such candidates as project roots recreates the 2026-05-04 dead-end-DB
  // disaster pattern: workers spawned in a worktree create rogue `.cleo/tasks.db`
  // files isolated from the real project database. The legacy fallback MUST only
  // accept candidates where `.git` is a true directory (a real repo root).
  const gitDir = join(candidate, '.git');
  if (existsSync(gitDir)) {
    let isRealGitDir = false;
    try {
      const stat = statSync(gitDir);
      isRealGitDir = stat.isDirectory();
    } catch {
      isRealGitDir = false;
    }
    if (!isRealGitDir) {
      // .git is a gitlink file (worktree marker) — NOT a project root.
      return false;
    }
    if (!_legacyFallbackWarned) {
      _legacyFallbackWarned = true;
      // T9774: debug-only — surfaced via CLEO_DEBUG to keep stderr clean by default.
      // Cannot use pushWarning here because paths.ts is in the import chain of
      // output.ts (output → sessions/context-alert → paths) — circular dep.
      if (process.env['CLEO_DEBUG']) {
        process.stderr.write(
          `[cleo][debug] W_PATH_RESOLUTION: ${candidate}/.cleo/ lacks project-info.json. ` +
            `Run \`cleo init\` to upgrade project metadata (T1864 legacy-fallback).\n`,
        );
      }
    }
    return true;
  }

  return false;
}

/**
 * Get the project root by walking ancestor directories for `.cleo/` or `.git/`.
 *
 * Stops at the **first** ancestor directory that contains either sentinel
 * directory and never drifts past it — even when multiple nested projects
 * exist above the starting directory.
 *
 * Resolution order:
 *   1. `CLEO_ROOT` env var — bypasses walk entirely (CI / test override)
 *   2. `CLEO_DIR` env var (absolute path only) — derives project root from dirname
 *   3. Walk ancestors from `cwd` (or `process.cwd()`) toward filesystem root:
 *      - `.cleo/` found with a sibling `.git/` or `package.json` → accept as root
 *      - `.cleo/` found but **no** sibling marker → skip (stray/parent `.cleo/`)
 *      - `.git/` found (without `.cleo/` sibling) → throw `E_NOT_INITIALIZED`
 *   4. Filesystem root reached without a valid root → throw `E_INVALID_PROJECT_ROOT`
 *      (if at least one `.cleo/` was skipped) or `E_NO_PROJECT` (none found)
 *
 * @param cwd - Optional starting directory; defaults to `process.cwd()`
 * @returns Absolute path to the project root directory (parent of `.cleo/`)
 * @throws {CleoError} `ExitCode.CONFIG_ERROR` (`E_NOT_INITIALIZED`) when a
 *   `.git/` is found but no `.cleo/` is present at that level.
 * @throws {CleoError} `ExitCode.CONFIG_ERROR` (`E_INVALID_PROJECT_ROOT`) when
 *   one or more `.cleo/` directories are found but none have the required sibling
 *   markers (`.git/` or `package.json`). This prevents accidental operations on
 *   the wrong project when a stray parent `.cleo/` exists higher in the filesystem.
 * @throws {CleoError} `ExitCode.NOT_FOUND` (`E_NO_PROJECT`) when neither
 *   sentinel is found in any ancestor.
 *
 * @remarks
 * `CLEO_ROOT` is an absolute-path escape hatch for environments where the
 * working directory is unrelated to the project (CI tmpdirs, monorepo scripts,
 * test harnesses). When set it is returned as-is without scanning ancestors.
 *
 * `CLEO_DIR` set to an absolute path (e.g. `/project/.cleo`) also bypasses
 * the walk: the project root is derived as its `dirname`. This preserves
 * backward compatibility for test harnesses that use `CLEO_DIR` to pin the
 * project root.
 *
 * NEVER auto-creates `.cleo/`. Project initialisation is an explicit opt-in
 * via `cleo init`.
 *
 * @example
 * ```typescript
 * // Running from packages/core inside the monorepo:
 * const root = getProjectRoot(); // "/mnt/projects/cleocode"
 * ```
 */
export function getProjectRoot(cwd?: string): string {
  // 0. AsyncLocalStorage worktree scope (T380/ADR-041 §D3) — checked FIRST.
  //    When a spawn adapter wraps execution in worktreeScope.run(...), the
  //    scoped root wins over all env-var and walk-based resolution.
  const scope = worktreeScope.getStore();
  if (scope !== undefined) {
    return scope.worktreeRoot;
  }

  // 1. Honour CLEO_ROOT / CLEO_PROJECT_ROOT env var — bypass walk entirely.
  //    CLEO_PROJECT_ROOT is the agent-friendly alias (T090).
  const envRoot = process.env['CLEO_ROOT'] ?? process.env['CLEO_PROJECT_ROOT'];
  if (envRoot) {
    return envRoot;
  }

  // 2. If CLEO_DIR is an absolute path, derive the project root from it.
  //    This preserves backward compatibility for test harnesses that set
  //    CLEO_DIR=/some/absolute/path/.cleo to pin the project root.
  const cleoDirEnv = process.env['CLEO_DIR'];
  if (cleoDirEnv && isAbsolutePath(cleoDirEnv)) {
    if (cleoDirEnv.endsWith('/.cleo') || cleoDirEnv.endsWith('\\.cleo')) {
      return dirname(cleoDirEnv);
    }
    return cleoDirEnv;
  }

  // This is the bottom of the resolution chain: the line lives INSIDE
  // getProjectRoot, and resolveOrCwd() delegates to getProjectRoot(), so using
  // the sanctioned helper here would recurse forever.
  const start = resolve(cwd ?? process.cwd()); // CWD-OK: base case of getProjectRoot itself
  let current = start;

  // 2.5. T9092 + T11034: if `start` is inside a git worktree (i.e. has `.git` as a
  //      gitlink FILE pointing to `<mainrepo>/.git/worktrees/<name>`), the
  //      canonical project root is the MAIN repo, not the worktree dir.
  //      Delegates to the shared _resolveMainRepoFromGitlink helper which
  //      provides deterministic resolution from any worktree path.
  const mainRepoFromStart = _resolveMainRepoFromGitlink(start);
  if (mainRepoFromStart !== null) return mainRepoFromStart;

  // T889/T909 guard: snapshot $HOME and filesystem root sentinels.
  //
  // Historical bug: when `cleo` ran with `cwd=$HOME` and a stray
  // `~/.cleo/` existed (from a prior buggy run or user mistake), the
  // walk-up returned `$HOME` as the project root. This silently created
  // `~/.cleo/conduit.db`, `~/.cleo/tasks.db`, etc. — diverging from the
  // real project DBs and losing data on branch switch. See ADR-037
  // (conduit.db is project-tier-only) and the orphan-conduit remediation.
  //
  // Contract: `getProjectRoot` MUST NEVER resolve to `$HOME` or `/`.
  // If the walk would land there, treat it as "no project" rather than
  // silently accepting a pathological root. Users who legitimately want
  // `$HOME` as a project root must set `CLEO_ROOT=$HOME` explicitly — the
  // env-var path above bypasses this guard, making the opt-in explicit.
  const homeRoot = homedir();

  // T1463/P1-7: track if we skipped any .cleo/ dirs that failed validation.
  // Used to produce a more informative error message when every candidate
  // was rejected by validateProjectRoot.
  const skippedCleoDirs: string[] = [];

  // 3. Walk ancestors toward filesystem root
  while (true) {
    const cleoDir = join(current, '.cleo');
    const gitDir = join(current, '.git');

    // T889/T909: refuse to accept $HOME or / as a project root, even if a
    // `.cleo/` sentinel exists there. This blocks the orphan-DB vector.
    const isDangerousRoot = current === homeRoot || current === '/' || current === '';

    // T12558: `cleo project reroot` left a tombstone here. With no live store
    // beside it (the `.cleo/` is gone, or `git checkout -- .` restored only its
    // tracked files), resolving here would silently create an EMPTY store and
    // answer every read with nothing. Refuse and name the new root. Only a
    // VALID tombstone counts (a committed or stale one is ignored with a
    // warning), and `cleo doctor` turns the refusal off to inspect the state.
    if (
      !isDangerousRoot &&
      isProjectMovedRefusalEnabled() &&
      !existsSync(join(cleoDir, 'cleo.db'))
    ) {
      const tombstone = readValidProjectTombstone(current);
      if (tombstone) throw projectMovedError(current, tombstone, start);
    }

    if (existsSync(cleoDir) && !isDangerousRoot) {
      // T1463/P1-7: validate that the .cleo/ dir has the required sibling
      // markers (.git/ or package.json) before accepting this candidate.
      //
      // T9092: previously the start-directory short-circuit was unconditional —
      // `current === start` returned the candidate without running
      // validateProjectRoot. That allowed a worktree (whose `.git` is a gitlink
      // FILE not a directory) to be accepted as a project root if any process
      // had previously created a stray `.cleo/` inside it. validateProjectRoot
      // now rejects gitlink-only candidates, so we must run it on the start dir
      // too — but only as a *gate* to walk up further, not to reject outright.
      // If start dir validation fails, we continue walking to find the real
      // project root (the main repo).
      if (validateProjectRoot(current)) {
        // Valid project root.
        return current;
      }
      // Stray/rogue .cleo/ found (e.g. worktree with gitlink, or .cleo without
      // project-info.json AND without a real .git/ sibling) — skip it and
      // continue walking up for the canonical project root.
      skippedCleoDirs.push(current);
    }

    if (existsSync(gitDir) && !isDangerousRoot) {
      // T9092: only treat .git as a "real repo root" boundary when it is a
      // DIRECTORY. A gitlink FILE (worktree marker) does not anchor a project
      // root — keep walking up to find the canonical main repo.
      let isRealGitDir = false;
      try {
        isRealGitDir = statSync(gitDir).isDirectory();
      } catch {
        isRealGitDir = false;
      }
      if (isRealGitDir) {
        // Real .git/ found but no .cleo/ sibling — not initialised
        throw new CleoError(ExitCode.CONFIG_ERROR, `Run cleo init at ${current}`, {
          fix: `cd ${current} && cleo init`,
        });
      }
      // gitlink file — attempt to resolve the main repo from it (T11034).
      // When a worktree lives under ~/.local/share/cleo/worktrees/... and the
      // caller is in a subdirectory (not the worktree root), the start-level
      // gitlink check misses it. During the walk we must resolve gitlinks
      // to ensure deterministic resolution from any worktree path.
      const mainRepoFromWalk = _resolveMainRepoFromGitlink(current);
      if (mainRepoFromWalk !== null) return mainRepoFromWalk;
      // gitlink we couldn't resolve — keep walking up.
    }

    // Move up one level
    const parent = dirname(current);
    if (parent === current) {
      // Reached filesystem root without finding either sentinel
      break;
    }
    current = parent;
  }

  // 4a. At least one .cleo/ was found but all were rejected by validateProjectRoot.
  //     This is the "parent .cleo/ trap" scenario: a stray .cleo/ dir higher in
  //     the filesystem lacks a .git/ or package.json sibling, so it cannot be
  //     trusted as a project root.
  if (skippedCleoDirs.length > 0) {
    throw new CleoError(
      ExitCode.CONFIG_ERROR,
      `E_INVALID_PROJECT_ROOT: no .cleo with sibling .git found from ${start} (skipped: ${skippedCleoDirs.join(', ')})`,
      {
        fix: `cleo init or add a .git directory alongside the .cleo dir`,
      },
    );
  }

  // 4b. No sentinel found in any ancestor
  throw new CleoError(
    ExitCode.NOT_FOUND,
    'Not inside a CLEO project. Run cleo init or cd to an existing project',
    {
      fix: 'cleo init',
    },
  );
}

/**
 * Module-level flag: emit the legacy-fallback warning at most once per process.
 * Prevents log spam when `validateProjectRoot` is called repeatedly in a session.
 */
let _legacyFallbackWarned = false;

/** Fields consumed by logging, audit, and correlation subsystems. */
export interface ProjectInfo {
  /** Write-once 12-char hex identity key persisted at init (T12557: never re-derived once stored). */
  projectHash: string;
  /**
   * Portable project id: the tracked `.cleo/project.json` / legacy
   * `.cleo/project-id` id, else the `projectId` cached in
   * `.cleo/project-info.json` (T12716).
   */
  projectId: string;
  /** Absolute path to the project root directory. */
  projectRoot: string;
  /** Display name from {@link getProjectDisplayName} (T12716). */
  projectName: string;
}

/**
 * Compute the write-once `projectHash` for a project root.
 *
 * `projectHash` is an identity key (audit correlation, idempotency, release
 * ids), not a path fact. It is computed once, at init, and persisted. This
 * computes it from the real path of the MAIN checkout: a linked worktree maps
 * to its parent project, and symlinked spellings (`/tmp` vs `/private/tmp`)
 * collapse to one path, so every spelling of one project gets one hash.
 *
 * @param projectRoot - Project root or a linked worktree of it.
 * @returns 12-char hex hash of the canonical main-checkout path.
 * @example
 * ```ts
 * const hash = computeStableProjectHash('/tmp/project'); // same as '/private/tmp/project'
 * ```
 * @task T12557
 */
export function computeStableProjectHash(projectRoot: string): string {
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return generateProjectHash(real(resolveStoreOwnerRoot(real(projectRoot))));
}

/**
 * Compute the portable `projectHash` for a project id (T12716).
 *
 * Every NEW `projectHash` is derived from the tracked id, never the path, so
 * every clone on every device computes the same key (T12558 introduced the
 * formula for `--new-identity`). A stored hash is never re-derived: existing
 * audit rows, idempotency keys and release ids keep the value they were
 * written with, and a legacy file without a hash is still backfilled with
 * {@link computeStableProjectHash}, the path-derived value its pre-T12557 keys
 * were built from.
 *
 * @param projectId - The project's portable id.
 * @returns 12-char hex hash of `project-id:<id>`.
 * @example
 * ```ts
 * computePortableProjectHash('c78d09c3a8ee'); // same value on every device
 * ```
 * @task T12716
 */
export function computePortableProjectHash(projectId: string): string {
  return generateProjectHash(`project-id:${projectId}`);
}

/**
 * The display name of a project (T12716) — the single accessor every
 * registration, encounter, Nexus link and label path uses.
 *
 * Order: the committed `.cleo/project.json` `name`; for a legacy project not
 * yet migrated by `cleo doctor project-identity --resolve`, the
 * `.cleo/project-info.json` `displayName` (what a legacy rename writes), then
 * its `name` (the init-time name, or what `cleo project rename` wrote before
 * T12716); otherwise the directory basename.
 *
 * @param projectRoot - Absolute project root.
 * @returns A non-empty name. Never throws.
 * @example
 * ```ts
 * getProjectDisplayName('/work/cleocode'); // 'cleocode' unless project.json names it
 * ```
 * @task T12716
 */
export function getProjectDisplayName(projectRoot: string): string {
  const tracked = readPortableProjectId(projectRoot);
  if (tracked.status === 'valid' && tracked.name !== undefined) return tracked.name;
  try {
    const info = JSON.parse(
      readFileSync(join(projectRoot, '.cleo', 'project-info.json'), 'utf-8'),
    ) as Record<string, unknown>;
    for (const field of ['displayName', 'name'] as const) {
      const name = info[field];
      if (typeof name === 'string' && isValidProjectDisplayName(name)) return name;
    }
  } catch {
    // No readable cache: the basename below.
  }
  const segments = projectRoot.replace(/[\\/]+$/, '').split(/[\\/]/);
  return segments[segments.length - 1] || 'unknown';
}

/**
 * Persist a derived `projectHash` into a legacy file, compare-and-swap style.
 *
 * The file is re-read just before the rename and written only when it still
 * has no hash and still carries `expectedProjectId`, so a concurrent re-key
 * (`doctor project-identity --resolve`) or backfill is never clobbered. Every
 * failure leaves the file untouched; the caller keeps the derived value.
 */
function backfillProjectHash(infoPath: string, expectedProjectId: unknown, hash: string): void {
  try {
    const current = JSON.parse(readFileSync(infoPath, 'utf-8')) as Record<string, unknown>;
    if (current.projectId !== expectedProjectId) return;
    if (typeof current.projectHash === 'string' && current.projectHash.length > 0) return;
    const tmp = `${infoPath}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify({ ...current, projectHash: hash }, null, 2)}\n`);
    renameSync(tmp, infoPath);
  } catch {
    // Read-only or vanished store: the derived value is still stable for this root.
  }
}

/**
 * Decode the existing project metadata contract at a caller-owned root.
 *
 * T12557: `projectRoot` always comes from the caller, never the file. The
 * persisted `projectHash` is authoritative. A legacy file without one gets
 * {@link computeStableProjectHash}, persisted once (best effort) so the value
 * never changes afterwards.
 */
function decodeProjectInfo(raw: string, projectRoot: string, infoPath: string): ProjectInfo {
  const data = JSON.parse(raw) as Record<string, unknown>;
  let projectHash: string;
  if (typeof data.projectHash === 'string' && data.projectHash.length > 0) {
    projectHash = data.projectHash;
  } else {
    projectHash = computeStableProjectHash(projectRoot);
    backfillProjectHash(infoPath, data.projectId, projectHash);
  }
  // T12716: the tracked id wins over the cached `projectId` (the same order
  // as `readDeclaredProjectIdentity` and `decideProjectIdentity`).
  const tracked = readPortableProjectId(projectRoot);
  return {
    projectHash,
    projectId:
      tracked.status === 'valid'
        ? tracked.projectId
        : typeof data.projectId === 'string'
          ? data.projectId
          : '',
    projectRoot,
    projectName: getProjectDisplayName(projectRoot),
  };
}

/**
 * Read metadata from a directory already resolved by the canonical path policy.
 * @param projectRoot - Captured root used for the returned identity and name.
 * @param cleoDir - Explicit data directory owned by that root.
 * @returns Validated project information, retaining the legacy empty portable ID.
 * @throws When reading or JSON decoding fails.
 * @remarks This leaf does not consult ambient environment pins. A legacy file
 * without `projectHash` is backfilled once (see {@link computeStableProjectHash}).
 * @example
 * ```ts
 * const info = await readProjectInfoAtDirectory(root, join(root, '.cleo'));
 * ```
 */
export async function readProjectInfoAtDirectory(
  projectRoot: string,
  cleoDir: string,
): Promise<ProjectInfo> {
  const infoPath = join(cleoDir, 'project-info.json');
  return decodeProjectInfo(await readFile(infoPath, 'utf-8'), projectRoot, infoPath);
}

/**
 * Strict synchronous metadata read for captured operation ownership validation.
 * @param projectRoot - Captured root used for the returned identity and name.
 * @param cleoDir - Explicit data directory owned by that root.
 * @returns Validated project information, retaining the legacy empty portable ID.
 * @throws When reading or JSON decoding fails.
 * @remarks Unlike the legacy public nullable wrapper, this preserves diagnostic failures.
 * @example
 * ```ts
 * const info = readProjectInfoAtDirectorySync(root, join(root, '.cleo'));
 * ```
 */
export function readProjectInfoAtDirectorySync(projectRoot: string, cleoDir: string): ProjectInfo {
  const infoPath = join(cleoDir, 'project-info.json');
  return decodeProjectInfo(readFileSync(infoPath, 'utf-8'), projectRoot, infoPath);
}
