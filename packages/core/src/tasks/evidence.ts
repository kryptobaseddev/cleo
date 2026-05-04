/**
 * Evidence-based gate validation (ADR-051 / T832).
 *
 * Parses and validates evidence atoms for `cleo verify`. Each atom is checked
 * against the filesystem, git, structured test-run JSON output (vitest /
 * pytest / cargo-nextest etc.), or a project-resolved toolchain exit code.
 * Soft evidence (`url:`, `note:`) is accepted without validation.
 *
 * Tool resolution is project-agnostic per T1534 / ADR-061:
 *   - {@link resolveToolCommand} maps `tool:<name>` to a runnable command
 *     using `.cleo/project-context.json` and per-`primaryType` fallbacks.
 *   - {@link runToolCached} memoises results per `(cmd, args, head, dirty)`
 *     and serialises concurrent identical runs via a cross-process lock,
 *     preventing the resource thrash observed when multiple `cleo verify`
 *     invocations spawned full toolchains in parallel.
 *
 * @task T832
 * @task T1534
 * @adr ADR-051
 * @adr ADR-061
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';

import type { EvidenceAtom, GateEvidence, VerificationGate } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';

import { CleoError } from '../errors.js';
import { runToolCached } from './tool-cache.js';
import {
  CANONICAL_TOOLS,
  type CanonicalTool,
  listValidToolNames,
  resolveToolCommand,
} from './tool-resolver.js';

/**
 * Valid tool names recognised by the `tool:<name>` evidence atom.
 *
 * Sourced from {@link listValidToolNames} so canonical names + every legacy
 * alias resolve identically. Use {@link isValidToolName} or pass to
 * {@link resolveToolCommand} directly — direct array indexing is no longer
 * the canonical path (post-T1534).
 *
 * @task T832
 * @task T1534
 */
export const VALID_TOOLS: readonly string[] = Object.freeze(listValidToolNames());

/**
 * Type of a supported evidence tool. Post-T1534, this is widened to every
 * canonical tool name plus every alias accepted by {@link resolveToolCommand}.
 *
 * Existing callers that assigned `'pnpm-test' | 'biome' | ...` continue to
 * compile because those literal types remain assignable to `string`.
 *
 * @task T832
 * @task T1534
 */
export type EvidenceTool = CanonicalTool | string;

/**
 * Test whether a string is a recognised tool name (canonical or alias).
 *
 * @task T1534
 */
export function isValidToolName(name: string): boolean {
  return VALID_TOOLS.includes(name);
}

/**
 * @deprecated Since T1534 — tool commands are resolved per-project from
 * `.cleo/project-context.json` via {@link resolveToolCommand}. This export
 * is retained as an empty record for back-compat with downstream callers
 * that destructured the legacy table; new code MUST call the resolver.
 *
 * @task T1534
 */
export const TOOL_COMMANDS: Record<string, { cmd: string; args: string[] }> = Object.freeze({});

/**
 * Minimum evidence required for each verification gate.
 *
 * - A single atom kind means at least one atom of that kind MUST be present.
 * - A tuple of kinds means all listed kinds MUST be present.
 * - Alternatives are modeled as separate sets — if ANY set is satisfied the
 *   evidence is accepted.
 *
 * ## `implemented` gate alternatives
 *
 * Two valid evidence sets exist for the `implemented` gate:
 *
 * 1. `[commit, files]` — standard: commit SHA + list of modified files.
 *    Use this when the implementation added or modified files.
 * 2. `[commit, note]` — deletion-safe: commit SHA + descriptive note.
 *    Use this when the implementation deleted files (no files remain to
 *    anchor the evidence, e.g. `note:deleted src/legacy.ts`).
 *
 * Example (deletion task):
 * ```bash
 * cleo verify T### --gate implemented \
 *   --evidence "commit:<sha>;note:deleted packages/legacy/src/old-module.ts"
 * ```
 *
 * @task T832
 * @task T1515
 * @adr ADR-051 §2.3
 */
export const GATE_EVIDENCE_MINIMUMS: Record<VerificationGate, EvidenceAtom['kind'][][]> = {
  implemented: [
    ['commit', 'files'],
    ['commit', 'note'],
  ],
  testsPassed: [['test-run'], ['tool']],
  qaPassed: [['tool']],
  documented: [['files'], ['url']],
  securityPassed: [['tool'], ['note']],
  cleanupDone: [['note']],
  /**
   * nexusImpact gate accepts `tool:nexus-impact-full` or a `note:` waiver.
   *
   * `tool:nexus-impact-full` runs `reasonImpactOfChange()` across all symbols
   * in the task's files list and fails if any symbol has risk=CRITICAL.
   *
   * A `note:` waiver is accepted when nexus is not available or the gate
   * is disabled via `CLEO_NEXUS_IMPACT_GATE` not being set to '1'.
   *
   * @task T1073
   * @epic T1042
   */
  nexusImpact: [['tool'], ['note']],
};

/**
 * Minimum LOC reduction percentage required when the `engine-migration` label
 * is present on a task.
 *
 * Tasks claiming to migrate an engine MUST demonstrate a measurable reduction
 * in lines of code to prevent structural-only migrations (T1604).
 *
 * @task T1604
 */
export const ENGINE_MIGRATION_MIN_REDUCTION_PCT = 10;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Result of parsing a raw evidence string into structured atoms.
 *
 * @task T832
 */
export interface ParsedEvidence {
  atoms: ParsedAtom[];
}

/**
 * An atom that has been parsed from the CLI syntax but not yet validated
 * against filesystem / git / tools.
 *
 * @task T832
 */
export type ParsedAtom =
  | { kind: 'commit'; sha: string }
  | { kind: 'files'; paths: string[] }
  | { kind: 'test-run'; path: string }
  | { kind: 'tool'; tool: string }
  | { kind: 'url'; url: string }
  | { kind: 'note'; note: string }
  | { kind: 'loc-drop'; fromLines: number; toLines: number }
  | { kind: 'callsite-coverage'; symbolName: string; relativeSourcePath: string };

/**
 * Parse the CLI `--evidence` string into structured atoms.
 *
 * Syntax:
 *   evidence-list := atom ';' atom ';' ...
 *   atom          := kind ':' payload
 *   payload for files: comma-separated paths
 *   payload for everything else: opaque string until next ';'
 *
 * @param raw - Raw CLI string from `--evidence`
 * @returns Parsed atoms ready for {@link validateEvidence}
 * @throws CleoError(VALIDATION_ERROR) for malformed input
 *
 * @example
 * ```ts
 * parseEvidence('commit:abc123;files:a.ts,b.ts;tool:biome');
 * // => { atoms: [{kind:'commit',sha:'abc123'}, ...] }
 * ```
 *
 * @task T832
 */
export function parseEvidence(raw: string): ParsedEvidence {
  if (!raw || typeof raw !== 'string') {
    throw new CleoError(ExitCode.VALIDATION_ERROR, 'Evidence string is empty', {
      fix: "Pass evidence like '--evidence commit:<sha>;files:<path>;...'",
    });
  }
  const chunks = raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  if (chunks.length === 0) {
    throw new CleoError(ExitCode.VALIDATION_ERROR, 'Evidence string contained no atoms', {
      fix: "Pass evidence like '--evidence commit:<sha>;files:<path>;...'",
    });
  }

  const atoms: ParsedAtom[] = [];
  for (const chunk of chunks) {
    const colon = chunk.indexOf(':');
    if (colon < 1 || colon === chunk.length - 1) {
      throw new CleoError(
        ExitCode.VALIDATION_ERROR,
        `Malformed evidence atom: "${chunk}" (expected <kind>:<payload>)`,
        {
          fix: 'Each atom must be of form "<kind>:<payload>" separated by ";".',
        },
      );
    }
    const kind = chunk.slice(0, colon).trim();
    const payload = chunk.slice(colon + 1).trim();
    switch (kind) {
      case 'commit':
        atoms.push({ kind: 'commit', sha: payload });
        break;
      case 'files':
        atoms.push({
          kind: 'files',
          paths: payload
            .split(',')
            .map((p) => p.trim())
            .filter(Boolean),
        });
        break;
      case 'test-run':
        atoms.push({ kind: 'test-run', path: payload });
        break;
      case 'tool':
        atoms.push({ kind: 'tool', tool: payload });
        break;
      case 'url':
        atoms.push({ kind: 'url', url: payload });
        break;
      case 'note':
        atoms.push({ kind: 'note', note: payload });
        break;
      case 'loc-drop': {
        // Format: loc-drop:<fromLines>:<toLines>
        const firstColon = payload.indexOf(':');
        if (firstColon < 1 || firstColon === payload.length - 1) {
          throw new CleoError(
            ExitCode.VALIDATION_ERROR,
            `Malformed loc-drop atom: "${chunk}" (expected loc-drop:<fromLines>:<toLines>)`,
            {
              fix: 'Use format: loc-drop:<fromLines>:<toLines> e.g. loc-drop:1200:800',
            },
          );
        }
        const fromRaw = payload.slice(0, firstColon).trim();
        const toRaw = payload.slice(firstColon + 1).trim();
        const fromLines = Number(fromRaw);
        const toLines = Number(toRaw);
        if (!Number.isInteger(fromLines) || fromLines < 0) {
          throw new CleoError(
            ExitCode.VALIDATION_ERROR,
            `loc-drop: fromLines must be a non-negative integer, got "${fromRaw}"`,
            { fix: 'Use format: loc-drop:<fromLines>:<toLines> e.g. loc-drop:1200:800' },
          );
        }
        if (!Number.isInteger(toLines) || toLines < 0) {
          throw new CleoError(
            ExitCode.VALIDATION_ERROR,
            `loc-drop: toLines must be a non-negative integer, got "${toRaw}"`,
            { fix: 'Use format: loc-drop:<fromLines>:<toLines> e.g. loc-drop:1200:800' },
          );
        }
        atoms.push({ kind: 'loc-drop', fromLines, toLines });
        break;
      }
      case 'callsite-coverage': {
        // Format: callsite-coverage:<symbolName>:<relativeSourcePath>
        const colonIdx = payload.indexOf(':');
        if (colonIdx < 1 || colonIdx === payload.length - 1) {
          throw new CleoError(
            ExitCode.VALIDATION_ERROR,
            `Malformed callsite-coverage atom: "${chunk}" (expected callsite-coverage:<symbolName>:<relativeSourcePath>)`,
            {
              fix: 'Use format: callsite-coverage:<symbolName>:<relativeSourcePath> e.g. callsite-coverage:myFn:packages/core/src/myFn.ts',
            },
          );
        }
        const symbolName = payload.slice(0, colonIdx).trim();
        const relativeSourcePath = payload.slice(colonIdx + 1).trim();
        if (!symbolName) {
          throw new CleoError(
            ExitCode.VALIDATION_ERROR,
            `callsite-coverage: symbolName must not be empty in "${chunk}"`,
            {
              fix: 'Use format: callsite-coverage:<symbolName>:<relativeSourcePath>',
            },
          );
        }
        if (!relativeSourcePath) {
          throw new CleoError(
            ExitCode.VALIDATION_ERROR,
            `callsite-coverage: relativeSourcePath must not be empty in "${chunk}"`,
            {
              fix: 'Use format: callsite-coverage:<symbolName>:<relativeSourcePath>',
            },
          );
        }
        atoms.push({ kind: 'callsite-coverage', symbolName, relativeSourcePath });
        break;
      }
      default:
        throw new CleoError(
          ExitCode.VALIDATION_ERROR,
          `Unknown evidence kind: "${kind}" in atom "${chunk}"`,
          {
            fix: 'Valid kinds: commit, files, test-run, tool, url, note, loc-drop, callsite-coverage',
          },
        );
    }
  }

  return { atoms };
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

/**
 * Result of validating one atom — success carries the validated form
 * (with sha256 / exit codes populated), failure carries a human-readable
 * reason string.
 *
 * @task T832
 */
export type AtomValidation =
  | { ok: true; atom: EvidenceAtom }
  | { ok: false; reason: string; codeName: string };

/**
 * Validate a single parsed atom against the filesystem / git / tools.
 *
 * @param parsed - Parsed atom from {@link parseEvidence}
 * @param projectRoot - Absolute path to project root (for resolving files, git)
 * @returns Validation outcome with canonicalised form on success
 *
 * @task T832
 * @adr ADR-051 §3
 */
export async function validateAtom(
  parsed: ParsedAtom,
  projectRoot: string,
): Promise<AtomValidation> {
  switch (parsed.kind) {
    case 'commit':
      return validateCommit(parsed.sha, projectRoot);
    case 'files':
      return validateFiles(parsed.paths, projectRoot);
    case 'test-run':
      return validateTestRun(parsed.path, projectRoot);
    case 'tool':
      return validateTool(parsed.tool, projectRoot);
    case 'url':
      return validateUrl(parsed.url);
    case 'note':
      return validateNote(parsed.note);
    case 'loc-drop':
      return validateLocDrop(parsed.fromLines, parsed.toLines);
    case 'callsite-coverage':
      return validateCallsiteCoverage(parsed.symbolName, parsed.relativeSourcePath, projectRoot);
    default: {
      // Exhaustiveness check — never reachable if ParsedAtom is complete.
      return { ok: false, reason: `Unknown parsed atom`, codeName: 'E_EVIDENCE_INVALID' };
    }
  }
}

async function validateCommit(sha: string, projectRoot: string): Promise<AtomValidation> {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    return {
      ok: false,
      reason: `Invalid SHA format: "${sha}" (expected 7-40 hex chars)`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  }
  const exists = await runCommand('git', ['cat-file', '-e', `${sha}^{commit}`], projectRoot);
  if (exists.exitCode !== 0) {
    return {
      ok: false,
      reason: `Commit not found in repository: ${sha}`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  }
  const reachable = await runCommand(
    'git',
    ['merge-base', '--is-ancestor', sha, 'HEAD'],
    projectRoot,
  );
  if (reachable.exitCode !== 0) {
    return {
      ok: false,
      reason: `Commit ${sha} exists but is not reachable from HEAD`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  }
  const short = await runCommand('git', ['rev-parse', '--short', sha], projectRoot);
  const shortSha = short.stdout.trim() || sha.slice(0, 7);
  const full = await runCommand('git', ['rev-parse', sha], projectRoot);
  const fullSha = full.stdout.trim() || sha;
  return { ok: true, atom: { kind: 'commit', sha: fullSha, shortSha } };
}

async function validateFiles(paths: string[], projectRoot: string): Promise<AtomValidation> {
  if (paths.length === 0) {
    return {
      ok: false,
      reason: 'files: atom requires at least one path',
      codeName: 'E_EVIDENCE_INVALID',
    };
  }
  const files: Array<{ path: string; sha256: string }> = [];
  for (const p of paths) {
    const abs = isAbsolute(p) ? p : resolvePath(projectRoot, p);
    if (!existsSync(abs)) {
      return {
        ok: false,
        reason: `File does not exist: ${p}`,
        codeName: 'E_EVIDENCE_INVALID',
      };
    }
    const st = await stat(abs);
    if (!st.isFile()) {
      return {
        ok: false,
        reason: `Path is not a regular file: ${p}`,
        codeName: 'E_EVIDENCE_INVALID',
      };
    }
    const content = await readFile(abs);
    const sha256 = createHash('sha256').update(content).digest('hex');
    files.push({ path: p, sha256 });
  }
  return { ok: true, atom: { kind: 'files', files } };
}

interface VitestJsonLike {
  testResults?: Array<{ status?: string; name?: string }>;
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  numTodoTests?: number;
}

async function validateTestRun(path: string, projectRoot: string): Promise<AtomValidation> {
  const abs = isAbsolute(path) ? path : resolvePath(projectRoot, path);
  if (!existsSync(abs)) {
    return {
      ok: false,
      reason: `test-run file does not exist: ${path}`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  }
  let content: Buffer;
  try {
    content = await readFile(abs);
  } catch (err) {
    return {
      ok: false,
      reason: `Cannot read test-run file: ${err instanceof Error ? err.message : String(err)}`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  }
  const sha256 = createHash('sha256').update(content).digest('hex');

  let parsed: VitestJsonLike;
  try {
    parsed = JSON.parse(content.toString('utf-8'));
  } catch (err) {
    return {
      ok: false,
      reason: `test-run file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  }

  const total = parsed.numTotalTests ?? 0;
  const failed = parsed.numFailedTests ?? 0;
  const passed = parsed.numPassedTests ?? 0;
  const pending = (parsed.numPendingTests ?? 0) + (parsed.numTodoTests ?? 0);

  if (total === 0) {
    return {
      ok: false,
      reason: 'test-run reports zero total tests (no tests were executed)',
      codeName: 'E_EVIDENCE_TESTS_FAILED',
    };
  }
  if (failed > 0) {
    return {
      ok: false,
      reason: `test-run reports ${failed} failed tests`,
      codeName: 'E_EVIDENCE_TESTS_FAILED',
    };
  }
  if (Array.isArray(parsed.testResults)) {
    const notPassing = parsed.testResults.filter(
      (tr) => tr.status && tr.status !== 'passed' && tr.status !== 'skipped',
    );
    if (notPassing.length > 0) {
      return {
        ok: false,
        reason: `test-run contains ${notPassing.length} non-passing suites`,
        codeName: 'E_EVIDENCE_TESTS_FAILED',
      };
    }
  }

  return {
    ok: true,
    atom: {
      kind: 'test-run',
      path,
      sha256,
      passCount: passed,
      failCount: failed,
      skipCount: pending,
    },
  };
}

async function validateTool(tool: string, projectRoot: string): Promise<AtomValidation> {
  const resolution = resolveToolCommand(tool, projectRoot);
  if (!resolution.ok) {
    return {
      ok: false,
      reason: resolution.reason,
      codeName:
        resolution.codeName === 'E_TOOL_UNKNOWN'
          ? 'E_EVIDENCE_INVALID'
          : 'E_EVIDENCE_TOOL_UNAVAILABLE',
    };
  }

  const result = await runToolCached(resolution.command, projectRoot);

  if (result.exitCode === null) {
    return {
      ok: false,
      reason:
        `Tool "${tool}" → ${resolution.command.cmd} ${resolution.command.args.join(' ')} ` +
        `could not be executed (binary missing or spawn error)`,
      codeName: 'E_EVIDENCE_TOOL_UNAVAILABLE',
    };
  }

  if (result.exitCode !== 0) {
    const tail = tailString(`${result.stdoutTail}\n${result.stderrTail}`, 512);
    return {
      ok: false,
      reason:
        `Tool "${tool}" exited with code ${result.exitCode}` +
        `${result.cacheHit ? ' (cached)' : ''}. Tail: ${tail}`,
      codeName: 'E_EVIDENCE_TOOL_FAILED',
    };
  }

  return {
    ok: true,
    atom: { kind: 'tool', tool, exitCode: 0, stdoutTail: result.stdoutTail },
  };
}

// Re-export so downstream code can keep importing the canonical-tools list
// from evidence.ts without crossing into tool-resolver internals.
export { CANONICAL_TOOLS };

function validateUrl(url: string): AtomValidation {
  if (!/^https?:\/\//.test(url)) {
    return {
      ok: false,
      reason: `url atom must start with http:// or https://`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  }
  return { ok: true, atom: { kind: 'url', url } };
}

function validateNote(note: string): AtomValidation {
  if (!note || note.length === 0) {
    return {
      ok: false,
      reason: 'note atom is empty',
      codeName: 'E_EVIDENCE_INVALID',
    };
  }
  if (note.length > 512) {
    return {
      ok: false,
      reason: `note is too long (${note.length} > 512 chars)`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  }
  return { ok: true, atom: { kind: 'note', note } };
}

/**
 * Validate a `loc-drop` atom: both counts must be non-negative integers and
 * `fromLines` must be strictly greater than zero (cannot reduce from nothing).
 *
 * The reduction percentage is computed and stored but the threshold check
 * (whether the percentage meets the required minimum) is performed separately
 * in `checkEngineMigrationLocDrop` so the gate logic stays decoupled from
 * atom validation.
 *
 * @param fromLines - Line count of the original file.
 * @param toLines - Line count of the migrated file.
 * @returns Validated atom on success, error on invalid input.
 *
 * @task T1604
 */
function validateLocDrop(fromLines: number, toLines: number): AtomValidation {
  if (!Number.isInteger(fromLines) || fromLines < 0) {
    return {
      ok: false,
      reason: `loc-drop: fromLines must be a non-negative integer, got ${fromLines}`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  }
  if (!Number.isInteger(toLines) || toLines < 0) {
    return {
      ok: false,
      reason: `loc-drop: toLines must be a non-negative integer, got ${toLines}`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  }
  if (fromLines === 0) {
    return {
      ok: false,
      reason: `loc-drop: fromLines cannot be zero (nothing to reduce)`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  }
  if (toLines > fromLines) {
    return {
      ok: false,
      reason: `loc-drop: toLines (${toLines}) is greater than fromLines (${fromLines}) — LOC increased, not dropped`,
      codeName: 'E_EVIDENCE_INSUFFICIENT',
    };
  }
  const reductionPct = Math.round(((fromLines - toLines) / fromLines) * 100 * 100) / 100;
  return { ok: true, atom: { kind: 'loc-drop', fromLines, toLines, reductionPct } };
}

/**
 * Check that the provided evidence atoms satisfy the LOC-drop requirement for
 * engine-migration tasks.
 *
 * Returns `null` when the requirement is satisfied; otherwise returns a human-
 * readable reason string suitable for use as an `E_EVIDENCE_INSUFFICIENT`
 * error message.
 *
 * @param atoms - Already-validated evidence atoms.
 * @param minReductionPct - Minimum reduction percentage required (default: 10%).
 * @returns `null` on success, error message on failure.
 *
 * @task T1604
 */
export function checkEngineMigrationLocDrop(
  atoms: EvidenceAtom[],
  minReductionPct: number = ENGINE_MIGRATION_MIN_REDUCTION_PCT,
): string | null {
  const locDropAtom = atoms.find((a) => a.kind === 'loc-drop') as
    | Extract<EvidenceAtom, { kind: 'loc-drop' }>
    | undefined;

  if (!locDropAtom) {
    return (
      `Gate 'implemented' on engine-migration tasks requires a 'loc-drop' evidence atom. ` +
      `Example: --evidence "commit:<sha>;files:<path>;loc-drop:<fromLines>:<toLines>". ` +
      `The migrated engine must shed ≥${minReductionPct}% of its lines.`
    );
  }

  if (locDropAtom.reductionPct < minReductionPct) {
    return (
      `loc-drop: reduction of ${locDropAtom.reductionPct}% is below the required ` +
      `${minReductionPct}% for engine-migration tasks ` +
      `(from=${locDropAtom.fromLines} lines, to=${locDropAtom.toLines} lines). ` +
      `The migrated engine must shed ≥${minReductionPct}% of its lines.`
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Callsite-coverage atom (T1605)
// ---------------------------------------------------------------------------

/**
 * The canonical label that triggers callsite-coverage gate enforcement.
 *
 * When a task carries this label the `implemented` gate MUST be accompanied
 * by a `callsite-coverage` evidence atom proving the exported symbol is
 * referenced from a production callsite.
 *
 * @task T1605
 */
export const CALLSITE_COVERAGE_LABEL = 'callsite-coverage';

/**
 * Validate a `callsite-coverage` atom by running ripgrep across the project,
 * excluding the definition file itself, test files, and dist directories.
 *
 * A callsite is any file that contains the `symbolName` identifier outside of:
 * - The source file itself (`relativeSourcePath`).
 * - Test files (`*.test.ts`, `*.spec.ts`, files under `__tests__/`).
 * - Built output (`dist/`, `node_modules/`).
 *
 * Requires `rg` (ripgrep) on the PATH.  Falls back gracefully with
 * `E_EVIDENCE_TOOL_FAILED` when ripgrep is unavailable so callers get a clear
 * diagnostic rather than a silent pass.
 *
 * @param symbolName - The exported identifier to search for.
 * @param relativeSourcePath - Source file path relative to project root
 *   (definition file — excluded from the search).
 * @param projectRoot - Absolute path to the CLEO project root.
 * @returns Validated atom (with `hitCount`) on success, error on failure.
 *
 * @task T1605
 */
async function validateCallsiteCoverage(
  symbolName: string,
  relativeSourcePath: string,
  projectRoot: string,
): Promise<AtomValidation> {
  if (!symbolName || typeof symbolName !== 'string') {
    return {
      ok: false,
      reason: `callsite-coverage: symbolName must be a non-empty string`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  }
  if (!relativeSourcePath || typeof relativeSourcePath !== 'string') {
    return {
      ok: false,
      reason: `callsite-coverage: relativeSourcePath must be a non-empty string`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  }

  // Build the ripgrep command.
  // Exclude: the definition file, test files, dist/, and node_modules/.
  const rgArgs = [
    '--fixed-strings',
    symbolName,
    '--glob',
    '!*.test.ts',
    '--glob',
    '!*.spec.ts',
    '--glob',
    '!**/__tests__/**',
    '--glob',
    '!**/dist/**',
    '--glob',
    '!**/node_modules/**',
    '--glob',
    `!${relativeSourcePath}`,
    '--count-matches',
    '--no-heading',
    '.',
  ];

  const result = await runCommand('rg', rgArgs, projectRoot);

  // rg exits 0 when matches found, 1 when no matches, 2 on error.
  if (result.exitCode === 2 || (result.exitCode !== 0 && result.exitCode !== 1)) {
    const isNotFound =
      result.stderr.includes('No such file or directory') ||
      result.stderr.includes('command not found') ||
      result.stderr.includes('not found');
    if (isNotFound || result.exitCode === null) {
      return {
        ok: false,
        reason:
          `callsite-coverage: ripgrep (rg) is not available on PATH. ` +
          `Install ripgrep to use callsite-coverage atoms.`,
        codeName: 'E_EVIDENCE_TOOL_FAILED',
      };
    }
    return {
      ok: false,
      reason: `callsite-coverage: ripgrep failed (exit ${result.exitCode}): ${result.stderr.slice(0, 200)}`,
      codeName: 'E_EVIDENCE_TOOL_FAILED',
    };
  }

  // Parse match counts from rg --count-matches output.
  // Each line is: <filepath>:<count>
  let totalHits = 0;
  if (result.exitCode === 0) {
    for (const line of result.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const lastColon = trimmed.lastIndexOf(':');
      if (lastColon < 0) continue;
      const count = parseInt(trimmed.slice(lastColon + 1), 10);
      if (Number.isFinite(count) && count > 0) {
        totalHits += count;
      }
    }
  }

  if (totalHits === 0) {
    return {
      ok: false,
      reason:
        `callsite-coverage: exported symbol "${symbolName}" has no production callsite. ` +
        `No references found outside "${relativeSourcePath}", test files, and dist directories. ` +
        `Wire the symbol to a production callsite before verifying the implemented gate.`,
      codeName: 'E_EVIDENCE_INSUFFICIENT',
    };
  }

  return {
    ok: true,
    atom: { kind: 'callsite-coverage', symbolName, relativeSourcePath, hitCount: totalHits },
  };
}

/**
 * Check that the provided evidence atoms satisfy the callsite-coverage
 * requirement for tasks carrying the `callsite-coverage` label.
 *
 * Returns `null` when the requirement is satisfied; otherwise returns a
 * human-readable reason string suitable for use as an `E_EVIDENCE_INSUFFICIENT`
 * error message.
 *
 * @param atoms - Already-validated evidence atoms.
 * @returns `null` on success, error message string on failure.
 *
 * @task T1605
 */
export function checkCallsiteCoverageAtom(atoms: EvidenceAtom[]): string | null {
  const hasCallsiteAtom = atoms.some((a) => a.kind === 'callsite-coverage');
  if (!hasCallsiteAtom) {
    return (
      `Gate 'implemented' on callsite-coverage tasks requires a 'callsite-coverage' evidence atom. ` +
      `Example: --evidence "commit:<sha>;files:<path>;callsite-coverage:<symbolName>:<relativeSourcePath>". ` +
      `The exported symbol must be referenced from at least one production callsite.`
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Gate minimum evaluation
// ---------------------------------------------------------------------------

/**
 * Check whether a set of validated atoms satisfies the minimum evidence
 * required for a given gate.
 *
 * @param gate - The gate being verified
 * @param atoms - Validated atoms
 * @returns null when satisfied; otherwise the reason message
 *
 * @task T832
 * @adr ADR-051 §2.3
 */
export function checkGateEvidenceMinimum(
  gate: VerificationGate,
  atoms: EvidenceAtom[],
): string | null {
  const minimums = GATE_EVIDENCE_MINIMUMS[gate];
  if (!minimums) return null;
  // Each entry in `minimums` is an alternative — satisfy ANY of them.
  for (const required of minimums) {
    const satisfied = required.every((kind) => atoms.some((a) => a.kind === kind));
    if (satisfied) return null;
  }
  const alternatives = minimums
    .map((set) => set.join(' AND '))
    .map((s) => `[${s}]`)
    .join(' OR ');
  return `Gate '${gate}' requires evidence: ${alternatives}`;
}

/**
 * Compose a {@link GateEvidence} record from validated atoms.
 *
 * @param atoms - Validated evidence atoms
 * @param capturedBy - Agent identifier
 * @param override - True when CLEO_OWNER_OVERRIDE is set
 * @param overrideReason - Reason supplied with the override
 * @returns Canonical GateEvidence ready to persist
 *
 * @task T832
 */
export function composeGateEvidence(
  atoms: EvidenceAtom[],
  capturedBy: string,
  override?: boolean,
  overrideReason?: string,
): GateEvidence {
  const result: GateEvidence = {
    atoms,
    capturedAt: new Date().toISOString(),
    capturedBy,
  };
  if (override) {
    result.override = true;
    if (overrideReason) result.overrideReason = overrideReason;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Re-verification (staleness check at complete time)
// ---------------------------------------------------------------------------

/**
 * Result of re-verifying stored evidence at complete time.
 *
 * @task T832
 */
export interface RevalidationResult {
  stillValid: boolean;
  failedAtoms: Array<{ atom: EvidenceAtom; reason: string }>;
}

/**
 * Re-validate stored evidence to detect tampering between verify and complete.
 *
 * Hard atoms (commit, files, test-run, tool) are re-executed. Soft atoms
 * (url, note, override) pass through unchanged.
 *
 * @param evidence - Previously-stored evidence
 * @param projectRoot - Absolute path to project root
 * @returns Revalidation outcome
 *
 * @task T832
 * @adr ADR-051 §5 / §8 (Decision 8)
 */
export async function revalidateEvidence(
  evidence: GateEvidence,
  projectRoot: string,
): Promise<RevalidationResult> {
  if (evidence.override) {
    // Override evidence is not re-validated — it had no programmatic proof
    // to begin with.
    return { stillValid: true, failedAtoms: [] };
  }

  const failed: Array<{ atom: EvidenceAtom; reason: string }> = [];

  for (const atom of evidence.atoms) {
    switch (atom.kind) {
      case 'url':
      case 'note':
      case 'override':
        break;
      case 'commit': {
        const check = await validateCommit(atom.sha, projectRoot);
        if (!check.ok) failed.push({ atom, reason: check.reason });
        break;
      }
      case 'files': {
        for (const f of atom.files) {
          const abs = isAbsolute(f.path) ? f.path : resolvePath(projectRoot, f.path);
          if (!existsSync(abs)) {
            failed.push({ atom, reason: `File removed since verify: ${f.path}` });
            break;
          }
          const content = await readFile(abs);
          const sha256 = createHash('sha256').update(content).digest('hex');
          if (sha256 !== f.sha256) {
            failed.push({
              atom,
              reason: `File modified since verify: ${f.path} (expected ${f.sha256.slice(0, 8)}, got ${sha256.slice(0, 8)})`,
            });
            break;
          }
        }
        break;
      }
      case 'test-run': {
        const abs = isAbsolute(atom.path) ? atom.path : resolvePath(projectRoot, atom.path);
        if (!existsSync(abs)) {
          failed.push({ atom, reason: `test-run file removed since verify: ${atom.path}` });
          break;
        }
        const content = await readFile(abs);
        const sha256 = createHash('sha256').update(content).digest('hex');
        if (sha256 !== atom.sha256) {
          failed.push({ atom, reason: `test-run output modified since verify: ${atom.path}` });
        }
        break;
      }
      case 'tool': {
        // Tool atoms are not re-executed (too slow for every complete call);
        // they are trusted once verified. Evidence for qaPassed / testsPassed
        // should use test-run / files to anchor the state.
        break;
      }
      case 'loc-drop':
        // LOC counts are immutable once captured — no re-execution possible.
        // The counts are structural facts about the migration; the atom is
        // trusted as-is once validated at verify time.
        break;
      case 'callsite-coverage':
        // Callsite hit counts are captured at verify time and treated as
        // immutable structural facts — no re-execution at complete time.
        break;
      default:
        // Exhaustiveness — unreachable if EvidenceAtom is complete.
        break;
    }
  }

  return { stillValid: failed.length === 0, failedAtoms: failed };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runCommand(cmd: string, args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (d) => {
      stdout += d.toString('utf-8');
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString('utf-8');
    });
    child.on('error', () => {
      resolve({ exitCode: null, stdout, stderr });
    });
    child.on('close', (code) => {
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

function tailString(s: string, max: number): string {
  if (s.length <= max) return s;
  return '…' + s.slice(s.length - max + 1);
}
