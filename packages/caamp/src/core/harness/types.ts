/**
 * Harness layer type definitions.
 *
 * @remarks
 * Defines the contract every first-class CAAMP harness must implement.
 * A harness is a provider that CAAMP treats natively — not through the
 * generic MCP-config-file path. Pi is the first (and currently only)
 * harness. The interface is intentionally generic so future harnesses
 * (Goose, OpenCode, ...) can slot in without shape churn.
 *
 * All methods are async even when they could be sync, so implementations
 * that need I/O (filesystem, child process) are not forced to lie about
 * their return types.
 *
 * @packageDocumentation
 */

import type { Provider } from '../../types.js';

/**
 * Scope at which a harness operation should be performed.
 *
 * @remarks
 * Harness operations target either the user's global state root (e.g.
 * `~/.pi/agent/`) or a specific project directory. Project scope requires
 * the caller to provide the absolute project directory path — the harness
 * does not infer cwd.
 *
 * @public
 */
export type HarnessScope = { kind: 'global' } | { kind: 'project'; projectDir: string };

/**
 * Declarative description of an MCP server that should be bridged into a
 * harness's native extension mechanism.
 *
 * @remarks
 * This is a harness-agnostic input shape. Fields mirror the MCP
 * configuration surface: stdio transports use {@link command} + {@link args},
 * remote transports use {@link url} + optional {@link headers}, and all
 * transports may carry environment variables via {@link env}.
 *
 * Harnesses that cannot host MCP servers as extensions will throw or omit
 * the {@link Harness.installMcpAsExtension} method entirely.
 *
 * @public
 */
export interface McpServerSpec {
  /** Logical name of the MCP server (e.g. `"filesystem"`, `"brave-search"`). */
  name: string;
  /**
   * Command to launch the server over stdio transport.
   * @defaultValue undefined
   */
  command?: string;
  /**
   * Arguments for the stdio command.
   * @defaultValue undefined
   */
  args?: string[];
  /**
   * URL for SSE/HTTP transports.
   * @defaultValue undefined
   */
  url?: string;
  /**
   * Environment variables for the server process.
   * @defaultValue undefined
   */
  env?: Record<string, string>;
  /**
   * HTTP headers for remote transports.
   * @defaultValue undefined
   */
  headers?: Record<string, string>;
}

/**
 * Description of a subagent task to be spawned under a harness.
 *
 * @remarks
 * Generic across harnesses: the same shape describes a Pi-managed child,
 * a future Goose-managed child, or any other. The {@link targetProviderId}
 * is a routing hint passed to the harness; concrete harnesses may use it
 * to select an inner agent or simply record it for observability.
 *
 * @public
 */
export interface SubagentTask {
  /** Provider id of the agent to spawn (e.g. `"claude-code"`). */
  targetProviderId: string;
  /** The prompt / instruction to give the spawned agent. */
  prompt: string;
  /**
   * Working directory for the spawned agent.
   * @defaultValue undefined
   */
  cwd?: string;
  /**
   * Environment variable overrides layered atop the parent environment.
   * @defaultValue undefined
   */
  env?: Record<string, string>;
  /**
   * Abort signal. When it aborts, the harness will terminate the subagent.
   * @defaultValue undefined
   */
  signal?: AbortSignal;
}

/**
 * Final result of a subagent's execution.
 *
 * @remarks
 * Collected once the child process exits. {@link parsed} is populated
 * on a best-effort basis: if the subagent emits JSON on stdout the
 * harness will parse it, otherwise {@link parsed} is left undefined.
 *
 * @public
 */
export interface SubagentResult {
  /** Process exit code, or `null` if the process was killed by a signal. */
  exitCode: number | null;
  /** Full stdout captured from the subagent. */
  stdout: string;
  /** Full stderr captured from the subagent. */
  stderr: string;
  /**
   * Parsed JSON output, when the target supports a JSON output mode and
   * emitted well-formed JSON on stdout.
   * @defaultValue undefined
   */
  parsed?: unknown;
}

/**
 * Live handle to a running subagent.
 *
 * @remarks
 * Returned synchronously from {@link Harness.spawnSubagent}. The caller
 * may await {@link result} to collect the final output, or invoke
 * {@link abort} to terminate the child early.
 *
 * @public
 */
export interface SubagentHandle {
  /** PID of the spawned process, or `null` if spawning did not yield one. */
  pid: number | null;
  /** Promise resolving to the subagent's final output once the process exits. */
  result: Promise<SubagentResult>;
  /** Synchronously terminate the subagent. Safe to call after exit. */
  abort: () => void;
}

/**
 * Contract every first-class harness must implement.
 *
 * @remarks
 * A harness is a provider that CAAMP treats natively — installing skills,
 * MCP bridges, instruction files, and subagent spawns through harness-specific
 * mechanisms rather than a generic MCP config file. Pi is the first concrete
 * harness; the interface is shaped so future harnesses (Goose, OpenCode, ...)
 * can be added without changing any caller code.
 *
 * Optional methods ({@link installMcpAsExtension}, {@link spawnSubagent},
 * {@link configureModels}) may be omitted by harnesses that cannot support
 * them. Callers MUST feature-check before invoking.
 *
 * @public
 */
export interface Harness {
  /** Short id matching the provider id (e.g. `"pi"`). */
  readonly id: string;

  /** The underlying resolved provider entry. */
  readonly provider: Provider;

  /**
   * Install a skill using the harness's native mechanism.
   *
   * @remarks
   * For Pi: copy the source skill directory into
   * `~/.pi/agent/skills/<skillName>/` (global) or `<projectDir>/.pi/skills/<skillName>/`
   * (project). Pi resolves paths at load time so a symlink would work, but
   * CAAMP prefers a recursive copy to avoid cross-filesystem symlink issues.
   *
   * @param sourcePath - Absolute path to the skill directory to install.
   * @param skillName - Target skill name (becomes the directory name on disk).
   * @param scope - Install target scope.
   */
  installSkill(sourcePath: string, skillName: string, scope: HarnessScope): Promise<void>;

  /**
   * Remove a skill previously installed via this harness.
   *
   * @remarks
   * Missing skills are tolerated silently so callers can use this as an
   * idempotent "ensure absent" operation.
   *
   * @param skillName - Skill name to remove.
   * @param scope - Install target scope.
   */
  removeSkill(skillName: string, scope: HarnessScope): Promise<void>;

  /**
   * List skills installed in this harness's skill directory for a scope.
   *
   * @remarks
   * Returns the skill directory names (not absolute paths). Missing scope
   * directories return an empty array rather than throwing.
   *
   * @param scope - Scope to inspect.
   * @returns Array of skill directory names.
   */
  listSkills(scope: HarnessScope): Promise<string[]>;

  /**
   * Inject content into the harness's instruction file using a marker-based
   * idempotent block.
   *
   * @remarks
   * For Pi the target file is `~/.pi/agent/AGENTS.md` (global) or
   * `<projectDir>/AGENTS.md` at the project root (not under `.pi/`). The
   * injection uses `<!-- CAAMP:START -->` / `<!-- CAAMP:END -->` markers so
   * subsequent calls replace the block in place.
   *
   * @param content - The content to inject inside the marker block.
   * @param scope - Instruction file scope.
   */
  injectInstructions(content: string, scope: HarnessScope): Promise<void>;

  /**
   * Remove the CAAMP injection block from the harness's instruction file.
   *
   * @remarks
   * The surrounding file content is preserved. Missing files are tolerated.
   *
   * @param scope - Instruction file scope.
   */
  removeInstructions(scope: HarnessScope): Promise<void>;

  /**
   * Install an MCP server as a harness extension.
   *
   * @remarks
   * For legacy providers with a native MCP config file, this is a
   * passthrough. For Pi it generates a TypeScript extension file under
   * `extensions/` that wraps the MCP server as a Pi tool via
   * `pi.registerTool()`.
   *
   * Optional — harnesses that cannot host MCP bridges should omit this
   * method. Callers MUST feature-check before invoking.
   *
   * @param server - Server spec to bridge.
   * @param scope - Install scope.
   */
  installMcpAsExtension?(server: McpServerSpec, scope: HarnessScope): Promise<void>;

  /**
   * Spawn a subagent under this harness's control.
   *
   * @remarks
   * For Pi: invokes `child_process.spawn` with the provider's configured
   * `capabilities.spawn.spawnCommand`, appending the task prompt as a
   * trailing positional argument. The returned handle lets the caller await
   * completion or abort early.
   *
   * Optional — harnesses that cannot spawn other agents should omit this
   * method. Callers MUST feature-check before invoking.
   *
   * @param task - Subagent task specification.
   * @returns A live subagent handle.
   */
  spawnSubagent?(task: SubagentTask): Promise<SubagentHandle>;

  /**
   * Configure which models are available in the harness's model picker.
   *
   * @remarks
   * For Pi: writes the provided glob list to `settings.json:enabledModels`.
   *
   * Optional — harnesses without a model picker should omit this method.
   *
   * @param modelPatterns - Glob patterns enumerating enabled models.
   * @param scope - Settings scope.
   */
  configureModels?(modelPatterns: string[], scope: HarnessScope): Promise<void>;

  /**
   * Read the harness's current settings as an opaque object.
   *
   * @remarks
   * The shape is harness-specific; callers that care about fields must know
   * the concrete harness's schema. Missing files resolve to an empty object.
   *
   * @param scope - Settings scope.
   * @returns Opaque settings blob.
   */
  readSettings(scope: HarnessScope): Promise<unknown>;

  /**
   * Deep-merge a patch into the harness's settings and persist the result.
   *
   * @remarks
   * The patch is merged, not replaced, so unrelated fields survive. The
   * shape is harness-specific.
   *
   * @param patch - Partial settings object to merge.
   * @param scope - Settings scope.
   */
  writeSettings(patch: Record<string, unknown>, scope: HarnessScope): Promise<void>;
}
