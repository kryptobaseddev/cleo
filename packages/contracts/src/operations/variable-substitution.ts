/**
 * Variable Substitution Domain Operations — shared types for the mustache
 * `{{var}}` template substitution engine used by `.cant` agents and
 * `.cantbook` playbooks.
 *
 * Syntax: double-brace mustache placeholders (e.g. `{{tech_stack}}`,
 * `{{context.foo.bar}}`) resolved lazily at spawn time.
 *
 * Resolver precedence (highest → lowest):
 *
 *  1. `bindings` — explicit caller overrides (e.g. payload-level hints).
 *  2. `sessionContext` — session/task-scoped state.
 *  3. `projectContext` — project-context.json (dot-notation capable).
 *  4. `env` — `CLEO_<VAR>` / `CANT_<VAR>` prefixed environment variables.
 *  5. Default value (when provided in {@link SubstitutionOptions}).
 *  6. Missing — strict mode errors, lenient leaves the placeholder.
 *
 * SYNC: Canonical SDK implementation at
 *   packages/core/src/agents/variable-substitution.ts
 *
 * Integration: {@link packages/cleo/src/dispatch/engines/orchestrate-engine.ts}
 *   applies substitution inside `orchestrateSpawnExecute` before the CANT
 *   agent body is embedded in the spawn prompt.
 *
 * @task T1238 Variable substitution engine + contracts types
 * @task T1232 CLEO Agents Architecture Remediation for v2026.4.110
 * @see R2-VARIABLE-SYNTAX-DESIGN.md §4 — TypeScript interfaces.
 */

/**
 * Which resolver tier produced a {@link ResolvedVariable} value.
 *
 * `'missing'` indicates the variable was referenced but unresolved. Callers
 * in lenient mode will see `source: 'missing'` for any variable that falls
 * through every tier without matching.
 */
export type SubstitutionSource =
  | 'bindings'
  | 'session'
  | 'project_context'
  | 'env'
  | 'default'
  | 'missing';

/**
 * A resolved value from one tier of the substitution chain.
 *
 * The `value` field is always stringified for template insertion (numbers,
 * booleans, and objects are coerced). `null` indicates an intentional null
 * projection — NOT missing. Missing variables appear in the result's
 * `missing` array and are never surfaced as {@link ResolvedVariable}s unless
 * a `defaultValue` was used (in which case `source === 'default'`).
 */
export interface ResolvedVariable {
  /** Variable name as it appeared between the `{{ }}` braces. */
  name: string;
  /**
   * Resolved value (always stringified for template insertion) or `null`
   * when the source intentionally projected `null`.
   */
  value: string | null;
  /** Which resolver tier provided this value. */
  source: SubstitutionSource;
}

/**
 * Options controlling substitution behaviour.
 *
 * Default posture is lenient (`strict: false`) to match the R2 design —
 * partial substitution is preferred over hard failure so agents can still
 * spawn with placeholder prompts. Callers needing fail-fast behaviour (e.g.
 * playbook approval prompts) should pass `strict: true`.
 */
export interface SubstitutionOptions {
  /**
   * When `true`, missing variables cause {@link SubstitutionResult.success}
   * to be `false` and populate {@link SubstitutionResult.error}. When
   * `false` (default), missing variables are left as literal placeholders
   * in the output text.
   */
  strict?: boolean;
  /**
   * Fallback string substituted for missing variables when {@link strict}
   * is `false`. When omitted, the literal placeholder is kept in the output.
   */
  defaultValue?: string;
  /**
   * When `true`, emits `console.warn` for each unresolved variable. Useful
   * during development; disabled by default so production spawns stay quiet.
   */
  warnMissing?: boolean;
  /**
   * Optional whitelist of variable names permitted in the template. When
   * provided, references to variables outside the list are treated as
   * unresolved (strict mode fails; lenient leaves the placeholder).
   */
  allowedVars?: readonly string[];
  /**
   * Environment prefix used to look up `CLEO_<VAR>` / `CANT_<VAR>` variables.
   * Defaults to both `CLEO_` and `CANT_` (tried in that order). Callers can
   * override to restrict or extend the prefix set.
   */
  envPrefixes?: readonly string[];
}

/**
 * Envelope returned by every call to {@link VariableResolver.resolve}.
 *
 * `text` is the template after substitution. `resolved` lists every variable
 * that was successfully replaced (including `'default'`-sourced fallbacks).
 * `missing` lists every variable that fell through all tiers. `success` is
 * `true` iff strict mode accepted the substitution (lenient mode always
 * succeeds at this level — callers inspect `missing` to decide).
 */
export interface SubstitutionResult {
  /** Template text after substitution. */
  text: string;
  /** Variables resolved during substitution, in discovery order. */
  resolved: ResolvedVariable[];
  /** Variables referenced but not resolved. Empty when strict succeeded. */
  missing: string[];
  /** `true` when substitution completed without strict-mode failure. */
  success: boolean;
  /** Human-readable error when `success === false`. */
  error?: string;
}

/**
 * Context payload consumed by {@link VariableResolver.resolve}.
 *
 * Every field is optional — resolvers fall through to the next tier when
 * the current one is absent or does not contain the variable. The resolver
 * only fails (strict mode) when ALL tiers produce no match.
 */
export interface SubstitutionContext {
  /**
   * Project-wide metadata loaded from `.cleo/project-context.json`. Supports
   * dot-notation lookups (e.g. `{{testing.framework}}` → `context.testing.framework`).
   */
  projectContext?: Record<string, unknown>;
  /**
   * Session/task-scoped state (e.g. `{ taskId, epicId, sessionId }`). Flat
   * key lookup — dot-notation is NOT applied here (session keys are scalar).
   */
  sessionContext?: Record<string, unknown>;
  /**
   * Raw environment variables (usually `process.env`). The resolver prefixes
   * lookups with `CLEO_` / `CANT_` (or the override in
   * {@link SubstitutionOptions.envPrefixes}) before matching.
   */
  env?: Record<string, string | undefined>;
  /**
   * Explicit highest-priority bindings. Used for spawn-time overrides (e.g.
   * classifier output, orchestrator hints). Flat key lookup only.
   */
  bindings?: Record<string, unknown>;
}

/**
 * Core resolver contract.
 *
 * Implementations MUST:
 *
 *  - Use the mustache regex `/\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g`.
 *  - Apply the documented resolver precedence (bindings → session →
 *    project → env → default → missing).
 *  - Never recursively evaluate resolved values (values containing `{{…}}`
 *    are left intact; recursion is NOT supported per R2 §10.2).
 *  - Coerce non-string scalar values to strings. Objects are JSON-stringified.
 *  - Be case-sensitive (`{{tech_stack}}` ≠ `{{TECH_STACK}}`).
 */
export interface VariableResolver {
  /**
   * Resolve and substitute variables in `text` using the supplied context.
   *
   * @param text - Template containing `{{var}}` placeholders.
   * @param context - Multi-tier resolver context.
   * @param options - Optional behaviour tweaks (strict/lenient, prefixes…).
   * @returns A {@link SubstitutionResult} envelope with text + diagnostics.
   */
  resolve(
    text: string,
    context: SubstitutionContext,
    options?: SubstitutionOptions,
  ): SubstitutionResult;

  /**
   * Extract every unique variable name referenced by `text` WITHOUT
   * resolving them. Useful for template validation and schema checks.
   *
   * @param text - Template to scan.
   * @returns Deduplicated variable names in discovery order.
   */
  extractVariables(text: string): string[];

  /**
   * Validate that every variable in `requiredVars` can be resolved from
   * `context`. Returns the set of variables that would fail resolution,
   * so callers can surface a full missing-var report up-front rather than
   * discovering them one by one during resolve().
   *
   * @param requiredVars - Variables the caller considers mandatory.
   * @param context - Resolver context to validate against.
   * @returns `{ valid: true }` when every variable resolves, otherwise
   *   `{ valid: false, missing: [...] }`.
   */
  validate(
    requiredVars: readonly string[],
    context: SubstitutionContext,
  ): { valid: boolean; missing: string[] };
}
