/**
 * Native addon loader for cant-core via napi-rs.
 *
 * @remarks
 * Loads the napi-rs native addon synchronously on first use. Tries the
 * package-local binary first (`packages/cant/napi/cant.linux-x64-gnu.node`),
 * then falls back to the workspace `cant-napi` crate's `index.cjs` for
 * dev-mode builds where the package binary may not be present yet.
 *
 * Replaces the previous WASM loader. Follows the same pattern as
 * `packages/lafs/src/native-loader.ts`.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
import { isAbsolute, join, relative, resolve } from 'node:path';

/** Shape of a parsed CANT message returned by the native binding. */
export interface NativeParseResult {
  /** The directive verb if present (e.g., `"done"`), or `undefined`. */
  directive?: string;
  /** The classification of the directive as a lowercase string. */
  directiveType?: string;
  /** All `@`-addresses found in the message, without the `@` prefix. */
  addresses?: string[];
  /** All task references found in the message, including the `T` prefix. */
  taskRefs?: string[];
  /** All `#`-tags found in the message, without the `#` prefix. */
  tags?: string[];
  /** The raw text of the first line (the header). */
  headerRaw?: string;
  /** Everything after the first newline (the body). */
  body?: string;
}

/** A parse error from document parsing, exposed by the native binding. */
export interface NativeParseError {
  /** Human-readable error message. */
  message: string;
  /** Line number (1-based) where the error occurred. */
  line: number;
  /** Column number (1-based) where the error occurred. */
  col: number;
  /** Byte offset of the error start. */
  start: number;
  /** Byte offset of the error end. */
  end: number;
  /** Severity: "error" or "warning". */
  severity: string;
}

/** Result of parsing a `.cant` document via the native binding. */
export interface NativeParseDocumentResult {
  /** Whether parsing succeeded. */
  success: boolean;
  /** Parsed AST as a JSON-compatible object (null if parsing failed). */
  document: unknown;
  /** Parse errors (empty if parsing succeeded). */
  errors: NativeParseError[];
}

/** A validation diagnostic from the 42-rule validation engine. */
export interface NativeDiagnostic {
  /** The rule ID (e.g., "S01", "P06", "W08"). */
  ruleId: string;
  /** Human-readable diagnostic message. */
  message: string;
  /** Severity: "error", "warning", "info", or "hint". */
  severity: string;
  /** Line number (1-based). */
  line: number;
  /** Column number (1-based). */
  col: number;
}

/** Result of validating a `.cant` document via the native binding. */
export interface NativeValidateResult {
  /** Whether validation passed (no errors; warnings allowed). */
  valid: boolean;
  /** Total number of diagnostics. */
  total: number;
  /** Number of errors. */
  errorCount: number;
  /** Number of warnings. */
  warningCount: number;
  /** All diagnostics from the validation engine. */
  diagnostics: NativeDiagnostic[];
}

/** A single step result from a pipeline run via the native binding. */
export interface NativePipelineStep {
  /** The step name from the pipeline definition. */
  name: string;
  /** Subprocess exit code (0 = success). */
  exitCode: number;
  /** Length in bytes of captured stdout. */
  stdoutLen: number;
  /** Length in bytes of captured stderr. */
  stderrLen: number;
  /** Wall-clock duration of the step in milliseconds. */
  durationMs: number;
  /** Whether the step was skipped due to a condition. */
  skipped: boolean;
}

/** The aggregate result of a pipeline run via the native binding. */
export interface NativePipelineResult {
  /** The pipeline name. */
  name: string;
  /** Whether all steps completed with exit code 0. */
  success: boolean;
  /** Total wall-clock duration in milliseconds. */
  durationMs: number;
  /** Per-step results in execution order. */
  steps: NativePipelineStep[];
  /** Optional error message describing why the pipeline did not run. */
  error?: string | null;
}

/** Shape of the native CANT addon. */
interface CantNativeModule {
  cantParse(content: string): NativeParseResult;
  cantClassifyDirective(verb: string): string;
  cantParseDocument(content: string): NativeParseDocumentResult;
  cantValidateDocument(content: string): NativeValidateResult;
  cantExtractAgentProfiles(content: string): unknown[];
  cantExecutePipeline(filePath: string, pipelineName: string): Promise<NativePipelineResult>;
}

let nativeModule: CantNativeModule | null = null;
let loadAttempted = false;

/**
 * Attempt to load the native addon. Called lazily on first use.
 * Native addons load synchronously via require() — no async init needed.
 */
function ensureLoaded(): void {
  if (loadAttempted) return;
  loadAttempted = true;

  // The compiled file lives at packages/cant/dist/native-loader.js, so
  // ../napi resolves to packages/cant/napi/cant.linux-x64-gnu.node.
  const packageBinary = join(__dirname, '..', 'napi', 'cant.linux-x64-gnu.node');

  try {
    nativeModule = require(packageBinary) as CantNativeModule;
    return;
  } catch {
    // Fall through to workspace dev fallback.
  }

  try {
    // Development fallback: load via the cant-napi crate's index.cjs.
    // From packages/cant/dist/ -> ../../../crates/cant-napi/index.cjs.
    nativeModule = require('../../../crates/cant-napi/index.cjs') as CantNativeModule;
  } catch {
    nativeModule = null;
  }
}

/**
 * Check if the native addon is available.
 *
 * @returns `true` if the native Rust binding loaded successfully.
 */
export function isNativeAvailable(): boolean {
  ensureLoaded();
  return nativeModule !== null;
}

/**
 * Get the native module, throwing if it failed to load.
 *
 * @internal
 * @throws Error when the native addon could not be loaded.
 */
function requireNative(): CantNativeModule {
  ensureLoaded();
  if (!nativeModule) {
    throw new Error(
      'cant-napi native addon not available. Build it with: cargo build --release -p cant-napi',
    );
  }
  return nativeModule;
}

/**
 * Parse a CANT message using the native addon.
 *
 * @param content - The CANT message content to parse.
 */
export function cantParseNative(content: string): NativeParseResult {
  return requireNative().cantParse(content);
}

/**
 * Classify a directive verb using the native addon.
 *
 * @param verb - The directive verb to classify.
 */
export function cantClassifyDirectiveNative(verb: string): string {
  return requireNative().cantClassifyDirective(verb);
}

/**
 * Parse a `.cant` document via the native addon (Layer 2/3).
 *
 * @param content - The raw `.cant` file content to parse.
 */
export function cantParseDocumentNative(content: string): NativeParseDocumentResult {
  return requireNative().cantParseDocument(content);
}

/**
 * Parse and validate a `.cant` document via the native addon (42 rules).
 *
 * @param content - The raw `.cant` file content to parse and validate.
 */
export function cantValidateDocumentNative(content: string): NativeValidateResult {
  return requireNative().cantValidateDocument(content);
}

/**
 * A single agent profile extracted from a `.cant` document.
 *
 * @remarks
 * Mirrors the subset of fields the Rust-side `cant_extract_agent_profiles`
 * function emits (see R1-AGENT-ARCHITECTURE-AUDIT.md §1.7). Fields are
 * optional because older `.cant` documents may omit them; resolver code
 * MUST handle `undefined` per-field.
 */
export interface AgentProfile {
  /** Agent business id (kebab-case), e.g. `"cleo-prime"`. */
  agentId?: string;
  /** Declared role, e.g. `"orchestrator"`, `"lead"`, `"worker"`. */
  role?: string;
  /** Declared parent agent id, if any. */
  parent?: string;
  /** Skill slugs declared on the agent (cached here; SSoT is `agent_skills`). */
  skills?: string[];
  /** Free-form fields the native binding did not typify. */
  [extra: string]: unknown;
}

/**
 * Extract agent profiles from a `.cant` document via the native addon.
 *
 * @param content - The raw `.cant` file content.
 *
 * @remarks
 * The native binding returns a loose `unknown[]`. Callers that need typed
 * access should prefer {@link extractAgentProfilesTyped}, which validates
 * the shape and returns `AgentProfile[]`.
 */
export function cantExtractAgentProfilesNative(content: string): unknown[] {
  return requireNative().cantExtractAgentProfiles(content);
}

/**
 * Typed wrapper around {@link cantExtractAgentProfilesNative}. Returns a
 * best-effort `AgentProfile[]` by shallow-validating each entry.
 *
 * @param content - The raw `.cant` file content.
 *
 * @remarks
 * Implements R1-AGENT-ARCHITECTURE-AUDIT Recommendation 3 by consolidating
 * agent-profile / skill extraction into a single well-typed surface so
 * downstream packages (`agent-install.ts`, `agent-doctor.ts`) do not have
 * to re-implement `.cant` field parsing.
 */
export function extractAgentProfilesTyped(content: string): AgentProfile[] {
  const raw = cantExtractAgentProfilesNative(content);
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is AgentProfile => {
    return typeof entry === 'object' && entry !== null;
  });
}

/**
 * Extract the `skills: [...]` list from a `.cant` agent document.
 *
 * @param content - The raw `.cant` file content.
 *
 * @returns Deduplicated, trimmed skill slug list (empty array if none).
 *
 * @remarks
 * Consolidates skill-parsing logic previously duplicated in
 * `packages/core/src/store/agent-install.ts` and
 * `packages/core/src/store/agent-doctor.ts` (R1 Recommendation 3). Both
 * modules now delegate to this helper so they stay in lock-step.
 */
export function extractAgentSkills(content: string): string[] {
  const profiles = extractAgentProfilesTyped(content);
  const skills = new Set<string>();
  for (const profile of profiles) {
    if (Array.isArray(profile.skills)) {
      for (const skill of profile.skills) {
        if (typeof skill === 'string') {
          const trimmed = skill.trim();
          if (trimmed.length > 0) skills.add(trimmed);
        }
      }
    }
  }
  return [...skills];
}

/**
 * Validate that a `.cant` file path stays within a declared root directory.
 *
 * @param cantPath - Absolute path to the `.cant` file from the registry row.
 * @param rootDir - Absolute root directory that the path MUST live inside
 *   (typically the project root or the global CANT agents dir).
 *
 * @returns `true` when `cantPath` is a descendant of `rootDir`; `false`
 *   otherwise. Also returns `false` for relative paths.
 *
 * @remarks
 * Implements R1-AGENT-ARCHITECTURE-AUDIT Recommendation 4. A malicious or
 * corrupted `agents.cant_path` row could point to `../../../etc/passwd`
 * or a symlink outside the project. Callers (agent resolver, doctor)
 * MUST gate any `readFileSync(cantPath)` on a successful
 * `validateAgentCantPath()` check.
 *
 * @example
 * ```ts
 * import { validateAgentCantPath } from '@cleocode/cant';
 *
 * const cantPath = row.cant_path;
 * if (!validateAgentCantPath(cantPath, projectRoot)) {
 *   throw new Error(`cant_path outside project root: ${cantPath}`);
 * }
 * ```
 */
export function validateAgentCantPath(cantPath: string, rootDir: string): boolean {
  if (typeof cantPath !== 'string' || cantPath.length === 0) return false;
  if (typeof rootDir !== 'string' || rootDir.length === 0) return false;
  if (!isAbsolute(cantPath) || !isAbsolute(rootDir)) return false;

  const resolvedRoot = resolve(rootDir);
  const resolvedPath = resolve(cantPath);
  const rel = relative(resolvedRoot, resolvedPath);

  // `relative()` returns a path that starts with `..` when the target is
  // outside the root. An absolute return value (Windows drive change) is
  // also outside. Empty string means the path IS the root — reject that.
  if (rel.length === 0) return false;
  if (rel.startsWith('..')) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

/**
 * Execute a deterministic pipeline from a `.cant` file via the native addon.
 *
 * @param filePath - Absolute or relative path to a `.cant` file.
 * @param pipelineName - The name of the `pipeline { ... }` block to run.
 */
export function cantExecutePipelineNative(
  filePath: string,
  pipelineName: string,
): Promise<NativePipelineResult> {
  return requireNative().cantExecutePipeline(filePath, pipelineName);
}

// Backward compatibility aliases (kept so existing callers compile).
export const isWasmAvailable = isNativeAvailable;
/**
 * Backward-compatible no-op initializer.
 *
 * @remarks
 * The previous WASM loader required an async `init()` call. With napi-rs
 * the binding loads synchronously, so this exists only to keep older
 * callers (e.g. test fixtures) compiling without changes.
 */
export const initWasm = async (): Promise<void> => {
  ensureLoaded();
};
