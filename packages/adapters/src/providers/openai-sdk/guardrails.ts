/**
 * CLEO permission rules mapped to OpenAI Agents SDK guardrails.
 *
 * CLEO ACLs (file-glob path allowlists, tool allowlists) are expressed as
 * `InputGuardrail` instances that run before agent execution. A path that
 * falls outside the allowed glob list causes the guardrail to trip and
 * the agent run is rejected.
 *
 * @task T582
 */

import type { InputGuardrail, InputGuardrailFunctionArgs } from '@openai/agents';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Converts a simple glob pattern to a RegExp.
 *
 * Supports `*` (any chars within a segment) and `**` (any chars including `/`).
 * This is a lightweight alternative to the `minimatch` package so no extra
 * dependency is required in the adapters package.
 *
 * @param glob - Glob pattern to convert (e.g. `/mnt/projects/**`).
 * @returns A RegExp that matches paths conforming to the glob.
 */
function globToRegex(glob: string): RegExp {
  // Escape regex metacharacters except * and ?
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // Replace ** first (order matters), then *
  const pattern = escaped.replace(/\*\*/g, '.+').replace(/\*/g, '[^/]*');
  return new RegExp(`^${pattern}$`);
}

/**
 * Check whether a file-system path is covered by at least one glob pattern.
 *
 * @param path - The absolute or relative path to test.
 * @param allowedGlobs - Array of glob patterns (supports `*` and `**`).
 * @returns `true` when the path matches at least one pattern.
 */
export function isPathAllowed(path: string, allowedGlobs: string[]): boolean {
  if (allowedGlobs.length === 0) return true;
  return allowedGlobs.some((glob) => globToRegex(glob).test(path));
}

// ---------------------------------------------------------------------------
// Guardrail builders
// ---------------------------------------------------------------------------

/**
 * Build an input guardrail that enforces CLEO file-glob path ACLs.
 *
 * Inspects the serialised agent input for embedded `"path":"..."` fields
 * and rejects the run when a path falls outside the allowlist. This provides
 * an early-exit safety fence before the agent starts consuming model tokens.
 *
 * @param allowedGlobs - Glob patterns that tool path arguments must match.
 *   Pass an empty array to allow all paths (permissive mode).
 * @returns An {@link InputGuardrail} ready to attach to an `Agent`.
 *
 * @example
 * ```typescript
 * const guard = buildPathGuardrail(['/mnt/projects/**', '/tmp/**']);
 * const agent = new Agent({ ..., inputGuardrails: [guard] });
 * ```
 */
export function buildPathGuardrail(allowedGlobs: string[]): InputGuardrail {
  return {
    name: 'cleo_path_acl',
    execute: async (
      args: InputGuardrailFunctionArgs,
    ): Promise<{ tripwireTriggered: boolean; outputInfo: unknown }> => {
      // Serialise input to a string for heuristic path scanning.
      const inputStr = typeof args.input === 'string' ? args.input : JSON.stringify(args.input);

      // Scan for JSON-encoded `"path":"..."` occurrences in the input text.
      // This is conservative: if no path field is found the guardrail passes.
      const pathMatches = inputStr.matchAll(/"path"\s*:\s*"([^"]+)"/g);
      for (const match of pathMatches) {
        const candidate = match[1];
        if (candidate && !isPathAllowed(candidate, allowedGlobs)) {
          return {
            tripwireTriggered: true,
            outputInfo: {
              reason: `cleo_path_acl: path denied by ACL — ${candidate}`,
              deniedPath: candidate,
              allowedGlobs,
            },
          };
        }
      }

      return { tripwireTriggered: false, outputInfo: null };
    },
  };
}

/**
 * Build an input guardrail that documents the tool allowlist for audit purposes.
 *
 * In the OpenAI Agents SDK, tool-name enforcement is primarily structural —
 * agents only receive the tools attached to their `tools` array. This guardrail
 * provides an additional audit layer that records the active allowlist in the
 * span metadata.
 *
 * @param allowedTools - Exact tool names permitted for this agent.
 *   Pass an empty array to allow all tools (permissive mode).
 * @returns An {@link InputGuardrail} ready to attach to an `Agent`.
 *
 * @example
 * ```typescript
 * const guard = buildToolAllowlistGuardrail(['read', 'write']);
 * ```
 */
export function buildToolAllowlistGuardrail(allowedTools: string[]): InputGuardrail {
  return {
    name: 'cleo_tool_allowlist',
    execute: async (
      _args: InputGuardrailFunctionArgs,
    ): Promise<{ tripwireTriggered: boolean; outputInfo: unknown }> => {
      // Structural enforcement: only listed tools are attached to the agent.
      // This guardrail records the allowlist for audit and always passes.
      return {
        tripwireTriggered: false,
        outputInfo: { allowedTools, checked: true },
      };
    },
  };
}

/**
 * Build the default CLEO guardrail set from spawn options.
 *
 * Combines path ACL and tool allowlist guards into a single array ready to
 * pass as `inputGuardrails` on an `Agent` or `RunConfig`.
 *
 * @param allowedGlobs - File-path glob allowlist.
 * @param allowedTools - Tool name allowlist.
 * @returns Array of input guardrails to attach to the agent.
 */
export function buildDefaultGuardrails(
  allowedGlobs: string[],
  allowedTools: string[],
): InputGuardrail[] {
  const guards: InputGuardrail[] = [];

  if (allowedGlobs.length > 0) {
    guards.push(buildPathGuardrail(allowedGlobs));
  }

  if (allowedTools.length > 0) {
    guards.push(buildToolAllowlistGuardrail(allowedTools));
  }

  return guards;
}
