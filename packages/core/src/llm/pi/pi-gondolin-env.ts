/**
 * Gondolin micro-VM Pi `ExecutionEnv` — the SECOND backend of the
 * {@link PiExecutionEnv} seam (T11909 · T11888-B · P5 Gondolin · epic T11599).
 *
 * Where the in-process {@link import('./pi-execution-env.js').GuardedExecutionEnv}
 * (S1 · T11761 · T11897) confines Pi with a deny-first `ToolGuard` + workspace
 * boundary INSIDE the host process, this backend's confinement is the
 * **micro-VM boundary itself**. Guest code runs with:
 *
 * - **ZERO host authority** — no `cleo.db` handle, no writer-lease IPC socket, no
 *   host `process.env` secrets, no host filesystem outside the single RW
 *   `/workspace` mount. The guest is a different kernel; it cannot reach the
 *   daemon, the lease arbiter, or BRAIN even if Pi-driven code tries.
 * - **Egress only via the credential-injection proxy** — `createHttpHooks` is
 *   constructed with `allowedHosts: []` (present-and-empty = DENY ALL per the
 *   gondolin docs; OMITTING it = allow-all — the egress footgun this guards) and
 *   host-side secret PLACEHOLDERS, so the guest only ever sees the `placeholder`
 *   bytes, never the real token. The loop appends specific hosts per run.
 * - **Live DBs NEVER mounted** — `.cleo/tasks.db` / `.cleo/brain.db` are NOT in
 *   the VFS mount set. A replay operates on a DISPOSABLE seeded copy
 *   (`VACUUM INTO` snapshot), so the T5158 data-loss vector (git overwrites the
 *   live WAL-backed DB) is structurally impossible: there is no live handle
 *   inside the VM to corrupt.
 *
 * This is strictly stronger than S1's env-scrub: S1 protects against an in-process
 * Pi escape via the guard allowlist; Gondolin protects via kernel + VFS + network
 * namespace separation. A thin in-guest deny layer (lexical `/workspace`
 * confinement + a command denylist for real egress verbs) is kept as DEFENSE IN
 * DEPTH — the boundary is the VM, but a Pi escape that runs a binary still cannot
 * do damage that survives the run.
 *
 * Optional-dep discipline (D11142): `@earendil-works/gondolin` is loaded ONLY via
 * the {@link import('./gondolin-loader.js').loadGondolin} dynamic import — it is
 * in NEITHER `dependencies` NOR `optionalDependencies`, and this module declares
 * NO `import type` from the package (the consumed structural shapes come from the
 * loader's LOCAL types). `core` builds + all non-gondolin tests pass with gondolin
 * ABSENT, and this module is import-time side-effect-free (no top-level VM boot).
 *
 * Never-throw discipline: every `vm.fs.*` / `vm.exec` call is wrapped exactly as
 * S1's `#toFsErr` / `execErr` — a thrown gondolin/guest error becomes a
 * {@link PiResult} `err` with `E_PI_FS_*` / `E_PI_EXEC_*` codes. The
 * `PiResult<T, E>` contract is byte-for-byte identical to S1, so the Pi loop
 * cannot tell the two backends apart.
 *
 * @epic T11599
 * @task T11909
 * @see ./pi-execution-env.js — the S1 `GuardedExecutionEnv` this mirrors over a VM
 * @see ./gondolin-loader.js — the optional-dep loader supplying the structural types
 */

import { isAbsolute as posixIsAbsolute, join as posixJoin } from 'node:path/posix';
import { getLogger } from '../../logger.js';
import {
  type CreateHttpHooks,
  type ExecOptions as GondolinExecOptions,
  type ExecResult as GondolinExecResult,
  type GondolinModule,
  loadGondolin,
  type RealFSProviderInstance,
  type SecretDefinition,
  type VM,
} from './gondolin-loader.js';
import type {
  PiExecOptions,
  PiExecResult,
  PiExecutionEnv,
  PiExecutionError,
  PiFileError,
  PiFileInfo,
  PiResult,
} from './pi-execution-env.js';

const log = getLogger('pi-gondolin-env');

/** The single RW mount point inside the guest — the ONLY writable location. */
export const GONDOLIN_WORKSPACE_ROOT = '/workspace' as const;

/** Where in-guest temp dirs/files are created (under the workspace mount). */
const GONDOLIN_TMP_DIR = `${GONDOLIN_WORKSPACE_ROOT}/.tmp`;

/** Default guest memory bound — set explicitly so we never rely on gondolin's default. */
const DEFAULT_GUEST_MEMORY = '1G' as const;

// ---------------------------------------------------------------------------
// Result constructors (byte-for-byte identical to S1's, so the Pi loop cannot
// tell the backends apart).
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
 * The real egress verbs the guest is NEVER allowed to run. Sandbox output is a
 * DRAFT PR opened HOST-side by the loop's egress step (never from inside the
 * guest). The guest may run `git diff`/`git apply`/`git status` to PRODUCE a
 * patch, but pushing/publishing is a host-only, budget-gated action. `cleo` is
 * denied for completeness (no daemon is reachable from the guest anyway).
 *
 * Each entry is matched against the command's argv-0 basename, plus the
 * two-token forms `git push` / `git remote` so a `git`-rooted egress is caught
 * even though `git`'s OWN basename is allowed (for `git diff` etc.).
 */
export const DENIED_EXEC_PREFIXES: readonly string[] = [
  'gh',
  'npm publish',
  'cleo',
  'git push',
  'git remote',
];

/**
 * Whether `command` (string or argv) is a denied real-egress verb. Deny-first:
 * checked BEFORE the command ever reaches `vm.exec`. Comparison is on the
 * normalized leading tokens (argv-0 basename + a possible second subcommand
 * token), so `git push origin main`, `/usr/bin/gh pr create`, and
 * `npm publish --tag x` are all rejected, while `git diff` / `git status` pass.
 *
 * @param command - The string command or argv array the env received.
 * @returns The matched denied prefix, or `null` when the command is allowed.
 */
export function deniedEgressVerb(command: string | readonly string[]): string | null {
  const tokens = Array.isArray(command)
    ? [...command]
    : String(command)
        .trim()
        .split(/\s+/)
        .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  const base0 = basenameOf(tokens[0] ?? '');
  const base1 = tokens.length > 1 ? basenameOf(tokens[1] ?? '') : '';
  const one = base0;
  const two = base1 ? `${base0} ${base1}` : '';
  for (const denied of DENIED_EXEC_PREFIXES) {
    if (denied === one) return denied;
    if (two !== '' && denied === two) return denied;
  }
  return null;
}

/** POSIX basename of a token (strips any path prefix, e.g. `/usr/bin/gh` → `gh`). */
function basenameOf(token: string): string {
  const slash = token.lastIndexOf('/');
  return slash === -1 ? token : token.slice(slash + 1);
}

// ---------------------------------------------------------------------------
// Loader injection seam (mirrors browser-driver's PlaywrightLoader)
// ---------------------------------------------------------------------------

/**
 * The injectable factory the {@link createGondolinExecutionEnv} uses to obtain
 * the gondolin module. Defaults to the real lazy {@link loadGondolin}; unit
 * tests inject a fake that returns a MOCK module so NO real QEMU VM is launched.
 */
export type GondolinLoader = () => Promise<GondolinModule | null>;

// ---------------------------------------------------------------------------
// Factory options
// ---------------------------------------------------------------------------

/** Construction options for {@link createGondolinExecutionEnv}. */
export interface CreateGondolinExecutionEnvOptions {
  /**
   * The host directory mounted RW at `/workspace` inside the guest. This MUST be
   * a DISPOSABLE seeded copy (e.g. a `VACUUM INTO` snapshot dir) — NEVER a path
   * containing the live `.cleo/tasks.db` / `.cleo/brain.db`. The factory mounts
   * ONLY this directory; live DBs are structurally absent from the guest VFS.
   */
  readonly seededCopyDir: string;
  /**
   * Outbound host allowlist. Defaults to `[]` (DENY ALL) when omitted — the
   * egress footgun guard. The loop appends ONLY the specific hosts it needs
   * (e.g. the model endpoint via the Vault proxy) per run.
   */
  readonly allowedHosts?: readonly string[];
  /**
   * Host-side secret injections. The guest only ever sees each entry's
   * `placeholder`; the real `value` bytes never enter the VM.
   */
  readonly vaultSecrets?: Readonly<Record<string, SecretDefinition>>;
  /** Guest memory bound (e.g. `"1G"`). Defaults to {@link DEFAULT_GUEST_MEMORY}. */
  readonly memory?: string;
  /**
   * Guest environment — the ONLY env the guest sees (host `process.env` is NEVER
   * inherited; that isolation is structural). Defaults to an empty map.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Optional loader override (tests inject a fake → a MOCK VM, no QEMU). Defaults
   * to the real {@link loadGondolin}.
   */
  readonly load?: GondolinLoader;
}

// ---------------------------------------------------------------------------
// GondolinExecutionEnv
// ---------------------------------------------------------------------------

/**
 * A {@link PiExecutionEnv} whose confinement is a gondolin micro-VM. Owns exactly
 * ONE {@link VM} and releases it in {@link cleanup} via `vm.close()`.
 *
 * Every fs op maps to `vm.fs.*`; `exec` maps to `vm.exec`. Each call is wrapped
 * try/catch → {@link PiResult} `err`, so no method ever throws. A thin in-guest
 * deny layer (lexical `/workspace` confinement + the {@link DENIED_EXEC_PREFIXES}
 * command denylist) is the defense-in-depth net BEHIND the VM boundary.
 *
 * Unlike the stateless {@link import('./pi-execution-env.js').GuardedExecutionEnv}
 * (whose `cleanup()` is a no-op), this env OWNS the VM and MUST release it.
 * `cleanup()` is idempotent (guarded by a `#closed` flag).
 */
export class GondolinExecutionEnv implements PiExecutionEnv {
  readonly #vm: VM;
  #closed = false;

  /**
   * @param vm - The booted gondolin VM this env owns. Construct via
   *   {@link createGondolinExecutionEnv}, not directly — the factory wires the
   *   deny-by-default egress hooks + seeded-copy-only mount set.
   */
  constructor(vm: VM) {
    this.#vm = vm;
  }

  // --- pure path arithmetic (no VM round-trip) -----------------------------

  /** The guest workspace root — the in-VM Pi run's working directory. */
  cwd(): string {
    return GONDOLIN_WORKSPACE_ROOT;
  }

  /** Resolve `path` to a guest-absolute path anchored at `/workspace`. */
  absolutePath(path: string): string {
    return posixIsAbsolute(path) ? posixJoin(path) : posixJoin(GONDOLIN_WORKSPACE_ROOT, path);
  }

  /** Join path segments (pure POSIX) anchored at the guest workspace root. */
  joinPath(...segments: string[]): string {
    return posixJoin(GONDOLIN_WORKSPACE_ROOT, ...segments);
  }

  /**
   * Lexically confine a (possibly relative) guest path under `/workspace`. The
   * guest cannot see host paths at all (separate VFS), so there is no
   * symlink-to-host vector to resolve — a lexical check is sufficient here. A
   * `../` climb or an absolute path outside `/workspace` returns `null`.
   *
   * @returns the normalized guest-absolute path, or `null` on an escape.
   */
  #confine(path: string): string | null {
    const abs = posixIsAbsolute(path) ? posixJoin(path) : posixJoin(GONDOLIN_WORKSPACE_ROOT, path);
    if (abs === GONDOLIN_WORKSPACE_ROOT || abs.startsWith(`${GONDOLIN_WORKSPACE_ROOT}/`)) {
      return abs;
    }
    return null;
  }

  // --- file reads ----------------------------------------------------------

  /** Read a file's text from the guest workspace. */
  async readTextFile(path: string): Promise<PiResult<string, PiFileError>> {
    const abs = this.#confine(path);
    if (abs === null) return fsErr('E_PI_FS_DENIED', 'path escapes workspace boundary', path);
    try {
      const content = await this.#vm.fs.readFile(abs, { encoding: 'utf-8' });
      return ok(content);
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
   * Binary read — FILLS S1's v0 denial. The guest VFS supports binary reads
   * directly via `vm.fs.readFile(p)` (returns a `Uint8Array`).
   */
  async readBinaryFile(path: string): Promise<PiResult<Uint8Array, PiFileError>> {
    const abs = this.#confine(path);
    if (abs === null) return fsErr('E_PI_FS_DENIED', 'path escapes workspace boundary', path);
    try {
      const bytes = await this.#vm.fs.readFile(abs);
      return ok(bytes);
    } catch (err) {
      return this.#toFsErr(err, abs);
    }
  }

  // --- file writes ---------------------------------------------------------

  /** Write a file to the guest workspace. */
  async writeFile(path: string, content: string): Promise<PiResult<void, PiFileError>> {
    const abs = this.#confine(path);
    if (abs === null) return fsErr('E_PI_FS_DENIED', 'path escapes workspace boundary', path);
    try {
      await this.#vm.fs.writeFile(abs, content);
      return ok(undefined);
    } catch (err) {
      return this.#toFsErr(err, abs);
    }
  }

  /**
   * Append to a file. The guest fs surface offers only whole-file writes, so this
   * reads-then-writes the concatenation (still confined). A missing file is
   * treated as empty (append-creates).
   */
  async appendFile(path: string, content: string): Promise<PiResult<void, PiFileError>> {
    const abs = this.#confine(path);
    if (abs === null) return fsErr('E_PI_FS_DENIED', 'path escapes workspace boundary', path);
    let prefix = '';
    try {
      prefix = await this.#vm.fs.readFile(abs, { encoding: 'utf-8' });
    } catch (err) {
      // A missing file is the only non-fatal case (append-creates). Any other
      // failure (permission, …) propagates as the Pi error.
      if (!isMissingFileError(err)) return this.#toFsErr(err, abs);
    }
    try {
      await this.#vm.fs.writeFile(abs, prefix + content);
      return ok(undefined);
    } catch (err) {
      return this.#toFsErr(err, abs);
    }
  }

  // --- metadata ------------------------------------------------------------

  /** Report whether a guest path is a file or directory. */
  async fileInfo(path: string): Promise<PiResult<PiFileInfo, PiFileError>> {
    const abs = this.#confine(path);
    if (abs === null) return fsErr('E_PI_FS_DENIED', 'path escapes workspace boundary', path);
    try {
      const stat = await this.#vm.fs.stat(abs);
      return ok({ isFile: stat.isFile(), isDirectory: stat.isDirectory() });
    } catch (err) {
      return this.#toFsErr(err, abs);
    }
  }

  /** Whether a guest path exists. */
  async exists(path: string): Promise<PiResult<boolean, PiFileError>> {
    const abs = this.#confine(path);
    if (abs === null) return fsErr('E_PI_FS_DENIED', 'path escapes workspace boundary', path);
    try {
      await this.#vm.fs.access(abs);
      return ok(true);
    } catch {
      // `access` rejects for a missing path — that is a definitive "does not
      // exist", NOT an error to surface. (A denied path was already rejected
      // above by `#confine`.)
      return ok(false);
    }
  }

  /**
   * Canonicalize a guest path via `realpath` inside the guest. Runs the binary in
   * ARRAY form (no `$PATH` / shell expansion) so the path argument cannot be
   * reinterpreted as shell.
   */
  async canonicalPath(path: string): Promise<PiResult<string, PiFileError>> {
    const abs = this.#confine(path);
    if (abs === null) return fsErr('E_PI_FS_DENIED', 'path escapes workspace boundary', path);
    try {
      const res = await this.#vm.exec(['/bin/realpath', abs]);
      const resolved = res.stdout.trim();
      if (res.exitCode !== 0 || resolved === '') {
        return fsErr('E_PI_FS_FAILED', res.stderr.trim() || 'realpath failed', abs);
      }
      return ok(resolved);
    } catch (err) {
      return this.#toFsErr(err, abs);
    }
  }

  // --- fs-mutating / listing ops (FILL S1's v0 denials) --------------------

  /** List a guest directory — FILLS S1's v0 denial. */
  async listDir(path: string): Promise<PiResult<string[], PiFileError>> {
    const abs = this.#confine(path);
    if (abs === null) return fsErr('E_PI_FS_DENIED', 'path escapes workspace boundary', path);
    try {
      const entries = await this.#vm.fs.listDir(abs);
      return ok(entries);
    } catch (err) {
      return this.#toFsErr(err, abs);
    }
  }

  /** Create a guest directory (recursive) — FILLS S1's v0 denial. */
  async createDir(path: string): Promise<PiResult<void, PiFileError>> {
    const abs = this.#confine(path);
    if (abs === null) return fsErr('E_PI_FS_DENIED', 'path escapes workspace boundary', path);
    try {
      await this.#vm.fs.mkdir(abs, { recursive: true });
      return ok(undefined);
    } catch (err) {
      return this.#toFsErr(err, abs);
    }
  }

  /** Remove a guest path (recursive, force) — FILLS S1's v0 denial. */
  async remove(path: string): Promise<PiResult<void, PiFileError>> {
    const abs = this.#confine(path);
    if (abs === null) return fsErr('E_PI_FS_DENIED', 'path escapes workspace boundary', path);
    try {
      await this.#vm.fs.deleteFile(abs, { recursive: true, force: true });
      return ok(undefined);
    } catch (err) {
      return this.#toFsErr(err, abs);
    }
  }

  /**
   * Create a temp directory under `/workspace/.tmp` — FILLS S1's v0 denial. Runs
   * `mktemp -d` in ARRAY form (no `$PATH` / shell expansion).
   */
  async createTempDir(prefix?: string): Promise<PiResult<string, PiFileError>> {
    return this.#mktemp(['-d'], prefix);
  }

  /**
   * Create a temp file under `/workspace/.tmp` — FILLS S1's v0 denial. Runs
   * `mktemp` in ARRAY form (no `$PATH` / shell expansion).
   */
  async createTempFile(prefix?: string): Promise<PiResult<string, PiFileError>> {
    return this.#mktemp([], prefix);
  }

  /**
   * Shared `mktemp` helper for {@link createTempDir} / {@link createTempFile}.
   * The template lives UNDER the `/workspace` mount, so the created path is
   * inside the only writable location and is confined by construction.
   */
  async #mktemp(flags: readonly string[], prefix?: string): Promise<PiResult<string, PiFileError>> {
    const safePrefix = (prefix ?? 'pi-').replace(/[^A-Za-z0-9._-]/g, '');
    const template = `${GONDOLIN_TMP_DIR}/${safePrefix}XXXXXX`;
    try {
      // Ensure the parent .tmp dir exists (idempotent) before mktemp runs.
      await this.#vm.fs.mkdir(GONDOLIN_TMP_DIR, { recursive: true });
      const res = await this.#vm.exec(['/bin/mktemp', ...flags, template]);
      const created = res.stdout.trim();
      if (res.exitCode !== 0 || created === '') {
        return fsErr('E_PI_FS_FAILED', res.stderr.trim() || 'mktemp failed', template);
      }
      return ok(created);
    } catch (err) {
      return this.#toFsErr(err, template);
    }
  }

  // --- shell ---------------------------------------------------------------

  /**
   * Execute a command in the guest via `vm.exec`. Deny-first: a real-egress verb
   * ({@link DENIED_EXEC_PREFIXES} — `gh` / `git push` / `npm publish` / `cleo` /
   * `git remote`) is rejected BEFORE reaching the VM, even though the VM itself
   * has no egress (the network namespace is deny-by-default). `cwd` is confined
   * to the workspace; the host `AbortSignal` is forwarded only when supplied.
   *
   * ## exitCode mapping
   *
   * gondolin's `ExecResult.exitCode` is `number` (NON-nullable) with a SEPARATE
   * optional `signal` field; Pi's `PiExecResult.exitCode` is `number | null`
   * ("null when killed by signal"). So a signal-kill is mapped to `null`, NOT
   * the raw `exitCode`.
   */
  async exec(
    command: string,
    options?: PiExecOptions,
  ): Promise<PiResult<PiExecResult, PiExecutionError>> {
    const denied = deniedEgressVerb(command);
    if (denied !== null) {
      return execErr('E_PI_EXEC_DENIED', `egress verb "${denied}" is denied inside the sandbox`);
    }
    const cwd = options?.cwd !== undefined ? this.#confine(options.cwd) : GONDOLIN_WORKSPACE_ROOT;
    if (cwd === null) {
      return execErr('E_PI_EXEC_DENIED', 'cwd escapes workspace boundary');
    }
    const execOptions: GondolinExecOptions = {
      cwd,
      ...(options?.env !== undefined ? { env: options.env } : {}),
      ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
    };
    try {
      const res: GondolinExecResult = await this.#vm.exec(command, execOptions);
      const exitCode = res.signal !== undefined ? null : res.exitCode;
      return ok({ stdout: res.stdout, stderr: res.stderr, exitCode });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return execErr('E_PI_EXEC_FAILED', message);
    }
  }

  // --- cleanup (idempotent — owns the VM) ----------------------------------

  /**
   * Tear down the owned VM (`vm.close()`). Idempotent: a second call is a no-op.
   * Best-effort and never throws (a close failure is logged, not propagated) so
   * the Pi contract — `cleanup()` must not throw — holds.
   */
  async cleanup(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#vm.close();
    } catch (err) {
      log.debug({ err }, 'gondolin VM close failed during cleanup (ignored)');
    }
  }

  // --- error mapping -------------------------------------------------------

  /** Convert a thrown error from a `vm.fs.*` call into a Pi `Result.err`. */
  #toFsErr(err: unknown, path: string): PiResult<never, PiFileError> {
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code?: unknown }).code)
        : 'E_PI_FS_FAILED';
    const message = err instanceof Error ? err.message : String(err);
    return fsErr(code, message, path);
  }
}

/**
 * Whether `err` is a "file does not exist" failure (`ENOENT`). Used by
 * {@link GondolinExecutionEnv.appendFile} to treat append-to-missing as
 * append-creates while still propagating every OTHER failure.
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
// Factory
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link createGondolinExecutionEnv} when the optional
 * `@earendil-works/gondolin` package (or its QEMU/KVM host infra) is not
 * available, so a VM cannot be booted. Callers that want graceful degradation
 * should check `isGondolinAvailable()` first (the selector
 * {@link import('./resolve-execution-env.js')} does this) and fall back to the
 * in-process {@link import('./pi-execution-env.js').GuardedExecutionEnv}.
 */
export class GondolinUnavailableError extends Error {
  /** Machine-readable code. */
  readonly code = 'E_GONDOLIN_UNAVAILABLE';
  constructor(message: string) {
    super(message);
    this.name = 'GondolinUnavailableError';
  }
}

/**
 * Boot a gondolin micro-VM and wrap it in a {@link GondolinExecutionEnv}.
 *
 * The VM is configured for ZERO host authority:
 * - **mount set** = ONLY `{ '/workspace': new RealFSProvider(seededCopyDir) }`.
 *   The disposable seeded copy is the single RW mount; live `tasks.db`/`brain.db`
 *   are structurally absent from the guest VFS (T5158 impossible in-VM).
 * - **egress** = `createHttpHooks({ allowedHosts, secrets })` with `allowedHosts`
 *   defaulting to `[]` (DENY ALL — the footgun guard) and host-side secret
 *   PLACEHOLDERS (the guest never sees real token bytes).
 * - **env** = ONLY `opts.env` (host `process.env` is NEVER inherited).
 * - **memory** = `opts.memory` (default `"1G"`), set EXPLICITLY.
 *
 * Import-time side-effect-free: the gondolin module is loaded lazily HERE (not at
 * module top-level) via the injectable {@link GondolinLoader} (tests pass a fake
 * → a MOCK VM, so NO real QEMU boots).
 *
 * @param opts - The seeded-copy mount dir + egress allowlist/secrets + guest env.
 * @returns A {@link PiExecutionEnv} backed by the booted VM.
 * @throws {GondolinUnavailableError} When the optional package cannot be loaded.
 *
 * @example
 * ```ts
 * const env = await createGondolinExecutionEnv({ seededCopyDir: snapshotDir });
 * // ... drive Pi's loop over `env` ...
 * await env.cleanup(); // releases the VM
 * ```
 */
export async function createGondolinExecutionEnv(
  opts: CreateGondolinExecutionEnvOptions,
): Promise<PiExecutionEnv> {
  const load = opts.load ?? loadGondolin;
  const mod = await load();
  if (mod === null) {
    throw new GondolinUnavailableError(
      'gondolin is not available (package absent or host infra missing); ' +
        'check isGondolinAvailable() and fall back to the in-process GuardedExecutionEnv',
    );
  }

  // The ONLY RW mount is the disposable seeded copy at /workspace. Live DBs are
  // structurally absent — there is no live handle inside the VM to corrupt.
  const mounts: Record<string, RealFSProviderInstance> = {
    [GONDOLIN_WORKSPACE_ROOT]: new mod.RealFSProvider(opts.seededCopyDir),
  };

  // Egress deny-by-default: `allowedHosts` MUST be PRESENT-and-empty `[]` (the
  // footgun — OMITTING it = allow-all per the gondolin docs). The loop appends
  // specific hosts per run; secret bytes are injected host-side (guest sees only
  // each `placeholder`).
  const createHooks: CreateHttpHooks = mod.createHttpHooks;
  const httpHooks = createHooks({
    allowedHosts: opts.allowedHosts ?? [],
    ...(opts.vaultSecrets !== undefined ? { secrets: opts.vaultSecrets } : {}),
  });

  const vm = await mod.VM.create({
    memory: opts.memory ?? DEFAULT_GUEST_MEMORY,
    env: opts.env ?? {},
    vfs: { mounts },
    httpHooks,
  });

  return new GondolinExecutionEnv(vm);
}
