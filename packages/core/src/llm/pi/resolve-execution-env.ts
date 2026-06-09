/**
 * Per-run {@link PiExecutionEnv} selector + CI process-isolation fallback
 * (T11910 · T11888-C · P5 Gondolin · epic T11599).
 *
 * The self-improvement loop wants ONE swap point that picks the strongest
 * available confinement backend for a run and SILENTLY DEGRADES when the stronger
 * one is unavailable — never erroring, never coupling the caller to whether a VM
 * booted. That is this module:
 *
 * - When `backend: 'gondolin'` is requested AND the Gondolin sandbox is available
 *   (the optional `@earendil-works/gondolin` package loads AND `/dev/kvm` exists
 *   AND a working `qemu-system-x86_64` is on `PATH` — the AND-gate of
 *   {@link import('./gondolin-loader.js').isGondolinAvailable}), the selector boots
 *   a micro-VM-backed {@link import('./pi-gondolin-env.js').GondolinExecutionEnv}
 *   (confinement = the VM boundary itself; guest has ZERO host authority).
 * - OTHERWISE — `backend: 'in-process'`, OR `'gondolin'` requested on a box where
 *   the package / `/dev/kvm` / QEMU is absent (the CI + most-developer-machines
 *   case) — it returns the always-available in-process deny-first
 *   {@link import('./pi-execution-env.js').GuardedExecutionEnv} (`ToolGuard` +
 *   workspace boundary). The loop runs IDENTICALLY over either backend (the
 *   `PiExecutionEnv` contract is byte-for-byte identical), just without VM
 *   isolation in the fallback.
 *
 * So in CI — gondolin uninstalled AND `/dev/kvm`/QEMU usually absent —
 * `isGondolinAvailable()` is `false`, the selector returns the in-process env, and
 * the suite stays green with ZERO VM infra. The degradation is structural: a box
 * that requested the VM but lacks the infra gets the guarded fallback, not an
 * error.
 *
 * Optional-dep discipline (D11142): this module imports ONLY sibling Pi modules
 * (`./gondolin-loader.js`, `./pi-gondolin-env.js`, `./pi-execution-env.js`). It has
 * NO `import type` from `@earendil-works/gondolin` — the gondolin package is loaded
 * lazily (and ONLY when chosen) inside `createGondolinExecutionEnv`. `core` builds
 * + all non-gondolin tests pass with gondolin ABSENT, and this module is
 * import-time side-effect-free (no top-level VM boot, no host probe).
 *
 * Scope (T11888-C): this is the SELECTOR ONLY. It does NOT wire the
 * `pi-agent-adapter.ts` env seam (a separate follow-up) — it is the single
 * function the loop calls to obtain a per-run env.
 *
 * @epic T11599
 * @task T11910
 * @see ./gondolin-loader.js — the optional-dep availability probe (`isGondolinAvailable`)
 * @see ./pi-gondolin-env.js — the VM-backed backend booted when available
 * @see ./pi-execution-env.js — the in-process `GuardedExecutionEnv` fallback
 */

import type { ToolGuard } from '../../tools/guard.js';
import { isGondolinAvailable as realIsGondolinAvailable } from './gondolin-loader.js';
import { createGuardedExecutionEnv, type PiExecutionEnv } from './pi-execution-env.js';
import {
  type CreateGondolinExecutionEnvOptions,
  createGondolinExecutionEnv as realCreateGondolinExecutionEnv,
} from './pi-gondolin-env.js';

/**
 * Which confinement backend a run REQUESTS. `'gondolin'` is a PREFERENCE, not a
 * guarantee — when the VM infra is absent the selector degrades to `'in-process'`
 * (the guarded fallback). `'in-process'` always resolves to the in-process
 * {@link import('./pi-execution-env.js').GuardedExecutionEnv} (no VM probe at all).
 */
export type ExecutionEnvBackend = 'gondolin' | 'in-process';

/**
 * Options for {@link resolveExecutionEnv}. The `guard` + `workspaceRoot` pair is
 * ALWAYS required because they back the in-process fallback (the guarded env that
 * runs when the VM is unavailable or not requested). The VM-only fields
 * (`seededCopyDir`, `allowedHosts`, `vaultSecrets`, `memory`, `env`) are consumed
 * ONLY when a Gondolin VM is actually booted.
 */
export interface ResolveExecutionEnvOptions {
  /**
   * The confinement backend this run PREFERS. `'gondolin'` boots a micro-VM when
   * available and degrades to the guarded env otherwise; `'in-process'` always
   * resolves to the guarded env.
   */
  readonly backend: ExecutionEnvBackend;
  /**
   * The deny-first guard surface backing the in-process fallback. REQUIRED even
   * when `backend: 'gondolin'` — it is what the selector returns when the VM is
   * unavailable. Must be an `enforce`-mode guard (the fallback factory asserts it).
   */
  readonly guard: ToolGuard;
  /**
   * The absolute workspace root the in-process fallback confines every fs path
   * under. Used ONLY by the guarded fallback (the VM confines to its own
   * `/workspace` mount).
   */
  readonly workspaceRoot: string;
  /**
   * The disposable seeded-copy host directory mounted RW at `/workspace` inside
   * the guest. REQUIRED when a VM is actually booted (`backend: 'gondolin'` AND
   * available); MUST be a `VACUUM INTO` snapshot dir, NEVER a path containing the
   * live `.cleo/tasks.db` / `.cleo/brain.db`. Ignored by the fallback.
   */
  readonly seededCopyDir?: string;
  /**
   * Outbound host allowlist forwarded to the VM's egress hooks. Defaults to `[]`
   * (DENY ALL) inside the VM factory when omitted. Ignored by the fallback.
   */
  readonly allowedHosts?: readonly string[];
  /**
   * Host-side secret injections for the VM's egress proxy (the guest only ever
   * sees each entry's `placeholder`). Ignored by the fallback.
   */
  readonly vaultSecrets?: CreateGondolinExecutionEnvOptions['vaultSecrets'];
  /**
   * Guest memory bound (e.g. `"1G"`) for a booted VM. Defaults inside the VM
   * factory. Ignored by the fallback.
   */
  readonly memory?: string;
  /**
   * Guest environment — the ONLY env a booted VM's guest sees (host `process.env`
   * is NEVER inherited). Ignored by the fallback.
   */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Injectable seams for {@link resolveExecutionEnv}.
 *
 * EXPORTED FOR TESTS ONLY — lets the selector matrix test simulate
 * "VM requested + available" (a mocked `isAvailable` returning `true` + a mocked
 * `createGondolin` returning a fake env) and "VM requested + unavailable"
 * (`isAvailable` returning `false`) WITHOUT touching the module graph or launching
 * a real QEMU VM. In production both default to the real loader probe + the real
 * VM factory.
 *
 * @internal
 */
export interface ResolveExecutionEnvSeams {
  /**
   * The availability probe. Defaults to the real
   * {@link import('./gondolin-loader.js').isGondolinAvailable} (package + `/dev/kvm`
   * + QEMU AND-gate).
   */
  readonly isAvailable?: () => Promise<boolean>;
  /**
   * The VM-backed env factory. Defaults to the real
   * {@link import('./pi-gondolin-env.js').createGondolinExecutionEnv}.
   */
  readonly createGondolin?: (opts: CreateGondolinExecutionEnvOptions) => Promise<PiExecutionEnv>;
}

/**
 * Thrown by {@link resolveExecutionEnv} when `backend: 'gondolin'` is requested,
 * the VM is reported available, but no {@link ResolveExecutionEnvOptions.seededCopyDir}
 * was supplied — a VM cannot boot without a disposable seeded-copy mount, and
 * silently degrading to the in-process fallback here would HIDE a caller bug
 * (the caller asked for the VM and the infra IS present). This is the ONE
 * non-degrading failure: it signals a misconfiguration, not missing infra.
 */
export class ExecutionEnvConfigError extends Error {
  /** Machine-readable code. */
  readonly code = 'E_EXECUTION_ENV_CONFIG';
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionEnvConfigError';
  }
}

/**
 * Resolve the {@link PiExecutionEnv} a single self-improvement run should use,
 * preferring the Gondolin micro-VM when requested AND available and SILENTLY
 * DEGRADING to the in-process {@link import('./pi-execution-env.js').GuardedExecutionEnv}
 * otherwise.
 *
 * Selection matrix:
 *
 * | `backend`      | VM available? | Result                                  |
 * |----------------|---------------|-----------------------------------------|
 * | `'gondolin'`   | yes           | `createGondolinExecutionEnv` (micro-VM) |
 * | `'gondolin'`   | no            | `createGuardedExecutionEnv` (degrade)   |
 * | `'in-process'` | (not probed)  | `createGuardedExecutionEnv`             |
 *
 * The availability check (`package + /dev/kvm + QEMU`) is performed ONLY when
 * `backend === 'gondolin'`, so an `'in-process'` request never probes the host or
 * touches the optional package. Degradation NEVER throws — the one exception is a
 * misconfiguration (`gondolin` requested + available but no `seededCopyDir`), which
 * is a caller bug surfaced as {@link ExecutionEnvConfigError} rather than a hidden
 * fallback.
 *
 * @param opts - The backend preference + the always-required guard/workspaceRoot
 *   fallback inputs + the VM-only mount/egress inputs.
 * @param seams - Test-only overrides for the availability probe + VM factory
 *   (defaults are the real loader probe + the real VM factory). Production callers
 *   pass nothing.
 * @returns A {@link PiExecutionEnv} — VM-backed when the sandbox booted, in-process
 *   guarded otherwise. The loop cannot tell the backends apart.
 * @throws {ExecutionEnvConfigError} When the VM is requested AND available but no
 *   `seededCopyDir` was supplied.
 *
 * @example
 * ```ts
 * // Prefer the VM; degrades to the guarded env in CI (no /dev/kvm / QEMU).
 * const env = await resolveExecutionEnv({
 *   backend: 'gondolin',
 *   guard,                       // enforce-mode ToolGuard (the fallback)
 *   workspaceRoot: projectRoot,  // the fallback's confinement root
 *   seededCopyDir: snapshotDir,  // the VM's only RW mount (disposable copy)
 * });
 * // ... drive Pi's loop over `env` ...
 * await env.cleanup();
 * ```
 */
export async function resolveExecutionEnv(
  opts: ResolveExecutionEnvOptions,
  seams: ResolveExecutionEnvSeams = {},
): Promise<PiExecutionEnv> {
  const isAvailable = seams.isAvailable ?? realIsGondolinAvailable;
  const createGondolin = seams.createGondolin ?? realCreateGondolinExecutionEnv;

  if (opts.backend === 'gondolin' && (await isAvailable())) {
    if (opts.seededCopyDir === undefined) {
      throw new ExecutionEnvConfigError(
        'backend "gondolin" is available but no seededCopyDir was supplied; ' +
          'a VM requires a disposable seeded-copy mount (VACUUM INTO snapshot) — ' +
          'live tasks.db/brain.db are NEVER mounted',
      );
    }
    return createGondolin({
      seededCopyDir: opts.seededCopyDir,
      ...(opts.allowedHosts !== undefined ? { allowedHosts: opts.allowedHosts } : {}),
      ...(opts.vaultSecrets !== undefined ? { vaultSecrets: opts.vaultSecrets } : {}),
      ...(opts.memory !== undefined ? { memory: opts.memory } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
    });
  }

  // Degrade (or honour `'in-process'`): the always-available in-process env. This
  // is the CI / most-developer-machines path — no VM probe touched the host when
  // backend was `'in-process'`; when it was `'gondolin'` the probe returned false.
  return createGuardedExecutionEnv({ guard: opts.guard, workspaceRoot: opts.workspaceRoot });
}
