/**
 * Shared helpers for the `caamp mcp <verb>` command group.
 *
 * @remarks
 * Every `caamp mcp` verb has to:
 *
 * 1. Look up a provider in the registry and validate it declares an
 *    `capabilities.mcp` block — bare instruction-only providers (Pi)
 *    cannot be targets for MCP server installs.
 * 2. Resolve a `--scope project|global` option into the {@link McpScope}
 *    type used by the underlying `core/mcp/*` library.
 * 3. Resolve a project directory for the `project` scope, honouring an
 *    explicit `--project-dir` flag and falling back to `process.cwd()`.
 * 4. Throw {@link LAFSCommandError} for any caller-side validation
 *    failure so the LAFS envelope carries a registered error code.
 *
 * This module centralises those steps so each verb file stays focused
 * on its own argument shaping and output construction.
 *
 * @packageDocumentation
 */

import type { McpScope } from '../../core/mcp/index.js';
import { getProvider } from '../../core/registry/providers.js';
import type { Provider } from '../../types.js';
import { LAFSCommandError } from '../advanced/lafs.js';

/**
 * Canonical LAFS error codes used by the `caamp mcp` command group.
 *
 * @remarks
 * The `advanced/lafs.ts` emit path normalises any unregistered error
 * code to `E_INTERNAL_UNEXPECTED` — so every code thrown by the mcp
 * commands MUST come from the canonical LAFS error registry. The four
 * codes covered here are also the same set used by the `caamp pi`
 * command group, kept consistent so downstream tooling can rely on a
 * single error vocabulary across both groups.
 *
 * - `VALIDATION` — caller-supplied input failed validation
 * - `NOT_FOUND`  — referenced resource (provider, file) does not exist
 * - `CONFLICT`   — target server entry already exists without `--force`
 * - `TRANSIENT`  — upstream operation failed and retry is viable
 *
 * @public
 */
export const MCP_ERROR_CODES = {
  /** Caller-supplied input failed validation (shape, type, enum). */
  VALIDATION: 'E_VALIDATION_SCHEMA',
  /** Referenced resource does not exist on disk or in the registry. */
  NOT_FOUND: 'E_NOT_FOUND_RESOURCE',
  /** Server entry already exists and overwrite was not requested. */
  CONFLICT: 'E_CONFLICT_VERSION',
  /** Upstream operation failed; retry is viable. */
  TRANSIENT: 'E_TRANSIENT_UPSTREAM',
} as const;

/**
 * Standard option shape accepted by every `caamp mcp <verb>` command.
 *
 * @public
 */
export interface McpCommandBaseOptions {
  /** `--scope project|global` (default: project). */
  scope?: string;
  /** `--project-dir <path>` — override cwd for the `project` scope. */
  projectDir?: string;
}

/**
 * Look up an MCP-capable provider in the registry by id, throwing a
 * typed {@link LAFSCommandError} when the id is unknown or the
 * provider does not declare an MCP capability.
 *
 * @remarks
 * The "no MCP capability" check is treated as a NOT_FOUND error
 * rather than a VALIDATION error because it semantically means "this
 * provider does not have an MCP config file to target", not "you
 * passed a malformed flag value". The error message includes a
 * recovery hint pointing the caller at `caamp providers list` so
 * they can discover the right id.
 *
 * @param providerId - Raw provider id supplied via `--provider <id>`.
 * @returns The resolved {@link Provider} entry.
 * @throws `LAFSCommandError` when the provider is unknown or has no
 *   MCP capability.
 *
 * @example
 * ```typescript
 * const provider = requireMcpProvider("claude-code");
 * console.log(provider.toolName); // "Claude Code"
 * ```
 *
 * @public
 */
export function requireMcpProvider(providerId: string): Provider {
  const provider = getProvider(providerId);
  if (provider === undefined) {
    throw new LAFSCommandError(
      MCP_ERROR_CODES.NOT_FOUND,
      `Unknown provider id: ${providerId}`,
      'Run `caamp providers list` to see registered provider ids.',
      false,
    );
  }
  if (provider.capabilities.mcp === null) {
    throw new LAFSCommandError(
      MCP_ERROR_CODES.NOT_FOUND,
      `Provider ${providerId} does not declare an MCP capability.`,
      'This provider does not consume MCP servers via a config file. Pick a different provider, or check `caamp providers list` for MCP-capable providers.',
      false,
    );
  }
  return provider;
}

/**
 * Parse and validate a `--scope` option value into a typed
 * {@link McpScope}.
 *
 * @remarks
 * Accepts `project`, `global`, or `undefined` — in which case the
 * `defaultScope` is returned. Any other value throws a typed
 * {@link LAFSCommandError} so the error envelope carries a meaningful
 * code rather than an opaque Commander error.
 *
 * @param raw - The raw option value from Commander (may be undefined).
 * @param defaultScope - Scope to use when `raw` is undefined.
 * @returns A resolved {@link McpScope}.
 * @throws `LAFSCommandError` when `raw` is set to an invalid value.
 *
 * @example
 * ```typescript
 * parseScope(undefined, "project"); // "project"
 * parseScope("global", "project");  // "global"
 * parseScope("weird", "project");   // throws LAFSCommandError(E_VALIDATION_SCHEMA)
 * ```
 *
 * @public
 */
export function parseScope(raw: string | undefined, defaultScope: McpScope): McpScope {
  if (raw === undefined) return defaultScope;
  if (raw === 'project' || raw === 'global') return raw;
  throw new LAFSCommandError(
    MCP_ERROR_CODES.VALIDATION,
    `Invalid --scope value: ${raw}`,
    "Use one of: 'project', 'global'.",
    false,
  );
}

/**
 * Resolve the project directory used for the `project` scope.
 *
 * @remarks
 * Mirrors the `caamp pi` resolver: returns the explicit
 * `--project-dir` value when set, falls back to `process.cwd()`
 * otherwise, and returns `undefined` for the `global` scope so the
 * underlying core helpers can decline the project-dir argument
 * cleanly.
 *
 * @param scope - Resolved scope.
 * @param explicit - The raw `--project-dir` option value.
 * @returns Absolute project dir for `project`, else `undefined`.
 *
 * @example
 * ```typescript
 * resolveProjectDir("project", undefined);  // process.cwd()
 * resolveProjectDir("project", "/tmp/app"); // "/tmp/app"
 * resolveProjectDir("global", "/tmp/app");  // undefined
 * ```
 *
 * @public
 */
export function resolveProjectDir(
  scope: McpScope,
  explicit: string | undefined,
): string | undefined {
  if (scope !== 'project') return undefined;
  if (explicit !== undefined && explicit.length > 0) return explicit;
  return process.cwd();
}

/**
 * Parse a single `--env KEY=VALUE` option value into a `[key, value]`
 * pair, throwing a typed validation error when the shape is wrong.
 *
 * @remarks
 * The MCP install verb takes a repeatable `--env KEY=VALUE` flag and
 * accumulates the parsed pairs into the `env` field of the
 * {@link McpServerConfig} payload. Splitting and validating happens
 * here so the verb's action body can stay declarative.
 *
 * @param raw - Single `KEY=VALUE` token from Commander.
 * @returns Tuple of `[key, value]`.
 * @throws `LAFSCommandError` when the token is malformed.
 *
 * @example
 * ```typescript
 * parseEnvAssignment("GITHUB_TOKEN=ghp_abc"); // ["GITHUB_TOKEN", "ghp_abc"]
 * parseEnvAssignment("NO_EQUALS");            // throws LAFSCommandError
 * ```
 *
 * @public
 */
export function parseEnvAssignment(raw: string): [string, string] {
  const idx = raw.indexOf('=');
  if (idx <= 0) {
    throw new LAFSCommandError(
      MCP_ERROR_CODES.VALIDATION,
      `Invalid --env value: ${raw}`,
      'Use KEY=VALUE format, e.g. --env GITHUB_TOKEN=ghp_...',
      false,
    );
  }
  const key = raw.slice(0, idx);
  const value = raw.slice(idx + 1);
  if (key.length === 0) {
    throw new LAFSCommandError(
      MCP_ERROR_CODES.VALIDATION,
      `Invalid --env value: ${raw}`,
      'KEY must be non-empty.',
      false,
    );
  }
  return [key, value];
}
