/**
 * High-level CANT document API.
 *
 * @remarks
 * Replaces the standalone `cant-cli` Rust binary that was previously
 * spawned by `cleo cant`. All operations now run in-process via the
 * cant-napi binding, avoiding subprocess overhead and shared-binary
 * lookup logic.
 *
 * The functions here return plain TypeScript values (no LAFS envelope)
 * so that callers can wrap them in whatever response shape they need.
 * The CLEO CLI uses `cliOutput` for envelope formatting.
 */

import { readFile } from 'node:fs/promises';
import {
  cantExecutePipelineNative,
  cantLegacyEntryPointWalksImports,
  cantParseDocumentNative,
  cantValidateDocumentNative,
  cantValidateFileNative,
  type NativeDiagnostic,
  type NativeParseError,
  type NativePipelineResult,
} from './native-loader';

/** The kind of section to enumerate via {@link listSections}. */
export type SectionKind = 'agent' | 'pipeline' | 'workflow';

/** Result of {@link parseDocument}. */
export interface CantDocumentResult {
  /** The file path that was parsed. */
  file: string;
  /** Whether parsing succeeded. */
  success: boolean;
  /** The parsed document AST as a JSON-compatible object (null on failure). */
  document: unknown;
  /** Parse errors (empty when `success` is true). */
  errors: NativeParseError[];
}

/** Result of {@link validateDocument}. */
export interface CantValidationResult {
  /** The file path that was validated. */
  file: string;
  /** Whether validation passed (no errors; warnings allowed). */
  valid: boolean;
  /** Total diagnostic count. */
  total: number;
  /** Number of error-severity diagnostics. */
  errorCount: number;
  /** Number of warning-severity diagnostics. */
  warningCount: number;
  /** All diagnostics emitted by the 42-rule validator. */
  diagnostics: NativeDiagnostic[];
  /**
   * Whether the cross-file import rules ran. `false` only when the loaded
   * cant-napi addon cannot walk imports at all (it predates T14603); only the
   * single-document rules ran then. An addon from v2026.11.17 runs S03, S11
   * and S12 (`true`) but not S04, and sets no diagnostic `file`.
   */
  importRulesRun: boolean;
}

/** Result of {@link listSections}. */
export interface CantListResult {
  /** The file path that was inspected. */
  file: string;
  /** The section filter that was applied. */
  filter: SectionKind;
  /** Number of matching sections. */
  count: number;
  /** Names of the matching sections (in source order). */
  names: string[];
}

/** Result of {@link executePipeline}. */
export interface CantPipelineResult {
  /** The file path that was executed. */
  file: string;
  /** The pipeline name that was requested. */
  pipeline: string;
  /** Whether the pipeline ran to completion with all steps succeeding. */
  success: boolean;
  /** Total wall-clock duration in milliseconds. */
  durationMs: number;
  /** Per-step results in execution order. */
  steps: NativePipelineResult['steps'];
  /** Optional error message describing why the pipeline did not run. */
  error?: string | null;
}

/**
 * Parse a `.cant` file and return its AST.
 *
 * @param filePath - Absolute path to the `.cant` file.
 * @returns A {@link CantDocumentResult} with either the AST or parse errors.
 */
export async function parseDocument(filePath: string): Promise<CantDocumentResult> {
  // Normalize CRLF → LF so the Rust parser sees consistent line endings
  // on Windows runners that check out files with core.autocrlf=true.
  const content = (await readFile(filePath, 'utf-8')).replace(/\r\n/g, '\n');
  const result = cantParseDocumentNative(content);
  return {
    file: filePath,
    success: result.success,
    document: result.document ?? null,
    errors: result.errors,
  };
}

/**
 * Validate a `.cant` file with cant-core's validator: the 42 numbered rules
 * plus the hierarchy lints. Imports resolve relative to `filePath`, so the
 * cross-file rules S03 (circular imports), S04 (import target existence),
 * S11 (import depth) and S12 (permission escalation) run too, and a
 * diagnostic raised in an imported file names that file in `file`. An addon
 * without the `cantValidateFile` entry point falls back to
 * `cantValidateDocument(content, filePath)`: one from v2026.11.17 still runs
 * S03, S11 and S12; an older one ignores the path, and `importRulesRun` is
 * then `false`.
 *
 * @param filePath - Absolute path to the `.cant` file.
 * @returns A {@link CantValidationResult} with all diagnostics.
 */
export async function validateDocument(filePath: string): Promise<CantValidationResult> {
  // Normalize CRLF → LF so the Rust validator sees consistent line endings
  // on Windows runners that check out files with core.autocrlf=true.
  const content = (await readFile(filePath, 'utf-8')).replace(/\r\n/g, '\n');
  const graphResult = cantValidateFileNative(content, filePath);
  const result = graphResult ?? cantValidateDocumentNative(content, filePath);
  return {
    file: filePath,
    valid: result.valid,
    total: result.total,
    errorCount: result.errorCount,
    warningCount: result.warningCount,
    diagnostics: result.diagnostics,
    importRulesRun: graphResult !== null || cantLegacyEntryPointWalksImports(),
  };
}

/**
 * Enumerate the agents, pipelines, or workflows defined in a `.cant` file.
 *
 * @param filePath - Absolute path to the `.cant` file.
 * @param kind - Which section type to enumerate (default: `"agent"`).
 * @returns A {@link CantListResult} with the matching section names.
 */
export async function listSections(
  filePath: string,
  kind: SectionKind = 'agent',
): Promise<CantListResult> {
  // Normalize CRLF → LF so the Rust parser sees consistent line endings
  // on Windows runners that check out files with core.autocrlf=true.
  const content = (await readFile(filePath, 'utf-8')).replace(/\r\n/g, '\n');
  const parsed = cantParseDocumentNative(content);
  if (!parsed.success || parsed.document == null) {
    return { file: filePath, filter: kind, count: 0, names: [] };
  }
  const doc = parsed.document as { sections?: unknown[] };
  const sections = Array.isArray(doc.sections) ? doc.sections : [];
  const names: string[] = [];
  for (const section of sections) {
    if (typeof section !== 'object' || section === null) continue;
    const wrapper = section as Record<string, unknown>;
    const inner = wrapper[capitalize(kind)] as Record<string, unknown> | undefined;
    if (!inner) continue;
    const nameField = inner['name'];
    if (typeof nameField === 'object' && nameField !== null) {
      const value = (nameField as Record<string, unknown>)['value'];
      if (typeof value === 'string') names.push(value);
    } else if (typeof nameField === 'string') {
      names.push(nameField);
    }
  }
  return { file: filePath, filter: kind, count: names.length, names };
}

/**
 * Execute a deterministic pipeline from a `.cant` file via the Rust runtime.
 *
 * @remarks
 * Wraps the napi-rs `cantExecutePipeline` async export. Logical failures
 * (file not found, parse errors, missing pipeline, runtime errors) are
 * surfaced via the `success: false` + `error` fields rather than thrown.
 *
 * @param filePath - Absolute path to the `.cant` file.
 * @param pipelineName - The name of the `pipeline { ... }` block to execute.
 * @returns A {@link CantPipelineResult} describing the pipeline outcome.
 */
export async function executePipeline(
  filePath: string,
  pipelineName: string,
): Promise<CantPipelineResult> {
  const result = await cantExecutePipelineNative(filePath, pipelineName);
  return {
    file: filePath,
    pipeline: pipelineName,
    success: result.success,
    durationMs: result.durationMs,
    steps: result.steps,
    error: result.error ?? null,
  };
}

/** Capitalize the first character of a string (used for AST section keys). */
function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
