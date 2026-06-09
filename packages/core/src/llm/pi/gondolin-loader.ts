/**
 * Gondolin micro-VM sandbox — the OPTIONAL, lazily-loaded execution backend
 * (T11908 · T11888-A · P5 Gondolin · epic T11599).
 *
 * The {@link import('./pi-execution-env.js').PiExecutionEnv} seam gains a SECOND
 * implementation (`GondolinExecutionEnv`, T11888-B) whose confinement is a real
 * micro-VM boundary instead of the in-process deny-first guard. The VM backend is
 * powered by `@earendil-works/gondolin`, which is an OPTIONAL dependency
 * (dependency-discipline · D11142): it is NEVER a hard dependency of
 * `@cleocode/core`. Exactly like `playwright` (see {@link ../../tools/browser-driver.js})
 * and `node-pty` (see {@link ../../tools/pty.js}), it is deliberately NOT declared
 * in `core`'s `dependencies` / `optionalDependencies` and is loaded ONLY via a
 * dynamic `import()` whose specifier is held in a variable — so neither the
 * bundler nor TS treats the missing package as a hard, statically-resolved
 * dependency, the published `@cleocode/core` carries no Gondolin / QEMU weight,
 * and `core` builds + non-sandbox tests pass with Gondolin NOT installed.
 *
 * An environment that wants the sandbox opts in by installing the package itself
 * (`pnpm add @earendil-works/gondolin`) AND providing the host infra (QEMU +
 * `/dev/kvm`). Availability is the AND of all three — package present, `/dev/kvm`
 * present, and a working `qemu-system-x86_64` — so a box with the package but no
 * KVM still reports UNAVAILABLE and the selector ({@link ./resolve-execution-env.js},
 * T11888-C) silently degrades to the in-process `GuardedExecutionEnv` rather than
 * erroring.
 *
 * Import-time side-effect-free: NO top-level `@earendil-works/gondolin` import; the
 * VM is booted lazily on the first `resolveExecutionEnv`. When Gondolin is absent,
 * {@link loadGondolin} resolves `null` and {@link isGondolinAvailable} resolves
 * `false` — nothing throws at import.
 *
 * The structural shapes of the consumed Gondolin surface are declared LOCALLY in
 * this file (`VM`, `VMOptions`, `VmFs`, `ExecResult`, `RealFSProvider`,
 * `createHttpHooks`); there is NO `import type` from the optional package, so the
 * type-check passes with the package uninstalled.
 *
 * @epic T11599
 * @task T11908
 * @see ../../tools/browser-driver.js — the analogous optional-dep (Playwright) lazy-load pattern
 * @see ./pi-execution-env.js — the `PiExecutionEnv` seam this backend implements
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { getLogger } from '../../logger.js';

const log = getLogger('pi-gondolin');

/**
 * The npm install hint surfaced to the model / caller when the sandbox backend is
 * unavailable because `@earendil-works/gondolin` (or its QEMU/KVM host infra) is
 * not present. Gondolin is an OPTIONAL dep — the selector degrades to the
 * in-process `GuardedExecutionEnv` regardless, but reports the sandbox
 * UNAVAILABLE until this is satisfied.
 */
export const GONDOLIN_INSTALL_HINT =
  'Sandbox execution requires the optional "@earendil-works/gondolin" package + QEMU/KVM. ' +
  'Install with `pnpm add @earendil-works/gondolin` (boots a ~200MB Alpine guest on first run), ' +
  'and ensure `/dev/kvm` plus a working `qemu-system-x86_64` are available on the host.';

// ---------------------------------------------------------------------------
// Minimal structural shapes of the Gondolin surface we consume.
//
// Declared LOCALLY so this file carries NO type dependency on the optional
// package — the dynamic import is shape-checked against these, not against the
// package's own `.d.ts`. Only the members the sandbox backend (T11888-B) actually
// uses are modelled; everything is `readonly` and narrow. There is NO
// `import type` from `@earendil-works/gondolin` anywhere in `core`.
// ---------------------------------------------------------------------------

/**
 * A buffered result of `vm.exec` (gondolin `exec.d.ts` `ExecResult`).
 *
 * `exitCode` is NON-nullable here (a `number`); a SEPARATE optional `signal`
 * field is set when the process was killed by a signal. The Pi adapter
 * (T11888-B) maps this to Pi's `exitCode: number | null` by emitting `null`
 * whenever `signal` is present.
 */
export interface ExecResult {
  /** Captured standard output. */
  readonly stdout: string;
  /** Captured standard error. */
  readonly stderr: string;
  /** Process exit code (always a number; `signal` distinguishes signal-kills). */
  readonly exitCode: number;
  /** The terminating signal number, when the process was killed by a signal. */
  readonly signal?: number;
}

/** Options for a single `vm.exec` invocation. */
export interface ExecOptions {
  /** Working directory inside the guest. */
  readonly cwd?: string;
  /** Extra guest environment variables. */
  readonly env?: Readonly<Record<string, string>>;
  /** Host abort signal — cancels the in-flight guest process. */
  readonly signal?: AbortSignal;
  /** Hard timeout in milliseconds. */
  readonly timeout?: number;
}

/** Metadata returned by `vm.fs.stat`. */
export interface VmStat {
  /** Whether the entry is a regular file. */
  isFile(): boolean;
  /** Whether the entry is a directory. */
  isDirectory(): boolean;
}

/**
 * The guest filesystem surface (`vm.fs`). Only the members the sandbox backend
 * consumes are modelled. All paths are guest-absolute under the single
 * `/workspace` RW mount.
 */
export interface VmFs {
  readFile(path: string, options: { readonly encoding: 'utf-8' }): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string): Promise<void>;
  stat(path: string): Promise<VmStat>;
  listDir(path: string): Promise<string[]>;
  access(path: string): Promise<void>;
  mkdir(path: string, options: { readonly recursive: boolean }): Promise<void>;
  deleteFile(
    path: string,
    options: { readonly recursive: boolean; readonly force: boolean },
  ): Promise<void>;
}

/**
 * A running micro-VM handle (gondolin `vm.d.ts` `VM`). The sandbox backend owns
 * exactly one of these per run and releases it in `cleanup()` via `close()`.
 */
export interface VM {
  /** The guest filesystem surface. */
  readonly fs: VmFs;
  /**
   * Run a command in the guest. STRING form runs via `/bin/sh -lc`; ARRAY form
   * runs the argv directly with no `$PATH` / shell expansion. The returned value
   * `implements PromiseLike<ExecResult>`, so `await vm.exec(...)` resolves the
   * buffered result.
   */
  exec(command: string | readonly string[], options?: ExecOptions): PromiseLike<ExecResult>;
  /** Tear down the VM and release its host resources (idempotent host-side guard recommended). */
  close(): Promise<void>;
}

/**
 * A single readable+writable secret the egress proxy injects HOST-side. The guest
 * only ever sees `placeholder` — never the real `value` bytes.
 */
export interface SecretDefinition {
  /** Hosts the secret may be sent to. */
  readonly hosts: readonly string[];
  /** The real secret bytes — injected host-side, NEVER visible to the guest. */
  readonly value: string;
  /** The opaque token the guest sees in place of `value`. */
  readonly placeholder: string;
}

/**
 * Options for {@link CreateHttpHooks}. Per the gondolin docs, `allowedHosts`
 * OMITTED = allow-all; `allowedHosts: []` (present-and-empty) = deny-all. The
 * backend MUST pass it present-and-empty by default (the egress-deny footgun).
 */
export interface CreateHttpHooksOptions {
  /** Outbound host allowlist. Present-and-empty `[]` = deny all; omitted = allow all. */
  readonly allowedHosts: readonly string[];
  /** Host-side secret injection (guest sees only `placeholder`). */
  readonly secrets?: Readonly<Record<string, SecretDefinition>>;
}

/** Opaque HTTP-hook handle wired into a VM's network namespace via {@link VMOptions}. */
export interface HttpHooks {
  readonly __httpHooks: true;
}

/** The `createHttpHooks` factory — allowlists egress + injects credential placeholders. */
export type CreateHttpHooks = (options: CreateHttpHooksOptions) => HttpHooks;

/**
 * A read/write filesystem provider rooted at a host directory, mounted into the
 * guest VFS (gondolin `fs/real.d.ts` `RealFSProvider`). The sandbox backend
 * mounts ONLY a disposable seeded-copy directory at `/workspace`; live
 * `tasks.db`/`brain.db` are NEVER in the mount set.
 */
export interface RealFSProviderInstance {
  readonly __realFsProvider: true;
}

/** The `RealFSProvider` constructor surface. */
export interface RealFSProvider {
  new (hostRootDir: string): RealFSProviderInstance;
}

/**
 * Options for {@link VMConstructor.create}. The guest's environment is ONLY
 * `env` (host `process.env` is NEVER inherited — that isolation is structural);
 * `memory` bounds the guest in-process (default `"1G"`, set explicitly).
 */
export interface VMOptions {
  /** Guest memory bound (e.g. `"1G"`). Set explicitly — never rely on the default. */
  readonly memory?: string;
  /** Guest environment — the ONLY env the guest sees (no host `process.env` inheritance). */
  readonly env?: Readonly<Record<string, string>>;
  /** VFS mount set — guest path → host FS provider. Live DBs never appear here. */
  readonly vfs?: {
    readonly mounts: Readonly<Record<string, RealFSProviderInstance>>;
  };
  /** Network egress hooks (allowlist + credential injection). */
  readonly httpHooks?: HttpHooks;
}

/** The `VM` constructor / factory surface (`VM.create`). */
export interface VMConstructor {
  create(options?: VMOptions): Promise<VM>;
}

/**
 * The minimal shape of the `@earendil-works/gondolin` module we depend on. Only
 * the three named exports the sandbox backend consumes are modelled.
 */
export interface GondolinModule {
  readonly VM: VMConstructor;
  readonly RealFSProvider: RealFSProvider;
  readonly createHttpHooks: CreateHttpHooks;
}

// ---------------------------------------------------------------------------
// Injectable seams — overridable ONLY by the unit tests so a mocked import() /
// host probe can deterministically simulate "package absent" and "no /dev/kvm"
// WITHOUT touching the module graph or launching a real QEMU VM. In production
// these resolve to the real dynamic import + host probes.
// ---------------------------------------------------------------------------

/** The npm specifier — held in a VARIABLE so it is never statically resolved. */
const GONDOLIN_SPECIFIER = '@earendil-works/gondolin';

/** A pluggable dynamic-importer (test seam). Defaults to the real `import()`. */
type DynamicImporter = (specifier: string) => Promise<unknown>;

/** A pluggable host probe (test seam) for `/dev/kvm` presence + a working QEMU. */
interface GondolinHostProbes {
  /** Whether `/dev/kvm` exists on the host. */
  readonly hasKvm: () => boolean;
  /** Whether a working `qemu-system-x86_64` is on `PATH`. */
  readonly hasQemu: () => boolean;
}

/**
 * The real dynamic importer. The specifier is passed as an argument (held in a
 * variable at the call site) so the bundler / TS never treats the optional
 * package as a hard dependency.
 */
const realImporter: DynamicImporter = (specifier) => import(specifier);

/** `true` when `/dev/kvm` exists — KVM acceleration is available on the host. */
function realHasKvm(): boolean {
  try {
    return existsSync('/dev/kvm');
  } catch {
    return false;
  }
}

/** `true` when `qemu-system-x86_64 --version` runs successfully (cheap probe). */
function realHasQemu(): boolean {
  try {
    execFileSync('qemu-system-x86_64', ['--version'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/** The active importer (swapped only by {@link __setGondolinTestHooks}). */
let importer: DynamicImporter = realImporter;
/** The active host probes (swapped only by {@link __setGondolinTestHooks}). */
let hostProbes: GondolinHostProbes = { hasKvm: realHasKvm, hasQemu: realHasQemu };

/**
 * Structurally validate a dynamically-imported candidate against the three
 * Gondolin exports the backend consumes. Returns the typed module on a match,
 * else `null` — so a shape-incompatible package version reports unavailable
 * rather than crashing later at VM-boot time.
 */
function shapeCheck(candidate: unknown): GondolinModule | null {
  if (candidate === null || typeof candidate !== 'object') return null;
  const mod = candidate as {
    VM?: unknown;
    RealFSProvider?: unknown;
    createHttpHooks?: unknown;
  };
  const vmOk =
    typeof mod.VM === 'object' &&
    mod.VM !== null &&
    typeof (mod.VM as { create?: unknown }).create === 'function';
  const realFsOk = typeof mod.RealFSProvider === 'function';
  const hooksOk = typeof mod.createHttpHooks === 'function';
  if (vmOk && realFsOk && hooksOk) {
    return candidate as GondolinModule;
  }
  return null;
}

/**
 * Attempt to lazily load `@earendil-works/gondolin`. Returns `null` when the
 * optional dep is not installed, fails to load, OR does not expose the expected
 * `VM` / `RealFSProvider` / `createHttpHooks` surface — so callers can report the
 * sandbox unavailable rather than crashing. NEVER throws.
 *
 * The import specifier is held in a variable (passed to the {@link importer}
 * seam) so bundlers / TS do not treat the missing optional dep as a hard,
 * statically-resolved dependency (same technique as
 * {@link ../../tools/browser-driver.js}'s Playwright load).
 *
 * @returns The shape-checked module, or `null` when unavailable.
 */
export async function loadGondolin(): Promise<GondolinModule | null> {
  try {
    const mod: unknown = await importer(GONDOLIN_SPECIFIER);
    const candidate = (mod as { default?: unknown }).default ?? mod;
    return shapeCheck(candidate);
  } catch (err) {
    log.debug({ err }, 'gondolin not loadable — sandbox execution unavailable');
    return null;
  }
}

/**
 * Whether the Gondolin sandbox backend can run in this process. The AND of three
 * conditions:
 *
 * 1. the `@earendil-works/gondolin` package loads ({@link loadGondolin} is non-`null`),
 * 2. `/dev/kvm` exists (KVM acceleration is present),
 * 3. a working `qemu-system-x86_64` is on `PATH`.
 *
 * A box with the package but no KVM still reports `false` so the selector
 * ({@link ./resolve-execution-env.js}) degrades to the in-process
 * `GuardedExecutionEnv` — it NEVER errors. The result is cached after the first
 * probe so availability checks stay cheap; {@link __resetGondolinAvailabilityCache}
 * clears it (tests only).
 *
 * @returns `true` only when package + `/dev/kvm` + QEMU are all present.
 */
let cachedAvailable: boolean | undefined;
export async function isGondolinAvailable(): Promise<boolean> {
  if (cachedAvailable !== undefined) return cachedAvailable;
  const pkgPresent = (await loadGondolin()) !== null;
  cachedAvailable = pkgPresent && hostProbes.hasKvm() && hostProbes.hasQemu();
  return cachedAvailable;
}

/**
 * Reset the cached Gondolin-availability probe.
 *
 * EXPORTED FOR TESTS ONLY — lets a unit test toggle the mocked availability of
 * the optional dep + host probes between cases without a fresh module graph.
 *
 * @internal
 */
export function __resetGondolinAvailabilityCache(): void {
  cachedAvailable = undefined;
}

/**
 * Override the dynamic-importer and/or host probes, and reset the availability
 * cache.
 *
 * EXPORTED FOR TESTS ONLY — lets a unit test simulate "package absent" (importer
 * rejects), "package present" (importer resolves a mock module), and "no
 * `/dev/kvm`" / "no QEMU" deterministically, WITHOUT touching the module graph or
 * launching a real QEMU VM. Pass `undefined` for a field to leave it at the real
 * default; call with no arguments to restore the real importer + probes.
 *
 * @param hooks - Partial overrides for the importer and host probes.
 * @internal
 */
export function __setGondolinTestHooks(hooks?: {
  importer?: DynamicImporter;
  hasKvm?: () => boolean;
  hasQemu?: () => boolean;
}): void {
  importer = hooks?.importer ?? realImporter;
  hostProbes = {
    hasKvm: hooks?.hasKvm ?? realHasKvm,
    hasQemu: hooks?.hasQemu ?? realHasQemu,
  };
  cachedAvailable = undefined;
}
