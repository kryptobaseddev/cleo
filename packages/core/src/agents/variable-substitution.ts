/**
 * Mustache `{{var}}` variable substitution engine for CANT agents and
 * `.cantbook` playbooks.
 *
 * This is the canonical SDK implementation of the {@link VariableResolver}
 * contract declared in `@cleocode/contracts`. The engine resolves double-brace
 * placeholders (e.g. `{{tech_stack}}`, `{{testing.framework}}`) at spawn time
 * from a multi-tier context (bindings → session → project-context.json →
 * environment → default → missing).
 *
 * Key guarantees (per R2-VARIABLE-SYNTAX-DESIGN.md §4):
 *
 *  - Regex: `/\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g`.
 *  - Dot-notation path access on `projectContext` (`{{context.foo.bar}}`).
 *  - Recursion prevention — resolved values are NEVER re-scanned for
 *    placeholders, so `{{a}} → "{{b}}"` remains literal.
 *  - Strict vs lenient mode: strict fails the whole substitution on any
 *    missing; lenient leaves the placeholder and reports it in `missing`.
 *  - Case-sensitive matching.
 *  - Scalar coercion (numbers, booleans → String); objects → JSON.stringify.
 *
 * Integration: {@link packages/cleo/src/dispatch/engines/orchestrate-engine.ts}
 *   calls {@link substituteCantAgentBody} from within `orchestrateSpawnExecute`
 *   so CANT agent bodies are resolved before the spawn prompt is assembled.
 *
 * @module agents/variable-substitution
 * @task T1238 Variable substitution engine + contracts types
 * @task T1232 CLEO Agents Architecture Remediation for v2026.4.110
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ResolvedVariable,
  SubstitutionContext,
  SubstitutionOptions,
  SubstitutionResult,
  SubstitutionSource,
  VariableResolver,
} from '@cleocode/contracts';
import { getCleoDirAbsolute } from '../paths.js';

/**
 * Mustache placeholder regex — matches `{{var}}` / `{{ var.path }}` with
 * optional surrounding whitespace. Names may contain letters, digits,
 * underscores, and dots; they MUST start with a letter or underscore.
 *
 * The regex is compiled once as a module-level constant to avoid per-call
 * allocation. Call sites use `new RegExp(source, 'g')` when they need a
 * fresh stateful matcher (e.g. `matchAll` is non-destructive but
 * `exec`-style loops require a fresh instance).
 */
const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g;

/**
 * Default environment-variable prefixes used when the caller does not supply
 * {@link SubstitutionOptions.envPrefixes}. Tried in order; the first match wins.
 */
const DEFAULT_ENV_PREFIXES: readonly string[] = ['CLEO_', 'CANT_'];

/**
 * Internal carrier for a single tier's resolver outcome.
 */
interface TierResolution {
  value: string | null;
  source: SubstitutionSource;
}

/**
 * Safely walk a dot-path (e.g. `"testing.framework"`) into a nested object.
 * Returns `undefined` when any intermediate segment is missing or not an
 * object/array. Primitives at a terminal path segment are returned as-is.
 *
 * @param path - Dot-separated path to walk.
 * @param obj  - Root object to walk from.
 * @returns The terminal value or `undefined` when the path is unreachable.
 */
function resolveNested(path: string, obj?: Record<string, unknown>): unknown {
  if (!obj) return undefined;
  const segments = path.split('.');
  let curr: unknown = obj;
  for (const key of segments) {
    if (curr === null || curr === undefined) return undefined;
    if (typeof curr !== 'object') return undefined;
    curr = (curr as Record<string, unknown>)[key];
  }
  return curr;
}

/**
 * Coerce a resolved value into the string form that gets inserted into the
 * template. Handles null/undefined, strings, numbers, booleans, and objects.
 *
 * - `null` → literal `"null"` (explicit projection; callers who want
 *   placeholder-retention should avoid binding the key at all).
 * - `undefined` → treated as "not resolved" by the caller BEFORE this helper.
 * - string → as-is.
 * - number/boolean → `String(value)`.
 * - object/array → `JSON.stringify(value)`.
 *
 * @param value - Raw value from a resolver tier.
 * @returns Stringified insertion value, or `null` when the input was
 *   explicitly `null` (to preserve the distinction).
 */
function coerceToString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'bigint') return value.toString();
  // Fall through: object/array — JSON-stringify for deterministic rendering.
  try {
    return JSON.stringify(value);
  } catch {
    // Circular or otherwise un-serializable — treat as unresolved.
    return null;
  }
}

/**
 * Canonical implementation of the {@link VariableResolver} contract.
 *
 * Stateless and reusable across call sites — instantiate once and share, or
 * use {@link defaultResolver} for the module-level singleton.
 *
 * @example
 * ```ts
 * const resolver = new DefaultVariableResolver();
 * const result = resolver.resolve(
 *   'Tech stack: {{tech_stack}}',
 *   { bindings: { tech_stack: 'TypeScript' } },
 * );
 * // result.text === 'Tech stack: TypeScript'
 * ```
 *
 * @task T1238
 */
export class DefaultVariableResolver implements VariableResolver {
  /**
   * Regex used to detect template variables. Exposed as a read-only class
   * field so subclasses and tests can assert against the canonical pattern.
   */
  public readonly pattern: RegExp = VARIABLE_PATTERN;

  /**
   * Resolve and substitute `{{var}}` placeholders in `text`.
   *
   * The algorithm makes a single pass over the template — each match is
   * resolved against the tier chain, and the result list is used to drive a
   * second pass that performs the actual string replacement. This avoids
   * accidental recursion when a resolved value itself contains `{{…}}`
   * (the regex is applied to the ORIGINAL text, never the replacement).
   *
   * @param text - Template containing `{{var}}` placeholders.
   * @param context - Multi-tier resolver context.
   * @param options - Optional behaviour tweaks.
   * @returns A {@link SubstitutionResult} envelope.
   */
  public resolve(
    text: string,
    context: SubstitutionContext,
    options: SubstitutionOptions = {},
  ): SubstitutionResult {
    const strict = options.strict === true;
    const warnMissing = options.warnMissing === true;
    const allowedVars = options.allowedVars;

    const resolved: ResolvedVariable[] = [];
    const missing: string[] = [];

    // Discovery pass — matchAll is non-destructive and gives stable offsets.
    const matches = Array.from(text.matchAll(VARIABLE_PATTERN));
    if (matches.length === 0) {
      return {
        text,
        resolved,
        missing,
        success: true,
      };
    }

    // Track per-variable resolution so multiple occurrences of the same
    // placeholder do not each fire a resolver lookup (and so the
    // `missing` array stays deduplicated while `resolved` tracks discovery
    // order for the first occurrence).
    const perVariable = new Map<string, TierResolution | null>();

    for (const match of matches) {
      const varName = match[1];
      if (varName === undefined) continue;
      if (perVariable.has(varName)) continue;

      // Whitelist enforcement — names outside the allowlist are treated as
      // missing (strict mode will flip success=false below).
      if (allowedVars && !allowedVars.includes(varName)) {
        perVariable.set(varName, null);
        if (!missing.includes(varName)) missing.push(varName);
        if (warnMissing) {
          // eslint-disable-next-line no-console
          console.warn(`[variable-substitution] "${varName}" not in allowedVars whitelist`);
        }
        continue;
      }

      const tier = this.resolveVariable(varName, context, options);
      if (tier !== null) {
        perVariable.set(varName, tier);
        resolved.push({ name: varName, value: tier.value, source: tier.source });
        continue;
      }

      // Apply explicit default value if provided — counts as a resolution
      // with `source: 'default'` so callers can audit fallback use.
      if (options.defaultValue !== undefined) {
        const defaultTier: TierResolution = {
          value: options.defaultValue,
          source: 'default',
        };
        perVariable.set(varName, defaultTier);
        resolved.push({ name: varName, value: defaultTier.value, source: 'default' });
        continue;
      }

      perVariable.set(varName, null);
      if (!missing.includes(varName)) missing.push(varName);
      if (warnMissing) {
        // eslint-disable-next-line no-console
        console.warn(`[variable-substitution] "${varName}" unresolved`);
      }
    }

    // Strict mode — return the original text untouched so callers do not
    // accidentally propagate a partial substitution as if it were complete.
    if (strict && missing.length > 0) {
      return {
        text,
        resolved,
        missing,
        success: false,
        error: `Missing required variables: ${missing.join(', ')}`,
      };
    }

    // Replacement pass — operate on the original text to preserve the
    // recursion-prevention invariant (resolved values are NEVER re-scanned).
    const output = text.replace(VARIABLE_PATTERN, (full, captured: string) => {
      const tier = perVariable.get(captured);
      if (tier === null || tier === undefined) {
        // Missing in lenient mode — leave the placeholder untouched.
        return full;
      }
      // `value: null` was intentional — render the string 'null' so downstream
      // consumers see a concrete value rather than a dangling placeholder.
      return tier.value === null ? 'null' : tier.value;
    });

    return {
      text: output,
      resolved,
      missing,
      success: true,
    };
  }

  /**
   * Extract the unique variable names referenced by `text`.
   *
   * Used by template validators and bundle compilers that want to report
   * undeclared variables before runtime resolution runs.
   *
   * @param text - Template to scan.
   * @returns Deduplicated variable names in discovery order.
   */
  public extractVariables(text: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const match of text.matchAll(VARIABLE_PATTERN)) {
      const name = match[1];
      if (name === undefined) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
    return out;
  }

  /**
   * Validate that every variable in `requiredVars` resolves against `context`.
   *
   * Convenience wrapper around {@link resolveVariable} for callers that want
   * a pre-flight missing-var report without substituting anything.
   *
   * @param requiredVars - Variables the caller considers mandatory.
   * @param context - Resolver context to validate against.
   * @returns `{ valid: true, missing: [] }` when every variable resolves,
   *   else `{ valid: false, missing: [...] }`.
   */
  public validate(
    requiredVars: readonly string[],
    context: SubstitutionContext,
  ): { valid: boolean; missing: string[] } {
    const missing: string[] = [];
    for (const name of requiredVars) {
      const tier = this.resolveVariable(name, context, {});
      if (tier === null) missing.push(name);
    }
    return { valid: missing.length === 0, missing };
  }

  /**
   * Resolve a single variable against the tier chain.
   *
   * Precedence (highest → lowest):
   *
   *  1. `bindings` (flat key lookup)
   *  2. `sessionContext` (flat key lookup)
   *  3. `projectContext` (dot-notation via {@link resolveNested})
   *  4. `env` — tries each configured prefix (default: `CLEO_`, `CANT_`);
   *     the variable name is upper-cased and dots are replaced with
   *     underscores (`{{foo.bar}}` → `CLEO_FOO_BAR`).
   *
   * @param varName - Variable name as captured by the pattern.
   * @param context - Resolver context.
   * @param options - Options (only `envPrefixes` is consulted here).
   * @returns The resolved tier or `null` when every tier missed.
   */
  private resolveVariable(
    varName: string,
    context: SubstitutionContext,
    options: SubstitutionOptions,
  ): TierResolution | null {
    // 1. bindings — exact key lookup (flat).
    if (context.bindings && Object.hasOwn(context.bindings, varName)) {
      const raw = context.bindings[varName];
      if (raw !== undefined) {
        const coerced = coerceToString(raw);
        if (coerced !== null || raw === null) {
          return { value: coerced, source: 'bindings' };
        }
      }
    }

    // 2. sessionContext — exact key lookup (flat).
    if (context.sessionContext && Object.hasOwn(context.sessionContext, varName)) {
      const raw = context.sessionContext[varName];
      if (raw !== undefined) {
        const coerced = coerceToString(raw);
        if (coerced !== null || raw === null) {
          return { value: coerced, source: 'session' };
        }
      }
    }

    // 3. projectContext — dot-notation walk (supports `{{foo.bar.baz}}`).
    if (context.projectContext) {
      const raw = resolveNested(varName, context.projectContext);
      if (raw !== undefined) {
        const coerced = coerceToString(raw);
        if (coerced !== null || raw === null) {
          return { value: coerced, source: 'project_context' };
        }
      }
    }

    // 4. env — `<PREFIX><UPPER_SNAKE>` lookup. Dots are flattened to
    //    underscores so `{{foo.bar}}` → `CLEO_FOO_BAR`.
    if (context.env) {
      const prefixes = options.envPrefixes ?? DEFAULT_ENV_PREFIXES;
      const suffix = varName.toUpperCase().replace(/\./g, '_');
      for (const prefix of prefixes) {
        const envKey = `${prefix}${suffix}`;
        const raw = context.env[envKey];
        if (raw !== undefined) {
          return { value: raw, source: 'env' };
        }
      }
    }

    return null;
  }
}

/**
 * Shared module-level resolver instance. Use for one-off call sites that do
 * not need custom configuration. Instantiating {@link DefaultVariableResolver}
 * directly is also cheap — no persistent state is kept.
 *
 * @task T1238
 */
export const defaultResolver: VariableResolver = new DefaultVariableResolver();

// ============================================================================
// Integration helpers — consumed by the orchestrate engine at spawn time
// ============================================================================

/**
 * Result envelope returned by {@link loadProjectContext}.
 */
export interface LoadProjectContextResult {
  /** Parsed JSON contents, or `null` when the file is missing or invalid. */
  context: Record<string, unknown> | null;
  /** Absolute path that was checked (for diagnostics). */
  path: string;
  /** `true` when the file was found, read, and parsed successfully. */
  loaded: boolean;
  /** Human-readable reason when `loaded === false`. */
  reason?: string;
}

/**
 * Load `.cleo/project-context.json` from the project root.
 *
 * Best-effort: missing / malformed files return `loaded: false` with a
 * diagnostic reason rather than throwing. Callers (spawn engine) MUST
 * continue gracefully — project context is an optional tier of the
 * substitution resolver chain.
 *
 * NEVER hard-codes `.cleo` — delegates to {@link getCleoDirAbsolute} so the
 * `CLEO_DIR` env override and worktree scope are respected.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns {@link LoadProjectContextResult} with parsed JSON (or `null`).
 * @task T1238
 */
export function loadProjectContext(projectRoot: string): LoadProjectContextResult {
  const cleoDir = getCleoDirAbsolute(projectRoot);
  const path = join(cleoDir, 'project-context.json');

  if (!existsSync(path)) {
    return {
      context: null,
      path,
      loaded: false,
      reason: 'project-context.json not found',
    };
  }

  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        context: null,
        path,
        loaded: false,
        reason: 'project-context.json is not a JSON object',
      };
    }
    return {
      context: parsed as Record<string, unknown>,
      path,
      loaded: true,
    };
  } catch (err) {
    return {
      context: null,
      path,
      loaded: false,
      reason: `Failed to parse project-context.json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Result envelope returned by {@link substituteCantAgentBody}.
 */
export interface SubstituteCantAgentBodyResult {
  /** Resolved CANT agent body (or the original body when no template vars were found). */
  text: string;
  /** Variables resolved during substitution. */
  resolved: ResolvedVariable[];
  /** Variables referenced but unresolved (lenient mode). */
  missing: string[];
  /** `true` when substitution completed without strict-mode failure. */
  success: boolean;
  /** Human-readable error when `success === false`. */
  error?: string;
  /** `true` when {@link loadProjectContext} returned a parsed context. */
  projectContextLoaded: boolean;
}

/**
 * Apply variable substitution to a CANT agent body (or any template string)
 * using the canonical spawn-time context stack.
 *
 * This is the integration entry point consumed by the orchestrate engine. It:
 *
 *  1. Loads `.cleo/project-context.json` via {@link loadProjectContext}.
 *  2. Builds a {@link SubstitutionContext} from `projectContext` + the caller's
 *     `sessionContext`, `bindings`, and `env`.
 *  3. Delegates to {@link defaultResolver} in lenient mode (`strict: false`)
 *     so partial substitutions do not block spawn.
 *
 * The returned envelope surfaces `missing` so the orchestrator can audit
 * which variables fell through — useful for detecting template drift as
 * project-context.json evolves.
 *
 * @param body - Template text (typically the CANT agent body).
 * @param params - Spawn-time context supplement.
 * @returns {@link SubstituteCantAgentBodyResult} with resolved text + diagnostics.
 * @task T1238
 */
export function substituteCantAgentBody(
  body: string,
  params: {
    projectRoot: string;
    sessionContext?: Record<string, unknown>;
    bindings?: Record<string, unknown>;
    env?: Record<string, string | undefined>;
    options?: SubstitutionOptions;
  },
): SubstituteCantAgentBodyResult {
  const loadResult = loadProjectContext(params.projectRoot);

  const context: SubstitutionContext = {
    projectContext: loadResult.context ?? undefined,
    sessionContext: params.sessionContext,
    bindings: params.bindings,
    env: params.env ?? process.env,
  };

  const result = defaultResolver.resolve(body, context, params.options ?? { strict: false });

  return {
    text: result.text,
    resolved: result.resolved,
    missing: result.missing,
    success: result.success,
    ...(result.error !== undefined ? { error: result.error } : {}),
    projectContextLoaded: loadResult.loaded,
  };
}
