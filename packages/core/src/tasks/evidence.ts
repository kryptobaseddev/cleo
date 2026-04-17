/**
 * Evidence-based gate validation (ADR-051 / T832).
 *
 * Parses and validates evidence atoms for `cleo verify`. Each atom is checked
 * against the filesystem, git, vitest JSON output, or toolchain exit code.
 * Soft evidence (`url:`, `note:`) is accepted without validation.
 *
 * @task T832
 * @adr ADR-051
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';

import type { EvidenceAtom, GateEvidence, VerificationGate } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';

import { CleoError } from '../errors.js';

/**
 * Valid tool names recognised by the `tool:<name>` evidence atom.
 *
 * Tool invocation definitions live in {@link TOOL_COMMANDS}.
 *
 * @task T832
 */
export const VALID_TOOLS = [
  'biome',
  'tsc',
  'eslint',
  'pnpm-build',
  'pnpm-test',
  'security-scan',
] as const;

/**
 * Type of a supported evidence tool.
 *
 * @task T832
 */
export type EvidenceTool = (typeof VALID_TOOLS)[number];

interface ToolCommand {
  cmd: string;
  args: string[];
}

/**
 * Tool name → shell command + args.  Each tool is executed with `cwd = project
 * root` and stdout/stderr captured. Exit 0 is required for acceptance.
 *
 * @task T832
 */
export const TOOL_COMMANDS: Record<EvidenceTool, ToolCommand> = {
  biome: { cmd: 'pnpm', args: ['biome', 'ci', '.'] },
  tsc: { cmd: 'pnpm', args: ['tsc', '--noEmit'] },
  eslint: { cmd: 'pnpm', args: ['eslint', '.'] },
  'pnpm-build': { cmd: 'pnpm', args: ['run', 'build'] },
  'pnpm-test': { cmd: 'pnpm', args: ['run', 'test'] },
  'security-scan': { cmd: 'pnpm', args: ['audit'] },
};

/**
 * Minimum evidence required for each verification gate.
 *
 * - A single atom kind means at least one atom of that kind MUST be present.
 * - A tuple of kinds means all listed kinds MUST be present.
 * - Alternatives are modeled as separate sets — if ANY set is satisfied the
 *   evidence is accepted.
 *
 * @task T832
 * @adr ADR-051 §2.3
 */
export const GATE_EVIDENCE_MINIMUMS: Record<VerificationGate, EvidenceAtom['kind'][][]> = {
  implemented: [['commit', 'files']],
  testsPassed: [['test-run'], ['tool']],
  qaPassed: [['tool']],
  documented: [['files'], ['url']],
  securityPassed: [['tool'], ['note']],
  cleanupDone: [['note']],
};

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
  | { kind: 'note'; note: string };

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
      default:
        throw new CleoError(
          ExitCode.VALIDATION_ERROR,
          `Unknown evidence kind: "${kind}" in atom "${chunk}"`,
          {
            fix: 'Valid kinds: commit, files, test-run, tool, url, note',
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
  if (!(VALID_TOOLS as readonly string[]).includes(tool)) {
    return {
      ok: false,
      reason: `Unknown tool: "${tool}". Valid: ${VALID_TOOLS.join(', ')}`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  }
  const cmd = TOOL_COMMANDS[tool as EvidenceTool];
  const result = await runCommand(cmd.cmd, cmd.args, projectRoot);
  if (result.exitCode === null) {
    return {
      ok: false,
      reason: `Tool "${tool}" could not be executed (binary missing or spawn error)`,
      codeName: 'E_EVIDENCE_TOOL_UNAVAILABLE',
    };
  }
  if (result.exitCode !== 0) {
    const tail = tailString(result.stdout + '\n' + result.stderr, 512);
    return {
      ok: false,
      reason: `Tool "${tool}" exited with code ${result.exitCode}. Tail: ${tail}`,
      codeName: 'E_EVIDENCE_TOOL_FAILED',
    };
  }
  const stdoutTail = tailString(result.stdout, 512);
  return {
    ok: true,
    atom: { kind: 'tool', tool, exitCode: 0, stdoutTail },
  };
}

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
