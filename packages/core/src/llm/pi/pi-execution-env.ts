/**
 * Guarded Pi `ExecutionEnv` (T11761 · S1 · T11897).
 *
 * Pi's agent loop performs ALL filesystem + shell work through a single
 * pluggable seam: `ExecutionEnv extends FileSystem, Shell`. This module supplies
 * Cleo's implementation of that seam — {@link GuardedExecutionEnv} — which routes
 * every operation through the deny-first {@link ToolGuard} chokepoint and an
 * injected **workspace boundary**, so Pi can touch nothing outside the
 * allowlisted roots and runs no command on the denylist.
 *
 * Two layers of confinement (deny-first):
 * 1. **Workspace boundary** — every fs path is canonicalized with SYMLINK
 *    RESOLUTION (`fs.realpath` on the nearest existing ancestor) and the REAL
 *    target MUST fall under the injected `workspaceRoot`; a `../` escape, an
 *    out-of-root absolute path, OR a symlink (file or parent dir) whose real
 *    target leaves the root is rejected as a Pi `Result.err(FileError)` BEFORE
 *    the guard is consulted. A purely lexical check is symlink-blind, so the
 *    boundary resolves symlinks first. (The guard's own `allowedRoots` is a
 *    second, ALSO-symlink-resolving net.)
 * 2. **ToolGuard** — the allowed operations delegate to the `ToolGuard` surface
 *    (`readFileText`/`writeFileAtomic`/`pathExists`/`executeShell`/`runGit`),
 *    which applies the project's symlink-resolved path allowlist + shell
 *    denylist + subprocess-env scrub. A `GuardDeniedError` from enforce-mode is
 *    CAUGHT and converted to a Pi `Result.err` — Pi's `FileSystem`/`Shell` ops
 *    must NEVER throw. The guard MUST be constructed in `enforce` mode (the
 *    factory asserts it) — in `warn` mode its allowlist/denylist are advisory
 *    and confinement would collapse to the workspace boundary alone.
 *
 * Every other capability (binary reads, raw temp/dir mutation, listing, …) for
 * which there is no atomic primitive in v0 is DENIED with a typed error rather
 * than reaching the real filesystem. The structural Pi interfaces are declared
 * locally here (the `@earendil-works/pi-agent-core` package is not yet a
 * dependency); S2 replaces these with the real type-only imports — the shapes
 * match `@earendil-works/pi-agent-core@0.78.1` `harness/types.ts:268-332`.
 *
 * Scope discipline (S1): NO `pi-ai`/`pi-agent-core` imports, NO DB access, NO
 * LLM calls. Import-time side-effect free.
 *
 * @epic T10403
 * @task T11761
 * @task T11897
 */

import { isAbsolute, relative, resolve as resolvePath } from 'node:path';
import { scrubSubprocessEnv } from '../../tools/env-scrub.js';
import { canonicalizePath } from '../../tools/fs.js';
import { GuardDeniedError, type GuardMode, type ToolGuard } from '../../tools/guard.js';

// ---------------------------------------------------------------------------
// Structural Pi seam (local declarations — replaced by type-only pi imports in S2)
// ---------------------------------------------------------------------------

/**
 * Pi's `Result<T, E>` discriminated union. Pi's `FileSystem`/`Shell` ops return
 * this and MUST never throw — failures are encoded as `{ ok: false, error }`.
 *
 * Matches `@earendil-works/pi-agent-core@0.78.1` result shape.
 */
export type PiResult<T, E> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: E;
    };

/** A filesystem failure surfaced to Pi (never thrown). */
export interface PiFileError {
  /** Stable failure kind. */
  readonly code: string;
  /** Human-readable description. */
  readonly message: string;
  /** The path the operation targeted, when applicable. */
  readonly path?: string;
}

/** A shell-execution failure surfaced to Pi (never thrown). */
export interface PiExecutionError {
  /** Stable failure kind. */
  readonly code: string;
  /** Human-readable description. */
  readonly message: string;
}

/** Metadata returned by `fileInfo`. */
export interface PiFileInfo {
  /** Whether the entry is a regular file. */
  readonly isFile: boolean;
  /** Whether the entry is a directory. */
  readonly isDirectory: boolean;
}

/** Result of a `Shell.exec`. */
export interface PiExecResult {
  /** Captured standard output. */
  readonly stdout: string;
  /** Captured standard error. */
  readonly stderr: string;
  /** Process exit code (`null` when killed by signal/timeout). */
  readonly exitCode: number | null;
}

/** Options for a `Shell.exec`. */
export interface PiExecOptions {
  /** Working directory. */
  readonly cwd?: string;
  /** Hard timeout in milliseconds. */
  readonly timeout?: number;
  /** Extra environment variables. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Pi's `FileSystem` interface (the fs half of `ExecutionEnv`). Every op returns
 * a {@link PiResult} and must never throw. Mirrors
 * `@earendil-works/pi-agent-core@0.78.1` `harness/types.ts:268-318`.
 */
export interface PiFileSystem {
  cwd(): string;
  absolutePath(path: string): string;
  joinPath(...segments: string[]): string;
  readTextFile(path: string): Promise<PiResult<string, PiFileError>>;
  readTextLines(path: string): Promise<PiResult<string[], PiFileError>>;
  readBinaryFile(path: string): Promise<PiResult<Uint8Array, PiFileError>>;
  writeFile(path: string, content: string): Promise<PiResult<void, PiFileError>>;
  appendFile(path: string, content: string): Promise<PiResult<void, PiFileError>>;
  fileInfo(path: string): Promise<PiResult<PiFileInfo, PiFileError>>;
  listDir(path: string): Promise<PiResult<string[], PiFileError>>;
  canonicalPath(path: string): Promise<PiResult<string, PiFileError>>;
  exists(path: string): Promise<PiResult<boolean, PiFileError>>;
  createDir(path: string): Promise<PiResult<void, PiFileError>>;
  remove(path: string): Promise<PiResult<void, PiFileError>>;
  createTempDir(prefix?: string): Promise<PiResult<string, PiFileError>>;
  createTempFile(prefix?: string): Promise<PiResult<string, PiFileError>>;
  cleanup(): Promise<void>;
}

/**
 * Pi's `Shell` interface (the shell half of `ExecutionEnv`). Mirrors
 * `@earendil-works/pi-agent-core@0.78.1` `harness/types.ts:321-328`.
 */
export interface PiShell {
  exec(command: string, options?: PiExecOptions): Promise<PiResult<PiExecResult, PiExecutionError>>;
  cleanup(): Promise<void>;
}

/**
 * Pi's `ExecutionEnv` — the single pluggable surface for all fs + process work.
 * Mirrors `@earendil-works/pi-agent-core@0.78.1` `harness/types.ts:332`.
 */
export interface PiExecutionEnv extends PiFileSystem, PiShell {}

// ---------------------------------------------------------------------------
// Result constructors
// ---------------------------------------------------------------------------

/** Build a successful {@link PiResult}. */
function ok<T>(value: T): PiResult<T, never> {
  return { ok: true, value };
}

/** Build a failed {@link PiResult} with a {@link PiFileError}. */
function fsErr(code: string, message: string, path?: string): PiResult<never, PiFileError> {
  return { ok: false, error: { code, message, ...(path !== undefined ? { path } : {}) } };
}

/** Build a failed {@link PiResult} with a {@link PiExecutionError}. */
function execErr(code: string, message: string): PiResult<never, PiExecutionError> {
  return { ok: false, error: { code, message } };
}

/**
 * Whether `err` is a "file does not exist" failure (`ENOENT`). Used by
 * {@link GuardedExecutionEnv.appendFile} to treat append-to-missing as
 * append-creates (empty prefix) while still propagating every OTHER failure
 * (guard denial, permission, …).
 */
function isMissingFileError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

// ---------------------------------------------------------------------------
// GuardedExecutionEnv
// ---------------------------------------------------------------------------

/** Construction dependencies for {@link GuardedExecutionEnv}. */
export interface GuardedExecutionEnvDeps {
  /**
   * The guarded primitive surface (path allowlist + shell denylist) the env
   * delegates allowed operations to. Injected by the dispatcher — the env never
   * constructs it (atomic primitives are Gate-11-bound to `core/src/tools`).
   */
  readonly guard: ToolGuard;
  /**
   * The absolute workspace root every fs path is confined under. A path that
   * resolves outside this root is denied BEFORE the guard is consulted.
   */
  readonly workspaceRoot: string;
}

/**
 * Deny-first {@link PiExecutionEnv} backed by the Cleo {@link ToolGuard} surface
 * and a workspace boundary.
 *
 * - File reads/writes/existence checks route through the guard's atomic
 *   primitives, confined to `workspaceRoot`.
 * - `exec` routes through the guard's `executeShell` (shell denylist applies).
 * - Capabilities with no atomic primitive in v0 (binary read, `listDir`,
 *   `createDir`, `remove`, temp dir/file) are DENIED with a typed
 *   `Result.err` — they never reach the real filesystem.
 * - Pure path arithmetic (`cwd`/`absolutePath`/`joinPath`) is computed locally
 *   (no fs access), anchored to `workspaceRoot`.
 *
 * Every method honours the Pi contract: it returns a {@link PiResult} and never
 * throws — a {@link GuardDeniedError} from the guard is caught and converted.
 */
export class GuardedExecutionEnv implements PiExecutionEnv {
  readonly #guard: ToolGuard;
  readonly #root: string;

  /**
   * @param deps - The guard surface + the workspace root to confine to.
   */
  constructor(deps: GuardedExecutionEnvDeps) {
    this.#guard = deps.guard;
    this.#root = resolvePath(deps.workspaceRoot);
  }

  /**
   * Lexically resolve a (possibly relative) path against the workspace root and
   * assert it does not climb out. This is the fast FIRST gate only — it is
   * symlink-blind, so {@link #confine} additionally re-checks the REAL target.
   *
   * @returns the lexically-resolved absolute path, or `null` on a `../`/absolute
   *   escape.
   */
  #lexicalConfine(path: string): string | null {
    const abs = isAbsolute(path) ? resolvePath(path) : resolvePath(this.#root, path);
    const rel = relative(this.#root, abs);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return abs;
    return null;
  }

  /**
   * Resolve a (possibly relative) path against the workspace root and assert its
   * REAL filesystem target stays inside the boundary. Two gates:
   * 1. lexical (`#lexicalConfine`) — rejects `../` / out-of-root absolute paths;
   * 2. SYMLINK resolution (`canonicalizePath`) — follows every symlink component
   *    (incl. a symlinked parent of a fresh write target) and re-checks
   *    containment against the REAL path, defeating the classic symlink/TOCTOU
   *    escape that a purely lexical check is blind to.
   *
   * @returns the symlink-resolved absolute path, or `null` when it escapes.
   */
  async #confine(path: string): Promise<string | null> {
    const lexical = this.#lexicalConfine(path);
    if (lexical === null) return null;
    const real = await canonicalizePath(lexical);
    // Compare against the REAL root too, so a workspace whose own path traverses
    // a symlink does not spuriously reject its own contained files.
    const realRoot = await canonicalizePath(this.#root);
    const rel = relative(realRoot, real);
    // The REAL target must not climb out of the (also-real) root.
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return real;
    return null;
  }

  // --- pure path arithmetic (no fs access) ---------------------------------

  /** The workspace root (the in-process Pi run's working directory). */
  cwd(): string {
    return this.#root;
  }

  /** Resolve `path` to an absolute path anchored at the workspace root. */
  absolutePath(path: string): string {
    return isAbsolute(path) ? resolvePath(path) : resolvePath(this.#root, path);
  }

  /** Join path segments (pure). */
  joinPath(...segments: string[]): string {
    return resolvePath(this.#root, ...segments);
  }

  // --- file reads ----------------------------------------------------------

  /** Read a file's text, confined to the workspace + guarded. */
  async readTextFile(path: string): Promise<PiResult<string, PiFileError>> {
    const abs = await this.#confine(path);
    if (abs === null) return fsErr('E_PI_FS_DENIED', 'path escapes workspace boundary', path);
    try {
      const res = await this.#guard.readFileText({ path: abs });
      return ok(res.content);
    } catch (err) {
      return this.#toFsErr(err, abs);
    }
  }

  /** Read a file's text as an array of lines. */
  async readTextLines(path: string): Promise<PiResult<string[], PiFileError>> {
    const res = await this.readTextFile(path);
    return res.ok ? ok(res.value.split(/\r?\n/)) : res;
  }

  /**
   * Binary read — DENIED in v0. The atomic `readFileText` primitive is
   * text-only (`ReadFileInput.encoding` has no binary variant); a binary
   * primitive must be added under `core/src/tools` (Gate 11) before this is
   * supported. Deny-first: never reaches the filesystem.
   */
  async readBinaryFile(path: string): Promise<PiResult<Uint8Array, PiFileError>> {
    return fsErr('E_PI_FS_UNSUPPORTED', 'binary read is not supported in v0', path);
  }

  // --- file writes ---------------------------------------------------------

  /** Atomically write a file, confined to the workspace + guarded. */
  async writeFile(path: string, content: string): Promise<PiResult<void, PiFileError>> {
    const abs = await this.#confine(path);
    if (abs === null) return fsErr('E_PI_FS_DENIED', 'path escapes workspace boundary', path);
    try {
      await this.#guard.writeFileAtomic({ path: abs, content });
      return ok(undefined);
    } catch (err) {
      return this.#toFsErr(err, abs);
    }
  }

  /**
   * Append to a file. The atomic surface offers only whole-file atomic writes,
   * so this reads-then-writes the concatenation (still confined + guarded). A
   * missing file is treated as empty.
   *
   * Confinement happens EXACTLY ONCE here, then the read + write delegate
   * straight to the guard with the already-resolved `abs`. Re-entering the
   * public `readTextFile`/`writeFile` would re-`#confine` the value `#confine`
   * just returned — and because `#confine` yields the SYMLINK-RESOLVED real path
   * (e.g. macOS `/tmp`→`/private/tmp`, or a symlinked workspace root), that real
   * path is `../`-outside the lexical `workspaceRoot`, so the second lexical
   * gate would spuriously reject it (`E_PI_FS_DENIED`). Reading once through the
   * guard — whose own allowlist canonicalizes both sides — avoids the
   * double-confine while keeping the symlink-escape denial intact.
   */
  async appendFile(path: string, content: string): Promise<PiResult<void, PiFileError>> {
    const abs = await this.#confine(path);
    if (abs === null) return fsErr('E_PI_FS_DENIED', 'path escapes workspace boundary', path);
    // Read existing content directly via the guard (a missing file → ENOENT,
    // treated as empty). Do NOT route through readTextFile: that would re-confine
    // the resolved real path against the lexical root and falsely reject it.
    let prefix = '';
    try {
      const res = await this.#guard.readFileText({ path: abs });
      prefix = res.content;
    } catch (err) {
      // A missing file is the only non-fatal case (append-creates). Any other
      // failure (guard denial, permission, …) propagates as the Pi error.
      if (!isMissingFileError(err)) return this.#toFsErr(err, abs);
    }
    try {
      await this.#guard.writeFileAtomic({ path: abs, content: prefix + content });
      return ok(undefined);
    } catch (err) {
      return this.#toFsErr(err, abs);
    }
  }

  // --- metadata ------------------------------------------------------------

  /** Report whether a path is a file or directory, confined + guarded. */
  async fileInfo(path: string): Promise<PiResult<PiFileInfo, PiFileError>> {
    const abs = await this.#confine(path);
    if (abs === null) return fsErr('E_PI_FS_DENIED', 'path escapes workspace boundary', path);
    try {
      const res = await this.#guard.pathExists({ path: abs });
      if (!res.exists) return fsErr('E_PI_FS_NOT_FOUND', 'path does not exist', abs);
      return ok({ isFile: res.kind === 'file', isDirectory: res.kind === 'directory' });
    } catch (err) {
      return this.#toFsErr(err, abs);
    }
  }

  /** Whether a path exists, confined + guarded. */
  async exists(path: string): Promise<PiResult<boolean, PiFileError>> {
    const abs = await this.#confine(path);
    if (abs === null) return fsErr('E_PI_FS_DENIED', 'path escapes workspace boundary', path);
    try {
      const res = await this.#guard.pathExists({ path: abs });
      return ok(res.exists);
    } catch (err) {
      return this.#toFsErr(err, abs);
    }
  }

  /**
   * Canonicalize a path inside the workspace. SYMLINK-RESOLVING: `#confine`
   * follows every symlink component via `fs.realpath`, so the returned value is
   * the REAL on-disk location (matching Pi's `NodeExecutionEnv.canonicalPath`
   * contract), and a path whose real target escapes the workspace is denied.
   */
  async canonicalPath(path: string): Promise<PiResult<string, PiFileError>> {
    const abs = await this.#confine(path);
    if (abs === null) return fsErr('E_PI_FS_DENIED', 'path escapes workspace boundary', path);
    return ok(abs);
  }

  // --- denied fs-mutating / listing ops (no atomic primitive in v0) --------

  /** DENIED in v0 — no `listDir` atomic primitive. */
  async listDir(path: string): Promise<PiResult<string[], PiFileError>> {
    return fsErr('E_PI_FS_UNSUPPORTED', 'directory listing is not supported in v0', path);
  }

  /** DENIED in v0 — no `createDir` atomic primitive. */
  async createDir(path: string): Promise<PiResult<void, PiFileError>> {
    return fsErr('E_PI_FS_UNSUPPORTED', 'directory creation is not supported in v0', path);
  }

  /** DENIED in v0 — no `remove` atomic primitive. */
  async remove(path: string): Promise<PiResult<void, PiFileError>> {
    return fsErr('E_PI_FS_UNSUPPORTED', 'remove is not supported in v0', path);
  }

  /** DENIED in v0 — no temp-dir atomic primitive. */
  async createTempDir(): Promise<PiResult<string, PiFileError>> {
    return fsErr('E_PI_FS_UNSUPPORTED', 'temp dir creation is not supported in v0');
  }

  /** DENIED in v0 — no temp-file atomic primitive. */
  async createTempFile(): Promise<PiResult<string, PiFileError>> {
    return fsErr('E_PI_FS_UNSUPPORTED', 'temp file creation is not supported in v0');
  }

  // --- shell ---------------------------------------------------------------

  /**
   * Execute a command through the guard's shell surface (denylist applies). The
   * Pi `command` string is a bare executable name (args are passed by Pi via the
   * loop, but the v0 seam takes only `command`); we forward it as the guard's
   * `command` with empty args. `cwd` is symlink-confined to the workspace.
   *
   * ## Env is SCRUBBED before it leaves this seam (T11897 · security)
   *
   * Pi's `options.env` is UNTRUSTED model-driven input. Forwarding it verbatim
   * would let Pi set `LD_PRELOAD`/`NODE_OPTIONS`/`GIT_SSH_COMMAND` (arbitrary
   * native code execution outside any allowlist) or hijack `PATH` to make a
   * workspace-resident impostor satisfy an allowed command basename. So the env
   * is run through {@link scrubSubprocessEnv} HERE — forbidden keys (loader
   * hooks, `PATH`, secrets) are dropped and `PATH` is pinned to a trusted value
   * — before it reaches the guard (which scrubs again as a redundant net, as
   * does `defaultShellExecutor`). This also prevents the daemon's own secrets
   * from leaking into the child (the scrubbed env never inherits `process.env`).
   */
  async exec(
    command: string,
    options?: PiExecOptions,
  ): Promise<PiResult<PiExecResult, PiExecutionError>> {
    const cwd = options?.cwd ? await this.#confine(options.cwd) : this.#root;
    if (cwd === null) {
      return execErr('E_PI_EXEC_DENIED', 'cwd escapes workspace boundary');
    }
    // Scrub Pi-supplied env to a minimal allowlist at the seam (defense in depth
    // — the guard + executor scrub again). Pi can NOT inject a loader hook,
    // hijack PATH, or read inherited daemon secrets through this channel.
    const env = scrubSubprocessEnv({ extra: options?.env });
    try {
      const res = await this.#guard.executeShell({
        command,
        cwd,
        env,
        ...(options?.timeout !== undefined ? { timeoutMs: options.timeout } : {}),
      });
      return ok({ stdout: res.stdout, stderr: res.stderr, exitCode: res.code });
    } catch (err) {
      if (err instanceof GuardDeniedError) {
        return execErr('E_PI_EXEC_DENIED', err.message);
      }
      const message = err instanceof Error ? err.message : String(err);
      return execErr('E_PI_EXEC_FAILED', message);
    }
  }

  // --- cleanup (best-effort, must not throw) -------------------------------

  /** Best-effort cleanup; the guarded surface owns no resources, so a no-op. */
  async cleanup(): Promise<void> {
    // no-op — required on both FileSystem + Shell; owns nothing to release.
  }

  // --- error mapping -------------------------------------------------------

  /** Convert a thrown error from the guarded surface into a Pi `Result.err`. */
  #toFsErr(err: unknown, path: string): PiResult<never, PiFileError> {
    if (err instanceof GuardDeniedError) {
      return fsErr('E_PI_FS_DENIED', err.message, path);
    }
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code?: unknown }).code)
        : 'E_PI_FS_FAILED';
    const message = err instanceof Error ? err.message : String(err);
    return fsErr(code, message, path);
  }
}

/**
 * Thrown by {@link createGuardedExecutionEnv} when the injected guard is NOT in
 * `enforce` mode. In `warn` mode the guard's path allowlist + command denylist
 * are advisory (log-and-proceed), so the second confinement net does not exist
 * and the boundary would collapse to the workspace check alone. The Pi adapter
 * therefore REFUSES a non-enforce guard rather than running untrusted Pi work
 * behind an advisory boundary.
 */
export class PiGuardModeError extends Error {
  /** Machine-readable code. */
  readonly code = 'E_PI_GUARD_NOT_ENFORCING';
  /**
   * @param mode - The (non-enforce) mode the guard was constructed with.
   */
  constructor(mode: GuardMode) {
    super(
      `Pi ExecutionEnv requires an enforce-mode ToolGuard; got "${mode}". ` +
        'In warn mode the path allowlist + command denylist are advisory and provide no boundary.',
    );
    this.name = 'PiGuardModeError';
  }
}

/**
 * Construct a deny-first {@link GuardedExecutionEnv}.
 *
 * REQUIRES an `enforce`-mode guard: a `warn`-mode guard's allowlist/denylist are
 * advisory, so handing untrusted Pi work behind one would leave confinement to
 * the workspace boundary alone. The factory ASSERTS the mode and throws
 * {@link PiGuardModeError} otherwise — the Pi adapter never silently degrades to
 * an advisory boundary.
 *
 * @param deps - The guard surface + the workspace root to confine to.
 * @returns A {@link PiExecutionEnv} safe to hand to Pi's agent loop.
 * @throws {PiGuardModeError} When `deps.guard.mode !== 'enforce'`.
 *
 * @example
 * ```ts
 * const guard = createToolGuard({ allowedRoots: [projectRoot], mode: 'enforce' });
 * const env = createGuardedExecutionEnv({ guard, workspaceRoot: projectRoot });
 * ```
 */
export function createGuardedExecutionEnv(deps: GuardedExecutionEnvDeps): PiExecutionEnv {
  if (deps.guard.mode !== 'enforce') {
    throw new PiGuardModeError(deps.guard.mode);
  }
  return new GuardedExecutionEnv(deps);
}
