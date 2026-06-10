/**
 * `execute_code` agent tool — guarded code execution via a {@link PiExecutionEnv}
 * (T11946 · M7 · epic T11456 · SG-TOOLS).
 *
 * The first M7 catalog increment: the ONE capability the existing ~18-tool set
 * lacks — running a supplied code snippet. It adds NO new execution mechanism of
 * its own; it routes EVERY run through the EXISTING per-run execution-env selector
 * {@link import('../llm/pi/resolve-execution-env.js').resolveExecutionEnv}, which
 * prefers the Gondolin micro-VM (`backend: 'gondolin'`) when the optional
 * `@earendil-works/gondolin` package + `/dev/kvm` + QEMU are present, and SILENTLY
 * DEGRADES to the always-available in-process deny-first
 * {@link import('../llm/pi/pi-execution-env.js').GuardedExecutionEnv} otherwise.
 * The snippet runs via `env.exec(...)` — NEVER a raw `child_process`.
 *
 * ## Why the selector, not a new primitive (Gate-11 + D11142)
 *
 * `resolveExecutionEnv` already owns the backend choice + the optional-dep
 * degradation. Reusing it means:
 *   - **Optional-dep safety (D11142):** this module has NO `import type` from
 *     `@earendil-works/gondolin`; the selector loads that package lazily and ONLY
 *     when the VM is chosen. `core` builds + runs + tests with gondolin ABSENT —
 *     the in-process env runs. This module is import-time side-effect-free.
 *   - **Gate-11 (Tools-vs-Skills):** the tool is DEFINED here under
 *     `packages/core/src/tools`; it constructs NO new atomic primitive — it
 *     consumes the existing `ExecutionEnv` seam + the existing `ToolGuard`.
 *   - **Gate-13 (LLM chokepoint):** `execute_code` runs CODE, not an LLM call. It
 *     constructs NO transport / client and reads no API key — there is no
 *     chokepoint concern.
 *
 * ## Availability (mirrors `browser_*`)
 *
 * The tool is ALWAYS registered but its {@link AvailabilityCheck} returns `false`
 * unless the run context advertises `capabilities.codeExec === true`. This mirrors
 * the Playwright-gated `browser_*` family: registered-but-hidden until the host
 * opts code execution in, so a loop that never enables it cannot invoke arbitrary
 * code. (The in-process env is itself ALWAYS constructible — Gondolin is the
 * preferred-but-optional upgrade — so the gate is a host POLICY switch, not an
 * infra probe.)
 *
 * ## Egress denylist (AC2)
 *
 * Before a command reaches `env.exec`, the tool rejects a real-egress verb
 * ({@link import('../llm/pi/pi-gondolin-env.js').DENIED_EXEC_PREFIXES} — `gh` /
 * `git push` / `git remote` / `npm publish` / `cleo`) via the shared
 * {@link import('../llm/pi/pi-gondolin-env.js').deniedEgressVerb} predicate. The
 * Gondolin backend enforces this denylist itself; applying it HERE gives the
 * in-process fallback the SAME egress posture (the guarded env's command denylist
 * is policy-configured and may not include these verbs).
 *
 * @epic T11456
 * @task T11946
 * @see ../llm/pi/resolve-execution-env.js — the backend selector this tool reuses
 * @see ../llm/pi/pi-execution-env.js — the in-process guarded `ExecutionEnv` fallback
 * @see ./web-agent-tools.js — the `browser_*` optional-dep + capability-gated pattern mirrored here
 */

import { z } from 'zod';
import type { PiExecutionEnv } from '../llm/pi/pi-execution-env.js';
import { DENIED_EXEC_PREFIXES, deniedEgressVerb } from '../llm/pi/pi-gondolin-env.js';
import {
  type ExecutionEnvBackend,
  type ResolveExecutionEnvOptions,
  type ResolveExecutionEnvSeams,
  resolveExecutionEnv as realResolveExecutionEnv,
} from '../llm/pi/resolve-execution-env.js';
import { getLogger } from '../logger.js';
import { resolveOrCwd } from '../paths.js';
import { createToolGuard, type ToolGuard } from '../tools/guard.js';
import type { AgentToolRegistry, AvailabilityCheck } from './agent-registry.js';

const log = getLogger('tool-exec-code');

/** The languages `execute_code` knows how to invoke (AC2). */
export const EXEC_CODE_LANGUAGES = ['python', 'node', 'bash', 'sh'] as const;

/** One supported {@link EXEC_CODE_LANGUAGES} value. */
export type ExecCodeLanguage = (typeof EXEC_CODE_LANGUAGES)[number];

/**
 * Available ONLY when the run context opts code execution in
 * (`capabilities.codeExec === true`). Mirrors the `browser_*` family's
 * `playwright`-gated predicate: the tool is ALWAYS registered (so the catalog is
 * stable) but hidden by `available()` until the host advertises the capability, so
 * a loop that never enables it cannot run arbitrary code.
 */
export const codeExecAvailable: AvailabilityCheck = (ctx) => ctx.capabilities?.codeExec === true;

/**
 * Result of an {@link registerExecCodeAgentTool | execute_code} run — the captured
 * process output plus the resolved language and backend, for the LLM and for
 * structured logging. `exitCode` is `null` when the process was killed by a
 * signal/timeout (the {@link PiExecResult} contract).
 */
export interface ExecCodeResult {
  /** The language the snippet was run as. */
  readonly language: ExecCodeLanguage;
  /** Captured standard output. */
  readonly stdout: string;
  /** Captured standard error. */
  readonly stderr: string;
  /** Process exit code, or `null` when killed by signal/timeout. */
  readonly exitCode: number | null;
  /** The confinement backend that ran the snippet (`gondolin` or `in-process`). */
  readonly backend: ExecutionEnvBackend;
  /** Whether the run completed without a denial/transport error (`exec` returned ok). */
  readonly ok: boolean;
  /**
   * Present only when `ok === false`: a stable code + message for why the run did
   * not produce a process result (e.g. a denied egress verb, or the selected
   * env's `exec` returned `Result.err`). NEVER carries a raw secret.
   */
  readonly error?: { readonly code: string; readonly message: string };
}

/**
 * The selector seam {@link registerExecCodeAgentTool} resolves a
 * {@link PiExecutionEnv} through. Defaults to the real
 * {@link import('../llm/pi/resolve-execution-env.js').resolveExecutionEnv}.
 *
 * EXPORTED so the unit test can inject a fake selector that returns a fake
 * `PiExecutionEnv` — asserting the selector IS called and its `exec` output is
 * captured, WITHOUT a real Gondolin VM, QEMU, or subprocess. In production the
 * default is the real selector (Gondolin when available, in-process guarded env
 * otherwise — gondolin ABSENT in CI).
 */
export type ExecutionEnvResolver = (
  opts: ResolveExecutionEnvOptions,
  seams?: ResolveExecutionEnvSeams,
) => Promise<PiExecutionEnv>;

/** Options for {@link registerExecCodeAgentTool} — all injectable for testing. */
export interface ExecCodeAgentToolOptions {
  /**
   * The env selector. Defaults to the real
   * {@link import('../llm/pi/resolve-execution-env.js').resolveExecutionEnv}. The
   * test injects a fake that returns a fake `PiExecutionEnv` (no real VM/subprocess).
   */
  readonly resolveEnv?: ExecutionEnvResolver;
  /**
   * The confinement backend to PREFER. `'gondolin'` boots the micro-VM when the
   * optional package + `/dev/kvm` + QEMU are present and DEGRADES to the in-process
   * env otherwise (the CI / most-developer-machines path); `'in-process'` always
   * resolves to the guarded env without probing the host. Defaults to `'gondolin'`
   * — prefer the strongest available confinement, degrade silently.
   */
  readonly backend?: ExecutionEnvBackend;
  /**
   * The enforce-mode {@link ToolGuard} backing the in-process fallback. Defaults to
   * a fresh `createToolGuard({ mode: 'enforce' })` per run. Injectable so a host
   * can supply a guard with a project path allowlist + command denylist.
   */
  readonly guard?: ToolGuard;
  /**
   * The absolute workspace root the in-process fallback confines fs paths under.
   * Defaults to the resolved project root (`resolveOrCwd(undefined)`, T9584 — never
   * a bare `process.cwd()`). The VM backend confines to its own `/workspace`.
   */
  readonly workspaceRoot?: string;
  /**
   * The disposable seeded-copy host dir mounted RW at the VM's `/workspace`.
   * REQUIRED only when a real Gondolin VM actually boots (`backend: 'gondolin'` AND
   * available) — MUST be a `VACUUM INTO` snapshot dir, NEVER the live `.cleo` DBs.
   * Ignored by the in-process fallback (the CI path).
   */
  readonly seededCopyDir?: string;
}

/**
 * Shell-quote a single argument for a POSIX `sh -c` / interpreter `-c`/`-e`
 * invocation: wrap in single quotes and escape embedded single quotes. The code
 * is UNTRUSTED model input, so it is passed as ONE quoted argument to the
 * interpreter's `-c`/`-e` flag rather than interpolated into the command shape.
 *
 * @param value - The raw argument (the model-supplied code).
 * @returns The single-quoted, shell-safe token.
 */
function singleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the command line for a `language` + `code` pair. Each interpreter runs the
 * snippet from its inline-code flag (`python -c`, `node -e`, `bash -c`, `sh -c`)
 * with the code passed as ONE single-quoted argument — no further shell expansion
 * of the model's code into the command shape.
 *
 * @param language - The interpreter to run.
 * @param code - The model-supplied snippet.
 * @returns The command string handed to `env.exec`.
 */
export function buildExecCommand(language: ExecCodeLanguage, code: string): string {
  const quoted = singleQuote(code);
  switch (language) {
    case 'python':
      return `python -c ${quoted}`;
    case 'node':
      return `node -e ${quoted}`;
    case 'bash':
      return `bash -c ${quoted}`;
    case 'sh':
      return `sh -c ${quoted}`;
  }
}

/**
 * Register the `execute_code` tool into `registry`. Pure registration — no env is
 * resolved, no VM is booted, no code runs here; all of that happens later inside
 * the tool's `execute` through the injected (or default) selector. Import-time
 * side-effect-free + optional-dep-safe (D11142).
 *
 * @param registry - The registry to populate.
 * @param options - Injectable selector / backend / guard / workspace (for testing).
 */
export function registerExecCodeAgentTool(
  registry: AgentToolRegistry,
  options: ExecCodeAgentToolOptions = {},
): void {
  const resolveEnv: ExecutionEnvResolver = options.resolveEnv ?? realResolveExecutionEnv;
  const backend: ExecutionEnvBackend = options.backend ?? 'gondolin';

  registry.register({
    name: 'execute_code',
    // 'shell' — the run is a process invocation (its strongest side-effect surface).
    class: 'shell',
    description:
      'Execute a code snippet in a guarded execution environment (Gondolin micro-VM ' +
      'when available, in-process guarded sandbox otherwise) and capture its ' +
      'stdout / stderr / exit code. Real-egress verbs (gh, git push, npm publish, ' +
      'cleo) are denied. Available only when the run enables code execution.',
    toolset: 'agent',
    stateless: true,
    available: codeExecAvailable,
    parameters: z.object({
      language: z
        .enum(EXEC_CODE_LANGUAGES)
        .describe('Interpreter to run the snippet with: python, node, bash, or sh.'),
      code: z.string().describe('The source code / script to execute.'),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Hard wall-time ceiling for the run, in milliseconds.'),
    }),
    execute: async (rawArgs): Promise<ExecCodeResult> => {
      // `rawArgs` is the schema-validated argument object (the dispatch engine
      // re-validates against `parameters` before calling). Narrow defensively.
      const language = rawArgs.language as ExecCodeLanguage;
      const code = String(rawArgs.code);
      const timeoutMs = typeof rawArgs.timeoutMs === 'number' ? rawArgs.timeoutMs : undefined;

      // AC2: deny a real-egress verb BEFORE the env runs it — same posture on the
      // in-process fallback as on the Gondolin backend (whose own denylist is the
      // shared DENIED_EXEC_PREFIXES list). The check runs against the SNIPPET
      // itself (the leading verb the user wants to run), NOT the wrapped
      // `bash -c '<snippet>'` command — whose argv-0 is always a benign
      // interpreter (`bash`/`sh`/`python`/`node`). For a shell snippet (`bash`/`sh`)
      // the code IS the command line, so `gh …`/`git push …`/`npm publish …` is
      // caught; for `python`/`node` the same scan is a harmless extra net.
      const denied = deniedEgressVerb(code);
      if (denied !== null) {
        return {
          language,
          stdout: '',
          stderr: '',
          exitCode: null,
          backend,
          ok: false,
          error: {
            code: 'E_EXEC_CODE_EGRESS_DENIED',
            message: `egress verb "${denied}" is denied (one of: ${DENIED_EXEC_PREFIXES.join(', ')})`,
          },
        };
      }

      // Shape the interpreter command line (the snippet passed as ONE quoted
      // argument to the interpreter's inline-code flag — no shell expansion of the
      // model's code into the command shape).
      const command = buildExecCommand(language, code);

      // Resolve the per-run env through the SELECTOR (Gondolin if present, else the
      // in-process guarded env). The selector owns the optional-dep degradation —
      // this call works with gondolin ABSENT.
      const guard = options.guard ?? createToolGuard({ mode: 'enforce' });
      // `resolveOrCwd` resolves to the supplied root, else the project root (T9584
      // — never a bare `process.cwd()` in core).
      const workspaceRoot = resolveOrCwd(options.workspaceRoot);
      const env = await resolveEnv({
        backend,
        guard,
        workspaceRoot,
        ...(options.seededCopyDir !== undefined ? { seededCopyDir: options.seededCopyDir } : {}),
      });

      try {
        const result = await env.exec(command, {
          ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
        });
        if (!result.ok) {
          // `exec` never throws — a denial / failure is a typed Result.err. Surface
          // it as a non-ok run rather than a thrown executable error.
          return {
            language,
            stdout: '',
            stderr: '',
            exitCode: null,
            backend,
            ok: false,
            error: { code: result.error.code, message: result.error.message },
          };
        }
        return {
          language,
          stdout: result.value.stdout,
          stderr: result.value.stderr,
          exitCode: result.value.exitCode,
          backend,
          ok: true,
        };
      } finally {
        // Best-effort teardown — the env (VM or guarded) may own resources; cleanup
        // never throws (the PiExecutionEnv contract).
        try {
          await env.cleanup();
        } catch (err) {
          log.debug({ err }, 'execute_code: env cleanup failed (ignored)');
        }
      }
    },
  });
}

/**
 * Self-registration marker (AC1) — the identifier the
 * {@link AgentToolRegistry.discover} bounded source scan greps for. Aliases
 * {@link registerExecCodeAgentTool} so a future scan-dir discovery (or the
 * built-in aggregator) can call it uniformly with the other agent-tool modules.
 *
 * @param registry - The registry to populate.
 */
export function registerAgentTools(registry: AgentToolRegistry): void {
  registerExecCodeAgentTool(registry);
}
