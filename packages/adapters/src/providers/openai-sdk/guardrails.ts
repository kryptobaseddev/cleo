/**
 * CLEO permission rules for the OpenAI SDK adapter.
 *
 * Historically these rules were expressed as `InputGuardrail` instances from
 * `@openai/agents`. Post T933 (ADR-052 — Vercel AI SDK consolidation) they
 * are CLEO-native objects with the same shape so provider code that relies on
 * their behaviour does not need to change. The Vercel AI SDK does not ship an
 * equivalent guardrail abstraction — CLEO implements its own path ACL and
 * tool allowlist enforcement here.
 *
 * A guardrail evaluates the serialised agent input before the request is sent
 * to the model. A path that falls outside the allowed glob list causes the
 * guardrail to trip and the run is rejected.
 *
 * @task T582 (original)
 * @task T933 (SDK consolidation — provider-neutral rewrite)
 */

// ---------------------------------------------------------------------------
// CLEO-native guardrail contract
// ---------------------------------------------------------------------------

/** Arguments passed to a CLEO input guardrail. */
export interface CleoInputGuardrailFunctionArgs {
  /** The agent being invoked. Opaque to guardrails. */
  agent: unknown;
  /** Serialised input to scan — may be a string or arbitrary JSON value. */
  input: unknown;
  /** Per-run context (opaque). */
  context: unknown;
}

/** Result of evaluating a CLEO input guardrail. */
export interface CleoGuardrailResult {
  /** When true, the guardrail has tripped and the run MUST be rejected. */
  tripwireTriggered: boolean;
  /** Free-form diagnostic payload for logging and trace spans. */
  outputInfo: unknown;
}

/**
 * CLEO-native replacement for `InputGuardrail` from `@openai/agents`.
 *
 * @remarks
 * The shape is identical to the legacy SDK contract so downstream consumers
 * do not require changes. CLEO enforces these guardrails in-process before
 * dispatching a prompt to the Vercel AI SDK.
 */
export interface CleoInputGuardrail {
  /** Stable guardrail identifier for logs and trace metadata. */
  name: string;
  /** Execute the guardrail against the current run arguments. */
  execute(args: CleoInputGuardrailFunctionArgs): Promise<CleoGuardrailResult>;
}

/**
 * @deprecated Use {@link CleoInputGuardrail}. Kept as a named alias for
 *   callers that previously imported the legacy `InputGuardrail` name from
 *   this module. Removed in a future major.
 */
export type InputGuardrail = CleoInputGuardrail;

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
 * @returns A {@link CleoInputGuardrail} ready to attach to an agent.
 *
 * @example
 * ```typescript
 * const guard = buildPathGuardrail(['/mnt/projects/**', '/tmp/**']);
 * const agent = buildStandaloneAgent('...', 'gpt-4.1', [guard]);
 * ```
 */
export function buildPathGuardrail(allowedGlobs: string[]): CleoInputGuardrail {
  return {
    name: 'cleo_path_acl',
    execute: async (args: CleoInputGuardrailFunctionArgs): Promise<CleoGuardrailResult> => {
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
 * Tool-name enforcement is primarily structural — agents only receive the
 * tools declared by CLEO orchestration. This guardrail provides an additional
 * audit layer that records the active allowlist in the span metadata.
 *
 * @param allowedTools - Exact tool names permitted for this agent.
 *   Pass an empty array to allow all tools (permissive mode).
 * @returns A {@link CleoInputGuardrail} ready to attach to an agent.
 *
 * @example
 * ```typescript
 * const guard = buildToolAllowlistGuardrail(['read', 'write']);
 * ```
 */
export function buildToolAllowlistGuardrail(allowedTools: string[]): CleoInputGuardrail {
  return {
    name: 'cleo_tool_allowlist',
    execute: async (_args: CleoInputGuardrailFunctionArgs): Promise<CleoGuardrailResult> => {
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
 * pass as `inputGuardrails` on an agent topology build.
 *
 * @param allowedGlobs - File-path glob allowlist.
 * @param allowedTools - Tool name allowlist.
 * @returns Array of input guardrails to attach to the agent.
 */
export function buildDefaultGuardrails(
  allowedGlobs: string[],
  allowedTools: string[],
): CleoInputGuardrail[] {
  const guards: CleoInputGuardrail[] = [];

  if (allowedGlobs.length > 0) {
    guards.push(buildPathGuardrail(allowedGlobs));
  }

  if (allowedTools.length > 0) {
    guards.push(buildToolAllowlistGuardrail(allowedTools));
  }

  return guards;
}

/**
 * Evaluate a set of CLEO input guardrails against an input payload.
 *
 * Runs every guardrail in sequence and returns the first tripwire result.
 * When no guardrail trips, returns a passing result with diagnostic data
 * aggregated from each guardrail's `outputInfo`.
 *
 * @param guardrails - Guardrails to evaluate.
 * @param input - The input string to test (typically the enriched prompt).
 * @returns Aggregated guardrail result.
 */
export async function evaluateGuardrails(
  guardrails: CleoInputGuardrail[],
  input: string,
): Promise<CleoGuardrailResult> {
  const aggregate: Array<{ name: string; outputInfo: unknown }> = [];

  for (const guard of guardrails) {
    const result = await guard.execute({
      agent: null,
      input,
      context: null,
    });

    if (result.tripwireTriggered) {
      return result;
    }

    aggregate.push({ name: guard.name, outputInfo: result.outputInfo });
  }

  return {
    tripwireTriggered: false,
    outputInfo: aggregate,
  };
}
