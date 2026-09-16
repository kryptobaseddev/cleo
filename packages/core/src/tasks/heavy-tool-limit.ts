/**
 * Kernel-enforced memory ceiling for heavy tools CLEO spawns (T12116).
 *
 * ## Why the environment variables were never enough
 *
 * {@link ./heavy-tool-env.ts | heavyToolEnv} bounds a heavy tool by exporting
 * `NODE_OPTIONS`, `VITEST_MAX_WORKERS` and `npm_config_workspace_concurrency`.
 * Every one of those is **advisory and runner-specific**:
 *
 *   - `VITEST_MAX_WORKERS` binds vitest. It does nothing for jest, mocha,
 *     `cargo test`, `pytest`, `go test`, or a hand-rolled `make test` — and
 *     CLEO is a general task runner whose consumers are not all Node projects.
 *   - `--max-old-space-size` caps the V8 **old space**, not RSS. Buffers, typed
 *     arrays, native allocations and every non-Node child are outside it.
 *   - A tool is free to ignore all of them.
 *
 * So the ceiling only ever bound the case we happened to think of. The failure
 * this is written against was not an OOM kill at all: `app.slice` reached its
 * `MemoryHigh`, the kernel throttled and thrashed swap, and the desktop locked
 * up **without logging anything** — which is why repeated OOM hunts found
 * nothing. A throttle-and-thrash freeze is silent.
 *
 * ## What this does instead
 *
 * Spawn the tool inside its own transient systemd scope with a hard
 * `MemoryMax` and, critically, `MemorySwapMax=0`. Two properties follow, and
 * neither depends on the tool's language or cooperation:
 *
 *   1. **The bound is the kernel's**, applied to the whole process tree. A
 *      `pnpm -r` fan-out into fifteen packages is still one cgroup.
 *   2. **Breaching it kills the tool, not the host.** With swap denied, the
 *      cgroup cannot thrash its way into freezing the desktop; it OOMs inside
 *      its own boundary and CLEO reports a failed run. A failed test run is a
 *      result. A frozen workstation is not.
 *
 * Verified on Fedora 44 / systemd 258 before this module was written: a scope
 * created with `MemoryMax=512M` reports `memory.max=536870912` and
 * `memory.swap.max=0` from inside, and a Node process touching 2 GiB is killed
 * at ~450 MiB RSS rather than allocating.
 *
 * Where systemd is unavailable (macOS, Windows, a container without a user
 * manager) this degrades to a no-op and the env-var overlay remains the only
 * bound — the same protection as before, never less.
 *
 * @module
 * @task T12116
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { totalmem } from 'node:os';
import { isHeavyTool } from './heavy-tool-env.js';
import type { CanonicalTool } from './tool-resolver.js';

/** Fraction of host RAM one heavy tool invocation may occupy. */
export const HEAVY_TOOL_RAM_FRACTION = 0.25;

/** Never grant a single invocation more than this, however large the host. */
export const HEAVY_TOOL_MEMORY_CEILING_MB = 8_192;

/** Never grant less than this — a real test suite must be able to run. */
export const HEAVY_TOOL_MEMORY_FLOOR_MB = 2_048;

/** Env var an operator can set to override the derived ceiling. */
export const MEMORY_MAX_ENV = 'CLEO_TOOL_MEMORY_MAX_MB';

/** Env var to disable cgroup confinement entirely. */
export const DISABLE_ENV = 'CLEO_NO_TOOL_CGROUP';

/** A command ready to spawn, plus whether a kernel bound was applied. */
export interface LimitedCommand {
  /** Executable to spawn. */
  readonly cmd: string;
  /** Arguments for {@link cmd}. */
  readonly args: readonly string[];
  /** `true` when the command runs inside a memory-bounded cgroup. */
  readonly confined: boolean;
  /** Ceiling applied, in MiB; `null` when unconfined. */
  readonly memoryMaxMb: number | null;
  /**
   * The explicit transient-unit name this command runs under, or `null` when
   * unconfined.
   *
   * Reported so a caller can stop or enumerate the scope. `suite-reaper.ts`
   * already reaps via `systemctl --user stop <unitName>` and could never
   * target a heavy-tool scope while the name was systemd's auto-generated one.
   *
   * @task T12221 (gh#1396)
   */
  readonly unitName: string | null;
}

/**
 * Memory ceiling for one heavy-tool invocation, in MiB.
 *
 * Derived from host RAM so a 16 GiB laptop is not handed a 45 GiB allowance,
 * then clamped. The result is per-invocation; total exposure is this times the
 * tool semaphore's concurrency, which is itself RAM-derived (T12091).
 *
 * @param totalRamGib - host RAM in GiB; injectable for deterministic tests.
 * @param env - environment to read the operator override from.
 * @returns the ceiling in MiB.
 *
 * @example
 * ```ts
 * resolveMemoryMaxMb(62);  // → 8192 (clamped from 15872)
 * resolveMemoryMaxMb(8);   // → 2048 (floor)
 * ```
 */
export function resolveMemoryMaxMb(
  totalRamGib: number = totalmem() / 1024 ** 3,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const override = Number.parseInt(env[MEMORY_MAX_ENV] ?? '', 10);
  if (Number.isFinite(override) && override > 0) return override;

  const derived = Math.floor(totalRamGib * 1024 * HEAVY_TOOL_RAM_FRACTION);
  return Math.min(HEAVY_TOOL_MEMORY_CEILING_MB, Math.max(HEAVY_TOOL_MEMORY_FLOOR_MB, derived));
}

/** Cached result of {@link cgroupConfinementAvailable}. */
let _available: boolean | null = null;

/**
 * Whether transient memory-bounded scopes can be created on this host.
 *
 * Probes once per process, because the answer cannot change mid-run and the
 * probe costs a subprocess. Requires both `systemd-run` and a **running user
 * manager** — the binary alone is not enough inside a container.
 *
 * @param env - environment to read {@link DISABLE_ENV} from.
 * @returns `true` when {@link withMemoryLimit} can confine a spawn.
 */
export function cgroupConfinementAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env[DISABLE_ENV] === '1') return false;
  if (process.platform !== 'linux') return false;
  if (_available !== null) return _available;

  // `spawnSync`, not `execFileSync`: `systemctl is-system-running` prints the
  // state on stdout but exits NON-ZERO for every state except `running` — a
  // `degraded` manager (one failed unit anywhere in the session, which is
  // extremely common) exits 1. `execFileSync` throws on a non-zero exit, so it
  // would discard the very string we need to read and silently disable
  // confinement on most real desktops. Measured on this host: `degraded`,
  // exit 1, with transient scopes working perfectly.
  const probe = spawnSync('systemd-run', ['--user', '--version'], {
    stdio: 'ignore',
    timeout: 5_000,
  });
  if (probe.error || probe.status !== 0) {
    _available = false;
    return _available;
  }

  const state = spawnSync('systemctl', ['--user', 'is-system-running'], {
    encoding: 'utf-8',
    timeout: 5_000,
  });
  const reported = (state.stdout ?? '').trim();

  // A manager that answers at all can host a transient scope. `running` and
  // `degraded` both do; `offline`/`unknown` (or no answer) do not.
  _available = reported === 'running' || reported === 'degraded';

  return _available;
}

/** Reset the cached probe. Test-only. @internal */
export function _resetConfinementCache(): void {
  _available = null;
}

/**
 * Build the transient-unit name a confined heavy tool runs under.
 *
 * `cleo-tool-<canonical>-<rootHash8>-<rand8>.scope`, e.g.
 * `cleo-tool-test-3f9a21c4-b7e01d55.scope`. Each component earns its place:
 *
 * | Component     | Defends against                                   |
 * |---------------|---------------------------------------------------|
 * | `cleo-tool-`  | *(legibility)* `systemctl --user list-units 'cleo-tool-*'` enumerates exactly CLEO's heavy-tool scopes, distinct from `cleo-agent-*`. |
 * | `<canonical>` | *(legibility)* an operator sees WHICH tool is stuck without opening anything. |
 * | `<rootHash8>` | two worktrees of one repo, and two projects on one host — both have different execution roots, so each gets its own namespace and either can be reaped without touching the other. |
 * | `<rand8>`     | two concurrent verifies of the same tool in the same tree, which differ in nothing else; and PID reuse, by not using the PID. |
 *
 * **Deliberately not the PID.** The PID is the component that makes systemd's
 * auto-generated `run-p<pid>-i<id>` collide, and it defends nothing randomness
 * does not. Including it out of familiarity would import the failure mode this
 * name exists to remove.
 *
 * `rootHash8` is taken off the execution root — the same identity the cache key
 * already uses (T12112 / gh#1220) — so the scope and the cache agree on what
 * "the tree under test" means rather than each deciding separately.
 *
 * At ~38 characters of `[a-z0-9-]` this is far inside systemd's 256-byte unit
 * name limit and uses only characters valid in a unit name.
 *
 * @param canonical - the heavy tool being run.
 * @param executionRoot - absolute path of the tree the tool runs in.
 * @returns a unit name ending in `.scope`.
 *
 * @task T12221 (gh#1396)
 */
export function buildToolScopeUnitName(canonical: CanonicalTool, executionRoot: string): string {
  const rootHash8 = createHash('sha256').update(executionRoot).digest('hex').slice(0, 8);
  const rand8 = randomBytes(4).toString('hex');
  return `cleo-tool-${canonical}-${rootHash8}-${rand8}.scope`;
}

/**
 * Is `cmd` a `systemd-run` invocation?
 *
 * Compares the basename so an absolute path (`/usr/bin/systemd-run`) is
 * recognised as readily as the bare name a `testing.command` usually carries.
 *
 * @param cmd - the executable a resolved tool command starts with.
 * @returns `true` when the command is itself systemd-run.
 *
 * @task T12221 (gh#1396)
 */
export function isSystemdRunCommand(cmd: string): boolean {
  const base = cmd.split('/').pop() ?? cmd;
  return base === 'systemd-run';
}

/**
 * Wrap a heavy tool command so the kernel bounds its whole process tree.
 *
 * Applied only to `test` and `build` — the canonicals that fork. Confining
 * `lint` or `typecheck` would add a subprocess to bound a single cheap process.
 *
 * `--scope` (not `--unit`) keeps the tool a child of this process, so CLEO's
 * existing stdio piping, timeout and exit-code handling are unchanged;
 * `--collect` reaps the transient unit so repeated verifies do not accumulate
 * scope units.
 *
 * @param canonical - the tool about to run.
 * @param cmd - executable.
 * @param args - arguments.
 * @param opts - overrides for deterministic tests.
 * @returns the command to spawn, confined where possible.
 *
 * @example
 * ```ts
 * const c = withMemoryLimit('test', 'pnpm', ['run', 'test']);
 * // c.cmd === 'systemd-run'
 * // c.args === ['--user','--scope','--quiet','--collect',
 * //             '-p','MemoryMax=8192M','-p','MemorySwapMax=0',
 * //             '--','pnpm','run','test']
 * ```
 *
 * @task T12116
 */
export function withMemoryLimit(
  canonical: CanonicalTool,
  cmd: string,
  args: readonly string[],
  opts: {
    totalRamGib?: number;
    env?: NodeJS.ProcessEnv;
    available?: boolean;
    /**
     * Tree the tool runs in, used for the unit name's `rootHash8`. Defaults to
     * `process.cwd()` so existing callers keep working; the tool-cache passes
     * the execution root it already resolved.
     */
    executionRoot?: string;
  } = {},
): LimitedCommand {
  const env = opts.env ?? process.env;

  // One definition of "heavy", shared with the worker caps, the semaphore and
  // the spawn deadline. Four independent literals agreeing by coincidence is
  // how a fifth heavy tool gets a long deadline and no memory bound.
  if (!isHeavyTool(canonical)) {
    return { cmd, args, confined: false, memoryMaxMb: null, unitName: null };
  }

  // gh#1396: do NOT wrap a command that already carries its own resource
  // wrapper. `axiom-analytics` pins
  //
  //   testing.command = "systemd-run --user --scope --quiet -p MemoryMax=8G \
  //                      -p MemorySwapMax=0 -- env … pnpm exec vitest run"
  //
  // and `parseCommandString` splits on whitespace, so `cmd` is literally
  // `systemd-run`. Prepending a second one nests two transient scopes, and
  // `systemd-run --scope` execs its payload rather than forking — so the inner
  // client regenerates a unit name the outer has already registered.
  // Measured: nested 5/5 collide with
  // "Unit run-p<pid>-i<id>.scope was already loaded or has a fragment file";
  // a single invocation, 0/6.
  //
  // The collision is the symptom. The defect is the double wrap, and declining
  // it is the rule this codebase has already adopted twice for exactly this
  // shape: `heapCapApplied()` in `bin/cleo.js` does not re-exec when an
  // operator's own `NODE_OPTIONS` already sets a heap cap, and
  // `mergeNodeOptions()` lets an existing explicit value outrank our default.
  // A project whose test command IS `systemd-run -p MemoryMax=8G` has made
  // that same explicit choice, and a second cap it did not ask for is the
  // thing to avoid, not merely the name clash.
  //
  // Deliberately systemd-run-SPECIFIC. `env`, `nice`, `taskset` and `timeout`
  // are all plausible leading tokens too, but none of them imposes the cgroup
  // memory bound this function exists to apply, so treating them as
  // "already confined" would silently drop the ceiling. Detecting general
  // intent would be guessing; this detects our own mechanism only.
  if (isSystemdRunCommand(cmd)) {
    return { cmd, args, confined: false, memoryMaxMb: null, unitName: null };
  }

  const available = opts.available ?? cgroupConfinementAvailable(env);
  if (!available) {
    return { cmd, args, confined: false, memoryMaxMb: null, unitName: null };
  }

  const memoryMaxMb = resolveMemoryMaxMb(opts.totalRamGib ?? totalmem() / 1024 ** 3, env);
  // CWD-OK: do NOT replace this with `resolveOrCwd(opts.executionRoot)`, which
  // is what the project-root lint recommends. That helper falls back to
  // `getProjectRoot()`, and `getProjectRoot()` DELIBERATELY collapses a git
  // worktree to the main repo (paths.ts, step 2.5: "the canonical project root
  // is the MAIN repo, not the worktree dir"). That is correct for locating
  // state, and wrong here: every worktree of a repo would then hash to the same
  // `rootHash8`, so two worktrees running `test` concurrently would build the
  // same unit-name namespace — reintroducing a collision class inside the fix
  // for a collision bug, and destroying the property this component exists to
  // provide (see {@link buildToolScopeUnitName}).
  //
  // The production call site (`tool-cache.ts`) ALWAYS passes `executionRoot` —
  // the same execution root the cache key uses — so this fallback is reached
  // only by callers that do not identify a tree: tests, and any future
  // in-process caller. For those, the process cwd is the best available answer
  // and a wrong-but-unique namespace is harmless, whereas a collapsed one is
  // not. Making `executionRoot` required would remove this line entirely and
  // is the right follow-up.
  const unitName = buildToolScopeUnitName(canonical, opts.executionRoot ?? process.cwd()); // CWD-OK: getProjectRoot() collapses worktrees to the main repo, which would give every worktree the same rootHash8 — see the note above

  return {
    cmd: 'systemd-run',
    args: [
      '--user',
      '--scope',
      // gh#1396: an EXPLICIT name. Without `--unit=` systemd generates
      // `run-p<pid>-i<dbus-id>`, which is unstoppable by name (so
      // `suite-reaper.ts` cannot target it) and collides outright when two
      // systemd-run clients share a pid. `--scope` picks the unit TYPE and
      // `--unit=` supplies its NAME; they are independent and compose, which
      // the TSDoc here asserted otherwise for the whole life of this defect.
      `--unit=${unitName}`,
      '--quiet',
      '--collect',
      '-p',
      `MemoryMax=${memoryMaxMb}M`,
      // Denying swap is the point. The failure this guards against was a
      // throttle-and-thrash freeze, not an OOM kill: with swap available the
      // cgroup degrades the whole host instead of failing itself.
      '-p',
      'MemorySwapMax=0',
      '--',
      cmd,
      ...args,
    ],
    confined: true,
    memoryMaxMb,
    unitName,
  };
}

/**
 * One sentence describing the memory bound a given tool runs under, for use in
 * an error message. Empty string when the tool is not confined.
 *
 * Derived by asking {@link withMemoryLimit} rather than re-testing
 * `isHeavyTool` and re-reading the ceiling. That matters here for the same
 * reason the comment inside `withMemoryLimit` gives: four independent literals
 * agreeing by coincidence is how a fifth heavy tool gets a long deadline and
 * no memory bound. A message that confidently names a ceiling the tool does
 * not actually run under would be worse than no message.
 *
 * Deliberately does NOT assert that a kill was an OOM kill. `SIGKILL` inside a
 * bounded scope is *consistent* with the cgroup being OOM-killed and is also
 * what an operator's own `kill -9` produces. The caller reports the signal it
 * measured; this reports the ceiling as configured; the two facts sit next to
 * each other and the reader draws the conclusion. Inferring OOM from SIGKILL
 * alone would be the same defect this text exists to fix — a true observation
 * stated as a cause it does not establish.
 *
 * @param canonical - the tool that was run.
 * @param env - environment, for tests.
 * @returns a leading-space sentence, or `''` when unconfined.
 *
 * @task T12116
 */
export function describeMemoryLimit(
  canonical: CanonicalTool,
  env: NodeJS.ProcessEnv = process.env,
): string {
  // `executionRoot` is a stable sentinel, not a real path: this probe reads
  // only `confined` and `memoryMaxMb` and discards the unit name, so making it
  // read the process cwd would be a side effect with no consumer.
  const limited = withMemoryLimit(canonical, 'probe', [], { env, executionRoot: 'probe' });
  if (!limited.confined || limited.memoryMaxMb === null) return '';
  return (
    ` This tool runs inside a memory-bounded systemd scope ` +
    `(MemoryMax=${limited.memoryMaxMb}M, swap denied), so the kernel kills the whole ` +
    `process tree if it exceeds that ceiling — which is consistent with the signal above, ` +
    `though an external kill looks identical. Raise it with ${MEMORY_MAX_ENV}=<megabytes>, ` +
    `reduce the tool's own worker count, or set ${DISABLE_ENV}=1 to run unconfined.`
  );
}

/**
 * `systemd-run`'s own pre-exec failure diagnostics.
 *
 * Each of these is printed by `systemd-run` itself, BEFORE it execs the wrapped
 * command, when it cannot create the transient unit. They are not produced by
 * the tool being wrapped, because the tool never ran.
 *
 * Matched case-insensitively against the captured stderr. The list is
 * deliberately narrow: every entry is a message `systemd-run` emits on the
 * failure path, not a generic systemd string that could plausibly appear in a
 * project's own test output.
 *
 * @task T12116 (gh#1397)
 */
const CONFINEMENT_STARTUP_MARKERS: readonly string[] = [
  'failed to start transient scope unit',
  'failed to start transient service unit',
  'failed to connect to bus',
  'failed to create bus connection',
  'interactive authentication required',
];

/**
 * Decide whether a non-zero exit came from CLEO's own confinement wrapper
 * failing to start, rather than from the wrapped tool running and failing.
 *
 * ## Why this cannot be done with the exit code
 *
 * `systemd-run --scope` is transparent on success: it exits with the WRAPPED
 * command's status. Measured on systemd 259 — a scope that starts and runs
 * `sh -c 'exit 7'` makes `systemd-run` exit `7`. When it cannot create the
 * unit it exits `1` and the wrapped command never runs.
 *
 * `1` is also the exit code of a test suite with a failing test. So the two
 * outcomes CLEO most needs to tell apart — "the harness never started" and
 * "the suite ran and was red" — are identical in the exit code, and differ
 * only in stderr. That is the whole of gh#1397: not a missing error code
 * ({@link validateTool} has had `E_EVIDENCE_TOOL_UNAVAILABLE` all along) but a
 * missing route into it.
 *
 * ## Scope of the claim
 *
 * Returns the matched diagnostic line so the caller can quote the real reason
 * rather than paraphrase it.
 *
 * Gated on whether the spawned command was a `systemd-run` invocation AT ALL —
 * NOT on whether CLEO added it. Those two were the same question until
 * double-wrap detection landed; now a project that pins its own
 * `systemd-run` test command is spawned unconfined by CLEO, and a failure of
 * ITS wrapper still means the suite never ran. Keying on
 * {@link LimitedCommand.confined} alone would have reported exactly the
 * gh#1396 project's harness failures as red suites — the defect this function
 * exists to remove, reintroduced by the fix for its sibling.
 *
 * This is a stderr match, so it is not airtight: a project whose own test
 * output contained one of these strings verbatim AND exited non-zero would be
 * misreported. That is judged acceptable against the alternative, which is the
 * status quo of reporting every harness failure as a red suite. The markers
 * are `systemd-run`'s, the check is gated on CLEO having wrapped the call, and
 * the returned message is quoted rather than asserted.
 *
 * @param stderr - captured stderr from the spawn.
 * @param viaSystemdRun - whether the spawned command was a systemd-run invocation,
 *   whether CLEO added it or the project pinned it.
 * @returns the matched diagnostic line, or `null` when the wrapper started fine.
 *
 * @example
 * ```ts
 * confinementStartupFailure(
 *   'Failed to start transient scope unit: Unit run-p1-i2.scope was already loaded.',
 *   true,
 * );
 * // => 'Failed to start transient scope unit: Unit run-p1-i2.scope was already loaded.'
 * confinementStartupFailure('2 tests failed', true);   // => null
 * confinementStartupFailure('Failed to connect to bus', false); // => null (not systemd-run)
 * ```
 *
 * @task T12116 (gh#1397)
 */
export function confinementStartupFailure(stderr: string, viaSystemdRun: boolean): string | null {
  if (!viaSystemdRun || stderr === '') return null;
  for (const line of stderr.split('\n')) {
    const haystack = line.toLowerCase();
    if (CONFINEMENT_STARTUP_MARKERS.some((m) => haystack.includes(m))) {
      return line.trim();
    }
  }
  return null;
}
