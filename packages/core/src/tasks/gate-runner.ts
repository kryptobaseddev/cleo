/**
 * Acceptance gate runner — executes typed `AcceptanceGate` items from a
 * task's `acceptance` array and returns structured `AcceptanceGateResult[]`.
 *
 * Supported gate kinds:
 *   - `test`    — spawn a command, assert exit code / stdout
 *   - `file`    — assert file properties (exists, bytes, content)
 *   - `command` — spawn any CLI, assert exit code / stdout / stderr
 *   - `lint`    — run biome/eslint/tsc/prettier/rustc/clippy, assert clean
 *   - `http`    — fetch URL, assert status + optional body
 *   - `manual`  — always returns `skipped` (requires explicit human verdict)
 *
 * Design constraints:
 *   - Each gate is self-contained (no cross-gate state).
 *   - Gates run sequentially unless the caller sets `parallel` options.
 *   - Default timeout is 60 000 ms per gate (overridable via `timeoutMs`
 *     on the gate or the `CLEO_GATE_TIMEOUT_MS` env variable).
 *
 * @epic T760
 * @task T781
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type {
  AcceptanceGate,
  AcceptanceGateResult,
  CommandGate,
  FileAssertion,
  FileGate,
  HttpGate,
  LintGate,
  ManualGate,
  TestGate,
} from '@cleocode/contracts';
import { getProjectRoot } from '../paths.js';
import { createAttachmentStore } from '../store/attachment-store.js';

const execFileAsync = promisify(execFile);

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default gate timeout in milliseconds. Overridden by env or per-gate `timeoutMs`. */
const DEFAULT_TIMEOUT_MS = Number(process.env['CLEO_GATE_TIMEOUT_MS'] ?? 60_000);

/** Maximum evidence string length stored per gate result. */
const MAX_EVIDENCE_BYTES = 2_000;

/** Agent identifier written into `checkedBy`. */
const CHECKED_BY = process.env['CLEO_AGENT_ID'] ?? 'cleo-verify';

// ─── Public API ───────────────────────────────────────────────────────────────

/** Options for `runGates`. */
export interface RunGatesOptions {
  /** Absolute project root; defaults to `getProjectRoot()`. */
  projectRoot?: string;
  /**
   * When `true`, manual gates are auto-skipped with a note.
   * When `false` (default), they return `result: 'skipped'` with a prompt notice.
   */
  skipManual?: boolean;
}

/**
 * Execute all typed `AcceptanceGate` entries and return results.
 *
 * Free-text strings in the acceptance array MUST be filtered by the caller
 * before invoking this function. Only `AcceptanceGate` objects are accepted.
 *
 * @param gates   - Typed gate objects (strings pre-filtered by caller).
 * @param options - Execution options.
 * @returns       Ordered `AcceptanceGateResult[]`, one per gate.
 *
 * @epic T760
 * @task T781
 */
export async function runGates(
  gates: AcceptanceGate[],
  options: RunGatesOptions = {},
): Promise<AcceptanceGateResult[]> {
  const projectRoot = options.projectRoot ?? getProjectRoot();
  const skipManual = options.skipManual ?? true;
  const results: AcceptanceGateResult[] = [];

  for (let i = 0; i < gates.length; i++) {
    const gate = gates[i]!;
    const startMs = Date.now();
    let result: AcceptanceGateResult;

    try {
      result = await runOneGate(gate, i, projectRoot, skipManual);
    } catch (err) {
      const durationMs = Date.now() - startMs;
      result = {
        index: i,
        req: gate.req,
        kind: gate.kind,
        result: 'error',
        durationMs,
        errorMessage: err instanceof Error ? err.message : String(err),
        checkedAt: new Date().toISOString(),
        checkedBy: CHECKED_BY,
      };
    }

    results.push(result);
  }

  return results;
}

// ─── Internal dispatcher ──────────────────────────────────────────────────────

async function runOneGate(
  gate: AcceptanceGate,
  index: number,
  projectRoot: string,
  skipManual: boolean,
): Promise<AcceptanceGateResult> {
  const timeout = gate.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  switch (gate.kind) {
    case 'test':
      return runTestGate(gate, index, projectRoot, timeout);
    case 'file':
      return runFileGate(gate, index, projectRoot);
    case 'command':
      return runCommandGate(gate, index, projectRoot, timeout);
    case 'lint':
      return runLintGate(gate, index, projectRoot, timeout);
    case 'http':
      return runHttpGate(gate, index, projectRoot, timeout);
    case 'manual':
      return runManualGate(gate, index, skipManual);
  }
}

// ─── Test gate ────────────────────────────────────────────────────────────────

async function runTestGate(
  gate: TestGate,
  index: number,
  projectRoot: string,
  timeoutMs: number,
): Promise<AcceptanceGateResult> {
  const startMs = Date.now();
  const cwd = resolveCwd(projectRoot, gate.cwd);

  // Split command string into binary + args if no explicit args provided
  const [bin, ...defaultArgs] = gate.command.split(' ');
  const args = gate.args ?? defaultArgs;

  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  let timedOut = false;

  try {
    const out = await execFileAsync(bin!, args, {
      cwd,
      env: { ...process.env, ...gate.env },
      timeout: timeoutMs,
    });
    stdout = out.stdout;
    stderr = out.stderr;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & {
      code?: string;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
      status?: number;
    };
    stdout = e.stdout ?? '';
    stderr = e.stderr ?? '';
    exitCode = typeof e.status === 'number' ? e.status : 1;
    if (e.killed || e.code === 'ETIMEDOUT') {
      timedOut = true;
    }
  }

  const durationMs = Date.now() - startMs;
  const combined = truncate(`${stdout}\n${stderr}`.trim(), MAX_EVIDENCE_BYTES);

  if (timedOut) {
    return makeResult(
      index,
      gate,
      'fail',
      durationMs,
      combined,
      `Gate timed out after ${timeoutMs}ms`,
    );
  }

  if (exitCode !== 0) {
    return makeResult(index, gate, 'fail', durationMs, combined, `Exit code ${exitCode}`);
  }

  // For 'pass' mode, check for obvious failure indicators in stdout
  if (gate.expect === 'pass') {
    const failPattern = /\bFAIL\b|failing|Error:/i;
    if (failPattern.test(stdout)) {
      return makeResult(
        index,
        gate,
        'fail',
        durationMs,
        combined,
        'Failure pattern detected in output',
      );
    }
  }

  return makeResult(index, gate, 'pass', durationMs, combined);
}

// ─── File gate ────────────────────────────────────────────────────────────────

async function runFileGate(
  gate: FileGate,
  index: number,
  projectRoot: string,
): Promise<AcceptanceGateResult> {
  const startMs = Date.now();

  // Resolve file path: either from gate.path or via AttachmentStore by sha256.
  let filePath: string;
  if (gate.attachmentSha256) {
    // Resolve via AttachmentStore — fail fast if the attachment is missing.
    const store = createAttachmentStore();
    const result = await store.get(gate.attachmentSha256);
    if (!result) {
      const durationMs = Date.now() - startMs;
      return makeResult(
        index,
        gate,
        'fail',
        durationMs,
        `attachment sha256=${gate.attachmentSha256} not found`,
        `Attachment not found: ${gate.attachmentSha256}`,
      );
    }
    // Derive the on-disk path from AttachmentStore internals via the metadata.
    const mime =
      'mime' in result.metadata.attachment
        ? (result.metadata.attachment.mime as string)
        : 'application/octet-stream';
    // Reconstruct path: .cleo/attachments/sha256/<prefix>/<rest>.<ext>
    const { getCleoDirAbsolute } = await import('../paths.js');
    const { join: pathJoin } = await import('node:path');
    const cleoDir = getCleoDirAbsolute(projectRoot);
    const sha256 = gate.attachmentSha256;
    const extMap: Record<string, string> = {
      'text/markdown': '.md',
      'text/plain': '.txt',
      'application/json': '.json',
      'application/pdf': '.pdf',
      'text/html': '.html',
    };
    const ext = extMap[mime] ?? '.bin';
    filePath = pathJoin(
      cleoDir,
      'attachments',
      'sha256',
      sha256.slice(0, 2),
      `${sha256.slice(2)}${ext}`,
    );
  } else if (gate.path) {
    filePath = isAbsolute(gate.path) ? gate.path : join(projectRoot, gate.path);
  } else {
    const durationMs = Date.now() - startMs;
    return makeResult(
      index,
      gate,
      'fail',
      durationMs,
      'FileGate requires either path or attachmentSha256',
      'FileGate missing path and attachmentSha256',
    );
  }

  const failures: string[] = [];
  const fileContent: string | null = null;
  let fileSize = 0;
  let fileExists = false;

  // Check existence first
  try {
    const st = await stat(filePath);
    fileExists = true;
    fileSize = st.size;
  } catch {
    fileExists = false;
  }

  for (const assertion of gate.assertions) {
    const failure = await checkFileAssertion(assertion, filePath, fileExists, fileSize, () => {
      if (fileContent === null) {
        return readFile(filePath, 'utf-8').catch(() => '');
      }
      return Promise.resolve(fileContent);
    });
    if (failure) {
      failures.push(failure);
    }
  }

  const durationMs = Date.now() - startMs;

  if (failures.length > 0) {
    const evidence = `path=${filePath}\n${failures.join('\n')}`;
    return makeResult(
      index,
      gate,
      'fail',
      durationMs,
      truncate(evidence, MAX_EVIDENCE_BYTES),
      failures[0],
    );
  }

  return makeResult(index, gate, 'pass', durationMs, `path=${filePath} — all assertions passed`);
}

/**
 * Run a single file assertion.
 *
 * @returns Error message string when the assertion fails, `null` when it passes.
 */
async function checkFileAssertion(
  assertion: FileAssertion,
  filePath: string,
  fileExists: boolean,
  fileSize: number,
  getContent: () => Promise<string>,
): Promise<string | null> {
  switch (assertion.type) {
    case 'exists':
      return fileExists ? null : `File does not exist: ${filePath}`;

    case 'absent':
      return fileExists ? `File should be absent but exists: ${filePath}` : null;

    case 'nonEmpty':
      if (!fileExists) return `File does not exist: ${filePath}`;
      return fileSize > 0 ? null : `File is empty: ${filePath}`;

    case 'maxBytes':
      if (!fileExists) return `File does not exist: ${filePath}`;
      return fileSize <= assertion.value
        ? null
        : `File size ${fileSize} exceeds max ${assertion.value} bytes`;

    case 'minBytes':
      if (!fileExists) return `File does not exist: ${filePath}`;
      return fileSize >= assertion.value
        ? null
        : `File size ${fileSize} is below min ${assertion.value} bytes`;

    case 'contains': {
      if (!fileExists) return `File does not exist: ${filePath}`;
      const content = await getContent();
      return content.includes(assertion.value)
        ? null
        : `File does not contain: ${JSON.stringify(assertion.value)}`;
    }

    case 'matches': {
      if (!fileExists) return `File does not exist: ${filePath}`;
      const content = await getContent();
      const re = new RegExp(assertion.regex, assertion.flags);
      return re.test(content)
        ? null
        : `File does not match regex /${assertion.regex}/${assertion.flags ?? ''}`;
    }

    case 'sha256': {
      if (!fileExists) return `File does not exist: ${filePath}`;
      const raw = await readFile(filePath);
      const hash = createHash('sha256').update(raw).digest('hex');
      return hash === assertion.value
        ? null
        : `SHA-256 mismatch: expected ${assertion.value}, got ${hash}`;
    }

    default: {
      // Exhaustive check — TypeScript narrows FileAssertion to `never` here
      const _exhaustive: never = assertion;
      return `Unknown assertion type: ${JSON.stringify(_exhaustive)}`;
    }
  }
}

// ─── Command gate ─────────────────────────────────────────────────────────────

async function runCommandGate(
  gate: CommandGate,
  index: number,
  projectRoot: string,
  timeoutMs: number,
): Promise<AcceptanceGateResult> {
  const startMs = Date.now();
  const cwd = resolveCwd(projectRoot, gate.cwd);
  const expectedExitCode = gate.exitCode ?? 0;

  let stdout = '';
  let stderr = '';
  let actualExitCode = 0;
  let timedOut = false;

  try {
    const out = await execFileAsync(gate.cmd, gate.args ?? [], {
      cwd,
      env: { ...process.env, ...gate.env },
      timeout: timeoutMs,
    });
    stdout = out.stdout;
    stderr = out.stderr;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & {
      code?: string;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
      status?: number;
    };
    stdout = e.stdout ?? '';
    stderr = e.stderr ?? '';
    actualExitCode = typeof e.status === 'number' ? e.status : 1;
    if (e.killed || e.code === 'ETIMEDOUT') {
      timedOut = true;
    }
  }

  const durationMs = Date.now() - startMs;
  const combined = truncate(`${stdout}\n${stderr}`.trim(), MAX_EVIDENCE_BYTES);

  if (timedOut) {
    return makeResult(
      index,
      gate,
      'fail',
      durationMs,
      combined,
      `Gate timed out after ${timeoutMs}ms`,
    );
  }

  if (actualExitCode !== expectedExitCode) {
    return makeResult(
      index,
      gate,
      'fail',
      durationMs,
      combined,
      `Exit code ${actualExitCode} (expected ${expectedExitCode})`,
    );
  }

  if (gate.stdoutMatches) {
    const re = new RegExp(gate.stdoutMatches);
    if (!re.test(stdout)) {
      return makeResult(
        index,
        gate,
        'fail',
        durationMs,
        combined,
        `stdout did not match /${gate.stdoutMatches}/`,
      );
    }
  }

  if (gate.stderrMatches) {
    const re = new RegExp(gate.stderrMatches);
    if (!re.test(stderr)) {
      return makeResult(
        index,
        gate,
        'fail',
        durationMs,
        combined,
        `stderr did not match /${gate.stderrMatches}/`,
      );
    }
  }

  return makeResult(index, gate, 'pass', durationMs, combined);
}

// ─── Lint gate ────────────────────────────────────────────────────────────────

/** Tool-specific CLI arguments and failure patterns. */
const LINT_TOOL_DEFAULTS: Record<
  LintGate['tool'],
  { cmd: string; defaultArgs: string[]; errorPattern?: RegExp }
> = {
  biome: { cmd: 'biome', defaultArgs: ['check', '.'] },
  eslint: { cmd: 'eslint', defaultArgs: ['.'] },
  tsc: { cmd: 'tsc', defaultArgs: ['--noEmit'] },
  prettier: { cmd: 'prettier', defaultArgs: ['--check', '.'] },
  rustc: { cmd: 'rustc', defaultArgs: ['--edition', '2021', '--crate-type', 'lib'] },
  clippy: {
    cmd: 'cargo',
    defaultArgs: ['clippy', '--', '-D', 'warnings'],
    errorPattern: /^error/m,
  },
};

async function runLintGate(
  gate: LintGate,
  index: number,
  projectRoot: string,
  timeoutMs: number,
): Promise<AcceptanceGateResult> {
  const startMs = Date.now();
  const cwd = resolveCwd(projectRoot, gate.cwd);
  const toolDef = LINT_TOOL_DEFAULTS[gate.tool];
  const args = gate.args ?? toolDef.defaultArgs;

  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  let timedOut = false;

  try {
    const out = await execFileAsync(toolDef.cmd, args, { cwd, timeout: timeoutMs });
    stdout = out.stdout;
    stderr = out.stderr;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & {
      code?: string;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
      status?: number;
    };
    stdout = e.stdout ?? '';
    stderr = e.stderr ?? '';
    exitCode = typeof e.status === 'number' ? e.status : 1;
    if (e.killed || e.code === 'ETIMEDOUT') {
      timedOut = true;
    }
  }

  const durationMs = Date.now() - startMs;
  const combined = truncate(`${stdout}\n${stderr}`.trim(), MAX_EVIDENCE_BYTES);

  if (timedOut) {
    return makeResult(
      index,
      gate,
      'fail',
      durationMs,
      combined,
      `Gate timed out after ${timeoutMs}ms`,
    );
  }

  // For 'noErrors' mode, exit code 0 = pass (warnings tolerated)
  if (gate.expect === 'noErrors') {
    const passed = exitCode === 0;
    return makeResult(
      index,
      gate,
      passed ? 'pass' : 'fail',
      durationMs,
      combined,
      passed ? undefined : `${gate.tool} reported errors (exit ${exitCode})`,
    );
  }

  // For 'clean' mode, check exit code AND optional error pattern
  if (exitCode !== 0) {
    return makeResult(
      index,
      gate,
      'fail',
      durationMs,
      combined,
      `${gate.tool} exited with ${exitCode}`,
    );
  }

  if (toolDef.errorPattern && toolDef.errorPattern.test(combined)) {
    return makeResult(
      index,
      gate,
      'fail',
      durationMs,
      combined,
      `${gate.tool} output matched error pattern`,
    );
  }

  return makeResult(index, gate, 'pass', durationMs, combined);
}

// ─── HTTP gate ────────────────────────────────────────────────────────────────

async function runHttpGate(
  gate: HttpGate,
  index: number,
  _projectRoot: string,
  timeoutMs: number,
): Promise<AcceptanceGateResult> {
  const startMs = Date.now();
  let serverProcess: ReturnType<typeof import('node:child_process').spawn> | null = null;

  // Start the server if configured
  if (gate.startCommand) {
    const { spawn } = await import('node:child_process');
    const [cmd, ...args] = gate.startCommand.split(' ');
    serverProcess = spawn(cmd!, args, { detached: true, stdio: 'ignore' });
    serverProcess.unref();

    // Wait for startup delay
    const delayMs = gate.startupDelayMs ?? 2_000;
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }

  let statusCode = 0;
  let body = '';
  let errorMsg: string | undefined;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(gate.url, {
        method: gate.method ?? 'GET',
        headers: gate.headers,
        signal: controller.signal,
      });
      statusCode = response.status;
      body = await response.text();
    } finally {
      clearTimeout(timer);
    }
  } catch (err: unknown) {
    errorMsg = err instanceof Error ? err.message : String(err);
  } finally {
    if (serverProcess) {
      try {
        serverProcess.kill();
      } catch {
        // Best-effort cleanup
      }
    }
  }

  const durationMs = Date.now() - startMs;

  if (errorMsg) {
    return makeResult(index, gate, 'fail', durationMs, errorMsg, errorMsg);
  }

  if (statusCode !== gate.status) {
    return makeResult(
      index,
      gate,
      'fail',
      durationMs,
      `HTTP ${statusCode}`,
      `Expected status ${gate.status}, got ${statusCode}`,
    );
  }

  if (gate.bodyMatches) {
    const re = new RegExp(gate.bodyMatches);
    if (!re.test(body)) {
      return makeResult(
        index,
        gate,
        'fail',
        durationMs,
        truncate(body, 500),
        `Response body did not match /${gate.bodyMatches}/`,
      );
    }
  }

  const evidence = `HTTP ${statusCode} — ${gate.url}`;
  return makeResult(index, gate, 'pass', durationMs, evidence);
}

// ─── Manual gate ──────────────────────────────────────────────────────────────

function runManualGate(
  gate: ManualGate,
  index: number,
  _skipManual: boolean,
): AcceptanceGateResult {
  // Manual gates always return skipped; a human or different agent must
  // set the verdict explicitly via `cleo verify --manual`.
  return {
    index,
    req: gate.req,
    kind: 'manual',
    result: 'skipped',
    durationMs: 0,
    evidence: `Manual gate requires explicit acceptance. Prompt: ${gate.prompt}`,
    checkedAt: new Date().toISOString(),
    checkedBy: CHECKED_BY,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a resolved working-directory path.
 * Relative `cwd` values are resolved relative to `projectRoot`.
 */
function resolveCwd(projectRoot: string, cwd?: string): string {
  if (!cwd) return projectRoot;
  return isAbsolute(cwd) ? cwd : join(projectRoot, cwd);
}

/** Truncate a string to `maxBytes` characters, appending `…` if trimmed. */
function truncate(s: string, maxBytes: number): string {
  if (s.length <= maxBytes) return s;
  return `${s.slice(0, maxBytes)}…`;
}

/** Construct an `AcceptanceGateResult` record. */
function makeResult(
  index: number,
  gate: AcceptanceGate,
  result: AcceptanceGateResult['result'],
  durationMs: number,
  evidence?: string,
  errorMessage?: string,
): AcceptanceGateResult {
  // Apply advisory override: a failed advisory gate becomes 'warn'
  const finalResult = result === 'fail' && gate.advisory === true ? 'warn' : result;

  return {
    index,
    req: gate.req,
    kind: gate.kind,
    result: finalResult,
    durationMs,
    evidence: evidence ? evidence.trim() : undefined,
    errorMessage: finalResult !== 'pass' ? errorMessage : undefined,
    checkedAt: new Date().toISOString(),
    checkedBy: CHECKED_BY,
  };
}

/**
 * Filter a mixed acceptance array to only typed `AcceptanceGate` objects.
 * Free-text strings are silently dropped with their original index preserved
 * via the `index` field of each result.
 *
 * @param items  - Mixed `(string | AcceptanceGate)[]` from `task.acceptance`.
 * @returns      Typed gates with their original indices.
 */
export function extractTypedGates(
  items: (string | AcceptanceGate)[],
): Array<{ gate: AcceptanceGate; originalIndex: number }> {
  return items
    .map((item, i) => ({ item, i }))
    .filter(
      (x): x is { item: AcceptanceGate; i: number } =>
        typeof x.item === 'object' && x.item !== null && 'kind' in x.item,
    )
    .map(({ item, i }) => ({ gate: item, originalIndex: i }));
}
