/**
 * Guarded deterministic-node runner — routes EVERY `deterministic` (shell/tool)
 * dispatch in `executePlaybook` through the `guard.ts` deny-first chokepoint
 * (T11802 · M4 cantbook done-gate).
 *
 * ## The gap this closes (AC1)
 *
 * The playbook runtime (`@cleocode/playbooks/runtime`) executes `deterministic`
 * nodes through an INJECTED `DeterministicRunner`. When no runner is injected it
 * degrades to `AgentDispatcher.dispatch` with a synthetic `deterministic:<cmd>`
 * agent id — a path that NEVER touches the `guard.ts` shell denylist. So a
 * `.cantbook` shell step could spawn a subprocess that bypasses the single
 * policy point.
 *
 * This factory builds the CANONICAL production `DeterministicRunner`: every
 * command is funnelled through the injected {@link GuardedToolSurface}'s
 * `executeShell` — the SAME deny-first command policy + env-scrub chokepoint
 * (`createToolGuard`) that in-process skill nodes already use (T11477). There is
 * NO second subprocess code path: shell steps and skill→tool calls share ONE
 * guard. The runtime stays a pure state machine (it imports no `child_process`);
 * the guard owns the spawn (AC1).
 *
 * ## Deny semantics (AC3)
 *
 * The guard's `executeShell` checks the command basename against the policy
 * denylist BEFORE any process is spawned. In `mode: 'enforce'` a denied command
 * rejects with {@link GuardDeniedError} (`E_TOOL_GUARD_DENIED`); this runner
 * catches that rejection and maps it to a contract-clean
 * `{ status: 'failure', error }` envelope so the runtime's retry / escalation
 * semantics stay intact (the runtime contract is non-throwing). In `mode: 'warn'`
 * the guard logs-and-proceeds — the denylist is advisory — so a guarded runner
 * built for enforcement MUST be constructed from an `enforce`-mode guard.
 *
 * ## Why a factory over a guard (DIP)
 *
 * The runner depends on the abstract {@link GuardedToolSurface} (the contract
 * shape of `createToolGuard()`), NOT on the concrete guard — so the policy point
 * is injected, exactly mirroring {@link createSkillNodeExecutor}. `core` builds
 * the guard once (`createToolGuard({ allowedRoots, deniedCommands, mode })`) and
 * hands the same surface to BOTH the skill executor and this deterministic
 * runner.
 *
 * @epic T11391
 * @task T11802
 * @saga T11387
 * @see ../tools/guard.ts — the deny-first chokepoint
 * @see ./skill-node-executor.ts — the sibling in-process skill path
 */

import type { GuardedToolSurface } from '@cleocode/contracts/tools/skill-executor';

/**
 * Canonical deny-list of destructive command basenames a `.cantbook`
 * `deterministic` node may NOT run (T11802 · AC3). This is the SSoT the
 * production dispatcher hands to `createToolGuard({ deniedCommands })` so the
 * SAME chokepoint that guards in-process skill→tool calls also rejects a
 * dangerous shell step. Matched against the command's last path segment by the
 * guard, so `/bin/rm` and `rm` are both denied.
 *
 * Intentionally conservative — destructive disk / process / system operations a
 * planning playbook should never invoke. Extend deliberately; every addition is
 * a policy decision.
 */
export const DEFAULT_DETERMINISTIC_DENIED_COMMANDS: readonly string[] = Object.freeze([
  'rm',
  'rmdir',
  'shutdown',
  'reboot',
  'mkfs',
  'dd',
  'shred',
  'fdisk',
  'mkswap',
  'kill',
  'killall',
]);

/**
 * Minimal projection of the playbook runtime's `DeterministicRunInput` that the
 * guarded runner consumes. Declared structurally so `@cleocode/core` does NOT
 * import `@cleocode/playbooks` (preserves the directed layering
 * `contracts → core → playbooks`). The runtime's input is structurally
 * assignable to this shape.
 */
export interface GuardedDeterministicInput {
  /** Playbook run identifier (FK into `playbook_runs.run_id`). */
  readonly runId: string;
  /** Node identifier within the run graph. */
  readonly nodeId: string;
  /** Executable to run (NOT a shell string — args are passed separately). */
  readonly command: string;
  /** Arguments passed to {@link GuardedDeterministicInput.command}. */
  readonly args: readonly string[];
  /** Working directory. Defaults to `process.cwd()` in the shell primitive. */
  readonly cwd?: string;
  /** Extra environment variables merged (and scrubbed) over the child env. */
  readonly env?: Readonly<Record<string, string>>;
  /** Hard timeout in milliseconds; the process is killed when exceeded. */
  readonly timeout_ms?: number;
}

/**
 * Terminal output of a guarded deterministic execution. Structurally identical
 * to the runtime's `DeterministicRunResult` so this runner is assignable to the
 * runtime's `DeterministicRunner` interface without a wrapper.
 */
export interface GuardedDeterministicResult {
  status: 'success' | 'failure';
  /** Key-value pairs merged into the run context on success. */
  output: Record<string, unknown>;
  /** Human-readable failure reason on `status === 'failure'`. */
  error?: string;
}

/**
 * Structural match for the playbook runtime's `DeterministicRunner` interface.
 * Re-declared here (not imported) for the same directed-layering reason as
 * {@link GuardedDeterministicInput}.
 */
export interface GuardedDeterministicRunner {
  run(input: GuardedDeterministicInput): Promise<GuardedDeterministicResult>;
}

/**
 * Options accepted by {@link createGuardedDeterministicRunner}.
 *
 * @task T11802
 */
export interface GuardedDeterministicRunnerOptions {
  /**
   * The deny-first guarded tool surface every deterministic command is routed
   * through. Typically the SAME `createToolGuard({ allowedRoots, deniedCommands,
   * mode })` result handed to the in-process skill executor — so shell steps and
   * skill→tool calls share ONE policy point. Injected (DIP) — the runner never
   * constructs its own guard.
   */
  readonly tools: GuardedToolSurface;
}

/**
 * Build a {@link GuardedDeterministicRunner} that routes EVERY `deterministic`
 * node command through the injected guard's `executeShell` (T11802 · AC1).
 *
 * Inject the result as `deterministicRunner` when calling `executePlaybook`:
 *
 * @example
 * ```ts
 * import { createToolGuard } from '@cleocode/core/internal';
 *
 * const tools = createToolGuard({
 *   allowedRoots: [projectRoot],
 *   deniedCommands: ['rm', 'shutdown', 'mkfs'],
 *   mode: 'enforce',
 * });
 * await executePlaybook({
 *   db, playbook, playbookHash, initialContext, dispatcher,
 *   deterministicRunner: createGuardedDeterministicRunner({ tools }),
 * });
 * // A `deterministic` node running `rm` → guard rejects → { status: 'failure' }
 * ```
 *
 * The returned runner NEVER throws — a guard `enforce`-mode rejection
 * ({@link import('../tools/guard.js').GuardDeniedError}) is caught and mapped to
 * a `{ status: 'failure', error }` envelope so the runtime's retry / escalation
 * stays intact (the runtime's `DeterministicRunner` contract is non-throwing).
 *
 * @param opts - The injected guarded tool surface.
 * @returns A runner assignable to the runtime's `DeterministicRunner`.
 * @task T11802
 */
export function createGuardedDeterministicRunner(
  opts: GuardedDeterministicRunnerOptions,
): GuardedDeterministicRunner {
  const { tools } = opts;
  return {
    async run(input: GuardedDeterministicInput): Promise<GuardedDeterministicResult> {
      try {
        // The guard checks the command basename against the denylist BEFORE
        // spawning (deny → reject in enforce mode), then scrubs the child env at
        // the chokepoint. This is the ONLY shell-spawn path for deterministic
        // nodes — there is no bypass.
        const result = await tools.executeShell({
          command: input.command,
          args: [...input.args],
          ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
          ...(input.env !== undefined ? { env: input.env } : {}),
          ...(input.timeout_ms !== undefined ? { timeoutMs: input.timeout_ms } : {}),
        });
        // A non-zero exit is a node failure, not a thrown error — mirror the
        // shell primitive's "exit code is the result" contract.
        if (result.code === 0) {
          return {
            status: 'success',
            output: {
              [`${input.nodeId}_stdout`]: result.stdout,
              [`${input.nodeId}_exitCode`]: result.code,
            },
          };
        }
        return {
          status: 'failure',
          output: {
            [`${input.nodeId}_stdout`]: result.stdout,
            [`${input.nodeId}_stderr`]: result.stderr,
            [`${input.nodeId}_exitCode`]: result.code,
          },
          error:
            `deterministic node "${input.nodeId}" command "${input.command}" exited ` +
            `${result.code === null ? 'on signal/timeout' : `with code ${result.code}`}`,
        };
      } catch (err) {
        // Guard-denied (enforce mode) or an unexpected spawn error — never let it
        // escape; the runtime contract is non-throwing.
        return {
          status: 'failure',
          output: {},
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
